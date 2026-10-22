// ── FlowRadar Neo market-regime classifier (server-only, v6.3) ──
// Layer-0 filter for the trigger hierarchy: every candidate is priced by the
// regime it lives in. TREND regimes punish counter-trend entries, CHOP punishes
// breakout chasing, VOLATILE cuts size and widens stops.
// Pure candle math — no invented data: everything derives from real klines.
//
// ── v6.3 REGIME FILTER HARDENING (operator mandate #2) ──
// Grounds: live ledger showed 94% of deploys landed in CHOP (WR 41%, net −$)
// while TREND deploys won 83% — the old soft penalties (−7 score, ×0.8 size)
// did not actually keep the engine out of rotational chop. Changes:
//   · RegimeRuling gains thrAdj — a per-candidate MIN_SCORE threshold
//     adjustment. MIN_SCORE stops being one flat number: the EFFECTIVE
//     threshold = gate.minScore + thrAdj (+ BTC spillover at guard L2).
//   · regimeGuard levels (governor-owned knob):
//       L0 — legacy soft penalties only
//       L1 — HARD VETO: BREAKOUT/MOMENTUM in strong chop (strength ≥ 0.6);
//            heavy threshold surcharge (+10) in moderate chop
//       L2 — full guard: + BTC-spillover counter-trend surcharge (engine
//            applies btcSpilloverThrAdj) + MEAN-REVERT veto in VOLATILE
//   · Per-regime outcome telemetry (n/wins/net $) persisted so the governor
//     reads a REGIME LEDGER each cycle and tunes regimeGuard from evidence.

import { db } from "@/lib/db";
import type { Candle } from "./market-feed";
import { atr, ema } from "./indicators";

export type RegimeId = "TREND_UP" | "TREND_DOWN" | "CHOP" | "VOLATILE";

export interface MarketRegime {
  regime: RegimeId;
  /** 0..1 — how strongly the regime asserts itself */
  strength: number;
  atrPct: number;
  /** EMA9-EMA21 spread normalized by ATR (signed) */
  trendPct: number;
  /** realized-vol percentile of current ATR% vs trailing window (0..1) */
  volPctile: number;
  /** directional efficiency: net move / sum of absolute per-candle moves (0..1) */
  efficiency: number;
  label: string;
  note: string;
}

export interface RegimeRuling {
  ok: boolean;
  reason?: string;
  /** margin multiplier applied on deployment */
  sizeMult: number;
  /** stop-distance multiplier applied on deployment */
  slMult: number;
  /** score adjustment applied before MIN_SCORE comparison */
  scoreAdj: number;
  /** v6.3 threshold adjustment — EFFECTIVE MIN_SCORE = base + thrAdj for this candidate */
  thrAdj: number;
  tag: string;
}

const memo = new Map<string, { at: number; regime: MarketRegime }>();
const MEMO_TTL = 90_000;

function percentileRank(series: number[], v: number): number {
  if (series.length < 5) return 0.5;
  const below = series.filter((x) => x <= v).length;
  return below / series.length;
}

