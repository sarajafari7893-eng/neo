// ── NEXUS liq-service (:3010) v2 — 4-venue REAL forced-liquidation aggregation ──
// Venues (all key-less public WS, zero invented data):
//   binance : wss://fstream.binance.com/ws/!forceOrder@arr   — all-market force orders (original feed, untouched semantics)
//   bybit   : wss://stream.bybit.com/v5/public/linear        — allLiquidation.{SYM} over a curated ~50 top USDT perps
//   okx     : wss://ws.okx.com:8443/ws/v5/public             — liquidation-orders SWAP = one sub covers ALL perpetuals
//   bitget  : wss://ws.bitget.com/v2/ws/public               — liquidation-orders USDT-FUTURES (attempted; degrades honestly
//                                                              to connected:false + health note if the exchange rejects it)
// Public JSON contract (consumed by src/lib/liquidations.ts — fields intact, only additive keys added):
//   GET /liquidations → { status:{connected,dataStalled,buffered,lastEventAt,uptimeSec,venues}, recent:[…], bySymbol:{…} }
//   GET /health       → all original fields + venues
// SIDE CONVENTION — mirrors the original Binance handler EXACTLY (ground truth, do not flip):
//   side "SELL" = forced SELL order ⇒ a LONG position was wrecked  → longsUsd10m
//   side "BUY"  = forced BUY  order ⇒ a SHORT position was wrecked → shortsUsd10m
// Venue mappings (verified against official docs):
//   bybit: S is the POSITION side — "Buy ⇒ a long position has been liquidated" ⇒ Buy→SELL, Sell→BUY
//   okx:   posSide (long/short) preferred; fallback order side sell⇒closes long ⇒ sell→SELL, buy→BUY
// OKX notional: sz is in CONTRACTS ⇒ sized with ctVal from public REST /public/instruments (refreshed 6h + lazy on miss);
//   unknown contract size ⇒ usd 0 (event still counted, nothing fabricated). Coin-margined (-USD-SWAP) ctValCcy=USD.

const PORT = 3010;
const RING_CAP = 5000; // was 600 (Binance-only); 4 venues ⇒ ring sized so the 1h aggregate window stays meaningful
const STALL_MS = 2 * 60_000;
const WARMUP_MS = 2 * 60_000; // grace after boot before "never any event from any venue" counts as stalled

const BINANCE_WS = "wss://fstream.binance.com/ws/!forceOrder@arr";
const HEARTBEAT_URL = "wss://fstream.binance.com/ws/btcusdt@aggTrade"; // busy stream: proves frames CAN reach this host
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
const OKX_WS = "wss://ws.okx.com:8443/ws/v5/public";
const BITGET_WS = "wss://ws.bitget.com/v2/ws/public";

