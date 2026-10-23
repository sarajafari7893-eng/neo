// ── NEXUS v12.11 — Binance spot !miniTicker@arr WS ring (server-only) ───────
// OPERATOR MANDATE (trace 1a16aaca/1a16ac16): «اگر جریانات اسپات کامل و
// معتبر نیست باید فقط از فیوچرز استفاده کرد» — the Binance anchor venue must
// be a REAL Binance plane, not sim drift or stale caches.
//
// WHY SPOT-ARR WS (evidence chain, 2026-10-23):
//   · fapi REST — 418 IP-banned (named-IP ledger). fstream (futures WS) —
//     ATTEMPTED and REFUTED this session: handshake OK but data MUTED from
//     this egress (sustain probe: btcusdt@aggTrade 240s ZERO frames with the
//     socket open; the earlier p50=30ms reading was a short-window burst
//     artifact — scripts/probe-fstream-symbols.ts kept as re-runnable
//     evidence). Per-symbol miniTicker and !arr equally silent. Binance
//     futures is therefore DATA-UNREACHABLE from this egress today — recorded
//     honestly, the fapi-revival task remains the structural fix.
//   · stream.binance.com SPOT WS — the ONE Binance plane that SUSTAINS here
//     (price-ws :3003 runs it for HOURS as its primary source, v12.8 ring-2).
//     Separate rate/ban pool from fapi; WS = zero REST weight; !miniTicker@arr
//     delivers the whole spot market as 1s array frames.
//   · SEMANTICS: for spot-listed symbols this is a genuine Binance price
//     (spot ≈ perp within bps — same doctrine as the v12.8 spot-mirror rung);
//     futures-only microcaps (JCT/BTW/BIR/MAGMA/IRYS — proven NOT listed on
//     spot) stay honestly NULL → the NO-BINANCE-CONFIRM +12 surcharge keeps
//     firing for exactly the cohort where no Binance ticket exists. The veto
//     reflects market fact, not infrastructure blindness — that is the
//     calibrated behavior the operator mandated.
//
// DESIGN: globalThis singleton (Turbopack dev re-eval safe, explicit teardown),
// one pooled connection, 90s quote freshness (illiquid spot symbols age out
// honestly), auto-reconnect with backoff, never throws.

const SPOT_WS_URL = "wss://stream.binance.com:9443/ws/!miniTicker@arr";
export const SPOTWS_FRESH_MS = 90_000;

interface SQuote {
  price: number;
  at: number; // exchange event time E
}

interface SpotWsState {
  ws: WebSocket | null;
  dead: boolean;
  quotes: Map<string, SQuote>;
  frames: number;
  lastFrameAt: number;
  backoffMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastErrAt: number;
  lastErr: string;
  lastLogAt: number;
}

const g = globalThis as unknown as { __nexusSpotWs?: SpotWsState };

function state(): SpotWsState {
  if (g.__nexusSpotWs) return g.__nexusSpotWs;
  const s: SpotWsState = {
    ws: null,
    dead: false,
    quotes: new Map(),
    frames: 0,
    lastFrameAt: 0,
    backoffMs: 2000,
    reconnectTimer: null,
    lastErrAt: 0,
    lastErr: "",
    lastLogAt: 0,
  };
  g.__nexusSpotWs = s;
  return s;
}

// hot-reload teardown: close the old socket before the new module eval spins up
if (g.__nexusSpotWs && !g.__nexusSpotWs.dead) {
  g.__nexusSpotWs.dead = true;
  try {
    g.__nexusSpotWs.ws?.close();
  } catch { /* already gone */ }
  g.__nexusSpotWs = undefined;
}

function connect(): void {
  const s = state();
  if (s.dead) return;
  try {
    const ws = new WebSocket(SPOT_WS_URL);
    s.ws = ws;
    ws.onopen = () => {
      s.backoffMs = 2000;
      console.log("[spotws-ring] open — Binance spot !miniTicker@arr venue plane (v12.11)");
    };
    ws.onmessage = (ev) => {
      try {
        const raw = JSON.parse(String(ev.data)) as unknown;
        const items = Array.isArray(raw)
          ? raw
          : raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)
            ? (raw as { data: Array<{ e?: string; s?: string; c?: string; E?: number }> }).data
            : [raw as { e?: string; s?: string; c?: string; E?: number }];
        for (const d of items) {
          if (!d || !d.s || !d.s.endsWith("USDT")) continue;
          const price = Number(d.c);
          if (!(price > 0)) continue;
          s.frames++;
          s.lastFrameAt = Date.now();
          s.quotes.set(d.s, { price, at: d.E || Date.now() });
        }
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
      console.log(`[spotws-ring] closed — reconnect in ${Math.round(wait / 1000)}s`);
      s.reconnectTimer = setTimeout(connect, wait);
    };
  } catch (err) {
    const s2 = state();
    s2.lastErrAt = Date.now();
    s2.lastErr = String(err).slice(0, 160);
    if (!s2.dead) s2.reconnectTimer = setTimeout(connect, s2.backoffMs);
  }
}

/** Lazy arm — the first venue sweep that needs the ring connects it. */
export function ensureSpotWsRing(): void {
  const s = state();
  if (s.dead || s.ws) return;
  if (!s.reconnectTimer) connect();
}

/** Fresh spot quotes (≤SPOTWS_FRESH_MS old, exchange-timestamped). */
export function spotwsFreshQuotes(symbols: string[]): Map<string, SQuote> {
  const s = state();
  const now = Date.now();
  const out = new Map<string, SQuote>();
  for (const sym of symbols) {
    const q = s.quotes.get(sym);
    if (!q) continue;
    if (now - q.at > SPOTWS_FRESH_MS) continue; // stale print — honest null
    out.set(sym, q);
  }
  return out;
}

/** Health/telemetry for consensus health + supervisor grounding. */
export function spotwsHealth(): { symbols: number; frames: number; lastFrameAgeMs: number | null; connected: boolean; lastErr: string | null } {
  const s = state();
  return {
    symbols: s.quotes.size,
    frames: s.frames,
    lastFrameAgeMs: s.lastFrameAt ? Date.now() - s.lastFrameAt : null,
    connected: !!s.ws && s.ws.readyState === WebSocket.OPEN,
    lastErr: s.lastErrAt && Date.now() - s.lastErrAt < 300_000 ? s.lastErr : null,
  };
}
