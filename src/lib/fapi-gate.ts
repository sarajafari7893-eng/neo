// ── NEXUS//SIGNALS FAPI GATE (server-only, v10.24 — Task 34-a) ──────────────
// Process-wide WEIGHT-BASED token bucket for Binance USDT-M futures REST
// (fapi.binance.com). WHY: 9+ modules in the Next.js process each did their own
// uncoordinated fetch() to the same host and the trade mini-service added
// ~1800 weight/min on top → Binance answered with HTTP 418 IP-bans carrying
// stacked multi-hour "banned until <ms>" windows. This gate is the single
// choke-point every futures-REST call in THIS process must pass:
//
//   · WEIGHT BUDGET — rolling-60s sliding window, default 1100 weight/min
//     (fapi real limit is 2400/min per IP; ~2× headroom absorbs drift between
//     weight estimates and the ungated mini-service until Task 34-b).
//   · LANES — "critical" (engine price feed, trigger measurements) executes
//     immediately when tokens exist, with ONE small negative retry after
//     250ms when momentarily empty; "telemetry" (every rotating scanner/
//     sampler/board) is DROPPED (returns null) when tokens are missing —
//     no unbounded queues, no storm amplification. All callers are
//     null-tolerant by contract.
//   · GLOBAL BAN AWARENESS (refined for the multi-IP egress pool — measured
//     2026-09-26: the sandbox egress rotates across several IPs and Binance's
//     418 body NAMES the banned one: «IP(47.57.x.x) banned until <ms>», with
//     different pool IPs banned in different windows):
//       – 418/429 body naming an IP → PER-IP ban record (capped now+35min),
//         the request's weight is REFUNDED (ban responses carry no weight
//         cost) and the call RETRIES (≤2, 120ms apart) — the pool usually
//         rotates onto a clean IP, so one unlucky draw never starves the app.
//       – ALL retries land on banned IPs → one unlucky draw too many: arm a
//         SHORT 60s global block, and only when that happens 3 times IN A ROW
//         (no successful call between) treat the pool as saturated and arm the
//         full zero-network window min(worst ban end, now+35min). A single
//         clean 2xx resets the streak — self-healing probes.
//       – 418/429 body WITHOUT a parseable IP (unknown scope — the classic
//         single-IP case): arm the global zero-network window immediately —
//         "banned until X" → min(X, now+35min); unparseable 418 → 10min;
//         unparseable 429 → 2min.
//       – While the global window is live, gateFetch returns null INSTANTLY —
//         zero network calls, so a live ban can never be extended by us.
//   · SINGLE-FLIGHT — one shared request per (host,path) while in flight and
//     for a 2s result window, so multiple modules asking the same endpoint
//     inside one tick share one weight spend.
//   · HOST AWARENESS — default host fapi.binance.com, optional alt host
//     (fapi1) for the market-feed availability ladder; bans/weight are
//     per-IP so both hosts share the SAME budget and ban state.
//
// NEVER THROWS: gateFetch returns parsed JSON or null on any failure.
// State lives on globalThis so Turbopack's dev module-graph duplication
// (route graph vs engine graph) still shares ONE process-wide bucket.
//
// SPOT (api.binance.com) and other exchanges (OKX/Bybit/Hyperliquid) must
// NOT pass through here — futures fapi host only.
//
// ── v12.0 EGRESS/IP MANAGER (Task 44-②, operator order «مدیریت egress/IP
// برای رفع بن fapi») ──────────────────────────────────────────────────────────
// Measured 2026-10-18: the sandbox egress is a rotating NAT pool and Binance
// bans POOL IPs with LONG windows (three named IPs banned until 10-18 19:47Z /
// 22:37Z / 10-19 13:26Z — each plain request is a lottery draw). Three new
// weapons:
//   1. EGRESS SAMPLER — api.ipify.org probe (3.5s timeout, 120s cache,
//      single-flight, never throws) tells us WHICH pool IP a draw exited from.
//   2. ROTATION-AWARE EARLY PROBE — while a global ban window is live, ONE
//      critical-lane call per 120s may bypass the silence IF the sampled IP is
//      clean: the moment the pool rotates, the window LIFTS instantly instead
//      of waiting out the 35min cap. A failed probe costs nothing (banned
//      responses carry no weight) and keeps the window armed.
//   3. BAN-LEDGER PERSISTENCE — named-IP ban records survive process
//      restarts (.data/fapi-gate/bans.json, 30s debounced) so a recycle no
//      longer re-learns the minefield by burning fresh probes.
//

