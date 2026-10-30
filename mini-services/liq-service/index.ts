// ── NEXUS liq-service (:3010) v3.1 — REAL forced-liquidation aggregation, BINANCE + BYBIT mirror ──
// v3.1 (operator mandate trace 1a18eba43d494571 — «liq feed بدون دیتا است؛ آیا
// می‌شود از دیتای TOOBIT استفاده کرد؟»): measured verdict on this egress —
//   ① Binance forceOrder frames (ALL lanes: !forceOrder@arr AND per-symbol
//      ring) are egress-muted since ~10-28: sockets open, subscribe ACK
//      arrives, ZERO data frames (probe 2026-10-30: 45s × arr+btcusdt = 0
//      frames while bookTicker/aggTrade flow). The 54-socket ring ran 3.6h
//      with events=0 — statistically impossible on a healthy fstream pipe.
//   ② TOOBIT has NO liquidation channel AT ALL (proof 2026-10-30: official
//      format {event:"sub",topic,symbol,params} verified live on
//      /quote/ws/v1 — trade streams flow, topic liquidation/forceOrder both
//      "Invalid topic"; JKorf/Toobit.Net full official client implements
//      trade/kline/ticker/orderbook only; REST demo has no market liq
//      endpoint). Own-account forceOrders is private + useless market-wide.
//   ③ BYBIT v5 allLiquidation WORKS from this egress (probe: 1273 frames/45s
//      on BTCUSDT alone). Lane-③ = batched allLiquidation topics over the
//      same 54-symbol list, venue-tagged "bybit" — transparent, never mixed
//      into Binance counters, side semantics identical (Sell = long wrecked).
// The v3.0 Binance lanes stay armed: if egress unmutes them, their counters
// simply start moving again (they are the mandate trace 1a185042c872b4f9
// original feed — semantics untouched).
// v3.0 (operator mandate trace 1a185042c872b4f9 — «ردپای OKX/Bybit در کجا وجود
// دارد و با بایننس جایگزین شود»): the v2 4-venue aggregation is rebuilt
// Binance-ONLY. Two Binance lanes, one venue, zero invented data:
//   ① market-wide !forceOrder@arr (original feed, semantics untouched)
//   ② PER-SYMBOL <sym>@forceOrder ring over a curated ~54 top-perp list —
//      the v14.0 engineering answer to the measured egress pathology
//      (2026-09-27: !forceOrder@arr silent 2h+ while host delivers frames;
//      2026-10-28: market-wide streams MUTED from this egress while per-symbol
//      streams sustain — the v13.5 futures bookTicker ring proves it). Every
//      ring socket is raw per-symbol (the format that WORKS here), feeds the
//      same venue state, and reconnects with its own backoff.
// Public JSON contract (consumed by src/lib/liquidations.ts — fields intact):
//   GET /liquidations → { status:{connected,dataStalled,buffered,lastEventAt,uptimeSec,venues}, recent:[…], bySymbol:{…} }
//   GET /health       → all original fields + venues
// SIDE CONVENTION — mirrors the original Binance handler EXACTLY (ground truth, do not flip):
//   side "SELL" = forced SELL order ⇒ a LONG position was wrecked  → longsUsd10m
//   side "BUY"  = forced BUY  order ⇒ a SHORT position was wrecked → shortsUsd10m

const PORT = 3010;
const RING_CAP = 5000;
const STALL_MS = 2 * 60_000;
const WARMUP_MS = 2 * 60_000; // grace after boot before "never any event" counts as stalled

const BINANCE_ARR_WS = "wss://fstream.binance.com/ws/!forceOrder@arr";
const HEARTBEAT_URL = "wss://fstream.binance.com/ws/btcusdt@aggTrade"; // busy stream: proves frames CAN reach this host

// Curated USDT perps for the per-symbol forceOrder ring (~54 top-by-volume,
// plain base-coin units only — 1000X symbols excluded so p×v stays true USD
// notional; the !forceOrder@arr lane already covers the whole market when it
// flows, the ring guarantees the majors during market-stream muting).
const FORCE_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "BNBUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TONUSDT",
  "TRXUSDT", "DOTUSDT", "LTCUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "SUIUSDT", "FILUSDT", "INJUSDT",
  "ATOMUSDT", "POLUSDT", "SEIUSDT", "WIFUSDT", "BOMEUSDT", "JUPUSDT", "PYTHUSDT", "RENDERUSDT", "FETUSDT", "WLDUSDT",
  "TIAUSDT", "ORDIUSDT", "LDOUSDT", "CRVUSDT", "AAVEUSDT", "UNIUSDT", "ETCUSDT", "BCHUSDT", "XLMUSDT", "HBARUSDT",
  "ICPUSDT", "STXUSDT", "IMXUSDT", "GALAUSDT", "SANDUSDT", "MANAUSDT", "AXSUSDT", "CHZUSDT", "ALGOUSDT", "TAOUSDT",
  "ENAUSDT", "ETHFIUSDT", "ONDOUSDT", "NOTUSDT",
];

