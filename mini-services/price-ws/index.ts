// ── NEXUS price-ws (:3003, socket.io) — sub-second price push ──
// Binance futures miniTicker combined stream with the stall-watchdog fallback:
// when WS frames are stripped by the sandbox egress, demotes to REST polling
// /fapi/v1/ticker/24hr every 2.5s and labels the source honestly.
// Universe auto-syncs from the terminal pulse every 5min.

import { Server } from "socket.io";

const PORT = 3003;
const WS_URL = "wss://fstream.binance.com/stream?streams=!miniTicker@arr";
const REST_URL = "https://fapi.binance.com/fapi/v1/ticker/24hr";
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
let source: "WS PUSH" | "WS·REST 2.5S" | "WS OFFLINE" = "WS PUSH";
let lastWsFrame = 0;
let lastEventAt: number | null = null;
// v10.7 ban-awareness (2026-09-17 dashboard audit): Binance 418/429 IP bans
// auto-extend when the REST fallback keeps hammering. Respect retry-after,
// stop polling while banned, and label the source honestly (WS OFFLINE)
// instead of a live-looking "WS·REST 2.5S" badge over frozen rows.
let restBannedUntil = 0;

async function restPoll() {
  if (Date.now() < restBannedUntil) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(REST_URL, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (res.status === 418 || res.status === 429) {
      const ra = Number(res.headers.get("retry-after") ?? 0);
      const until = Date.now() + Math.min(Math.max(ra, 60), 4 * 3600) * 1000;
      if (until > restBannedUntil) {
        console.log(`[price-ws] REST ${res.status} IP-ban/ratelimit — backing off until ${new Date(until).toISOString()}`);
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

connect();

// stall watchdog → REST fallback (ban-aware, v10.7)
setInterval(() => {
  const wsAlive = Date.now() - lastWsFrame <= STALL_MS;
  if (wsAlive) {
    if (source !== "WS PUSH") console.log("[price-ws] WS frames live — source WS PUSH");
    source = "WS PUSH";
    return;
  }
  const banned = Date.now() < restBannedUntil;
  const next: typeof source = banned ? "WS OFFLINE" : "WS·REST 2.5S";
  if (source !== next) {
    console.log(`[price-ws] source → ${next}${banned ? ` (REST ban until ${new Date(restBannedUntil).toISOString()})` : " — demoting to REST poll 2.5s"}`);
    source = next;
  }
}, 5000);

setInterval(() => {
  if (source === "WS·REST 2.5S") void restPoll();
}, 2500);

// universe sync from terminal pulse
async function syncUniverse() {
  try {
    const res = await fetch("http://localhost:3000/api/pulse", { cache: "no-store" });
    if (!res.ok) return;
    const snap = (await res.json()) as { market?: Array<{ symbol: string }> };
    for (const m of snap.market ?? []) {
      if (!prices.has(m.symbol)) prices.set(m.symbol, { symbol: m.symbol, price: 0, change24h: 0, high24h: 0, low24h: 0, volume24h: 0, at: 0 });
    }
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