// v10.25 (Task 41, operator order «بایننس ای پی را بلاک نکرده باشد و قابل
// جایگزینی باشد»): the host is env-swappable WITHOUT a code change — if fapi
// is ever hard-blocked (451/region/grey-list, not just a timed 418), set
// NEXUS_FAPI_HOST in .env to a reachable futures-mirror and restart the app.
// Default stays the canonical host. Downstream replaceability ladder is
// already layered: fapi-gate (this) → SPOT-MIRROR aggTrade WS → spot REST
// klines/price fallback → multi-venue liq (bybit/okx/bitget).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const FAPI_HOST = process.env.NEXUS_FAPI_HOST?.trim().replace(/\/+$/, "") || "https://fapi.binance.com";
const DEFAULT_TIMEOUT_MS = 6500;
const WINDOW_MS = 60_000;
const DEFAULT_BUDGET = 1100; // real fapi limit 2400/min per IP — headroom by design
const BAN_CAP_MS = 35 * 60_000; // never record a ban window longer than 35min even if Binance claims hours
// v12.6.1 — mixed-pool era: an UNPARSEABLE 418 is evidence of ONE banned draw,
// not a pool-wide ban (measured 2026-10-20 19:32Z: boot's first draw 418'd
// unparseable while 6/10 fresh connections succeeded — the old 10min arm
// locked the whole app out of a majority-clean pool). 2min + the streak
// escalation ladder covers true saturation.
const BAN_418_DEFAULT_MS = 2 * 60_000; // unparseable 418 → short backoff (was 10min — pool-starvation lesson)
const BAN_429_DEFAULT_MS = 2 * 60_000; // unparseable 429 → short warning backoff
const CRITICAL_RETRY_MS = 250; // the "small negative retry" for the critical lane
const SF_RESULT_MS = 2_000; // single-flight result sharing window
const SF_MAP_CAP = 512;
const SPEND_CAP = 4096; // defensive cap on window entries (~worst-case small-weight bursts)
const BAN_RETRIES = 3; // extra attempts after a named-IP ban (pool rotation)
// v12.6.2 ESCALATING RETRY CADENCE: the NAT egress mapping rotates over ~30s
// (measured 2026-10-20 19:41Z: keep-alive 6×418 → 30s later 6×200), so three
// retries 120ms apart shared ONE doomed mapping. Spacing the retries across
// it (120ms → 2s → 8s) lets draws 2-4 land on a rotated mapping — higher
// per-call success, fewer 60s short blocks. Worst added latency ~10s on a
// banned stretch; the ladder still escalates to the 60s block on failure.
const BAN_RETRY_DELAYS_MS = [120, 2_000, 8_000];
const POOL_BLOCK_SHORT_MS = 60_000; // all-retries-banned → short block, let the pool rotate
const POOL_STREAK_FOR_LONG_BLOCK = 3; // consecutive all-banned calls ⇒ pool saturated
const IP_BAN_MAP_CAP = 16;
// ── v12.0 egress manager constants ──
const EGRESS_SAMPLE_TTL_MS = 120_000; // ipify cache — one draw sample per 2min
const EGRESS_TIMEOUT_MS = 3_500;
const PROBE_COOLDOWN_MS = 120_000; // one early-probe attempt per 2min while a window is live
const BAN_PERSIST_DIR = `${process.cwd()}/.data/fapi-gate`;
const BAN_PERSIST_PATH = `${BAN_PERSIST_DIR}/bans.json`;
const BAN_PERSIST_DEBOUNCE_MS = 30_000;

export type FapiGatePriority = "critical" | "telemetry";

export interface GateFetchOpts {
  weight?: number; // explicit weight; default resolved from the path
  priority?: FapiGatePriority; // default "telemetry"
  timeoutMs?: number; // default 6500
  host?: string; // default fapi.binance.com (alt: fapi1 — same IP pool, same budget)
  /** v12.0 internal — rotation-aware early probe: single attempt, no ban retries */
  singleProbe?: boolean;
}