interface LiqEvent {
  symbol: string;
  side: "BUY" | "SELL"; // forced side: SELL = long wrecked, BUY = short wrecked (original Binance semantics, preserved)
  price: number;
  qty: number;
  usd: number;
  at: number;
  venue: string; // additive origin tag — client-side LiqEvent fields remain intact
}

type VenueName = "binance" | "bybit" | "okx";
interface VenueState {
  connected: boolean;
  degraded: boolean;
  lastEventAt: number | null;
  events: number;
  reconnects: number;
  note: string;
  ws: WebSocket | null;
  backoffMs: number;
  pingTimer: ReturnType<typeof setInterval> | null;
}

const VENUE_NAMES: VenueName[] = ["binance", "bybit", "okx"];
function mkVenueState(): VenueState {
  return { connected: false, degraded: false, lastEventAt: null, events: 0, reconnects: 0, note: "", ws: null, backoffMs: 0, pingTimer: null };
}
const venues: Record<VenueName, VenueState> = { binance: mkVenueState(), bybit: mkVenueState(), okx: mkVenueState() };

const ring: LiqEvent[] = [];
let lastEventAt: number | null = null;
let startedAt = Date.now();
let lastHeartbeatFrame = 0;

// ── helpers ────────────────────────────────────────────────────────────────
function stopPing(v: VenueName) {
  if (venues[v].pingTimer) {
    clearInterval(venues[v].pingTimer);
    venues[v].pingTimer = null;
  }
}
function startPing(v: VenueName, ms: number, frame: string) {
  stopPing(v);
  venues[v].pingTimer = setInterval(() => {
    try {
      if (venues[v].ws && venues[v].ws.readyState === 1) venues[v].ws.send(frame);
    } catch {
      /* ignore transient send errors */
    }
  }, ms);
}
function reconnect(v: VenueName, fn: () => void) {
  const st = venues[v];
  st.connected = false;
  stopPing(v);
  st.backoffMs = Math.min((st.backoffMs || 2500) * 2, 60_000); // 5s → 10s → 20s → 40s → 60s cap
  st.reconnects++;
  console.log(`[liq-service] ${v} closed — reconnect in ${Math.round(st.backoffMs / 1000)}s`);
  setTimeout(fn, st.backoffMs);
}
function pushEvent(v: VenueName, ev: Omit<LiqEvent, "venue">) {
  ring.push({ ...ev, venue: v });
  if (ring.length > RING_CAP) ring.shift();
  const now = Date.now();
  lastEventAt = now;
  venues[v].lastEventAt = now;
  venues[v].events++;
  if (venues[v].note) venues[v].note = ""; // data flowing — clear transient subscription notes
}
function anyConnected(): boolean {
  return VENUE_NAMES.some((v) => venues[v].connected);
}
function computeStalled(): boolean {
  // dataStalled ⇔ ≥1 socket open BUT no lane has delivered an event in the stall window
  // (or nothing ever arrived past the warmup grace). All-sockets-down is "down" (connected:false), not stalled.
  const now = Date.now();
  if (!anyConnected()) return false;
  if (lastEventAt === null) return now - startedAt > WARMUP_MS;
  return now - lastEventAt > STALL_MS;
}
function venuesPayload() {
  const out: Record<string, { connected: boolean; lastEventAt: number | null; events: number; reconnects: number; degraded: boolean; note: string }> = {};
  for (const v of VENUE_NAMES) {
    const s = venues[v];
    out[v] = { connected: s.connected, lastEventAt: s.lastEventAt, events: s.events, reconnects: s.reconnects, degraded: s.degraded, note: s.note };
  }
  return out;
}