/** Classify the current regime of a symbol from its recent candles. */
export function classifyRegime(candles: Candle[]): MarketRegime | null {
  if (candles.length < 80) return null;
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1]!;

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const emaSpreadPct = ((e9[e9.length - 1]! - e21[e21.length - 1]!) / e21[e21.length - 1]!) * 100;
  const a = atr(candles);
  const atrPct = a > 0 ? (a / price) * 100 : 0.5;
  const trendPct = a === 0 ? 0 : (emaSpreadPct / a) * 100;

  // realized-vol percentile: current ATR% vs trailing 80-candle rolling ATR%
  const volSeries: number[] = [];
  for (let i = Math.max(15, candles.length - 80); i < candles.length; i++) {
    const seg = candles.slice(Math.max(0, i - 14), i + 1);
    const av = atr(seg);
    volSeries.push((av / seg[seg.length - 1]!.close) * 100);
  }
  const volPctile = percentileRank(volSeries, atrPct);

  // directional efficiency over last 24 completed candles (Kaufman-style)
  const win = candles.slice(-25, -1);
  const net = Math.abs(win[win.length - 1]!.close - win[0]!.open);
  const path = win.reduce((s, c) => s + Math.abs(c.close - c.open) + Math.abs(c.high - c.low), 0) / 2;
  const efficiency = path === 0 ? 0 : Math.min(1, net / path);

  let regime: RegimeId;
  let note: string;
  if (volPctile >= 0.88 && Math.abs(trendPct) < 2.2) {
    regime = "VOLATILE";
    note = `ATR% ${atrPct.toFixed(2)} at ${Math.round(volPctile * 100)}th pctile — expansion regime, size cut`;
  } else if (Math.abs(trendPct) >= 1.1 && efficiency >= 0.33) {
    regime = trendPct > 0 ? "TREND_UP" : "TREND_DOWN";
    note = `EMA spread ${emaSpreadPct.toFixed(2)}% = ${Math.abs(trendPct).toFixed(1)}×ATR with ${(efficiency * 100).toFixed(0)}% path efficiency — ${trendPct > 0 ? "markup" : "markdown"} trend`;
  } else {
    regime = "CHOP";
    note = `path efficiency ${(efficiency * 100).toFixed(0)}% below threshold — rotational chop, breakouts decay`;
  }

  const strength =
    regime === "VOLATILE"
      ? Math.min(1, (volPctile - 0.7) / 0.3)
      : Math.min(1, Math.abs(trendPct) / 2.6) * 0.6 + efficiency * 0.4;

  const label =
    regime === "TREND_UP" ? "TREND ▲" : regime === "TREND_DOWN" ? "TREND ▼" : regime === "CHOP" ? "CHOP ∿" : "VOLATILE ⚡";

  return { regime, strength: Number(strength.toFixed(2)), atrPct: Number(atrPct.toFixed(2)), trendPct: Number(trendPct.toFixed(2)), volPctile: Number(volPctile.toFixed(2)), efficiency: Number(efficiency.toFixed(2)), label, note };
}

/** Memoized regime lookup keyed by symbol (engine klines pass-through). */
export function getRegimeCached(symbol: string, candles: Candle[]): MarketRegime | null {
  if (!candles || candles.length < 80) return null;
  const hit = memo.get(symbol);
  if (hit && Date.now() - hit.at < MEMO_TTL) return hit.regime;
  const r = classifyRegime(candles);
  if (r) memo.set(symbol, { at: Date.now(), regime: r });
  return r;
}

export function peekRegime(symbol: string): MarketRegime | null {
  const hit = memo.get(symbol);
  return hit && Date.now() - hit.at < MEMO_TTL * 4 ? hit.regime : null;
}

/**
 * Regime ruling for a candidate — the LAYER-0 gate of the trigger hierarchy.
 * confStrategy is used to judge alignment (MEAN-REVERT is counter-trend by design).
 * v6.3: guard level (gate.regimeGuard) hardens chop/vol handling; every ruling
 * now also carries thrAdj so the effective deployment threshold is dynamic.
 */
