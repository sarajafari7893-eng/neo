// ── FlowRadar Neo v6.2 macro layer — key-less Fear & Greed feed ─────────
// Architecture review P2 remediation: L4_MACRO was a PERMANENT OBSERVER
// ("no key-less measurable source — never fabricated"). There IS a key-less,
// free, measurable macro sentiment source: the Crypto Fear & Greed Index
// (alternative.me, no API key, aggregated from volatility/momentum/social/
// dominance/trend across the market). This module fetches it on a 30min
// cache with honest degradation: any failure returns null and the trigger
// bus keeps its previous honest "OBSERVING" declaration instead of inventing
// data. Extremes become measurable L4 context triggers (contrarian side).

const FNG_URL = "https://api.alternative.me/fng/?limit=1";
const CACHE_TTL_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 6000;

export interface MacroSnapshot {
  value: number; // 0..100
  classification: string; // "Extreme Fear" … "Extreme Greed"
  fetchedAt: number;
}

let cache: MacroSnapshot | null = null;
let inflight: Promise<MacroSnapshot | null> | null = null;
let lastError: string | null = null;

async function fetchFng(): Promise<MacroSnapshot | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(FNG_URL, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      return null;
    }
    const json = (await res.json()) as { data?: Array<{ value?: string; value_classification?: string }> };
    const row = json.data?.[0];
    const value = Number(row?.value);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      lastError = "malformed payload";
      return null;
    }
    lastError = null;
    return { value, classification: row?.value_classification ?? "Unknown", fetchedAt: Date.now() };
  } catch (e) {
    lastError = e instanceof Error ? e.name : "network error";
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cached macro snapshot — null while the source is unreachable (honest gap preserved). */
export async function getMacroSnapshot(): Promise<MacroSnapshot | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
  if (!inflight) {
    inflight = fetchFng()
      .then((snap) => {
        if (snap) cache = snap;
        return snap;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Synchronous peek for sync contexts (trigger bus summary) — may be null until first successful fetch. */
export function peekMacro(): MacroSnapshot | null {
  return cache;
}

export function macroHealth(): { hasData: boolean; value: number | null; classification: string | null; ageMin: number | null; lastError: string | null } {
  if (!cache) return { hasData: false, value: null, classification: null, ageMin: null, lastError };
  return {
    hasData: true,
    value: cache.value,
    classification: cache.classification,
    ageMin: Math.round((Date.now() - cache.fetchedAt) / 60_000),
    lastError: null,
  };
}