// ── aggregation (identical math to v1/v2) ──────────────────────────────────
function aggregates() {
  const now = Date.now();
  const bySymbol: Record<string, { usd10m: number; usd1h: number; longsUsd10m: number; shortsUsd10m: number; count: number; last: number }> = {};
  for (const e of ring) {
    const age = now - e.at;
    if (age > 3_600_000) continue;
    const row = (bySymbol[e.symbol] ??= { usd10m: 0, usd1h: 0, longsUsd10m: 0, shortsUsd10m: 0, count: 0, last: 0 });
    row.usd1h += e.usd;
    row.count++;
    row.last = e.at;
    if (age <= 600_000) {
      row.usd10m += e.usd;
      // SELL forceOrder = a LONG position was wrecked; BUY = SHORT wrecked (v1 semantics preserved)
      if (e.side === "SELL") row.longsUsd10m += e.usd;
      else row.shortsUsd10m += e.usd;
    }
  }
  return bySymbol;
}

// shared frame parser — both Binance lanes deliver {e:"forceOrder", o:{…}}
function handleForceOrderFrame(raw: string): void {
  try {
    const msg = JSON.parse(raw) as { e?: string; o?: { s: string; S: string; ap: string; q: string; T: number } };
    if (msg.e === "forceOrder" && msg.o) {
      const o = msg.o;
      const price = Number(o.ap);
      const qty = Number(o.q);
      if (!isFinite(price) || !isFinite(qty)) return;
      pushEvent("binance", { symbol: o.s, side: o.S as "BUY" | "SELL", price, qty, usd: Number((price * qty).toFixed(2)), at: o.T || Date.now() });
    }
  } catch {
    /* skip malformed frame */
  }
}

// ── lane ③: BYBIT allLiquidation mirror (v3.1 — the egress-proven venue) ─
// Bybit v5 public/linear: batched {op:"subscribe",args:["allLiquidation.<SYM>",…]}
// (10 topics/request), ping {op:"ping"} every 20s. Frame: {topic,type:"snapshot",
// data:[{T,s,S,v,p}]} — S:"Sell" = forced sell = LONG wrecked (Binance "SELL"
// semantics — the SIDE CONVENTION above holds verbatim across both venues).
// v3.2.1 MUTED-LANE PARKING: lanes ② (54-socket binance forceOrder ring) and
// ③ (bybit allLiquidation WS) are PROVEN egress-muted (sockets open, zero data
// frames for hours — probes 2026-10-30). They stay CODED but PARKED by default:
// 55 dead sockets cost RAM (this box OOM-kills under 4GB churn) and churn
// reconnects. LIQ_MUTED_LANES=1 re-arms them (e.g. if egress policy changes).
const MUTED_LANES = process.env.LIQ_MUTED_LANES === "1";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
const BYBIT_BATCH = 10; // v5 arg limit per subscribe request
const BYBIT_PING_MS = 20_000;

function handleBybitFrame(raw: string): void {
  try {
    const msg = JSON.parse(raw) as { topic?: string; data?: unknown };
    if (!msg.topic || !msg.topic.startsWith("allLiquidation") || !Array.isArray(msg.data)) return;
    for (const row of msg.data as Array<{ T?: number; s?: string; S?: string; v?: string; p?: string }>) {
      if (!row?.s || !row?.p || !row?.v) continue;
      const price = Number(row.p);
      const qty = Number(row.v);
      if (!isFinite(price) || !isFinite(qty) || price <= 0 || qty <= 0) continue;
      pushEvent("bybit", {
        symbol: row.s,
        side: row.S === "Buy" ? "BUY" : "SELL", // Sell = long wrecked (same convention as Binance)
        price,
        qty,
        usd: Number((price * qty).toFixed(2)),
        at: row.T || Date.now(),
      });
    }
  } catch {
    /* skip malformed frame */
  }
}

function connectBybit(): void {
  if (!MUTED_LANES) {
    console.log("[liq-service] lane-3 bybit allLiquidation PARKED (egress-muted; LIQ_MUTED_LANES=1 to arm)");
    return;
  }
  const st = venues.bybit;
  try {
    const ws = new WebSocket(BYBIT_WS);
    st.ws = ws;
    ws.onopen = () => {
      st.connected = true;
      st.backoffMs = 0;
      // batched subscribe over the curated list (same 54 top-perps as Binance ring)
      for (let i = 0; i < FORCE_SYMBOLS.length; i += BYBIT_BATCH) {
        const args = FORCE_SYMBOLS.slice(i, i + BYBIT_BATCH).map((s) => `allLiquidation.${s}`);
        try { ws.send(JSON.stringify({ op: "subscribe", args })); } catch { /* onclose → reconnect */ }
      }
      console.log(`[liq-service] bybit lane-3 connected — allLiquidation ×${FORCE_SYMBOLS.length} symbols (${Math.ceil(FORCE_SYMBOLS.length / BYBIT_BATCH)} batches)`);
    };
    ws.onmessage = (ev) => handleBybitFrame(String(ev.data));
    ws.onclose = () => reconnect("bybit", connectBybit);
    ws.onerror = () => {
      st.connected = false;
    };
    startPing("bybit", BYBIT_PING_MS, JSON.stringify({ op: "ping" }));
  } catch (err) {
    st.connected = false;
    console.error("[liq-service] bybit lane-3 connect error", err);
    setTimeout(connectBybit, 5000);
  }
}

