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
//   · GLOBAL BAN AWARENESS — HTTP 418/429 body "banned until <ms>" arms a
//     module-level banUntil (capped at now+35min for safety; unparseable
//     bodies arm a conservative 10min). While a ban is live, gateFetch
//     returns null INSTANTLY — zero network calls, so a live ban can never
//     be extended by our own retries.
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

const FAPI_HOST = "https://fapi.binance.com";
const DEFAULT_TIMEOUT_MS = 6500;
const WINDOW_MS = 60_000;
const DEFAULT_BUDGET = 1100; // real fapi limit 2400/min per IP — headroom by design
const BAN_CAP_MS = 35 * 60_000; // never block longer than 35min even if Binance claims hours
const BAN_DEFAULT_MS = 10 * 60_000; // unparseable 418/429 body → conservative default
const CRITICAL_RETRY_MS = 250; // the "small negative retry" for the critical lane
const SF_RESULT_MS = 2_000; // single-flight result sharing window
const SF_MAP_CAP = 512;
const SPEND_CAP = 4096; // defensive cap on window entries (~worst-case small-weight bursts)

export type FapiGatePriority = "critical" | "telemetry";

export interface GateFetchOpts {
  weight?: number; // explicit weight; default resolved from the path
  priority?: FapiGatePriority; // default "telemetry"
  timeoutMs?: number; // default 6500
  host?: string; // default fapi.binance.com (alt: fapi1 — same IP, same budget)
}

export interface FapiGateStats {
  attempted: number; // every gateFetch call
  allowed: number; // actual HTTP requests issued that returned 2xx JSON
  droppedBudget: number; // shed by the weight bucket (telemetry drop / critical post-retry)
  droppedBan: number; // shed instantly because an IP ban window is live
  lastBanUntil: number; // epoch ms of the last armed ban end (0 = never)
  budgetPer60s: number;
  usedLast60s: number;
  singleFlightShared: number; // calls served by an in-flight/2s-window shared request
  banRemainingMs: number;
}

interface GateState {
  budgetPer60s: number;
  banUntil: number;
  spend: Array<{ at: number; w: number }>; // weight spends inside the rolling window (time-ordered)
  windowSum: number;
  inflight: Map<string, { startedAt: number; settled: boolean; promise: Promise<unknown> }>;
  stats: {
    attempted: number;
    allowed: number;
    droppedBudget: number;
    droppedBan: number;
    lastBanUntil: number;
    singleFlightShared: number;
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
    stats: { attempted: 0, allowed: 0, droppedBudget: 0, droppedBan: 0, lastBanUntil: 0, singleFlightShared: 0 },
  });

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

/** Try to reserve `weight` from the rolling window. True = spend recorded. */
function tryTake(weight: number): boolean {
  const now = Date.now();
  pruneWindow(now);
  if (state.windowSum + weight > state.budgetPer60s) return false;
  state.spend.push({ at: now, w: weight });
  state.windowSum += weight;
  return true;
}

function noteBan(status: number, body: string): void {
  const now = Date.now();
  const m = /banned until (\d+)/i.exec(body);
  const until = m
    ? Math.min(Number(m[1]), now + BAN_CAP_MS)
    : now + BAN_DEFAULT_MS;
  if (until > state.banUntil) {
    state.banUntil = until;
    state.stats.lastBanUntil = until;
  }
  // silence unused-param lint when status someday needs differentiated handling
  void status;
}

function pruneInflight(now: number): void {
  for (const [k, e] of state.inflight) {
    if (e.settled && now - e.startedAt >= SF_RESULT_MS) state.inflight.delete(k);
  }
}

/**
 * THE gate. Every fapi.binance.com REST call in this process goes through here.
 * Resolves parsed JSON, or null on: live IP ban, weight-budget shed, HTTP
 * failure, timeout, or parse error. Never throws, never queues.
 */
async function executeGated<T>(path: string, opts?: GateFetchOpts): Promise<T | null> {
  const lane: FapiGatePriority = opts?.priority ?? "telemetry";
  const weight = Math.max(1, Math.round(opts?.weight ?? resolveWeight(path)));
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!tryTake(weight)) {
    if (lane !== "critical") {
      state.stats.droppedBudget++;
      return null; // telemetry: drop instead of queueing a storm
    }
    await new Promise<void>((r) => setTimeout(r, CRITICAL_RETRY_MS)); // one small negative retry
    if (!tryTake(weight)) {
      state.stats.droppedBudget++;
      return null;
    }
  }

  const host = opts?.host ?? FAPI_HOST;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}${path}`, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) {
      if (res.status === 418 || res.status === 429) {
        noteBan(res.status, await res.text().catch(() => ""));
      }
      return null;
    }
    const text = await res.text();
    if (!text) return null; // empty 200 — nothing to invent
    state.stats.allowed++;
    return JSON.parse(text) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function gateFetch<T>(path: string, opts?: GateFetchOpts): Promise<T | null> {
  state.stats.attempted++;
  const now = Date.now();

  // GLOBAL BAN AWARENESS — while a ban window is live, zero network calls.
  if (now < state.banUntil) {
    state.stats.droppedBan++;
    return null;
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