export interface FapiGateStats {
  attempted: number; // every gateFetch call
  allowed: number; // actual HTTP requests issued that returned 2xx JSON
  droppedBudget: number; // shed by the weight bucket (telemetry drop / critical post-retry)
  droppedBan: number; // shed instantly because a global ban window is live
  lastBanUntil: number; // epoch ms of the last armed GLOBAL ban end (0 = never)
  budgetPer60s: number;
  usedLast60s: number;
  singleFlightShared: number; // calls served by an in-flight/2s-window shared request
  banRemainingMs: number;
  bannedPoolIps: number; // named egress IPs currently inside a ban window (observability)
  retriesAfterBan: number; // requests re-attempted after a named-IP 418/429
  // v12.0 egress manager
  probesIssued: number; // rotation-aware early probes attempted during a ban window
  probeLifts: number; // windows lifted early because a clean draw succeeded
}

interface SpendEntry { at: number; w: number }

interface GateState {
  budgetPer60s: number;
  banUntil: number; // GLOBAL zero-network window (unknown-scope / pool-wide bans only)
  spend: SpendEntry[]; // weight spends inside the rolling window (time-ordered)
  windowSum: number;
  inflight: Map<string, { startedAt: number; settled: boolean; promise: Promise<unknown> }>;
  ipBans: Map<string, number>; // named egress IP → ban end (observability + pool evidence)
  recentBanEvents: Array<{ at: number; ip: string }>; // named-IP ban events (observability)
  allBanStreak: number; // consecutive gateFetch calls where EVERY attempt was banned
  // v12.0 egress manager
  sampledIp: string | null;
  sampledAt: number;
  lastBannedIp: string | null;
  lastProbeAt: number;
  stats: {
    attempted: number;
    allowed: number;
    droppedBudget: number;
    droppedBan: number;
    lastBanUntil: number;
    singleFlightShared: number;
    retriesAfterBan: number;
    probesIssued: number;
    probeLifts: number;
  };
}

// globalThis singleton — survives Turbopack dev module-graph duplication
const g = globalThis as unknown as { __nexusFapiGate?: GateState };
const state: GateState =
  g.__nexusFapiGate ??
  (g.__nexusFapiGate = {
    budgetPer60s: DEFAULT_BUDGET,
    banUntil: 0,
    spend: [],
    windowSum: 0,
    inflight: new Map(),
    ipBans: new Map(),
    recentBanEvents: [],
    allBanStreak: 0,
    sampledIp: null,
    sampledAt: 0,
    lastBannedIp: null,
    lastProbeAt: 0,
    stats: { attempted: 0, allowed: 0, droppedBudget: 0, droppedBan: 0, lastBanUntil: 0, singleFlightShared: 0, retriesAfterBan: 0, probesIssued: 0, probeLifts: 0 },
  });

// ── v12.0 ban-ledger persistence (survive restarts without re-probing) ──
// v12.6 BINANCE-REVIVAL (operator order «سیستم را به بایننس متصل کن»,
// trace 1a15ac1a1724cdb1) — POLICY SPLIT between ban scopes. Measured 2026-10-20
// 19:17-19:26Z: with ONE named pool IP banned (8.212.10.159), 9 direct draws
// returned 7×200 (klines/OI/funding/depth/aggTrades) and 2×418 — the NAT pool
// is MAJORITY-CLEAN, yet the v12.1 rule “one named-IP ban in the ledger ⇒
// GLOBAL zero-network window until the worst ban end” blacked out the whole
// fapi plane (flow BINANCE rung, venue consensus, OI/funding/tape/depth) for
// up to 35min per event and pushed flow to BYBIT ×0.5 for most of its life.
//   · NAMED-IP entries («1.2.3.4»: until) = pool INTEL: recorded, retried
//     around (≤2, 120ms — pool rotation), but they NO LONGER arm the global
//     silence. Worst case stays bounded by the existing escalation ladder
//     (2 retries → 60s block → 3-streak ⇒ real-end window) — the Task-50
//     anti-spiral law applies where it matters (saturated pool / unknown scope).
//   · UNKNOWN-SCOPE entries (unparseable bodies, “_pool” markers, naked
//     “banned until X”) = the pool itself is the suspect ⇒ immediate global
//     window, exactly as before.
export function isUnknownScopeKey(key: string): boolean {
  return !/^\d{1,3}(\.\d{1,3}){3}$/.test(key); // anything that is not an IPv4 literal ("_pool", hostnames…)
}