// ── lane ④: OKX REST liquidation-orders poller (v3.2 — the ONLY flowing market liq source) ──
// Proof matrix 2026-10-30 (trace 1a18eba43d494571): Binance forceOrder WS muted,
// Bybit allLiquidation WS muted (ACK'd, 0 frames/120s while publicTrade flowed
// 408 frames) — this egress filters LIQUIDATION push streams specifically across
// exchanges. OKX public REST GET /api/v5/public/liquidation-orders?instType=SWAP
// &instId=<SYM>-USDT-SWAP&state=filled returns REAL filled liquidations (bkPx,
// posSide, side, sz contracts, ts). Per-symbol cursor-free polling with ts-dedupe;
// sz (contracts) × ctVal = base qty; × bkPx = USD notional.
// SIDE MAP (same convention as Binance lanes): posSide=long & side=sell → forced
// SELL → LONG wrecked → "SELL"; posSide=short & side=buy → "BUY".
const OKX_REST = "https://www.okx.com/api/v5/public/liquidation-orders";
const OKX_INSTS_URL = "https://www.okx.com/api/v5/public/instruments?instType=SWAP";
const OKX_POLL_MS = 12_000;
const OKX_CONCURRENCY = 8;
interface OkxTarget { instId: string; binanceSym: string; ctVal: number }
let okxTargets: OkxTarget[] = [];
const okxLastTs = new Map<string, number>(); // instId → newest ts already ingested
const okxDedupe = new Map<string, number>(); // rowkey → seenAt (10min pruning)

