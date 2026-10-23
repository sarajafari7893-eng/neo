// ── NEXUS v12.11 — Binance USDT-M futures aggTrade WS ring (server-only) ────
// OPERATOR MANDATE (trace 1a16aaca / 1a16ac16): «اگر جریانات اسپات کامل و
// معتبر نیست باید فقط از فیوچرز استفاده کرد» — the Binance anchor venue must
// come from the FUTURES plane, not spot overlays.
//
// ROOT CAUSE CHAIN (measured live, probe scripts/probe-fstream-symbols.ts
// 2026-10-23 ~22:0xZ + scripts/venue-latency-probe.ts v12.10):
//   · BOTH Binance REST planes (fapi + spot pool) are 418-banned from this
//     egress → BINANCE venue row null → NO-BINANCE-CONFIRM +12 fired on every
//     multi-venue microcap deploy (anchor venue absent by INFRASTRUCTURE,
//     not by market fact).
//   · fstream WS handshake SUCCEEDS and per-symbol streams DELIVER —
//     IRYSUSDT@aggTrade measured 4280 frames/20s (~214/s, ttfb 186ms),
//     BTCUSDT@trade 196/20s (ttfb 527ms). The suppression is SELECTIVE:
//     miniTicker summary streams (both !arr and per-symbol) are silent, the
//     RAW TRADE TAPE flows. aggTrade is richer anyway: every executed trade
//     with price/qty/exchange-time — the market itself, not a summary.
//   · WS lives in a separate rate/ban pool from REST — zero fapi-gate weight,
//     zero ban-escalation risk (Task-50 law respected: no REST contact).
//
// DESIGN:
//   · ONE pooled connection, dynamic SUBSCRIBE/UNSUBSCRIBE (futures WS allows
//     200 streams/conn, 10 incoming msgs/s — we chunk 100/param-batch, paced).
//   · Cap 250 hot symbols (FIFO eviction of cold subs) — the sweep working set
//     (hot lane 64 + deploy candidates) stays well inside.
//   · Quote freshness 90s (trade-print staleness — illiquid symbols with no
//     trades honestly age out to null; REST rungs still cover them).
//   · Hot-reload safe: globalThis singleton with explicit teardown.
//   · NEVER throws — the venue ladder (rung 0 WS → rung 1 fapi → rung 2 spot
//     mirror) degrades exactly like today when the ring is dark.

const FSTREAM_WS = "wss://fstream.binance.com/ws";
const MAX_SUBS = 250;
const SUB_CHUNK = 100; // params per SUBSCRIBE message (limit 200/conn — headroom)
const SUB_GAP_MS = 350; // ≤10 incoming messages/sec — polite pacing
export const FSTREAM_FRESH_MS = 90_000;

interface FQuote {
  price: number;
  at: number; // exchange trade time (E), not local receipt
}

interface FstreamState {
  ws: WebSocket | null;
  dead: boolean; // hot-reload teardown flag — stop reconnect loops
  subs: Map<string, number>; // SYMBOL → first-subscribed-at (FIFO eviction order)
  quotes: Map<string, FQuote>;
  msgId: number;
  lastFrameAt: number;
  frames: number;
  backoffMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastErrAt: number;
  lastErr: string;
  lastLogAt: number;
}

// globalThis singleton — Turbopack dev re-evals modules; the previous
// instance's sockets must be torn down explicitly or they linger.
const g = globalThis as unknown as { __nexusFstream?: FstreamState };

function state(): FstreamState {
  if (g.__nexusFstream) return g.__nexusFstream;
  const s: FstreamState = {
    ws: null,
    dead: false,
    subs: new Map(),
    quotes: new Map(),
    msgId: 1,
    lastFrameAt: 0,
    frames: 0,
    backoffMs: 2000,
    reconnectTimer: null,
    lastErrAt: 0,
    lastErr: "",
    lastLogAt: 0,
  };
  g.__nexusFstream = s;
  return s;
}

// hot-reload teardown: close the old socket BEFORE the new module eval spins up
if (g.__nexusFstream && !g.__nexusFstream.dead) {
  g.__nexusFstream.dead = true;
  try {
    g.__nexusFstream.ws?.close();
  } catch { /* already gone */ }
  g.__nexusFstream = undefined;
}

function lower(sym: string): string {
  return `${sym.replace(/USDT$/, "").toLowerCase()}usdt@aggTrade`;
}

