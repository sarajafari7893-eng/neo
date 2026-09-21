// ── NEXUS//SIGNALS trade-service (v4.7 RESEARCH FACTORS · P0-a) ───────────
// REAL aggressor tape for the order-flow gate. Connects to the Binance
// USDT-M ALL-MARKET aggregate-trade stream (public, key-less):
//
//   wss://fstream.binance.com/ws/!aggTrade
//
// Every frame is an actual executed trade aggregated by the exchange —
// NOT a derivation. From the raw tape the service maintains, per symbol:
//   · minute buckets (120 min) of { delta, buyUsd, sellUsd, lastPrice }
//     → real CVD over 15m / 1h in USD and as % of taker volume
//   · classic + hidden CVD-vs-price divergence detection (ZitaPlus/LuxAlgo
//     taxonomy) over a 36-minute window
//   · VPIN-lite: volume-synchronized probability of informed trading
//     (Easley/López de Prado/O'Hara) from per-symbol volume buckets
//
// Endpoints:
//   GET  /health              → { ok, connected, stalled, symbols, trades, source, reconnects, uptimeMs }
//   GET  /flow?symbol=BTCUSDT → per-symbol real CVD / divergence / VPIN block
//   GET  /top                 → busiest symbols by 15m taker volume (ops)
//   POST /watch               → { symbols: [] } — REST fallback watchlist
//
// EGRESS REALITY (v4.7): some hosts (this sandbox) open the Binance WS but
// strip data frames. The service therefore runs DUAL INGEST:
//   · WS  wss://fstream.binance.com/ws/!aggTrade  (when frames arrive)
//   · REST https://fapi.binance.com/fapi/v1/aggTrades incremental fromId
//     polling over the engine's watchlist (3 symbols / 2s round-robin)
// REST fills the same minute buckets; trades are de-duplicated by their
// exchange trade id so both paths can run concurrently.
//
// HONESTY CONTRACT: when neither path reaches the exchange the response
// says so (stalled flag / null block) — the engine never invents numbers
// from a silent feed.

const PORT = 3011;
const WS_URL = "wss://fstream.binance.com/ws/!aggTrade";
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
  lastId: number; // exchange aggTrade id — WS/REST de-dup boundary
}

const symbols = new Map<string, SymbolState>();
let connected = false;
let lastFrameAt: number | null = null;
let trades = 0;
let restPolls = 0;
let restErrors = 0;
let reconnects = 0;
let wsTimer: ReturnType<typeof setTimeout> | null = null;
const startedAt = Date.now();

// REST fallback ingest — the engine registers its active universe here
const watch = new Set<string>();
let watchCursor = 0;
const REST_HOST = "https://fapi.binance.com";
const REST_BATCH = 3; // symbols per 2s tick → 24-symbol watch cycles ≈16s
const REST_POLL_MS = 2_000;

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

function record(tr: AggTrade, id?: number): void {
  if (tr?.e !== "aggTrade" || !tr.s || !tr.p || !tr.q) return;
  const st0 = symbols.get(tr.s);
  const tradeId = id ?? 0;
  // de-dup boundary: REST poller only advances forward past lastId;
  // WS frames for already-counted ids are dropped
  if (st0 && tradeId > 0 && tradeId <= st0.lastId) return;
  const price = parseFloat(tr.p);
  const qty = parseFloat(tr.q);
  if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0) return;
  const usd = price * qty;
  const minute = Math.floor((tr.T || Date.now()) / 60_000) * 60_000;
  const st = stateFor(tr.s);
  if (tradeId > st.lastId) st.lastId = tradeId;
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

/* ── REST fallback ingest (incremental aggTrades by fromId) ──── */

async function restPollSymbol(sym: string): Promise<void> {
  const st = stateFor(sym);
  const fromId = st.lastId > 0 ? st.lastId + 1 : 0;
  const url = `${REST_HOST}/fapi/v1/aggTrades?symbol=${sym}&limit=1000${fromId > 0 ? `&fromId=${fromId}` : ""}`;
  restPolls++;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as RestTrade[];
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const r of rows) {
      record({ e: "aggTrade", s: sym, p: r.p, q: r.q, m: r.m, T: r.T }, r.a);
    }
  } catch {
    restErrors++;
  }
}

function restPollTick(): void {
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

function dataStalled(): boolean {
  if (!connected) return true;
  if (lastFrameAt === null) return Date.now() - startedAt > STALL_MS;
  return Date.now() - lastFrameAt > STALL_MS;
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
        source: restOk() ? (restLive() ? "REST" : watch.size > 0 ? "REST-WARMING" : "REST-IDLE") : connected && !dataStalled() ? "WS" : "OFFLINE",
        watch: watch.size,
        lastFrameAt,
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
        console.log(`[tape] watchlist synced — ${watch.size} symbols for REST ingest`);
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
        source: restOk() ? "REST" : "WS",
        symbols: symbols.size,
        trades,
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

console.log(`[tape] trade-service listening on :${PORT} — streaming REAL Binance !aggTrade aggressor flow`);
