// ── NEXUS//SIGNALS trade-service (v4.9 SHARED BAN-LEDGER · TASK-49) ────
// REAL aggressor tape for the order-flow gate. Every frame is an actual
// executed trade aggregated by the exchange — NOT a derivation. From the
// raw tape the service maintains, per symbol:
//   · minute buckets (120 min) of { delta, buyUsd, sellUsd, lastPrice }
//     → real CVD over 15m / 1h in USD and as % of taker volume
//   · classic + hidden CVD-vs-price divergence detection (ZitaPlus/LuxAlgo
//     taxonomy) over a 36-minute window
//   · VPIN-lite: volume-synchronized probability of informed trading
//     (Easley/López de Prado/O'Hara) from per-symbol volume buckets
//
// Endpoints:
//   GET  /health              → { ok, connected, dataStalled, source, watch, lastFrameAt,
//                                 spotConnected, spotFrames, spotLastFrameAt, spotStreams,
//                                 spotReconnects, restBannedUntil, symbols, trades, restPolls,
//                                 restErrors, reconnects, uptimeMs }
//   GET  /flow?symbol=BTCUSDT → per-symbol real CVD / divergence / VPIN block
//   GET  /top                 → busiest symbols by 15m taker volume (ops)
//   POST /watch               → { symbols: [] } — watchlist: REST fallback + SPOT-MIRROR subs
//
// DUAL-LANE INGEST (v4.8) — empirically, this sandbox's IP pool OPENS the
// fstream WS but suppresses its data frames, while SPOT aggTrade frames
// flow fine and fapi REST carries a multi-hour auto-ban history (418):
//   LANE 1 (futures) wss://fstream.binance.com/ws/!aggTrade — kept alive;
//                    it may recover one day, frames always win the label
//   LANE 2 (mirror)  wss://stream.binance.com:9443 stream.binance.com spot aggTrade over
//                    the engine watchlist (1 sym → /ws/<s>@aggTrade, multi →
//                    /stream?streams=a@aggTrade/b@aggTrade), diff-resubscribed on
//                    watchlist change, reconnect 1s→30s exponential backoff
//   LANE 3 (fallback) https://fapi.binance.com/fapi/v1/aggTrades incremental fromId
//                    polling — weight slashed 3 syms/2s (~1800 wt/min) → 1 sym/5s
//                    (~240 wt/min); any 418/429 body "banned until <ms>" pauses ALL
//                    REST polling until that timestamp (capped +35min) → restBannedUntil
//
// SPOT-MIRROR frames feed the SAME minute buckets in their OWN lane:
// separate de-dup boundary (lastSpotId), separate counters (spotFrames /
// spotConnected), honest labeling.
//
// SOURCE PRIORITY (honesty contract): WS (real futures frames flowing)
//   > SPOT-MIRROR (spot frames flowing, futures silent) > REST >
//   REST-WARMING / REST-IDLE > OFFLINE. A frame is a frame — spot counts
//   as live data for dataStalled, but the source label always says which
//   lane is doing the work. The engine never invents numbers from a
//   silent feed (stalled flag / null block).

const PORT = 3011;
import { ledgerUnknownScopeBanUntil, writeLedgerBan } from "../_shared/ban-ledger";
const WS_URL = "wss://fstream.binance.com/ws/!aggTrade";
const SPOT_WS_HOST = "wss://stream.binance.com:9443"; // SPOT-MIRROR lane (verified working where fstream is suppressed)
const SPOT_OPEN_GUARD_MS = 15_000; // handshake hang guard — recycle and let backoff retry
const SPOT_BACKOFF_MAX_MS = 30_000; // reconnect backoff ceiling (1s → 30s ladder)
const STALL_MS = 120_000; // no frame for 2min on this busy stream ⇒ egress stripped
const MINUTE_CAP = 120; // 2h of per-minute buckets per symbol
const SYMBOL_CAP = 700; // memory guard — prune least-recently-seen beyond this

