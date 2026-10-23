// ── NEXUS price-ws (:3003, socket.io) — sub-second price push ──────────────
// Fuel priority (honest labeling, Task 35):
//   1. WS PUSH     — Binance futures miniTicker combined stream
//   2. WS·SPOT     — Binance SPOT !miniTicker@arr WS (v12.8 AUDIT-20261023:
//                    measured 10:30Z — fstream (futures) delivers ZERO frames
//                    from this egress while stream.binance.com (spot) is
//                    ALIVE (8 frames/8s direct test). Spot lives in a separate
//                    rate/ban pool — feeding it as rung-2 restores Binance
//                    price parity while the futures plane is IP-suppressed,
//                    instead of jumping straight to BYBIT and losing the
//                    reference venue. Same row shape; spot symbols that have
//                    no futures twin simply never arrive (BYBIT covers those).
//   3. WS·BYBIT    — Bybit v5 public linear tickers WS (SECOND EXCHANGE —
//                    independent IP/rate budget, keeps live data flowing while
//                    Binance fstream/fapi are IP-suppressed or 418-banned)
//   4. WS·REST 2.5S— Binance fapi /ticker/24hr poll (ban-aware, v10.7)
//   5. WS OFFLINE  — everything down; badge never lies
// Universe auto-syncs from the terminal pulse every 5min.

import { Server } from "socket.io";

const PORT = 3003;
const WS_URL = "wss://fstream.binance.com/stream?streams=!miniTicker@arr";
// v12.8 AUDIT-20261023 — SPOT-ARR ring: raw spot all-market miniTicker WS.
// ALIVE from this egress while fstream is silent (measured + verified live).
const SPOT_WS_URL = "wss://stream.binance.com:9443/ws/!miniTicker@arr";
const REST_URL = "https://fapi.binance.com/fapi/v1/ticker/24hr";
// v12.2 TASK-52 — SPOT-MIRROR rung: api.binance.com lives in a SEPARATE
// rate-limit/ban pool from fapi.binance.com. While the fapi pool is banned
// and both WS lanes are dead, the fuel ladder burns SPOT (same exchange,
// same row shape, weight 80 on a fresh pool) instead of going dark or poking
// the banned fapi pool (Task-50 law: every contact during a ban escalates).
const SPOT_URL = "https://api.binance.com/api/v3/ticker/24hr";
const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
const STALL_MS = 60_000;

interface PriceRow {
  symbol: string;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  at: number;
}

const prices = new Map<string, PriceRow>();
let source: "WS PUSH" | "WS·SPOT" | "WS·BYBIT" | "WS·REST 2.5S" | "WS·REST·SPOT" | "WS OFFLINE" = "WS PUSH";
let lastWsFrame = 0;
// v12.8 — spot-arr ring state
let spotWsLastFrame = 0;
let lastEventAt: number | null = null;
// v10.7 ban-awareness (2026-09-17 dashboard audit): Binance 418/429 IP bans
// auto-extend when the REST fallback keeps hammering. Respect retry-after,
// stop polling while banned, and label the source honestly (WS OFFLINE)
// instead of a live-looking "WS·REST 2.5S" badge over frozen rows.
let restBannedUntil = 0;
let spotBannedUntil = 0; // separate pool — NEVER shares the fapi ledger
let spotLastOkAt = 0;
// v10.8 TASK-49 — shared-ledger discipline: parse the REAL "banned until"
// body (retry-after is often absent → the old 60s default re-poked every
// minute all ban long), write named-IP discoveries to the shared ledger, and
// defer resume while ANY pool IP is still banned (NAT lottery — one banned
// IP means any request may land on it and re-escalate the expiry).
import { ledgerUnknownScopeBanUntil, writeLedgerBan } from "../_shared/ban-ledger";