export function regimeRuling(regime: MarketRegime | null, direction: "LONG" | "SHORT", strategy: string, guard = 1): RegimeRuling {
  if (!regime) return { ok: true, sizeMult: 1, slMult: 1, scoreAdj: 0, thrAdj: 0, tag: "REGIME-UNKNOWN" };
  const long = direction === "LONG";

  if (regime.regime === "TREND_UP") {
    if (!long && strategy === "MEAN-REVERT") return { ok: false, reason: `TREND ▲ (${regime.note}) — counter-trend short mean-revert vetoed`, sizeMult: 0, slMult: 1, scoreAdj: 0, thrAdj: 0, tag: "REGIME-TREND-UP" };
    if (!long) return { ok: true, sizeMult: 0.75, slMult: 1.1, scoreAdj: -6, thrAdj: 8, reason: "short against markup trend — penalized (+8 threshold)", tag: "REGIME-TREND-UP" };
    return { ok: true, sizeMult: 1, slMult: 1, scoreAdj: 4, thrAdj: -5, reason: "with-trend long in markup (−5 threshold: trend alignment admits more)", tag: "REGIME-TREND-UP" };
  }
  if (regime.regime === "TREND_DOWN") {
    if (long && strategy === "MEAN-REVERT") return { ok: false, reason: `TREND ▼ (${regime.note}) — counter-trend long mean-revert vetoed`, sizeMult: 0, slMult: 1, scoreAdj: 0, thrAdj: 0, tag: "REGIME-TREND-DOWN" };
    if (long) return { ok: true, sizeMult: 0.75, slMult: 1.1, scoreAdj: -6, thrAdj: 8, reason: "long against markdown trend — penalized (+8 threshold)", tag: "REGIME-TREND-DOWN" };
    return { ok: true, sizeMult: 1, slMult: 1, scoreAdj: 4, thrAdj: -5, reason: "with-trend short in markdown (−5 threshold: trend alignment admits more)", tag: "REGIME-TREND-DOWN" };
  }
  if (regime.regime === "CHOP") {
    // ── v9.3 STRONGER CHOP LADDER (operator mandate — «فیلتر قوی‌تر CHOP») ──
    // REGIME LEDGER evidence: 197 of 218 EPOCH-2 closes carried REGIME-CHOP at
    // WR 25.9% / −$29.98 — the old ladder (veto only BREAKOUT/MOMENTUM in
    // strong chop) let the other strategies bleed freely. New guard-governed
    // ladder: L1 vetoes ALL breakout/momentum in ANY chop and taxes every
    // other strategy hard in strong chop; L2 vetoes everything in chop.
    // (v9.4 amendment below: L2 is now the ASYMMETRIC activation — SHORT
    // admitted through the tax ladder, LONG stays vetoed, ledger-cited.)
    //
    // ── v9.4 ASYMMETRIC CHOP LADDER (EQ-100 operator mandate 2026-10-13:
    // «ممیزی کامل … رژیم CHOP را فعال کن») — the blanket L2 chop stop was an
    // over-fit to the AGGREGATE ledger (CHOP cell n=2011 WR 34% net −$16.12).
    // Deep direction-split forensics of the same ledger (EQ-100 audit,
    // 1795 settled REGIME-CHOP rows): the damage is entirely LONG-side while
    // the SHORT book EARNED in every window, including under the CURRENT
    // guard stack (shortGuard=1 HTF-align + QUAD-SHORT + STRATW, FLAT-10):
    //   LONG  book: −$123.69 all-time (n=1031) · −$111.22 Oct · −$108.09 W41+42
    //   SHORT book:  +$37.42 all-time (n=621)  ·  +$37.67 Oct ·  +$40.49 W41+42
    //     AI-SWING|SHORT  +$36.89 W41+42 (n=105, WR 41%)
    //     MEAN-REVERT|SHORT +$12.04 W41+42 (n=51, WR 56.9% — doctrinal rotation fit)
    //   Structural driver: 86% of CHOP rows never touch TP1 (1537/1795
    //   reachedTp=0) — LONGs round-trip via EXPIRED fees + deep −1R stops,
    //   while counter-rotation shorts monetize the decay.
    // L2 is therefore RE-OPENED asymmetrically: LONG vetoed (evidence-ledger),
    // SHORT admitted through the L1 tax ladder (strong chop ×0.7/+10thr,
    // moderate ×0.85/+6thr) — FLAT-10 keeps every margin at exactly $10, the
    // size multipliers remain TAG-ONLY audit metadata. BREAKOUT/MOMENTUM keep
    // their unconditional hard veto (0/9, −$2.58 in chop).
    const strongChop = regime.strength >= 0.6;
    // ── v11.6 CHOP FINAL ACTIVATION (EQ-100 re-audit 2026-10-14, full 2411-row
    // ledger restored from GitHub d7cef8d) ── the asymmetric verdict is
    // CONFIRMED on the complete book:
    //   CHOP all-time: LONG −$959.39 (n=1100, WR 33.3%) · SHORT +$1171.84
    //   (n=812, WR 36.3%). Anatomy: TP1-touch LONG 18.7% vs SHORT 20.3%;
    //   expired-drift LONG −2.95% vs SHORT +0.70%; avgLoss −9.61 vs avgWin
    //   +18.5 — rotational decay bleeds longs and monetizes shorts.
    //   Recent-14d CHOP SHORT cells: AI-SWING +$657.31 (n=266, WR 41.4%) ·
    //   MEAN-REVERT +$416.88 (n=141, WR 43.3%) — the admitted SHORT tax ladder
    //   IS the data-driven CHOP activation and stays live (post-ladder cohort
    //   Oct-13: 5/5 SHORT, 3 wins, +$82.64; post-recovery signals #2410/2411
    //   deployed SHORT in CHOP).
    // NEW CELL FLIP (v11.6): AI-SCALP|CHOP is deep-negative BOTH sides in the
    // recent window (14d: LONG −$245.63 n=146 WR 24% · SHORT −$169.39 n=102
    // WR 19.6%; all-time it was +$31.48 WR 33.3% — the cell decayed through
    // it) and the L1 tax does not save it. AI-SCALP therefore joins
    // BREAKOUT/MOMENTUM in the unconditional CHOP hard-veto. This is the
    // STRUCTURAL half of the fix; the TEMPORAL half is the EQ-97 STRAT-PAUSE
    // switch engaged on AI-SCALP book-wide (non-CHOP cells also bleed) — the
    // veto survives any pause-lift until the cell re-earns its way out.
    if (strategy === "BREAKOUT" || strategy === "MOMENTUM" || strategy === "AI-SCALP") {
      // v6.3 evidence: BREAKOUT in chop bled −$28 at WR 28% — a soft −7 penalty
      // did not keep the engine out. v9.3: guard L1+ hard-vetoes ANY chop
      // (strong or moderate); guard 0 still vetoes the strong-chop extreme.
      // v9.4 ledger re-check: 9 settled chop rows, 0 wins, −$2.58 — veto stands.
      // v11.6: AI-SCALP joins (ledger: scalp decay −$169/−$245 recent-14d, WR
      // 19.6%/24% — above).
      const vetoFamily = strategy === "AI-SCALP"
        ? "scalp VETOED in chop (v11.6 cell-flip: AI-SCALP −$169.39 SHORT / −$245.63 LONG recent-14d, WR 19.6%/24% — tax ladder cannot save a decayed cell)"
        : "breakout/momentum VETOED in chop";
      if (guard >= 1 || strongChop) {
        return { ok: false, reason: `CHOP (${regime.note}) — ${vetoFamily} (guard L${guard}, strength ${regime.strength.toFixed(2)}${strongChop ? ", strong" : ""}; ledger 197/218 closes CHOP −$29.98)`, sizeMult: 0, slMult: 1, scoreAdj: 0, thrAdj: 0, tag: "REGIME-CHOP" };
      }
      return { ok: true, sizeMult: 0.7, slMult: 1, scoreAdj: -7, thrAdj: 8, reason: `CHOP (${regime.note}) — ${strategy === "AI-SCALP" ? "scalp" : "breakout/momentum"} decays, +8 threshold + size cut ×0.7 (guard L0 moderate-chop residual)`, tag: "REGIME-CHOP" };
    }
    // v9.4 ASYMMETRIC GUARD L1+ — the EQ-100 activation. NOTE: the asymmetry
    // must hold at L1 TOO, not only at L2: the W41+42 LONG bleed (−$108.09)
    // accrued UNDER L1-style taxation — the tax does not save the LONG book.
    // Live correction: the AI governor auto-softened L2→L1 minutes after the
    // v9.4 deploy (its knob, legal) which would have re-opened the condemned
    // cohort — so the LONG veto is pinned to guard ≥ 1; guard 0 (explicit
    // legacy softening) is the only path that re-opens CHOP LONGs.
    if (guard >= 1) {
      if (long) {
        return { ok: false, reason: `CHOP (${regime.note}) — LONG vetoed in chop at guard L${guard} (EQ-100 ledger: LONG −$111.22 Oct / −$108.09 W41+42, TP1-touch only 14% — rotational decay, strength ${regime.strength.toFixed(2)})`, sizeMult: 0, slMult: 1, scoreAdj: 0, thrAdj: 0, tag: "REGIME-CHOP" };
      }
      return strongChop
        ? { ok: true, sizeMult: 0.7, slMult: 1, scoreAdj: -6, thrAdj: 10, reason: `CHOP strong (${regime.note}) — SHORT admitted at guard L${guard} (EQ-100: CHOP SHORT +$40.49 W41+42, MR|S WR 56.9%): +10 threshold, conviction −6, size ×0.7`, tag: "REGIME-CHOP" }
        : { ok: true, sizeMult: 0.85, slMult: 1, scoreAdj: -3, thrAdj: 6, reason: `CHOP (${regime.note}) — SHORT admitted at guard L${guard} (EQ-100: CHOP SHORT +$40.49 W41+42, AI-SWING|S +$36.89 WR41%): +6 threshold, conviction −3, size ×0.85`, tag: "REGIME-CHOP" };
    }
    // guard 0 — legacy soft ladder (explicit operator softening only)
    if (strongChop) {
      return { ok: true, sizeMult: 0.7, slMult: 1, scoreAdj: -6, thrAdj: 10, reason: `CHOP strong (${regime.note}) — rotational decay taxes all strategies: +10 threshold, size ×0.7, conviction −6`, tag: "REGIME-CHOP" };
    }
    return { ok: true, sizeMult: 0.85, slMult: 1, scoreAdj: 0, thrAdj: 2, reason: `rotational regime — mean-revert favored (+2 threshold) (guard L0 legacy soft path)`, tag: "REGIME-CHOP" };
  }
  // VOLATILE — v6.3: expansion regimes tax EVERY entry (unpredictable wick risk);
  // at guard L2 mean-revert is also vetoed (catching knives in vol spikes).
  if (guard >= 2 && strategy === "MEAN-REVERT") {
    return { ok: false, reason: `VOLATILE (${regime.note}) — mean-revert vetoed in vol expansion (guard L2 — no knife-catching)`, sizeMult: 0, slMult: 1.3, scoreAdj: 0, thrAdj: 0, tag: "REGIME-VOLATILE" };
  }
  return { ok: true, sizeMult: 0.6, slMult: 1.3, scoreAdj: 0, thrAdj: 6, reason: `VOLATILE (${regime.note}) — margin ×0.6, stops ×1.3, +6 threshold`, tag: "REGIME-VOLATILE" };
}