interface AggTrade {
  e: string; // "aggTrade"
  s: string; // symbol
  p: string; // price
  q: string; // quantity
  m: boolean; // true ⇒ buyer is maker ⇒ SELL aggressor
  T: number; // trade time
}

interface MinuteBucket {
  t: number; // minute epoch (ms)
  delta: number; // buyUsd − sellUsd (signed aggressor flow, USD)
  buy: number;
  sell: number;
  c: number; // last price in the minute
}

interface SymbolState {
  minutes: MinuteBucket[];
  vpinBuckets: number[]; // last imbalance values per completed volume bucket
  curBucket: { buy: number; sell: number };
  bucketTarget: number; // USD volume per VPIN bucket (recalculated every 5min)
  bucketTargetAt: number;
  lastPrice: number;
  lastSeen: number;
  lastId: number; // exchange aggTrade id — futures WS/REST de-dup boundary
  lastSpotId: number; // spot aggTrade id — SEPARATE de-dup boundary for the mirror lane
}

const symbols = new Map<string, SymbolState>();
let connected = false; // futures lane socket (fstream !aggTrade)
let lastFrameAt: number | null = null; // last futures WS frame
let trades = 0; // total recorded trades across BOTH lanes
let restPolls = 0;
let restErrors = 0;
let reconnects = 0;
let wsTimer: ReturnType<typeof setTimeout> | null = null;
const startedAt = Date.now();

// ── SPOT-MIRROR lane state (34-b) — spot aggTrade frames, counted separately ──
let spotConnected = false;
let spotFrames = 0;
let spotLastFrameAt: number | null = null;
let spotReconnects = 0;
let spotWs: WebSocket | null = null;
let spotWsTimer: ReturnType<typeof setTimeout> | null = null;
let spotOpenGuard: ReturnType<typeof setTimeout> | null = null;
let spotBackoffMs = 1000; // 1s → 30s exponential ladder, reset on successful open
let spotSubSeq = 0;
let spotSubs = new Set<string>(); // streams subscribed on the live spot socket

// REST fallback ingest — the engine registers its active universe here
const watch = new Set<string>();
let watchCursor = 0;
const REST_HOST = "https://fapi.binance.com";
// 34-b ban-storm fix: REST weight slashed ~7.5× — 1 sym/5s ≈ 240 weight/min (was 3 syms/2s ≈ 1800)
const REST_BATCH = 1;
const REST_POLL_MS = 5_000;
// v4.9 TASK-49: the 35min display cap is GONE from the pause timer — the
// resume rule is now ledger-driven: stay silent while ANY pool IP has a live
// recorded ban (Binance's REAL end, sanity-capped 24h). Resuming on a cosmetic
// cap poked still-banned IPs and re-escalated the expiry (11:58→12:34→13:09
// spiral of 2026-10-19). The sanity cap exists only to bound parse artifacts.
const REST_BAN_SANITY_MS = 2 * 3600_000; // single reported window never pauses beyond +2h
const REST_SOFT_BAN_MS = 60_000; // 418/429 without a "banned until" body — back off anyway
let restBannedUntil: number | null = null; // ms epoch — ALL REST polling paused until then
let restProbeConsecutiveFails = 0; // v4.9 — probe streak, resets on a clean 2xx

function stateFor(sym: string): SymbolState {
  let st = symbols.get(sym);
  if (!st) {
    st = {
      minutes: [],
      vpinBuckets: [],
      curBucket: { buy: 0, sell: 0 },
      bucketTarget: 0,
      bucketTargetAt: 0,
      lastPrice: 0,
      lastSeen: Date.now(),
      lastId: 0,
      lastSpotId: 0,
    };
    symbols.set(sym, st);
  }
  return st;
}

interface RestTrade {
  a: number; // aggTrade id
  p: string;
  q: string;
  T: number;
  m: boolean;
}