try {
  const raw = JSON.parse(readFileSync(BAN_PERSIST_PATH, "utf8")) as { ipBans?: Record<string, number> } | null;
  const nowMs = Date.now();
  let unknownMax = 0;
  let named = 0;
  for (const [key, until] of Object.entries(raw?.ipBans ?? {})) {
    if (typeof until !== "number" || until <= nowMs) continue;
    if (isUnknownScopeKey(key)) {
      if (until > unknownMax) unknownMax = until;
    } else {
      state.ipBans.set(key, until);
      named++;
    }
  }
  if (unknownMax > state.banUntil) {
    state.banUntil = unknownMax;
    console.log(`[fapi-gate] v12.6 restored UNKNOWN-SCOPE pool ban from disk — silence armed until ${new Date(unknownMax).toISOString()}`);
  }
  if (state.ipBans.size > 0) {
    // v12.6: named-IP records are INTEL only — no global arm at boot. The
    // first gateFetch takes the lottery draw; a banned draw retries around
    // the named IP (pool rotation) exactly like any other 418.
    console.log(`[fapi-gate] v12.6 restored ${named} named-IP ban record(s) as intel (no global arm — majority-clean pool policy)`);
  }
} catch { /* no ledger yet — fine */ }
let banPersistTimer: ReturnType<typeof setTimeout> | null = null;
function persistBans(): void {
  if (banPersistTimer) return;
  banPersistTimer = setTimeout(() => {
    banPersistTimer = null;
    try {
      mkdirSync(BAN_PERSIST_DIR, { recursive: true });
      const nowMs = Date.now();
      const ipBans: Record<string, number> = {};
      // v12.1 TASK-49 — READ-MERGE-WRITE: mini-services write their own 418
      // discoveries (incl. "_pool" unknown-scope markers with REAL ends) to
      // this same file. Blindly overwriting with state-only data DELETED a
      // 15:20Z pool ban mid-storm (2026-10-19) — never shorten/lose foreign
      // entries: merge disk first, then overlay ours, keep live only.
      try {
        const disk = JSON.parse(readFileSync(BAN_PERSIST_PATH, "utf8")) as { ipBans?: Record<string, number> } | null;
        for (const [ip, until] of Object.entries(disk?.ipBans ?? {})) {
          if (typeof until === "number" && until > nowMs) ipBans[ip] = until;
        }
      } catch {
        /* no ledger yet */
      }
      for (const [ip, until] of state.ipBans) if (until > nowMs) ipBans[ip] = Math.max(ipBans[ip] ?? 0, until);
      writeFileSync(BAN_PERSIST_PATH, JSON.stringify({ savedAt: new Date().toISOString(), ipBans }, null, 1));
    } catch { /* fail-open — observability only */ }
  }, BAN_PERSIST_DEBOUNCE_MS);
}

// ── v12.0 egress IP sampler (which pool IP did this draw exit from?) ──
let egressInflight: Promise<string | null> | null = null;
export async function sampleEgressIp(): Promise<string | null> {
  if (state.sampledIp && Date.now() - state.sampledAt < EGRESS_SAMPLE_TTL_MS) return state.sampledIp;
  if (egressInflight) return egressInflight;
  egressInflight = (async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), EGRESS_TIMEOUT_MS);
      const res = await fetch("https://api.ipify.org?format=json", { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!res.ok) return null;
      const j = (await res.json()) as { ip?: string };
      const ip = typeof j.ip === "string" && j.ip ? j.ip : null;
      if (ip) {
        state.sampledIp = ip;
        state.sampledAt = Date.now();
      }
      return ip;
    } catch {
      return null; // sampler down — never blocks the gate (fail-open)
    } finally {
      egressInflight = null;
    }
  })();
  return egressInflight;
}

export interface FapiEgressStatus {
  banUntil: number;
  banRemainingMs: number;
  sampledIp: string | null;
  sampledAt: number | null;
  lastBannedIp: string | null;
  bannedIps: Array<{ ip: string; until: number; remainingMs: number }>;
  probesIssued: number;
  probeLifts: number;
  lastProbeAt: number;
}