async function okxFetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { Connection: "close" } });
    if (!res.ok) throw new Error(`okx http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function okxBuildTargets(): Promise<void> {
  try {
    const d = await okxFetchJson(OKX_INSTS_URL);
    const byInst = new Map<string, any>();
    for (const r of d?.data ?? []) byInst.set(r.instId, r);
    okxTargets = [];
    for (const sym of FORCE_SYMBOLS) {
      const instId = `${sym.replace(/USDT$/, "")}-USDT-SWAP`; // BTCUSDT → BTC-USDT-SWAP
      const inst = byInst.get(instId);
      if (!inst) continue; // not on OKX — honest skip
      okxTargets.push({ instId, binanceSym: sym, ctVal: Number(inst.ctVal) || 0 });
    }
    console.log(`[liq-service] okx lane-4 targets ready — ${okxTargets.length}/${FORCE_SYMBOLS.length} symbols mapped (ctVal ×${okxTargets.length ? "ok" : "MISS"})`);
  } catch (err) {
    console.error("[liq-service] okx instruments load failed — retry 30s", err);
    setTimeout(okxBuildTargets, 30_000);
  }
}

function okxIngestPoll(instId: string, binanceSym: string, ctVal: number, rows: Array<Record<string, unknown>>): number {
  let added = 0;
  const last = okxLastTs.get(instId) ?? 0;
  let newest = last;
  for (const x of rows) {
    const ts = Number(x.ts ?? x.time ?? 0);
    if (!ts || ts <= last) continue; // cursor gate — only NEW rows
    if (ts > newest) newest = ts;
    const side = x.posSide === "long" ? "SELL" : "BUY"; // long+sell wreck = forced SELL (Binance semantics)
    const sz = Number(x.sz ?? 0);
    const bkPx = Number(x.bkPx ?? 0);
    if (!(sz > 0) || !(bkPx > 0) || !ctVal) continue;
    const key = `${instId}|${ts}|${side}|${sz}`;
    if (okxDedupe.has(key)) continue;
    okxDedupe.set(key, Date.now());
    pushEvent("okx", {
      symbol: binanceSym,
      side: side as "BUY" | "SELL",
      price: bkPx,
      qty: Number((sz * ctVal).toFixed(6)),
      usd: Number((sz * ctVal * bkPx).toFixed(2)),
      at: ts,
    });
    added++;
  }
  if (newest > last) okxLastTs.set(instId, newest);
  return added;
}

async function okxPollOnce(target: OkxTarget): Promise<boolean> {
  try {
    // NOTE: this endpoint accepts uly/instFamily only for SWAP (instId → code 50015 param error)
    const uly = target.instId.replace("-SWAP", ""); // BTC-USDT-SWAP → BTC-USDT
    const d = await okxFetchJson(`${OKX_REST}?instType=SWAP&uly=${uly}&state=filled`);
    if (d?.code !== "0") return false;
    const groups = Array.isArray(d.data) ? d.data : [];
    const rows = groups.flatMap((g: any) => (Array.isArray(g?.details) ? g.details : []));
    okxIngestPoll(target.instId, target.binanceSym, target.ctVal, rows);
    return true;
  } catch {
    return false;
  }
}

async function okxPollCycle(): Promise<void> {
  if (okxTargets.length === 0) return;
  const st = venues.okx;
  // bounded-concurrency worker pool
  let idx = 0;
  let ok = 0;
  async function worker(): Promise<void> {
    while (idx < okxTargets.length) {
      const t = okxTargets[idx++];
      if (await okxPollOnce(t)) ok++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(OKX_CONCURRENCY, okxTargets.length) }, worker));
  if (ok > 0) {
    st.connected = true;
    st.backoffMs = 0;
  } else {
    st.connected = false;
    st.reconnects++;
  }
  // prune dedupe window (10min)
  const cut = Date.now() - 600_000;
  if (okxDedupe.size > 8000) for (const [k, t] of okxDedupe) if (t < cut) okxDedupe.delete(k);
}

function startOkxPoller(): void {
  void okxBuildTargets().then(() => {
    if (okxTargets.length === 0) return;
    setInterval(() => void okxPollCycle(), OKX_POLL_MS);
    void okxPollCycle();
    console.log(`[liq-service] okx lane-4 poller armed — every ${OKX_POLL_MS / 1000}s × ${okxTargets.length} instIds (REST, egress-proven)`);
  });
}

// ── lane ①: market-wide !forceOrder@arr (original feed, unchanged) ─────────
function connectBinance() {
  const st = venues.binance;
  try {
    const ws = new WebSocket(BINANCE_ARR_WS);
    st.ws = ws;
    ws.onopen = () => {
      st.connected = true;
      st.backoffMs = 0;
      console.log("[liq-service] binance lane-1 connected to !forceOrder@arr");
    };
    ws.onmessage = (ev) => handleForceOrderFrame(String(ev.data));
    ws.onclose = () => reconnect("binance", connectBinance);
    ws.onerror = () => {
      st.connected = false;
    };
  } catch (err) {
    st.connected = false;
    console.error("[liq-service] binance lane-1 connect error", err);
    setTimeout(connectBinance, 5000);
  }
}

// ── lane ②: per-symbol forceOrder ring (v14.0 — the egress-proven format) ──
// One raw socket per symbol (the bookTicker-ring pattern proven live from this
// egress). All sockets feed venues.binance; each keeps an independent backoff
// so one dead stream cannot churn the rest.
interface RingSock { sym: string; ws: WebSocket | null; backoffMs: number; reconnects: number }
const forceRing = new Map<string, RingSock>();
let ringLogged = 0;

function connectForceSymbol(rs: RingSock): void {
  try {
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${rs.sym.toLowerCase()}@forceOrder`);
    rs.ws = ws;
    ws.onopen = () => {
      rs.backoffMs = 0;
      venues.binance.connected = true;
      if (ringLogged < 3) {
        ringLogged++;
        console.log(`[liq-service] binance lane-2 ring open (${rs.sym.toLowerCase()}@forceOrder) — ${ringLogged}/3 logged`);
      }
    };
    ws.onmessage = (ev) => handleForceOrderFrame(String(ev.data));
    ws.onclose = () => {
      rs.backoffMs = Math.min((rs.backoffMs || 2500) * 2, 60_000);
      rs.reconnects++;
      venues.binance.reconnects++;
      setTimeout(() => connectForceSymbol(rs), rs.backoffMs);
    };
    ws.onerror = () => {};
  } catch {
    setTimeout(() => connectForceSymbol(rs), 5000);
  }
}
function connectForceRing(): void {
  if (!MUTED_LANES) {
    console.log("[liq-service] lane-2 forceOrder ring PARKED (egress-muted; LIQ_MUTED_LANES=1 to arm)");
    return;
  }
  for (const sym of FORCE_SYMBOLS) {
    const rs: RingSock = { sym, ws: null, backoffMs: 0, reconnects: 0 };
    forceRing.set(sym, rs);
    connectForceSymbol(rs);
  }
  console.log(`[liq-service] binance lane-2 forceOrder ring spawning ${FORCE_SYMBOLS.length} per-symbol sockets`);
}