// ── v12.8 SPOT-ARR ring — Binance spot WS (rung 2) ──────────────────────────
// Raw stream frames arrive as the event object itself (no combined-wrapper):
// { e:"24hrMiniTicker", E, s, c, o, h, l, v, q }. Symbol parity with futures
// tickers is 1:1 for USDT pairs that exist on both planes (BTCUSDT…);
// futures-only tickers simply never arrive here and stay on BYBIT fuel.
function connectSpotWs(): void {
  try {
    const ws = new WebSocket(SPOT_WS_URL);
    ws.onopen = () => {
      spotWsLastFrame = Date.now();
      console.log("[price-ws] spot !miniTicker@arr WS open (v12.8 ring-2)");
    };
    ws.onmessage = (ev) => {
      try {
        // v12.8.1 — !miniTicker@arr payloads arrive as an ARRAY of miniTicker
        // objects (measured live: frames with e=undefined when parsed as a
        // single object). Accept array / combined-wrapper / single-object.
        const raw = JSON.parse(String(ev.data)) as unknown;
        const items: Array<{ e?: string; s?: string; c?: string; o?: string; h?: string; l?: string; q?: string; E?: number }> = Array.isArray(raw)
          ? (raw as Array<{ e?: string; s?: string; c?: string; o?: string; h?: string; l?: string; q?: string; E?: number }>)
          : raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)
            ? ((raw as { data: Array<{ e?: string; s?: string; c?: string; o?: string; h?: string; l?: string; q?: string; E?: number }> }).data)
            : [raw as { e?: string; s?: string; c?: string; o?: string; h?: string; l?: string; q?: string; E?: number }];
        for (const d of items) {
          if (!d || !d.s || !d.s.endsWith("USDT")) continue;
          spotWsLastFrame = Date.now();
          const price = Number(d.c);
          if (!(price > 0)) continue;
          prices.set(d.s, {
            symbol: d.s,
            price,
            change24h: d.o ? ((price - Number(d.o)) / Number(d.o)) * 100 : 0,
            high24h: Number(d.h) || price,
            low24h: Number(d.l) || price,
            volume24h: Number(d.q) || 0,
            at: d.E || Date.now(),
          });
          lastEventAt = Date.now();
        }
      } catch {
        /* skip */
      }
    };
    ws.onclose = () => {
      console.log("[price-ws] spot arr stream closed — reconnect 5s");
      setTimeout(connectSpotWs, 5000);
    };
    ws.onerror = () => {};
  } catch (err) {
    console.error("[price-ws] spot connect error", err);
    setTimeout(connectSpotWs, 5000);
  }
}

// ── Bybit tier state (Task 35 — second reputable exchange) ─────────────────
let bybLastFrame = 0;
const bybSubscribed = new Set<string>();
// Bybit tickers topic sends a full snapshot then field-level deltas — keep the
// last partial per symbol so deltas can be merged into a complete row.
type BybPartial = { symbol: string; price?: number; change24h?: number; high24h?: number; low24h?: number; volume24h?: number };
const bybPartial = new Map<string, BybPartial>();
let bybWs: WebSocket | null = null;