// Curated Bybit linear USDT perps (~50 top-by-volume, plain base-coin units only — 1000X symbols excluded so
// p×v stays true USD notional; Binance !forceOrder already covers the whole market incl. PEPE/SHIB-class names).
const BYBIT_SYMBOLS = [
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

type VenueName = "binance" | "bybit" | "okx" | "bitget";
interface VenueState {
  connected: boolean;
  degraded: boolean; // exchange refused the subscription (e.g. bitget channel unavailable)
  lastEventAt: number | null;
  events: number;
  reconnects: number;
  note: string;
  ws: WebSocket | null;
  backoffMs: number;
  pingTimer: ReturnType<typeof setInterval> | null;
}

const VENUE_NAMES: VenueName[] = ["binance", "bybit", "okx", "bitget"];
function mkVenueState(): VenueState {
  return { connected: false, degraded: false, lastEventAt: null, events: 0, reconnects: 0, note: "", ws: null, backoffMs: 0, pingTimer: null };
}
const venues: Record<VenueName, VenueState> = {
  binance: mkVenueState(),
  bybit: mkVenueState(),
  okx: mkVenueState(),
  bitget: mkVenueState(),
};

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
  // dataStalled ⇔ ≥1 socket open BUT no venue has delivered an event in the stall window
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

// ── aggregation (identical math to v1; now fed by all venues) ──────────────
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

// ── venue: BINANCE (original feed, unchanged semantics) ───────────────────
function connectBinance() {
  const st = venues.binance;
  try {
    const ws = new WebSocket(BINANCE_WS);
    st.ws = ws;
    ws.onopen = () => {
      st.connected = true;
      st.backoffMs = 0;
      console.log("[liq-service] binance connected to !forceOrder@arr");
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { e?: string; o?: { s: string; S: string; ap: string; q: string; T: number } };
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
    };
    ws.onclose = () => reconnect("binance", connectBinance);
    ws.onerror = () => {
      st.connected = false;
    };
  } catch (err) {
    st.connected = false;
    console.error("[liq-service] binance connect error", err);
    setTimeout(connectBinance, 5000);
  }
}

// ── venue: BYBIT v5 (allLiquidation, curated list) ─────────────────────────
// Doc: S is the POSITION side — "Buy ⇒ a long position has been liquidated". Our convention: longs wrecked ⇒ "SELL".
function bybitSide(S: string): "BUY" | "SELL" | null {
  if (S === "Buy") return "SELL"; // long position liquidated
  if (S === "Sell") return "BUY"; // short position liquidated
  return null;
}
function connectBybit() {
  const st = venues.bybit;
  try {
    const ws = new WebSocket(BYBIT_WS);
    st.ws = ws;
    ws.onopen = () => {
      st.connected = true;
      st.backoffMs = 0;
      // batched subscribes keep one bad symbol from poisoning the whole op
      for (let i = 0; i < BYBIT_SYMBOLS.length; i += 10) {
        try {
          ws.send(JSON.stringify({ op: "subscribe", args: BYBIT_SYMBOLS.slice(i, i + 10).map((s) => `allLiquidation.${s}`) }));
        } catch (err) {
          console.error("[liq-service] bybit subscribe chunk error", err);
        }
      }
      startPing("bybit", 20_000, JSON.stringify({ op: "ping" })); // Bybit v5 keepalive per docs
      console.log(`[liq-service] bybit connected — ${BYBIT_SYMBOLS.length} allLiquidation topics`);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          op?: string;
          success?: boolean;
          ret_msg?: string;
          topic?: string;
          data?: Array<{ T?: number; s?: string; S?: string; v?: string; p?: string }>;
        };
        if (msg.op === "subscribe" && msg.success === false) {
          st.note = `sub error: ${String(msg.ret_msg ?? "unknown").slice(0, 180)}`;
          console.error(`[liq-service] bybit ${st.note}`);
          return;
        }
        if (typeof msg.topic === "string" && msg.topic.startsWith("allLiquidation.") && Array.isArray(msg.data)) {
          for (const d of msg.data) {
            const side = bybitSide(d.S ?? "");
            const price = Number(d.p);
            const qty = Number(d.v); // executed size in base coin (linear USDT) ⇒ p×v = true USD notional
            if (!side || !d.s || !isFinite(price) || !isFinite(qty) || price <= 0 || qty <= 0) continue;
            pushEvent("bybit", { symbol: d.s, side, price, qty, usd: Number((price * qty).toFixed(2)), at: d.T || Date.now() });
          }
        }
      } catch {
        /* skip control/pong frames */
      }
    };
    ws.onclose = () => reconnect("bybit", connectBybit);
    ws.onerror = () => {
      st.connected = false;
    };
  } catch (err) {
    st.connected = false;
    console.error("[liq-service] bybit connect error", err);
    setTimeout(connectBybit, 5000);
  }
}