// ── heartbeat watchdog (unchanged v1 pattern: busy Binance aggTrade stream) ─
function connectHeartbeat() {
  try {
    const hbWs = new WebSocket(HEARTBEAT_URL);
    hbWs.onmessage = () => {
      lastHeartbeatFrame = Date.now();
    };
    hbWs.onclose = () => setTimeout(connectHeartbeat, 5000);
    hbWs.onerror = () => {};
  } catch {
    setTimeout(connectHeartbeat, 5000);
  }
}

// ── boot ────────────────────────────────────────────────────────────────────
connectBinance();
connectForceRing();
connectHeartbeat();
connectBybit(); // v3.1 — lane-3 BYBIT allLiquidation mirror (armed; egress-muted today)
startOkxPoller(); // v3.2 — lane-④ OKX REST liquidation-orders poller (the ONLY flowing market liq source)

// ── venue-liveness supervisor (v2.1 → v3.0) ────────────────────────────────
// A socket can sit "connected" while delivering NOTHING for hours — the
// fstream half-open pathology (same reason trade-service's futures aggTrade
// WS is suppressed and SPOT-MIRROR exists). Rule: only force a reconnect when
// the HOST is provably alive (heartbeat btcusdt@aggTrade fresh <10min) but
// the lane itself has been silent >60min. The lane-2 ring self-heals per
// socket; this supervisor covers lane-1 (the market-wide arr socket).
const LIVENESS_TICK_MS = 5 * 60_000;
const LIVENESS_SILENT_MS = 60 * 60_000;
const LIVENESS_HB_FRESH_MS = 10 * 60_000;
setInterval(() => {
  const now = Date.now();
  const hbFresh = lastHeartbeatFrame && now - lastHeartbeatFrame < LIVENESS_HB_FRESH_MS;
  if (!hbFresh) return; // host-level problem — venue churn would be noise
  // v3.1 — lane-1 arr + lane-3 bybit supervisor (same rule: a socket can sit
  // "connected" delivering nothing; pongs keep it alive without data, so
  // silence while the host is provably fresh = force reconnect)
  for (const v of ["binance", "bybit"] as VenueName[]) {
    const st = venues[v];
    if (!st.connected || !st.ws) continue;
    const silentFor = st.lastEventAt ? now - st.lastEventAt : now - startedAt;
    if (silentFor > LIVENESS_SILENT_MS) {
      console.log(`[liq-service] liveness: ${v} lane silent ${Math.round(silentFor / 60000)}min while host delivers frames — forcing reconnect`);
      try { st.ws.close(); } catch { /* onclose → reconnect */ }
    }
  }
}, LIVENESS_TICK_MS);

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      const dataStalled = computeStalled();
      return Response.json({
        service: "nexus-liq-service",
        connected: anyConnected(),
        dataStalled,
        heartbeatAgeMs: lastHeartbeatFrame ? Date.now() - lastHeartbeatFrame : null,
        buffered: ring.length,
        lastEventAt,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        note: dataStalled
          ? "no liquidation data from ANY lane within the stall window — Binance/Bybit liq push streams are egress-muted (sockets open, zero frames) and the OKX REST poller is failing; no invented data"
          : "ok",
        venues: venuesPayload(),
      });
    }
    if (url.pathname === "/liquidations") {
      const dataStalled = computeStalled();
      return Response.json({
        status: {
          connected: anyConnected(),
          dataStalled,
          buffered: ring.length,
          lastEventAt,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          venues: venuesPayload(),
        },
        recent: ring.slice(-120).reverse(),
        bySymbol: aggregates(),
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[liq-service] v3.2.1 listening on :${server.port} (BINANCE arr [1 socket] + OKX REST poller x53 + lanes②③ ${MUTED_LANES ? "ARMED" : "PARKED"})`);