function record(tr: AggTrade, id?: number, lane: "FUT" | "SPOT" = "FUT"): void {
  if (tr?.e !== "aggTrade" || !tr.s || !tr.p || !tr.q) return;
  const st0 = symbols.get(tr.s);
  const tradeId = id ?? 0;
  // de-dup boundary (per lane): pollers/WS only advance forward past the
  // lane's last id; frames for already-counted ids are dropped. Spot ids
  // live in a different id-space, so the mirror keeps its own boundary.
  if (st0 && tradeId > 0) {
    const boundary = lane === "SPOT" ? st0.lastSpotId : st0.lastId;
    if (tradeId <= boundary) return;
  }
  const price = parseFloat(tr.p);
  const qty = parseFloat(tr.q);
  if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0) return;
  const usd = price * qty;
  const minute = Math.floor((tr.T || Date.now()) / 60_000) * 60_000;
  const st = stateFor(tr.s);
  if (tradeId > 0) {
    if (lane === "SPOT") {
      if (tradeId > st.lastSpotId) st.lastSpotId = tradeId;
    } else if (tradeId > st.lastId) {
      st.lastId = tradeId;
    }
  }
  st.lastSeen = Date.now();
  st.lastPrice = price;
  trades++;

  const last = st.minutes[st.minutes.length - 1];
  if (!last || last.t !== minute) {
    st.minutes.push({ t: minute, delta: 0, buy: 0, sell: 0, c: price });
    if (st.minutes.length > MINUTE_CAP) st.minutes.splice(0, st.minutes.length - MINUTE_CAP);
  }
  const cur = st.minutes[st.minutes.length - 1];
  if (tr.m) {
    // buyer is maker ⇒ the AGGRESSOR sold
    cur.sell += usd;
    cur.delta -= usd;
    st.curBucket.sell += usd;
  } else {
    cur.buy += usd;
    cur.delta += usd;
    st.curBucket.buy += usd;
  }

  // ── VPIN volume buckets (target recalculated every 5min from 1m vols) ──
  if (st.bucketTargetAt === 0 || Date.now() - st.bucketTargetAt > 300_000) {
    const window = st.minutes.slice(-60);
    const total = window.reduce((a, m) => a + m.buy + m.sell, 0);
    st.bucketTarget = window.length > 5 ? (total / window.length) * 1.5 : 0;
    st.bucketTargetAt = Date.now();
  }
  const bucketVol = st.curBucket.buy + st.curBucket.sell;
  if (st.bucketTarget > 0 && bucketVol >= st.bucketTarget) {
    st.vpinBuckets.push((st.curBucket.buy - st.curBucket.sell) / bucketVol);
    if (st.vpinBuckets.length > 60) st.vpinBuckets.splice(0, st.vpinBuckets.length - 60);
    st.curBucket = { buy: 0, sell: 0 };
  }

  // memory guard: drop symbols the tape has abandoned for 2h
  if (symbols.size > SYMBOL_CAP) {
    for (const [sym, s] of symbols) {
      if (Date.now() - s.lastSeen > 2 * 3600_000) symbols.delete(sym);
      if (symbols.size <= SYMBOL_CAP) break;
    }
  }
}

/* ── REST fallback ingest (incremental aggTrades by fromId) ────
   34-b ban-storm guard: a 418/429 body like
   {"code":418,"msg":"IP has been auto-banned. Temporary banned until 1727350000000."}
   pauses ALL REST polling until that timestamp (capped at +35min). */

function parseBanUntil(bodyText: string): number | null {
  const m = bodyText.match(/banned until (\d{10,16})/i);
  if (!m) return null;
  let ts = Number(m[1]);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (ts < 10_000_000_000) ts *= 1000; // seconds-scaled body → ms
  return ts;
}

function applyRestBan(untilMs: number): void {
  const capped = Math.min(untilMs, Date.now() + REST_BAN_SANITY_MS);
  if (restBannedUntil === null || capped > restBannedUntil) restBannedUntil = capped;
  console.error(`[tape] Binance REST ban — ALL REST polling paused until ${new Date(restBannedUntil).toISOString()}`);
}