/** Live egress/ban picture for /api/egress-status and the nervous sweep. */
export function fapiEgressStatus(): FapiEgressStatus {
  const now = Date.now();
  const bannedIps: FapiEgressStatus["bannedIps"] = [];
  for (const [ip, until] of state.ipBans) if (until > now) bannedIps.push({ ip, until, remainingMs: until - now });
  bannedIps.sort((a, b) => b.until - a.until);
  return {
    banUntil: state.banUntil,
    banRemainingMs: Math.max(0, state.banUntil - now),
    sampledIp: state.sampledIp,
    sampledAt: state.sampledAt || null,
    lastBannedIp: state.lastBannedIp,
    bannedIps,
    probesIssued: state.stats.probesIssued,
    probeLifts: state.stats.probeLifts,
    lastProbeAt: state.lastProbeAt,
  };
}

/** Optional runtime tuning — sane defaults mean nobody needs to call this. */
export function configureFapiGate(opts?: { budgetPer60s?: number }): void {
  if (opts?.budgetPer60s !== undefined) {
    const b = Math.max(200, Math.min(2300, Math.round(opts.budgetPer60s)));
    state.budgetPer60s = b;
  }
}

export function fapiBanRemainingMs(): number {
  return Math.max(0, state.banUntil - Date.now());
}

export function fapiGateStats(): FapiGateStats {
  const now = Date.now();
  pruneWindow(now);
  let bannedIps = 0;
  for (const [, until] of state.ipBans) if (until > now) bannedIps++;
  return {
    attempted: state.stats.attempted,
    allowed: state.stats.allowed,
    droppedBudget: state.stats.droppedBudget,
    droppedBan: state.stats.droppedBan,
    lastBanUntil: state.stats.lastBanUntil,
    budgetPer60s: state.budgetPer60s,
    usedLast60s: state.windowSum,
    singleFlightShared: state.stats.singleFlightShared,
    banRemainingMs: fapiBanRemainingMs(),
    bannedPoolIps: bannedIps,
    retriesAfterBan: state.stats.retriesAfterBan,
    probesIssued: state.stats.probesIssued,
    probeLifts: state.stats.probeLifts,
  };
}

