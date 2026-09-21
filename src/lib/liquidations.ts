// ── FlowRadar Neo liquidation feed client (server-only) ──
// Reads mini-services/liq-service (:3010). Honesty contract: when the stream
// is stalled or down we return null — never a fabricated "quiet tape".

const LIQ_URL = process.env.LIQ_SERVICE_URL ?? "http://localhost:3010";
const TIMEOUT_MS = 2500;
const CACHE_TTL = 20_000;

export interface LiqStatus {
  connected: boolean;
  dataStalled: boolean;
  buffered: number;
  lastEventAt: number | null;
  uptimeSec: number;
}

export interface LiqEvent {
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  usd: number;
  at: number;
}

export interface LiqSymbolRow {
  usd10m: number;
  usd1h: number;
  longsUsd10m: number;
  shortsUsd10m: number;
  count: number;
  last: number;
}

export interface LiqSnapshot {
  status: LiqStatus;
  recent: LiqEvent[];
  bySymbol: Record<string, LiqSymbolRow>;
}

let cache: { at: number; snap: LiqSnapshot | null } | null = null;
let inFlight: Promise<LiqSnapshot | null> | null = null;

export async function getLiquidationSnapshot(): Promise<LiqSnapshot | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.snap;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(`${LIQ_URL}/liquidations`, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`liq ${res.status}`);
      const snap = (await res.json()) as LiqSnapshot;
      cache = { at: Date.now(), snap };
      return snap;
    } catch {
      cache = { at: Date.now(), snap: null };
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** null when liq-service is down/unreachable. */
export async function getLiquidationStatus(): Promise<(LiqStatus & { online: boolean }) | null> {
  const snap = await getLiquidationSnapshot();
  if (!snap) return null;
  return { online: true, ...snap.status };
}

/** Real cascade probe for a symbol — null when feed stalled/down (honesty contract). */
export async function liquidationPressure(symbol: string): Promise<{ usd10m: number; longsUsd10m: number; shortsUsd10m: number } | null> {
  const snap = await getLiquidationSnapshot();
  if (!snap || snap.status.dataStalled || !snap.status.connected) return null;
  const row = snap.bySymbol[symbol];
  if (!row) return { usd10m: 0, longsUsd10m: 0, shortsUsd10m: 0 };
  return { usd10m: row.usd10m, longsUsd10m: row.longsUsd10m, shortsUsd10m: row.shortsUsd10m };
}