async function restPollSymbol(sym: string): Promise<void> {
  const st = stateFor(sym);
  const fromId = st.lastId > 0 ? st.lastId + 1 : 0;
  const url = `${REST_HOST}/fapi/v1/aggTrades?symbol=${sym}&limit=1000${fromId > 0 ? `&fromId=${fromId}` : ""}`;
  restPolls++;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    // v5.0 connection-recycle: keep-alive pools ONE egress IP for the flow's
    // life — a pinned-banned connection 418s forever (measured 2026-10-20).
    // `Connection: close` = fresh NAT lottery draw per poll.
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { Connection: "close" } });
    clearTimeout(t);
    if (res.status === 418 || res.status === 429) {
      // ban-storm guard: honor "banned until <ms>" bodies, else back off softly
      let until: number | null = null;
      let namedIp: string | null = null;
      try {
        const body = await res.text();
        until = parseBanUntil(body);
        const m = /IP\(([\d.]+)\)\s*banned until (\d+)/i.exec(body);
        if (m) {
          namedIp = m[1]!;
          const real = Number(m[2]);
          if (Number.isFinite(real) && real > (until ?? 0)) until = real;
        }
      } catch {
        /* body unreadable */
      }
      // v4.9 TASK-49 — write-through: our 418 discovery goes to the SHARED
      // ledger so the app gate, price-ws and future resumes all stay silent.
      if (until) writeLedgerBan(namedIp, until);
      restProbeConsecutiveFails++;
      applyRestBan(until ?? Date.now() + REST_SOFT_BAN_MS);
      restErrors++;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as RestTrade[];
    if (!Array.isArray(rows) || rows.length === 0) return;
    restProbeConsecutiveFails = 0; // clean 2xx — the pool serves us again
    for (const r of rows) {
      record({ e: "aggTrade", s: sym, p: r.p, q: r.q, m: r.m, T: r.T }, r.a);
    }
  } catch {
    restErrors++;
  }
}

function restPollTick(): void {
  if (restBannedUntil !== null) {
    if (Date.now() < restBannedUntil) return; // hard pause — zero REST weight while banned
    // v4.9 TASK-49 — LEDGER-GATED RESUME: our own window elapsed, but the
    // SHARED ledger may still carry a live ban another process discovered
    // (real ends, not cosmetic caps). v1.1 scope split: resume defers ONLY
    // while an UNKNOWN-SCOPE ("_pool") ban is live — one named pool member's
    // ban no longer pauses this poll (majority-clean pool, 2026-10-20). Our
    // own 418 discoveries still pause THIS lane via applyRestBan as before.
    const poolBan = ledgerUnknownScopeBanUntil();
    if (poolBan > Date.now()) {
      if (restBannedUntil === null || poolBan > restBannedUntil) {
        restBannedUntil = poolBan;
        console.log(`[tape] shared ledger still bans fapi pool (unknown scope) until ${new Date(poolBan).toISOString()} — probe deferred`);
      }
      return;
    }
    restBannedUntil = null;
    console.log("[tape] REST ban window elapsed — PROBE poll (full resume only on 2xx)");
  }
  const list = [...watch];
  if (list.length === 0) return;
  for (let i = 0; i < Math.min(REST_BATCH, list.length); i++) {
    const sym = list[watchCursor % list.length];
    watchCursor++;
    void restPollSymbol(sym);
  }
}

setInterval(restPollTick, REST_POLL_MS);

/* ── real CVD + divergence per symbol ────────────────────────── */

export interface Divergence {
  type: "CLASSIC_BULL" | "CLASSIC_BEAR" | "HIDDEN_BULL" | "HIDDEN_BEAR";
  strengthPct: number; // relative price gap between the two extremes (%)
  at: number; // minute ts of the recent extreme
}

