// ── NEXUS liq-service (:3010) v3.0 — BINANCE-ONLY REAL forced-liquidation aggregation ──
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

type VenueName = "binance";
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

const VENUE_NAMES: VenueName[] = ["binance"];
function mkVenueState(): VenueState {
  return { connected: false, degraded: false, lastEventAt: null, events: 0, reconnects: 0, note: "", ws: null, backoffMs: 0, pingTimer: null };
}
const venues: Record<VenueName, VenueState> = { binance: mkVenueState() };

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
  const st = venues.binance;
  if (!st.connected || !st.ws) return;
  const silentFor = st.lastEventAt ? now - st.lastEventAt : now - startedAt;
  if (silentFor > LIVENESS_SILENT_MS) {
    console.log(`[liq-service] liveness: lane-1 arr silent ${Math.round(silentFor / 60000)}min while host delivers frames — forcing reconnect`);
    try { st.ws.close(); } catch { /* onclose → reconnect */ }
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
          ? "no liquidation frames from ANY Binance lane within the stall window — sockets may be open but data frames are not reaching this host; no invented data"
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

console.log(`[liq-service] v3.0 listening on :${server.port} (BINANCE-ONLY: !forceOrder@arr + ${FORCE_SYMBOLS.length}-symbol forceOrder ring)`);