// ── venue: OKX v5 (liquidation-orders SWAP — all instruments, one sub) ─────
// Doc: details.side = ORDER side, details.posSide = position side; sz is in CONTRACTS for SWAP.
const okxCtVal = new Map<string, { ctVal: number; ccy: string }>();
let okxCtValFetchedAt = 0;
async function loadOkxInstruments(reason: string) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch("https://www.okx.com/api/v5/public/instruments?instType=SWAP", { signal: ctrl.signal });
    clearTimeout(timer);
    const j = (await res.json()) as { code?: string; data?: Array<{ instId?: string; ctVal?: string; ctValCcy?: string }> };
    if (j?.code === "0" && Array.isArray(j.data)) {
      for (const inst of j.data) {
        if (!inst.instId) continue;
        okxCtVal.set(inst.instId, { ctVal: Number(inst.ctVal), ccy: String(inst.ctValCcy ?? "") });
      }
      okxCtValFetchedAt = Date.now();
      console.log(`[liq-service] okx instrument specs loaded (${okxCtVal.size} SWAP) via ${reason}`);
    }
  } catch (err) {
    console.error("[liq-service] okx instruments fetch failed", err);
  }
}
function okxCtValMiss() {
  if (Date.now() - okxCtValFetchedAt > 60_000) void loadOkxInstruments("lazy-miss");
}
// coin-margined (-USD-SWAP): ctValCcy = USD ⇒ notional = sz×ctVal ; linear (USDT/USDC): notional = sz×ctVal×px
function okxNotional(instId: string, sz: number, px: number): number {
  const spec = okxCtVal.get(instId);
  if (!spec || !isFinite(spec.ctVal) || spec.ctVal <= 0) return 0;
  return spec.ccy === "USD" ? sz * spec.ctVal : sz * spec.ctVal * px;
}
function okxSymbol(instId: string): string {
  const m = instId.match(/^([A-Z0-9]+)-(USDT|USDC|USD)-SWAP$/);
  return m ? m[1] + m[2] : instId.replaceAll("-", ""); // BTC-USDT-SWAP → BTCUSDT (Binance-style)
}
function okxSide(posSide?: string, side?: string): "BUY" | "SELL" | null {
  if (posSide === "long") return "SELL"; // long position wrecked
  if (posSide === "short") return "BUY";
  if (side === "sell") return "SELL"; // order-side fallback: a sell order closes a long
  if (side === "buy") return "BUY";
  return null;
}
function connectOkx() {
  const st = venues.okx;
  try {
    const ws = new WebSocket(OKX_WS);
    st.ws = ws;
    ws.onopen = () => {
      st.backoffMs = 0;
      ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "liquidation-orders", instType: "SWAP" }] }));
      startPing("okx", 25_000, "ping"); // OKX drops silent conns <30s — text "ping" per docs
      console.log("[liq-service] okx connected — liquidation-orders SWAP subscribe sent");
    };
    ws.onmessage = (ev) => {
      const raw = String(ev.data);
      if (raw === "pong") return;
      try {
        const msg = JSON.parse(raw) as {
          event?: string;
          code?: string;
          msg?: string;
          arg?: { channel?: string };
          data?: Array<{ instId?: string; details?: Array<{ instId?: string; side?: string; posSide?: string; bkPx?: string; sz?: string; ts?: string }> }>;
        };
        if (msg.event === "error") {
          st.degraded = true;
          st.connected = false;
          st.note = `subscribe rejected: ${msg.code ?? "?"} ${msg.msg ?? ""}`.trim().slice(0, 180);
          console.error(`[liq-service] okx ${st.note}`);
          return;
        }
        if (msg.event === "subscribe") {
          st.connected = true;
          st.degraded = false;
          st.note = "";
          console.log("[liq-service] okx liquidation-orders SWAP subscribed");
          return;
        }
        if (msg.arg?.channel === "liquidation-orders" && Array.isArray(msg.data)) {
          for (const d of msg.data) {
            for (const x of d.details ?? []) {
              const instId = x.instId ?? d.instId ?? "";
              if (!instId) continue;
              const side = okxSide(x.posSide, x.side);
              const price = Number(x.bkPx);
              const sz = Number(x.sz);
              if (!side || !isFinite(price) || !isFinite(sz) || price <= 0 || sz <= 0) continue;
              const spec = okxCtVal.get(instId);
              if (!spec) okxCtValMiss(); // self-heal sizing map, event still recorded below with usd 0
              const usdRaw = spec ? okxNotional(instId, sz, price) : 0;
              // qty reported in base coin so price×qty ≈ usd stays internally consistent
              const qty = spec ? (spec.ccy === "USD" ? Number(((sz * spec.ctVal) / price).toFixed(6)) : Number((sz * spec.ctVal).toFixed(6))) : sz;
              if (!isFinite(qty) || qty <= 0) continue;
              pushEvent("okx", {
                symbol: okxSymbol(instId),
                side,
                price,
                qty,
                usd: Number(usdRaw.toFixed(2)),
                at: Number(x.ts) || Date.now(),
              });
            }
          }
        }
      } catch {
        /* skip malformed frame */
      }
    };
    ws.onclose = () => reconnect("okx", connectOkx);
    ws.onerror = () => {
      st.connected = false;
    };
  } catch (err) {
    st.connected = false;
    console.error("[liq-service] okx connect error", err);
    setTimeout(connectOkx, 5000);
  }
}