// ── v6.3 BTC-SPILLOVER GUARD (regimeGuard L2) ──
// Alts inherit BTC's regime: a LONG alt while BTC is in markdown, or a SHORT
// alt while BTC marks up, fights the market's primary flow. The surcharge is a
// THRESHOLD adjustment so marginal counter-BTC setups fail the gate while
// high-conviction ones still pass.
export function btcSpilloverThrAdj(btcRegime: MarketRegime | null, symbol: string, direction: "LONG" | "SHORT"): { adj: number; reason: string | null } {
  if (!btcRegime || symbol === "BTCUSDT" || symbol === "ETHUSDT") return { adj: 0, reason: null };
  if (btcRegime.regime === "TREND_DOWN" && direction === "LONG") return { adj: 5, reason: `BTC TREND ▼ spillover (+5 threshold on counter-BTC long)` };
  if (btcRegime.regime === "TREND_UP" && direction === "SHORT") return { adj: 5, reason: `BTC TREND ▲ spillover (+5 threshold on counter-BTC short)` };
  return { adj: 0, reason: null };
}

// ── v6.3 REGIME OUTCOME TELEMETRY — per-regime realized ledger ──
// resolveSignals bumps this on every close (tag parsed from signal tags); the
// governor reads it as the REGIME LEDGER and tunes regimeGuard from evidence.
const REGIME_TELEMETRY_KEY = "regime.telemetry";