async function restPoll() {
  if (restBannedUntil > 0 && Date.now() >= restBannedUntil) {
    // v10.8 TASK-49 — ledger-gated resume: our window elapsed but the shared
    // ledger may still carry a live pool ban another process discovered.
    // v1.1 scope split: resume defers ONLY while an UNKNOWN-SCOPE ("_pool")
    // ban is live — a single named pool member's ban no longer silences this
    // lane (majority-clean pool measured 2026-10-20; our own 418 discoveries
    // still pause THIS lane via restBannedUntil as before).
    const poolBan = ledgerUnknownScopeBanUntil();
    if (poolBan > Date.now()) {
      if (poolBan > restBannedUntil) {
        restBannedUntil = poolBan;
        console.log(`[price-ws] shared ledger still bans fapi pool (unknown scope) until ${new Date(poolBan).toISOString()} — resume deferred`);
      }
      return;
    }
    restBannedUntil = 0;
    console.log("[price-ws] REST ban window elapsed — probe resume");
  }
  if (Date.now() < restBannedUntil) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    // v12.6.1 connection-recycle: fresh egress draw per poll (see fapi-gate)
    const res = await fetch(REST_URL, { signal: ctrl.signal, cache: "no-store", headers: { Connection: "close" } });
    clearTimeout(timer);
    if (res.status === 418 || res.status === 429) {
      // v10.8: honor the REAL body end first (Binance names IP + epoch),
      // fall back to retry-after, then the 60s soft default.
      let until = 0;
      let namedIp: string | null = null;
      try {
        const body = await res.text();
        const m = /IP\(([\d.]+)\)\s*banned until (\d+)/i.exec(body);
        if (m) {
          namedIp = m[1]!;
          const real = Number(m[2]);
          if (Number.isFinite(real) && real > Date.now()) until = real;
        } else {
          const u = /banned until (\d{10,16})/i.exec(body);
          if (u) {
            let ts = Number(u[1]);
            if (ts < 10_000_000_000) ts *= 1000;
            if (ts > Date.now()) until = ts;
          }
        }
      } catch {
        /* body unreadable */
      }
      if (!until) {
        const ra = Number(res.headers.get("retry-after") ?? 0);
        until = Date.now() + Math.min(Math.max(ra, 60), 4 * 3600) * 1000;
      }
      writeLedgerBan(namedIp, until); // shared truth — other processes stay silent too
      if (until > restBannedUntil) {
        console.log(`[price-ws] REST ${res.status} IP-ban/ratelimit — backing off until ${new Date(until).toISOString()}${namedIp ? ` (IP ${namedIp})` : ""}`);
        restBannedUntil = until;
      }
      return;
    }
    if (!res.ok) return;
    const rows = (await res.json()) as Array<{ symbol: string; lastPrice: string; priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string }>;
    for (const r of rows) {
      if (!r.symbol.endsWith("USDT")) continue;
      const prev = prices.get(r.symbol);
      prices.set(r.symbol, {
        symbol: r.symbol,
        price: Number(r.lastPrice),
        change24h: Number(r.priceChangePercent),
        high24h: Number(r.highPrice),
        low24h: Number(r.lowPrice),
        volume24h: Number(r.quoteVolume),
        at: Date.now(),
      });
      void prev;
    }
    lastEventAt = Date.now();
  } catch {
    /* keep last known prices */
  }
}

// v12.2 TASK-52 — SPOT-MIRROR fuel poll: active while BOTH WS lanes are dead
// AND the fapi pool is banned (source WS OFFLINE / WS·REST·SPOT). 10s cadence
// (last-resort freshness, ~480 weight/min on the spot pool — trivial).
async function spotPoll() {
  if (Date.now() < spotBannedUntil) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(SPOT_URL, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (res.status === 418 || res.status === 429) {
      spotBannedUntil = Date.now() + 60_000; // own pool, own soft backoff — no ledger write
      spotLastOkAt = 0;
      console.log("[price-ws] SPOT-MIRROR rung rate-limited — spot backoff 60s (separate pool, no fapi poke)");
      return;
    }
    if (!res.ok) return;
    const rows = (await res.json()) as Array<{ symbol: string; lastPrice: string; priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string }>;
    for (const r of rows) {
      if (!r.symbol.endsWith("USDT")) continue;
      prices.set(r.symbol, {
        symbol: r.symbol,
        price: Number(r.lastPrice),
        change24h: Number(r.priceChangePercent),
        high24h: Number(r.highPrice),
        low24h: Number(r.lowPrice),
        volume24h: Number(r.quoteVolume),
        at: Date.now(),
      });
    }
    lastEventAt = Date.now();
    if (spotLastOkAt === 0) console.log("[price-ws] SPOT-MIRROR fuel active — spot ticker/24hr feeding prices (fapi banned, WS lanes dead)");
    spotLastOkAt = Date.now();
  } catch {
    /* keep last known prices */
  }
}