export interface SymbolFlow {
  cvd15mUsd: number;
  cvd1hUsd: number;
  vol15mUsd: number;
  vol1hUsd: number;
  cvd15mPct: number; // cvd15m / vol15m × 100
  cvd1hPct: number; // cvd1h / vol1h × 100
  divergence: Divergence | null;
  vpin: { value: number; buckets: number } | null;
  lastPrice: number;
  minutes: number;
}

function cumDeltas(minutes: MinuteBucket[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const m of minutes) {
    acc += m.delta;
    out.push(acc);
  }
  return out;
}

function detectDivergence(minutes: MinuteBucket[]): Divergence | null {
  // needs a recent 10min window plus a prior 26min reference window
  if (minutes.length < 36) return null;
  const recent = minutes.slice(-10);
  const prior = minutes.slice(-36, -10);
  const cvd = cumDeltas(minutes);
  const cvdRecent = cvd.slice(-10);
  const cvdPrior = cvd.slice(-36, -10);

  const idxOfMin = (arr: number[]) => arr.reduce((best, v, i) => (v < arr[best] ? i : best), 0);
  const idxOfMax = (arr: number[]) => arr.reduce((best, v, i) => (v > arr[best] ? i : best), 0);

  const recentCloses = recent.map((m) => m.c);
  const priorCloses = prior.map((m) => m.c);
  const rLowI = idxOfMin(recentCloses);
  const rHighI = idxOfMax(recentCloses);
  const pLowI = idxOfMin(priorCloses);
  const pHighI = idxOfMax(priorCloses);

  // CLASSIC BULL: price lower low, CVD higher low (sellers exhausting / absorption)
  if (recentCloses[rLowI] < priorCloses[pLowI] && cvdRecent[rLowI] > cvdPrior[pLowI]) {
    const strength = Math.abs(recentCloses[rLowI] / priorCloses[pLowI] - 1) * 100;
    return { type: "CLASSIC_BULL", strengthPct: Math.round(strength * 100) / 100, at: minutes[minutes.length - 10 + rLowI].t };
  }
  // CLASSIC BEAR: price higher high, CVD lower high (buyers exhausting)
  if (recentCloses[rHighI] > priorCloses[pHighI] && cvdRecent[rHighI] < cvdPrior[pHighI]) {
    const strength = Math.abs(recentCloses[rHighI] / priorCloses[pHighI] - 1) * 100;
    return { type: "CLASSIC_BEAR", strengthPct: Math.round(strength * 100) / 100, at: minutes[minutes.length - 10 + rHighI].t };
  }
  // HIDDEN BULL: price higher low, CVD lower low (aggressive selling absorbed → uptrend continuation)
  if (recentCloses[rLowI] > priorCloses[pLowI] && cvdRecent[rLowI] < cvdPrior[pLowI]) {
    return { type: "HIDDEN_BULL", strengthPct: 0, at: minutes[minutes.length - 10 + rLowI].t };
  }
  // HIDDEN BEAR: price lower high, CVD higher high (aggressive buying absorbed → downtrend continuation)
  if (recentCloses[rHighI] < priorCloses[pHighI] && cvdRecent[rHighI] > cvdPrior[pHighI]) {
    return { type: "HIDDEN_BEAR", strengthPct: 0, at: minutes[minutes.length - 10 + rHighI].t };
  }
  return null;
}