function sendChunked(s: FstreamState, method: "SUBSCRIBE" | "UNSUBSCRIBE", streams: string[]): void {
  for (let i = 0; i < streams.length; i += SUB_CHUNK) {
    const chunk = streams.slice(i, i + SUB_CHUNK);
    setTimeout(() => {
      if (s.dead || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
      try {
        s.ws.send(JSON.stringify({ method, params: chunk, id: s.msgId++ }));
      } catch { /* socket died mid-send — reconnect path owns recovery */ }
    }, (i / SUB_CHUNK) * SUB_GAP_MS);
  }
}

function connect(): void {
  const s = state();
  if (s.dead) return;
  try {
    const ws = new WebSocket(FSTREAM_WS);
    s.ws = ws;
    ws.onopen = () => {
      s.backoffMs = 2000;
      // resubscribe everything the ring owns (fresh connection = empty session)
      const all = [...s.subs.keys()].map(lower);
      if (all.length) sendChunked(s, "SUBSCRIBE", all);
      console.log(`[fstream-ring] open — resubscribed ${all.length} stream(s)`);
    };
    ws.onmessage = (ev) => {
      try {
        const raw = JSON.parse(String(ev.data)) as
          | { e?: string; s?: string; p?: string; E?: number; T?: number }
          | { stream?: string; data?: { e?: string; s?: string; p?: string; E?: number; T?: number } }
          | { result?: unknown; id?: number };
        // subscription acks / pong payloads — no quote
        if (!("e" in raw) && !("data" in raw)) return;
        const d = "data" in raw && raw.data ? raw.data : (raw as { e?: string; s?: string; p?: string; E?: number; T?: number });
        if (d.e !== "aggTrade" || !d.s || !d.p) return;
        const price = Number(d.p);
        if (!(price > 0)) return;
        s.frames++;
        s.lastFrameAt = Date.now();
        s.quotes.set(d.s, { price, at: d.E || d.T || Date.now() });
      } catch { /* skip malformed frame */ }
    };
    ws.onerror = () => {
      s.lastErrAt = Date.now();
      s.lastErr = "socket error";
    };
    ws.onclose = () => {
      if (s.dead || s.ws !== ws) return;
      s.ws = null;
      const wait = s.backoffMs;
      s.backoffMs = Math.min(s.backoffMs * 2, 60_000);
      console.log(`[fstream-ring] closed — reconnect in ${Math.round(wait / 1000)}s`);
      s.reconnectTimer = setTimeout(connect, wait);
    };
  } catch (err) {
    const s2 = state();
    s2.lastErrAt = Date.now();
    s2.lastErr = String(err).slice(0, 160);
    if (!s2.dead) s2.reconnectTimer = setTimeout(connect, s2.backoffMs);
  }
}

/** Idempotent subscription management — call with whatever symbols the current
 * sweep needs. Grows the ring, FIFO-evicts cold subs past the cap, keeps the
 * socket warm. Never throws. */
export function ensureFstreamSubs(symbols: string[]): void {
  const s = state();
  if (s.dead) return;
  const wanted: string[] = [];
  for (const sym of symbols) {
    if (!sym.endsWith("USDT")) continue;
    if (!s.subs.has(sym)) wanted.push(sym);
  }
  if (wanted.length) {
    // FIFO eviction: oldest subs not in the wanted batch leave first
    let over = s.subs.size + wanted.length - MAX_SUBS;
    if (over > 0) {
      const evict: string[] = [];
      for (const [sym, since] of [...s.subs.entries()].sort((a, b) => a[1] - b[1])) {
        if (over <= 0) break;
        if (wanted.includes(sym)) continue;
        evict.push(sym);
        s.subs.delete(sym);
        s.quotes.delete(sym);
        over--;
      }
      if (evict.length) {
        if (s.ws && s.ws.readyState === WebSocket.OPEN) sendChunked(s, "UNSUBSCRIBE", evict.map(lower));
      }
    }
    const now = Date.now();
    for (const sym of wanted) s.subs.set(sym, now);
    if (s.ws && s.ws.readyState === WebSocket.OPEN) sendChunked(s, "SUBSCRIBE", wanted.map(lower));
    else if (!s.ws && !s.reconnectTimer) connect();
    if (Date.now() - s.lastLogAt > 600_000) {
      s.lastLogAt = Date.now();
      console.log(`[fstream-ring] subs=${s.subs.size} +${wanted.length} new (cap ${MAX_SUBS}) — aggTrade venue plane v12.11`);
    }
  } else if (!s.ws && !s.reconnectTimer && s.subs.size > 0) {
    connect();
  }
}

/** Fresh trade-print quotes (≤FSTREAM_FRESH_MS old, exchange-timestamped). */
export function fstreamFreshQuotes(symbols: string[]): Map<string, FQuote> {
  const s = state();
  const now = Date.now();
  const out = new Map<string, FQuote>();
  for (const sym of symbols) {
    const q = s.quotes.get(sym);
    if (!q) continue;
    if (now - q.at > FSTREAM_FRESH_MS) continue; // stale print — honest null, REST rungs cover
    out.set(sym, q);
  }
  return out;
}

/** Health/telemetry for the consensus health card + supervisor grounding. */
export function fstreamHealth(): { subs: number; frames: number; lastFrameAgeMs: number | null; connected: boolean; lastErr: string | null } {
  const s = state();
  return {
    subs: s.subs.size,
    frames: s.frames,
    lastFrameAgeMs: s.lastFrameAt ? Date.now() - s.lastFrameAt : null,
    connected: !!s.ws && s.ws.readyState === WebSocket.OPEN,
    lastErr: s.lastErrAt && Date.now() - s.lastErrAt < 300_000 ? s.lastErr : null,
  };
}