function connect() {
  try {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      lastWsFrame = Date.now();
      source = "WS PUSH";
      console.log("[price-ws] miniTicker stream open");
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { data?: { s: string; c: string; o: string; h: string; l: string; q: string; E: number } };
        const d = msg.data;
        if (!d || !d.s.endsWith("USDT")) return;
        lastWsFrame = Date.now();
        prices.set(d.s, {
          symbol: d.s,
          price: Number(d.c),
          change24h: ((Number(d.c) - Number(d.o)) / Number(d.o)) * 100,
          high24h: Number(d.h),
          low24h: Number(d.l),
          volume24h: Number(d.q),
          at: d.E || Date.now(),
        });
        lastEventAt = Date.now();
      } catch {
        /* skip */
      }
    };
    ws.onclose = () => {
      console.log("[price-ws] stream closed — reconnect 5s");
      setTimeout(connect, 5000);
    };
    ws.onerror = () => {};
  } catch (err) {
    console.error("[price-ws] connect error", err);
    setTimeout(connect, 5000);
  }
}

// ── Bybit v5 public linear tickers WS (Task 35) ────────────────────────────
function bybitSubscribe(symbols: string[]) {
  if (!bybWs || bybWs.readyState !== WebSocket.OPEN) return;
  const toSub = symbols.filter((s) => s.endsWith("USDT") && !bybSubscribed.has(s));
  // Bybit v5: max 10 args per request — chunk politely.
  for (let i = 0; i < toSub.length; i += 10) {
    const args = toSub.slice(i, i + 10).map((s) => `tickers.${s}`);
    bybWs.send(JSON.stringify({ op: "subscribe", args }));
    for (const a of args) bybSubscribed.add(a.slice("tickers.".length));
  }
  if (toSub.length) console.log(`[price-ws] bybit subscribed +${toSub.length} (total ${bybSubscribed.size})`);
}
function connectBybit() {
  try {
    const ws = new WebSocket(BYBIT_WS);
    bybWs = ws;
    ws.onopen = () => {
      console.log("[price-ws] bybit linear tickers WS open");
      bybLastFrame = Date.now();
      bybSubscribed.clear();
      bybitSubscribe([...prices.keys()]);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          topic?: string; type?: string;
          data?: { symbol?: string; lastPrice?: string; price24hPcnt?: string; highPrice24h?: string; lowPrice24h?: string; turnover24h?: string };
        };
        if (msg.topic?.startsWith("tickers.") && msg.data?.symbol) {
          const sym = msg.data.symbol;
          if (!sym.endsWith("USDT")) return;
          bybLastFrame = Date.now();
          const base = bybPartial.get(sym) ?? { symbol: sym };
          const p: BybPartial = {
            ...base,
            symbol: sym,
            price: msg.data.lastPrice !== undefined ? Number(msg.data.lastPrice) : base.price,
            change24h: msg.data.price24hPcnt !== undefined ? Number(msg.data.price24hPcnt) * 100 : base.change24h,
            high24h: msg.data.highPrice24h !== undefined ? Number(msg.data.highPrice24h) : base.high24h,
            low24h: msg.data.lowPrice24h !== undefined ? Number(msg.data.lowPrice24h) : base.low24h,
            volume24h: msg.data.turnover24h !== undefined ? Number(msg.data.turnover24h) : base.volume24h,
          };
          bybPartial.set(sym, p);
          if (p.price && p.price > 0) {
            prices.set(sym, {
              symbol: sym,
              price: p.price,
              change24h: p.change24h ?? 0,
              high24h: p.high24h ?? p.price,
              low24h: p.low24h ?? p.price,
              volume24h: p.volume24h ?? 0,
              at: Date.now(),
            });
            lastEventAt = Date.now();
          }
        }
      } catch {
        /* skip */
      }
    };
    ws.onclose = () => {
      console.log("[price-ws] bybit stream closed — reconnect 5s");
      bybWs = null;
      setTimeout(connectBybit, 5000);
    };
    ws.onerror = () => {};
  } catch (err) {
    console.error("[price-ws] bybit connect error", err);
    setTimeout(connectBybit, 5000);
  }
}