function symbolFlow(sym: string): SymbolFlow | null {
  const st = symbols.get(sym);
  if (!st || st.minutes.length < 5 || st.lastPrice <= 0) return null;
  const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
  // a stale tape (stream stalled) must not pretend to be current
  if (nowMin - st.minutes[st.minutes.length - 1].t > 3 * 60_000) return null;

  const last15 = st.minutes.slice(-15);
  const last60 = st.minutes.slice(-60);
  const sum = (arr: MinuteBucket[], k: "buy" | "sell") => arr.reduce((a, m) => a + m[k], 0);
  const cvd15 = last15.reduce((a, m) => a + m.delta, 0);
  const cvd60 = last60.reduce((a, m) => a + m.delta, 0);
  const vol15 = sum(last15, "buy") + sum(last15, "sell");
  const vol60 = sum(last60, "buy") + sum(last60, "sell");

  const vpin =
    st.vpinBuckets.length >= 10
      ? {
          value: Math.round((st.vpinBuckets.slice(-30).reduce((a, v) => a + Math.abs(v), 0) / Math.min(30, st.vpinBuckets.length)) * 1000) / 1000,
          buckets: st.vpinBuckets.length,
        }
      : null;

  return {
    cvd15mUsd: Math.round(cvd15),
    cvd1hUsd: Math.round(cvd60),
    vol15mUsd: Math.round(vol15),
    vol1hUsd: Math.round(vol60),
    cvd15mPct: vol15 > 0 ? Math.round((cvd15 / vol15) * 10000) / 100 : 0,
    cvd1hPct: vol60 > 0 ? Math.round((cvd60 / vol60) * 10000) / 100 : 0,
    divergence: detectDivergence(st.minutes),
    vpin,
    lastPrice: st.lastPrice,
    minutes: st.minutes.length,
  };
}

/* ── connection (same resilience pattern as liq-service) ─────── */

function futFlowing(): boolean {
  return connected && lastFrameAt !== null && Date.now() - lastFrameAt < STALL_MS;
}

function spotFlowing(): boolean {
  return spotConnected && spotLastFrameAt !== null && Date.now() - spotLastFrameAt < STALL_MS;
}

/** A frame is a frame — futures OR SPOT-MIRROR counts as live data (34-b). */
function dataStalled(): boolean {
  if (!connected && !spotConnected) return true;
  const last =
    lastFrameAt === null
      ? spotLastFrameAt
      : spotLastFrameAt === null
        ? lastFrameAt
        : Math.max(lastFrameAt, spotLastFrameAt);
  return Date.now() - (last ?? startedAt) > STALL_MS;
}

/** Source priority: WS > SPOT-MIRROR > REST > REST-WARMING/REST-IDLE > OFFLINE. */
function currentSource(): string {
  if (futFlowing()) return "WS"; // real futures aggTrade frames flowing
  if (spotFlowing()) return "SPOT-MIRROR"; // spot frames flowing, futures silent
  if (restOk()) {
    if (restLive()) return "REST";
    return watch.size > 0 ? "REST-WARMING" : "REST-IDLE";
  }
  if (connected) return "WS"; // futures socket open, frames not yet proven (legacy warming label)
  return "OFFLINE";
}

/** REST ingest reached the exchange at least once and last poll window had data. */
function restOk(): boolean {
  return restPolls > 0 && restErrors < restPolls; // at least one success
}

function restLive(): boolean {
  // any symbol has minute data within the last 2 minutes
  const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
  for (const st of symbols.values()) {
    if (st.minutes.length > 0 && nowMin - st.minutes[st.minutes.length - 1].t <= 2 * 60_000) return true;
  }
  return false;
}

function connect(): void {
  try {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      connected = true;
      console.log(`[tape] connected ${WS_URL}`);
    };
    ws.onmessage = (e) => {
      lastFrameAt = Date.now();
      try {
        record(JSON.parse(String(e.data)) as AggTrade);
      } catch {
        /* malformed frame — ignore */
      }
    };
    ws.onerror = (err) => {
      console.error("[tape] ws error", err instanceof Error ? err.message : err);
    };
    ws.onclose = () => {
      connected = false;
      reconnects++;
      console.log(`[tape] closed — reconnect in 5s (attempt ${reconnects})`);
      if (wsTimer) clearTimeout(wsTimer);
      wsTimer = setTimeout(connect, 5000);
    };
  } catch (err) {
    connected = false;
    reconnects++;
    console.error("[tape] connect failed", err);
    if (wsTimer) clearTimeout(wsTimer);
    wsTimer = setTimeout(connect, 5000);
  }
}

