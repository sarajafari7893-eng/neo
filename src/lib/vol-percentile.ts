// ── v10.14 REGIME-ADAPTIVE BARRIER CAP — realized-vol percentile (server-only) ──
// SUPERVISOR proposal 2026-09-19T06:51Z (terminal thought, phase=propose),
// operator APPROVE 2026-09-19T08:56Z bridge msg 861802419
// («پیشنهادات سوپروایزر رو کامل و مهندسی انجام بده»).
//
// WHY: both RAW-CAL issuance droughts (139min + 141min) had the identical
// signature — sweep healthy (best |score| 68 vs MIN_SCORE 35) while 100% of
// the blocks were vol-scaled-barrier t1r 724-4932m vs the FIXED 240m cap.
// In compression regimes the barrier math says "slow" and the cap kills every
// candidate — yet the cohort's best trade (GUSDT BREAKOUT TP3 +95.2%) is
// exactly a compression-expansion capture. Literature (validated via web
// search 2026-09-19): Lopez de Prado's triple-barrier vertical barrier is
// widely critiqued as a fixed-time constant; practitioners set it from
// holding-time / vol distribution percentiles; volatility compression
// precedes expansion.
//
// MECHANISM (exact proposal formula):
//   volPctile = realized-vol percentile of the symbol vs its own 30d history
//   cap_m     = base                                    if volPctile >= 30
//             = clamp(base*(1 + 2*(30-volPctile)/30), base, 3*base) otherwise
//   (base 240 → ceiling 720m at volPctile 0, linear in between — the proposal
//   hard-codes [240, 720]; 3×base reproduces that at the default knob and
//   stays coherent if the operator ever moves volBarrierCapMin.)
//
// FAIL-OPEN POLICY: any fetch/math failure → null → the caller falls back to
// the FIXED base cap (exact pre-change behavior). A null volPctile NEVER
// widens the cap. Results cached 30min per symbol (the regime is a slow
// variable; the deploy path must not pay a klines round-trip per evaluation),
// failures cached 5min so a Binance hiccup cannot hammer the feed.

import { fetchKlines } from "@/lib/market-feed";

const CACHE_TTL_MS = 30 * 60_000; // 30min — regime is a slow variable
const FAIL_TTL_MS = 5 * 60_000; // 5min — backoff after a failed fetch
const BARS_1H = 720; // 30d of hourly bars (single ≤1000-limit request)
const SIGMA_WINDOW = 24; // realized-vol window = 24h of hourly returns
const MIN_SAMPLES = 200; // need a real distribution to rank against

interface CacheRow {
  at: number;
  volPctile: number | null;
}

const cache = new Map<string, CacheRow>(); // symbol → {at, volPctile}

function stdev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / n; // population (ddof 0)
  return Math.sqrt(v);
}

/** Percentile rank (0..100) of the CURRENT 24h realized vol within the
 * symbol's own 30d distribution of 24h realized vols. Pure rank — unit-free,
 * robust to per-symbol vol scale (a rank, not a level). */
export async function realizedVolPctile(symbol: string): Promise<number | null> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < (hit.volPctile === null ? FAIL_TTL_MS : CACHE_TTL_MS)) return hit.volPctile;
  try {
    const candles = await fetchKlines(symbol, "1h", BARS_1H);
    if (!candles || candles.length < SIGMA_WINDOW + MIN_SAMPLES) throw new Error(`insufficient history ${candles?.length ?? 0}`);
    const rets: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1]!.close;
      if (prev > 0) rets.push((candles[i]!.close - prev) / prev);
    }
    // rolling 24h realized vol at each hourly step
    const vols: number[] = [];
    for (let i = SIGMA_WINDOW; i < rets.length; i++) vols.push(stdev(rets.slice(i - SIGMA_WINDOW, i)));
    if (vols.length < MIN_SAMPLES) throw new Error(`insufficient vol samples ${vols.length}`);
    const cur = vols[vols.length - 1]!;
    if (!(cur > 0)) throw new Error("degenerate current vol");
    let below = 0;
    for (const v of vols) if (v <= cur) below++;
    const pct = (below / vols.length) * 100;
    cache.set(symbol, { at: Date.now(), volPctile: pct });
    return pct;
  } catch {
    cache.set(symbol, { at: Date.now(), volPctile: null });
    return null;
  }
}

/** The proposal formula, verbatim semantics: volPctile ≥ 30 → base (current
 * behavior); below 30 → linear relaxation up to 3×base (240→720 at default)
 * as vol compresses toward the 0th percentile. base is the operator's
 * volBarrierCapMin knob — the knob itself is NOT modified. */
export function adaptiveBarrierCap(baseCap: number, volPctile: number): number {
  if (!(volPctile >= 0) || !(volPctile <= 100)) return baseCap; // fail-closed
  if (volPctile >= 30) return baseCap;
  const relaxed = baseCap * (1 + (2 * (30 - volPctile)) / 30);
  return Math.min(baseCap * 3, Math.max(baseCap, relaxed));
}