// Bybit requires an app-level ping every ~20s to keep the session alive.
setInterval(() => {
  if (bybWs && bybWs.readyState === WebSocket.OPEN) bybWs.send(JSON.stringify({ op: "ping" }));
}, 20_000);

connect();
connectSpotWs(); // v12.8 — spot ring opens alongside the futures ring (whichever flows, fuels)
connectBybit();

// stall watchdog → fuel priority (binance futures WS > binance spot WS > bybit WS > REST > OFFLINE)
setInterval(() => {
  const wsAlive = Date.now() - lastWsFrame <= STALL_MS;
  const spotWsAlive = Date.now() - spotWsLastFrame <= STALL_MS;
  const bybAlive = Date.now() - bybLastFrame <= STALL_MS;
  const banned = Date.now() < restBannedUntil;
  let next: typeof source;
  if (wsAlive) next = "WS PUSH";
  else if (spotWsAlive) next = "WS·SPOT";
  else if (bybAlive) next = "WS·BYBIT";
  else if (banned) next = Date.now() - spotLastOkAt <= 30_000 ? "WS·REST·SPOT" : "WS OFFLINE";
  else next = "WS·REST 2.5S";
  if (source !== next) {
    console.log(`[price-ws] source → ${next}${!wsAlive && spotWsAlive ? " (futures fstream silent — spot-arr ring fuel, v12.8)" : ""}${!wsAlive && !spotWsAlive && bybAlive ? " (binance silent — bybit fuel)" : ""}${banned && !wsAlive && !spotWsAlive && !bybAlive && next === "WS OFFLINE" ? ` (REST ban until ${new Date(restBannedUntil).toISOString()})` : ""}${next === "WS·REST·SPOT" ? " (SPOT-MIRROR fuel rung, Task-52)" : ""}`);
    source = next;
  }
}, 5000);

setInterval(() => {
  if (source === "WS·REST 2.5S") void restPoll();
}, 2500);
setInterval(() => {
  // v12.2 TASK-52 — spot rung: while the fapi pool is banned and both WS
  // lanes are dead, feed prices from the spot pool every 10s instead of
  // sitting dark; the stall watchdog promotes the source label once fresh
  // spot rows land. Own pool, own backoff — the fapi ledger stays untouched.
  if (source === "WS OFFLINE" || source === "WS·REST·SPOT") void spotPoll();
}, 10_000);

// universe sync from terminal pulse
async function syncUniverse() {
  try {
    const res = await fetch("http://localhost:3000/api/pulse", { cache: "no-store" });
    if (!res.ok) return;
    const snap = (await res.json()) as { market?: Array<{ symbol: string }> };
    for (const m of snap.market ?? []) {
      if (!prices.has(m.symbol)) prices.set(m.symbol, { symbol: m.symbol, price: 0, change24h: 0, high24h: 0, low24h: 0, volume24h: 0, at: 0 });
    }
    bybitSubscribe([...prices.keys()]);
  } catch {
    /* terminal may be restarting */
  }
}
void syncUniverse();
setInterval(syncUniverse, 5 * 60_000);

const io = new Server(PORT, { cors: { origin: "*" }, path: "/" });

io.on("connection", (socket) => {
  socket.emit("prices:snapshot", {
    source,
    rows: [...prices.values()].filter((r) => r.price > 0),
  });
  socket.emit("price:source", { source, at: Date.now() });
});

setInterval(() => {
  const rows = [...prices.values()].filter((r) => r.price > 0);
  if (rows.length > 0) io.emit("prices", { source, rows, at: Date.now() });
}, 1000);

setInterval(() => {
  io.emit("price:source", { source, at: Date.now() });
}, 10_000);

console.log(`[price-ws] socket.io listening on :${PORT} — path /`);