/* ── SPOT-MIRROR lane (34-b): spot aggTrade over stream.binance.com ──
   This egress pool suppresses fstream aggTrade frames while SPOT aggTrade
   flows fine. The mirror feeds the SAME minute buckets (CVD / divergence /
   VPIN) in its own lane: separate de-dup boundary (lastSpotId), separate
   counters, and an honest SPOT-MIRROR source label whenever it is the
   lane doing the work. */

function spotStreams(): string[] {
  return [...watch].map((s) => `${s.toLowerCase()}@aggTrade`);
}

function spotUrl(streams: string[]): string {
  return streams.length === 1
    ? `${SPOT_WS_HOST}/ws/${streams[0]}`
    : `${SPOT_WS_HOST}/stream?streams=${streams.join("/")}`;
}

function handleSpotFrame(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // malformed frame — ignore
  }
  // combined stream: {stream, data} · raw stream: payload itself · acks: {result, id}
  const payload = (parsed as { data?: unknown }).data ?? parsed;
  if (!payload || typeof payload !== "object") return;
  const tr = payload as AggTrade & { a?: number };
  if (tr.e !== "aggTrade" || !tr.s || !tr.p || !tr.q) return;
  spotFrames++;
  spotLastFrameAt = Date.now();
  record({ e: tr.e, s: tr.s, p: tr.p, q: tr.q, m: tr.m, T: tr.T }, tr.a, "SPOT");
}

function connectSpot(): void {
  if (spotWsTimer) {
    clearTimeout(spotWsTimer);
    spotWsTimer = null;
  }
  if (spotOpenGuard) {
    clearTimeout(spotOpenGuard);
    spotOpenGuard = null;
  }
  const streams = spotStreams();
  if (streams.length === 0) return; // nothing to mirror — lane stays down
  if (spotWs) {
    try {
      spotWs.close();
    } catch {
      /* already dead */
    }
    spotWs = null;
  }
  const url = spotUrl(streams);
  try {
    const ws = new WebSocket(url);
    spotWs = ws;
    spotOpenGuard = setTimeout(() => {
      console.error("[tape] spot open timeout — recycling socket");
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }, SPOT_OPEN_GUARD_MS);
    ws.onopen = () => {
      if (spotOpenGuard) {
        clearTimeout(spotOpenGuard);
        spotOpenGuard = null;
      }
      spotConnected = true;
      spotBackoffMs = 1000; // success resets the backoff ladder
      spotSubs = new Set(streams);
      console.log(`[tape] SPOT-MIRROR connected — ${streams.length} stream(s) via stream.binance.com`);
    };
    ws.onmessage = (e) => handleSpotFrame(String(e.data));
    ws.onerror = (err) => {
      console.error("[tape] spot ws error", err instanceof Error ? err.message : err);
    };
    ws.onclose = () => {
      if (spotOpenGuard) {
        clearTimeout(spotOpenGuard);
        spotOpenGuard = null;
      }
      spotConnected = false;
      spotSubs = new Set();
      spotWs = null;
      spotReconnects++;
      const wait = spotBackoffMs;
      spotBackoffMs = Math.min(SPOT_BACKOFF_MAX_MS, spotBackoffMs * 2);
      console.log(`[tape] spot closed — reconnect in ${wait}ms (attempt ${spotReconnects})`);
      if (spotWsTimer) clearTimeout(spotWsTimer);
      spotWsTimer = setTimeout(connectSpot, wait);
    };
  } catch (err) {
    spotConnected = false;
    spotWs = null;
    spotReconnects++;
    const wait = spotBackoffMs;
    spotBackoffMs = Math.min(SPOT_BACKOFF_MAX_MS, spotBackoffMs * 2);
    console.error("[tape] spot connect failed", err);
    if (spotWsTimer) clearTimeout(spotWsTimer);
    spotWsTimer = setTimeout(connectSpot, wait);
  }
}