// ── venue: BITGET v2 (attempted; degrades honestly if channel rejected) ────
let bitgetLoggedFirstFrame = false;
function connectBitget() {
  const st = venues.bitget;
  try {
    const ws = new WebSocket(BITGET_WS);
    st.ws = ws;
    ws.onopen = () => {
      st.backoffMs = 0;
      // channel availability is only known once the exchange ACKs — do not claim connected yet
      ws.send(JSON.stringify({ op: "subscribe", args: [{ instType: "USDT-FUTURES", channel: "liquidation-orders" }] }));
      startPing("bitget", 25_000, "ping"); // Bitget keepalive: text "ping" per docs
      console.log("[liq-service] bitget ws open — liquidation-orders USDT-FUTURES subscribe sent");
    };
    ws.onmessage = (ev) => {
      const raw = String(ev.data);
      if (raw === "pong") return;
      try {
        const msg = JSON.parse(raw) as {
          event?: string;
          code?: string;
          msg?: string;
          arg?: { channel?: string };
          data?: Array<Record<string, unknown>>;
        };
        if (msg.event === "error") {
          st.connected = false;
          st.degraded = true;
          st.note = `channel rejected: ${msg.code ?? "?"} ${msg.msg ?? ""}`.trim().slice(0, 180);
          console.error(`[liq-service] bitget DEGRADED — ${st.note}`);
          return;
        }
        if (msg.event === "subscribe") {
          st.connected = true;
          st.degraded = false;
          st.note = "";
          console.log("[liq-service] bitget liquidation-orders subscribed");
          return;
        }
        if (msg.arg?.channel === "liquidation-orders" && Array.isArray(msg.data)) {
          if (!bitgetLoggedFirstFrame) {
            bitgetLoggedFirstFrame = true;
            console.log("[liq-service] bitget first liq frame:", raw.slice(0, 500));
          }
          for (const d of msg.data) {
            const symbol = String(d.instId ?? d.symbol ?? "").toUpperCase();
            if (!symbol) continue;
            const posSide = typeof d.posSide === "string" ? d.posSide : typeof d.holdSide === "string" ? (d.holdSide as string) : undefined;
            const side =
              posSide === "long" ? "SELL" : posSide === "short" ? "BUY" : d.side === "sell" ? "SELL" : d.side === "buy" ? "BUY" : null;
            const price = Number(d.bkPx ?? d.price ?? d.px ?? 0);
            const qty = Number(d.sz ?? d.size ?? d.baseVolume ?? 0);
            if (!side || !isFinite(price) || !isFinite(qty) || price <= 0 || qty <= 0) continue;
            pushEvent("bitget", { symbol, side, price, qty, usd: Number((price * qty).toFixed(2)), at: Number(d.ts) || Date.now() });
          }
        }
      } catch {
        /* skip malformed frame */
      }
    };
    ws.onclose = () => reconnect("bitget", connectBitget);
    ws.onerror = () => {
      st.connected = false;
    };
  } catch (err) {
    st.connected = false;
    console.error("[liq-service] bitget connect error", err);
    setTimeout(connectBitget, 5000);
  }
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
void loadOkxInstruments("boot");
setInterval(() => void loadOkxInstruments("6h-refresh"), 6 * 3_600_000);
connectBinance();
connectBybit();
connectOkx();
connectBitget();
connectHeartbeat();

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
          ? "no liquidation frames from ANY venue within the stall window — sockets may be open but data frames are not reaching this host; no invented data"
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

console.log(`[liq-service] v2 listening on :${server.port} (venues: binance+bybit+okx+bitget)`);
