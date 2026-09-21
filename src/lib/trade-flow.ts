// ── NEXUS//SIGNALS Real-Tape client (server-only) ──
// Thin, fault-tolerant client for the trade-service mini-service
// (mini-services/trade-service, port 3011) which ingests REAL Binance
// USDT-M aggregate trades (WS !aggTrade with incremental REST fallback)
// and computes per-symbol real CVD, CVD-vs-price divergence (classic +
// hidden, ZitaPlus/LuxAlgo taxonomy) and VPIN-lite.
//
// HONESTY CONTRACT: if the service is down, stalled or a symbol has no
// tape yet this returns null — the research stack then reports the factor
// as UNAVAILABLE. Nothing is ever invented here.

const TAPE_URL = process.env.TRADE_SERVICE_URL ?? "http://127.0.0.1:3011";
const FETCH_TIMEOUT_MS = 2500;
const SNAP_TTL_MS = 15_000;

export interface TapeDivergence {
  type: "CLASSIC_BULL" | "CLASSIC_BEAR" | "HIDDEN_BULL" | "HIDDEN_BEAR";
  strengthPct: number;
  at: number;
}

export interface TapeFlow {
  cvd15mUsd: number;
  cvd1hUsd: number;
  vol15mUsd: number;
  vol1hUsd: number;
  cvd15mPct: number;
  cvd1hPct: number;
  divergence: TapeDivergence | null;
  vpin: { value: number; buckets: number } | null;
  lastPrice: number;
  minutes: number;
}

export interface TapeSnapshot {
  ts: number;
  connected: boolean;
  dataStalled: boolean;
  source: string;
  flow: TapeFlow | null;
}

interface CacheEntry {
  snap: TapeSnapshot;
  ts: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<TapeSnapshot | null>>();

async function fetchFlow(symbol: string): Promise<TapeSnapshot | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${TAPE_URL}/flow?symbol=${encodeURIComponent(symbol)}`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = (await res.json()) as TapeSnapshot;
    cache.set(symbol, { snap, ts: Date.now() });
    return snap;
  } catch {
    clearTimeout(t);
    return null;
  }
}

/** Fresh (<15s) per-symbol real-tape block or null when unreachable/empty. */
export async function getTapeFlow(symbol: string): Promise<TapeSnapshot | null> {
  const c = cache.get(symbol);
  if (c && Date.now() - c.ts < SNAP_TTL_MS) return c.snap;
  const running = inFlight.get(symbol);
  if (running) return running;
  const job = fetchFlow(symbol).finally(() => {
    inFlight.delete(symbol);
  });
  inFlight.set(symbol, job);
  return job;
}

/** The real-tape block only (null when service down/stalled/no data). */
export async function getTape(symbol: string): Promise<TapeFlow | null> {
  const snap = await getTapeFlow(symbol);
  if (!snap || !snap.flow) return null;
  if (snap.dataStalled && snap.source !== "REST") return null; // frames stripped, no fallback — no numbers
  return snap.flow;
}

/** Register the engine's universe as the REST ingest watchlist (fire-and-forget). */
export async function syncTapeWatchlist(symbols: string[]): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${TAPE_URL}/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols: symbols.slice(0, 80) }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export interface TapeHealth {
  reachable: boolean;
  connected: boolean;
  source: string;
  symbols: number;
  trades: number;
  dataStalled: boolean;
}

export async function getTapeHealth(): Promise<TapeHealth> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${TAPE_URL}/health`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!res.ok) throw new Error("bad status");
    const h = (await res.json()) as {
      connected: boolean;
      source: string;
      symbols: number;
      trades: number;
      dataStalled: boolean;
    };
    return {
      reachable: true,
      connected: h.connected,
      source: h.source ?? "UNKNOWN",
      symbols: h.symbols ?? 0,
      trades: h.trades ?? 0,
      dataStalled: h.dataStalled !== false,
    };
  } catch {
    return { reachable: false, connected: false, source: "OFFLINE", symbols: 0, trades: 0, dataStalled: true };
  }
}