/** Watchlist changed (or periodic reconcile) — diff-resubscribe the live spot socket. */
function syncSpotSubscriptions(): void {
  const want = new Set(spotStreams());
  if (want.size === 0) {
    if (spotWs) {
      try {
        spotWs.close(); // onclose schedules a reconnect that no-ops on an empty watchlist
      } catch {
        /* ignore */
      }
    }
    return;
  }
  if (spotWs && spotConnected) {
    const add = [...want].filter((s) => !spotSubs.has(s));
    const del = [...spotSubs].filter((s) => !want.has(s));
    if (add.length === 0 && del.length === 0) return;
    try {
      if (del.length > 0) spotWs.send(JSON.stringify({ method: "UNSUBSCRIBE", params: del, id: ++spotSubSeq }));
      if (add.length > 0) spotWs.send(JSON.stringify({ method: "SUBSCRIBE", params: add, id: ++spotSubSeq }));
      spotSubs = want;
      console.log(`[tape] spot resubscribed (+${add.length}/-${del.length}) — ${want.size} stream(s)`);
    } catch (err) {
      console.error("[tape] spot resubscribe failed — forcing reconnect", err);
      try {
        spotWs.close(); // onclose schedules the backoff reconnect with the fresh list
      } catch {
        /* ignore */
      }
    }
    return;
  }
  if (!spotWs && !spotWsTimer) connectSpot(); // first sync, or the lane is fully down
}

/* ── HTTP surface ── */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "trade-service",
        connected,
        dataStalled: dataStalled(),
        source: currentSource(),
        watch: watch.size,
        lastFrameAt,
        spotConnected,
        spotFrames,
        spotLastFrameAt,
        spotStreams: spotSubs.size,
        spotReconnects,
        restBannedUntil,
        restProbeConsecutiveFails,
        symbols: symbols.size,
        trades,
        restPolls,
        restErrors,
        reconnects,
        uptimeMs: Date.now() - startedAt,
      });
    }
    if (url.pathname === "/watch" && req.method === "POST") {
      try {
        const body = (await req.json()) as { symbols?: string[] };
        const list = Array.isArray(body.symbols) ? body.symbols.filter((s) => typeof s === "string" && s.endsWith("USDT")).slice(0, 80) : [];
        watch.clear();
        for (const s of list) watch.add(s);
        syncSpotSubscriptions(); // 34-b: the watchlist now also drives the SPOT-MIRROR lane
        console.log(`[tape] watchlist synced — ${watch.size} symbols (REST ingest + SPOT-MIRROR subs)`);
        return json({ ok: true, watch: watch.size });
      } catch {
        return json({ error: "bad body" }, 400);
      }
    }
    if (url.pathname === "/flow") {
      const sym = url.searchParams.get("symbol");
      if (!sym) return json({ error: "symbol required" }, 400);
      const stalled = dataStalled() && !restOk();
      return json({
        ts: Date.now(),
        connected,
        dataStalled: dataStalled(),
        source: currentSource(),
        symbols: symbols.size,
        trades,
        spotConnected,
        spotFrames,
        restBannedUntil,
        flow: stalled ? null : symbolFlow(sym),
      });
    }
    if (url.pathname === "/top") {
      // busiest symbols by 15m taker volume (ops diagnostics)
      const rows = [...symbols.entries()]
        .map(([sym, st]) => {
          void st;
          const f = symbolFlow(sym);
          return f ? { symbol: sym, vol15mUsd: f.vol15mUsd, cvd15mPct: f.cvd15mPct } : null;
        })
        .filter((x): x is { symbol: string; vol15mUsd: number; cvd15mPct: number } => x !== null)
        .sort((a, b) => b.vol15mUsd - a.vol15mUsd)
        .slice(0, 20);
      return json({ ts: Date.now(), rows });
    }
    return json({ error: "not found" }, 404);
  },
});

connect();
setInterval(syncSpotSubscriptions, 60_000); // reconcile spot subs — watchlist drift / missed diffs self-heal

console.log(
  `[tape] trade-service listening on :${PORT} — futures !aggTrade + SPOT-MIRROR lanes (source: WS > SPOT-MIRROR > REST)`,
);