export interface RegimeTeleCell { n: number; wins: number; pnlUsd: number }
export type RegimeTelemetry = Record<string, RegimeTeleCell>;

export function regimeTagOf(tags: string | null): string | null {
  if (!tags) return null;
  const t = tags.split(",").find((x) => x.startsWith("REGIME-"));
  return t ? t.replace("REGIME-", "") : null;
}

export async function bumpRegimeTelemetry(tag: string, win: boolean, pnlUsd: number): Promise<void> {
  let tel: RegimeTelemetry = {};
  try {
    const row = await db.engineSetting.findUnique({ where: { key: REGIME_TELEMETRY_KEY } });
    if (row) tel = JSON.parse(row.value) as RegimeTelemetry;
  } catch {
    /* fresh */
  }
  const cell = tel[tag] ?? { n: 0, wins: 0, pnlUsd: 0 };
  cell.n += 1;
  if (win) cell.wins += 1;
  cell.pnlUsd = Number((cell.pnlUsd + pnlUsd).toFixed(2));
  tel[tag] = cell;
  await db.engineSetting.upsert({ where: { key: REGIME_TELEMETRY_KEY }, create: { key: REGIME_TELEMETRY_KEY, value: JSON.stringify(tel) }, update: { value: JSON.stringify(tel) } });
}

export async function getRegimeTelemetry(): Promise<RegimeTelemetry> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: REGIME_TELEMETRY_KEY } });
    if (row) return JSON.parse(row.value) as RegimeTelemetry;
  } catch {
    /* fresh */
  }
  return {};
}

/** Pulse summary — top symbols → regime labels for the TERMINAL strip. */
export function getRegimeSummary(): Array<{ symbol: string; regime: RegimeId; label: string; strength: number }> {
  const out: Array<{ symbol: string; regime: RegimeId; label: string; strength: number }> = [];
  for (const [sym, hit] of memo) {
    if (Date.now() - hit.at < MEMO_TTL * 4) {
      out.push({ symbol: sym, regime: hit.regime.regime, label: hit.regime.label, strength: hit.regime.strength });
    }
  }
  return out.sort((a, b) => b.strength - a.strength).slice(0, 12);
}