// ── weight table (Binance USDT-M futures documented weights) ────────────────
// klines ~2 (limit≤100) · depth 2-5-10 by limit · aggTrades 20 · trades 20 ·
// ticker/24hr 1 per-symbol / 40 full-universe · premiumIndex 1 per-symbol /
// 10 all-markers · futures/data/* 1 (openInterestHist, L/S ratios, basis…) ·
// exchangeInfo 1 · ping/time 1 · unknown default 5 (conservative).
function resolveWeight(path: string): number {
  const qIdx = path.indexOf("?");
  const ep = (qIdx === -1 ? path : path.slice(0, qIdx)).replace(/^\//, "").replace(/\/+$/, "");
  const query = qIdx === -1 ? "" : path.slice(qIdx + 1);
  const limit = (): number | null => {
    const m = /[?&]limit=(\d+)/.exec(query);
    return m ? Number(m[1]) : null;
  };
  switch (ep) {
    case "fapi/v1/ping":
    case "fapi/v1/time":
    case "fapi/v1/exchangeInfo":
      return 1;
    case "fapi/v1/klines": {
      const l = limit() ?? 500;
      return l <= 100 ? 2 : l <= 499 ? 5 : 10;
    }
    case "fapi/v1/depth": {
      const l = limit() ?? 100;
      return l <= 100 ? 2 : l <= 500 ? 5 : 10;
    }
    case "fapi/v1/aggTrades":
    case "fapi/v1/trades":
      return 20;
    case "fapi/v1/ticker/24hr":
      return /[?&]symbol=/.test(query) ? 1 : 40;
    case "fapi/v1/premiumIndex":
      return /[?&]symbol=/.test(query) ? 1 : 10;
    default:
      if (ep.startsWith("futures/data/")) return 1; // openInterestHist / L-S ratios / basis family
      return 5; // unknown → conservative default (covers fapi/v1/fundingRate etc.)
  }
}

function pruneWindow(now: number): void {
  const cutoff = now - WINDOW_MS;
  while (state.spend.length > 0 && state.spend[0]!.at <= cutoff) {
    const e = state.spend.shift()!;
    state.windowSum -= e.w;
  }
  if (state.spend.length > SPEND_CAP) {
    // defensive: drop the oldest half rather than grow unbounded
    const keep = state.spend.slice(Math.floor(state.spend.length / 2));
    let sum = 0;
    for (const e of keep) sum += e.w;
    state.spend = keep;
    state.windowSum = sum;
  }
}

/** Reserve `weight` from the rolling window. Returns the spend entry (for refunds) or null. */
function takeWeight(weight: number): SpendEntry | null {
  const now = Date.now();
  pruneWindow(now);
  if (state.windowSum + weight > state.budgetPer60s) return null;
  const entry: SpendEntry = { at: now, w: weight };
  state.spend.push(entry);
  state.windowSum += weight;
  return entry;
}

/** 418/429 responses carry no weight cost — give the reservation back. */
function refundWeight(entry: SpendEntry | null): void {
  if (!entry) return;
  const idx = state.spend.indexOf(entry);
  if (idx === -1) return; // already pruned out of the window (its cost is gone too)
  state.spend.splice(idx, 1);
  state.windowSum -= entry.w;
}

function armGlobalBan(until: number): void {
  if (until > state.banUntil) {
    state.banUntil = until;
    state.stats.lastBanUntil = until;
  }
}

/** Record a 418/429 body. Returns { ip, until } when the body NAMES the banned egress IP. */
function noteBanBody(status: number, body: string): { ip: string; until: number } | null {
  const now = Date.now();
  const named = /IP\(([\d.]+)\)\s*banned until (\d+)/i.exec(body);
  if (named) {
    const ip = named[1]!;
    // v12.1 TASK-49: the LEDGER carries Binance's REAL end (sanity-capped 24h) —
    // the cosmetic +35min cap only applies to the global silence window below.
    // Capping the ledger made the early probe fire at a fake expiry and the
    // resulting 418 contact re-escalated the real ban (11:58→12:34→13:09 spiral).
    const realUntil = Math.min(Number(named[2]), now + 24 * 60_000);
    const until = Math.min(realUntil, now + BAN_CAP_MS);
    state.ipBans.set(ip, realUntil);
    state.lastBannedIp = ip;
    persistBans(); // v12.0 — named-IP ban ledger survives restarts (30s debounce)
    if (state.ipBans.size > IP_BAN_MAP_CAP) {
      // evict the soonest-expiring record
      let oldestKey: string | null = null;
      let oldestVal = Infinity;
      for (const [k, v] of state.ipBans) if (v < oldestVal) { oldestVal = v; oldestKey = k; }
      if (oldestKey) state.ipBans.delete(oldestKey);
    }
    state.recentBanEvents.push({ at: now, ip });
    if (state.recentBanEvents.length > 64) state.recentBanEvents.splice(0, state.recentBanEvents.length - 64);
    return { ip, until };
  }
  const untilMatch = /banned until (\d+)/i.exec(body);
  if (untilMatch) {
    armGlobalBan(Math.min(Number(untilMatch[1]), now + BAN_CAP_MS)); // unknown scope — assume it's us
    return null;
  }
  // unparseable body — conservative defaults (taxonomy precedent for 418)
  armGlobalBan(now + (status === 429 ? BAN_429_DEFAULT_MS : BAN_418_DEFAULT_MS));
  return null;
}

/** Every retry landed on a (named) banned IP — escalate the global silence window. */
function escalatePoolBlock(worstNamedUntil: number): void {
  const now = Date.now();
  state.allBanStreak++;
  if (state.allBanStreak >= POOL_STREAK_FOR_LONG_BLOCK) {
    // repeated independent evidence — the egress pool is saturated: full
    // zero-network window, capped at 35min, then a fresh probe self-heals.
    armGlobalBan(Math.min(worstNamedUntil, now + BAN_CAP_MS));
    state.allBanStreak = 0;
  } else {
    armGlobalBan(now + POOL_BLOCK_SHORT_MS);
  }
}

function pruneInflight(now: number): void {
  for (const [k, e] of state.inflight) {
    if (e.settled && now - e.startedAt >= SF_RESULT_MS) state.inflight.delete(k);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * THE gate body. Resolves parsed JSON, or null on: live IP ban, weight-budget
 * shed, HTTP failure, timeout, or parse error. Never throws, never queues.
 */
async function executeGated<T>(path: string, opts?: GateFetchOpts): Promise<T | null> {
  const lane: FapiGatePriority = opts?.priority ?? "telemetry";
  const weight = Math.max(1, Math.round(opts?.weight ?? resolveWeight(path)));
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let entry = takeWeight(weight);
  if (!entry) {
    if (lane !== "critical") {
      state.stats.droppedBudget++;
      return null; // telemetry: drop instead of queueing a storm
    }
    await delay(CRITICAL_RETRY_MS); // one small negative retry
    entry = takeWeight(weight);
    if (!entry) {
      state.stats.droppedBudget++;
      return null;
    }
  }

  const host = opts?.host ?? FAPI_HOST;
  let attempt = 0;

  while (true) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      // v12.6.1 CONNECTION-RECYCLE (measured 2026-10-20 19:41Z, bun runtime):
      // a keep-alive fetch POOLS one TCP flow ⇒ ONE egress IP for its whole
      // life — a pinned-banned connection turned 231 gate calls into 0 allowed
      // while 6/10 fresh connections succeeded. `Connection: close` = a fresh
      // NAT lottery draw per request; the TLS cost (~60ms) is trivial next to
      // the starvation it prevents.
      res = await fetch(`${host}${path}`, { signal: ctrl.signal, cache: "no-store", headers: { Connection: "close" } });
    } catch {
      return null; // timeout/abort/network — weight may have been consumed, keep the reservation
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      const text = await res.text().catch(() => "");
      if (!text) return null; // empty 200 — nothing to invent
      state.stats.allowed++;
      state.allBanStreak = 0; // a clean 2xx proves the pool still serves us
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    }

    if (res.status === 418 || res.status === 429) {
      const body = await res.text().catch(() => "");
      refundWeight(entry); // banned responses carry no weight cost
      entry = null;
      const named = noteBanBody(res.status, body);
      if (opts?.singleProbe) return null; // v12.0 early probe — single attempt, window stays armed
      if (!named) return null; // unknown-scope ban — global zero-network window already armed
      if (attempt >= BAN_RETRIES) {
        escalatePoolBlock(named.until);
        return null;
      }
      attempt++;
      state.stats.retriesAfterBan++;
      await delay(BAN_RETRY_DELAYS_MS[Math.min(attempt - 1, BAN_RETRY_DELAYS_MS.length - 1)]!); // span the NAT rotation window
      entry = takeWeight(weight);
      if (!entry) {
        state.stats.droppedBudget++;
        return null;
      }
      continue;
    }

    return null; // other non-ok status — honest null, no retry
  }
}

/** v12.1 TASK-49 — a recorded ban counts ONLY while its real end is in the future. */
function isIpBanned(ip: string | null, now: number): boolean {
  if (!ip) return false;
  return (state.ipBans.get(ip) ?? 0) > now;
}

// v12.1 TASK-49 — SHARED LEDGER REFRESH: trade-service / price-ws write their
// own 418 discoveries (with REAL ends) to the same bans.json. Merge live disk
// entries into state every 30s (extend-only). v12.6 scope split: UNKNOWN-SCOPE
// entries extend the global silence (pool-suspect evidence); NAMED-IP entries
// merge into ipBans as intel only — a majority-clean pool must not be
// blacked out because one pool member drew a ban.
let lastLedgerCheckAt = 0;
function refreshLedgerOnce(): void {
  const nowMs = Date.now();
  lastLedgerCheckAt = nowMs;
  try {
    const raw = JSON.parse(readFileSync(BAN_PERSIST_PATH, "utf8")) as { ipBans?: Record<string, number> } | null;
    let unknownMax = 0;
    for (const [key, until] of Object.entries(raw?.ipBans ?? {})) {
      if (typeof until !== "number" || until <= nowMs) continue;
      if (isUnknownScopeKey(key)) {
        if (until > unknownMax) unknownMax = until;
        continue;
      }
      if (until > (state.ipBans.get(key) ?? 0)) state.ipBans.set(key, until);
    }
    // unknown-scope knowledge extends the global silence window (extend-only)
    if (unknownMax > state.banUntil) {
      state.banUntil = unknownMax;
      console.log(`[fapi-gate] v12.6 ledger refresh — UNKNOWN-SCOPE pool ban extends silence until ${new Date(unknownMax).toISOString()}`);
    }
  } catch {
    /* ledger gone/unreadable — keep in-memory state */
  }
}
try {
  const refresh = setInterval(refreshLedgerOnce, 30_000);
  if (typeof refresh.unref === "function") refresh.unref();
} catch {
  /* non-blocking env — skip refresh */
}

export async function gateFetch<T>(path: string, opts?: GateFetchOpts): Promise<T | null> {
  state.stats.attempted++;
  const now = Date.now();

  // v12.1 TASK-49 — LAZY LEDGER GUARD: the instant our global window expires,
  // re-check the shared ledger (throttled to one disk read / 15s) BEFORE any
  // network call — closes the poke-gap where the window died but the refresh
  // interval hadn't fired yet. While the pool is ledger-banned, zero pokes.
  if (now >= state.banUntil && now - lastLedgerCheckAt >= 15_000) refreshLedgerOnce();
  if (now < state.banUntil) state.stats.droppedBan++; // ledger re-armed the window — shed instantly

  // GLOBAL BAN AWARENESS — while a global ban window is live, zero network calls
  // …except the v12.0 ROTATION-AWARE EARLY PROBE: one critical-lane attempt per
  // PROBE_COOLDOWN_MS when the sampled egress IP is clean — the pool rotates,
  // so the window can be LIFTED the moment a clean draw appears instead of
  // waiting out the full 35min cap. A failed probe keeps the window armed.
  if (now < state.banUntil) {
    state.stats.droppedBan++;
    const canProbe = (opts?.priority ?? "telemetry") === "critical" && now - state.lastProbeAt >= PROBE_COOLDOWN_MS;
    if (!canProbe) return null;
    // v12.1 TASK-49 — LEDGER FRESHNESS BEFORE PROBE: state may hold a cosmetic
    // cap while the disk carries a longer REAL end another process discovered.
    // A probe fired on stale state pokes a still-banned pool and re-escalates.
    // Re-read the ledger (15s throttle) and re-arm BEFORE the probe decision.
    if (now - lastLedgerCheckAt >= 15_000) refreshLedgerOnce();
    if (now < state.banUntil) return null; // ledger extended the silence — no probe
    state.lastProbeAt = now;
    const ip = await sampleEgressIp();
    // v12.1 TASK-49: expiry-aware check — a recorded ban whose real end passed
    // no longer blocks the probe (the old .has() kept ghost entries armed).
    if (!ip || isIpBanned(ip, now)) return null; // sampled draw is banned/unknown — stay silent
    state.stats.probesIssued++;
    const probeResult = await executeGated<T>(path, { ...opts, singleProbe: true });
    if (probeResult !== null) {
      state.banUntil = 0; // clean draw proved the pool rotated — lift instantly
      state.allBanStreak = 0;
      state.stats.probeLifts++;
      console.log(`[fapi-gate] v12.0 ban window LIFTED early — egress rotated to clean IP ${ip}`);
    }
    return probeResult;
  }

  // SINGLE-FLIGHT per (host,path): share the request while it is in flight and
  // for a 2s result window — concurrent module askers pay the weight once.
  const key = `${opts?.host ?? FAPI_HOST}${path}`;
  const existing = state.inflight.get(key);
  if (existing) {
    const age = now - existing.startedAt;
    if (!existing.settled || age < SF_RESULT_MS) {
      state.stats.singleFlightShared++;
      return existing.promise as Promise<T | null>;
    }
    state.inflight.delete(key);
  }
  if (state.inflight.size >= SF_MAP_CAP) pruneInflight(now);

  const promise = executeGated<T>(path, opts);
  const entry = { startedAt: now, settled: false, promise };
  state.inflight.set(key, entry);
  void promise
    .catch(() => null) // executeGated never rejects — belt & suspenders
    .finally(() => {
      entry.settled = true;
    });
  return promise;
}
