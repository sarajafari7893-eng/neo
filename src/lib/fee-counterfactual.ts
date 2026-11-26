// ── v11.4 FEE-COUNTERFACTUAL MACHINERY (EQ-92 P1 + EQ-94 operator mandate
// «توصیه‌ها و پیشنهادها را کامل و مهندسی اجرا کن») ────────────────────────────
// EQ-92/93 measured the structural truth of this book: gross is positive, the
// NET bleeds through fees/swap ($54.8 fees vs $66.2 gross over the 4.1-day
// post-shield window = 83%). Doctrine adopted: EVERY candidate change must
// carry a fee-aware counterfactual before it can be judged. This module is
// that machinery, shared by audits and exposed via /api/fee-counterfactual:
//   · feeAnatomy(windowDays) — gross / fee / net decomposition of the settled
//     clean book (the baseline every counterfactual is measured against).
//   · minScoreCounterfactual(windowDays, thresholds) — sweep raises of the
//     NOMINAL minScore over the ledger: per raise, which settled rows would
//     have been blocked (headroom = |score| − eff < K), their gross AND
//     fee-aware net (a blocked row also saves its fees — it never exists),
//     the ΔΣnet of the remaining book, and the headroom separation between
//     winners and losers (the decisive evidence for the TIGHTEN verdicts).
// Score/eff are parsed from the immutable `analysis` text minted at deploy
// ("score X/100 vs dynamic MIN_SCORE B+adj regime adj → eff E" or
// "score X/100/PASS gate B") — no back-derivation from outcomes.

import { db } from "@/lib/db";

export const SETTLED_STATUSES = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] as const;

export interface FeeRow {
  serial: number;
  symbol: string;
  strategy: string;
  status: string;
  pnl: number; // gross pnlPercent (margin-relative)
  feePct: number; // (feeUsd + swapUsd) / margin × 100
  netPct: number; // pnl − feePct — what the ledger actually keeps
  createdAt: number;
  headroom: number; // |score| − eff (null when analysis is unparsable)
}

function parseScoreEff(analysis: string): { score: number; eff: number } | null {
  const sm = analysis.match(/score (-?[\d.]+)\/100/);
  if (!sm) return null;
  const score = Math.abs(parseFloat(sm[1]));
  const effM = analysis.match(/→ eff ([\d.]+)/) ?? analysis.match(/(?:PASS|FAIL) gate (\d+(?:\.\d+)?)/);
  const eff = effM ? parseFloat(effM[1]) : 12;
  return { score, eff };
}

/** Settled clean rows in the window, with fee-aware net and parsed headroom. */
export async function feeRows(windowDays: number): Promise<FeeRow[]> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const rows = await db.signal.findMany({
    where: { qualityFlag: null, status: { in: [...SETTLED_STATUSES] }, createdAt: { gte: since }, serial: { gt: 0 } },
    select: { serial: true, symbol: true, strategy: true, status: true, pnlPercent: true, marginUsd: true, feeUsd: true, swapUsd: true, createdAt: true, analysis: true },
  });
  const out: FeeRow[] = [];
  for (const r of rows) {
    const feePct = r.marginUsd > 0 ? (100 * (r.feeUsd + r.swapUsd)) / r.marginUsd : 1.2;
    const parsed = parseScoreEff(r.analysis);
    out.push({
      serial: r.serial,
      symbol: r.symbol,
      strategy: r.strategy,
      status: r.status,
      pnl: r.pnlPercent,
      feePct,
      netPct: r.pnlPercent - feePct,
      createdAt: r.createdAt.getTime(),
      headroom: parsed ? parsed.score - parsed.eff : Number.NaN,
    });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export interface FeeAnatomy {
  windowDays: number;
  n: number;
  winRatePct: number;
  grossSumPct: number;
  grossAvgPct: number;
  feeSumPct: number;
  feeAvgPct: number;
  netSumPct: number;
  netAvgPct: number;
  feeShareOfGrossAbsPct: number; // |fees| as % of |gross| — the fee drag dial
  computedAt: string;
}

/** P1 baseline — the gross→net decomposition every change must respect. */
export async function feeAnatomy(windowDays: number): Promise<FeeAnatomy> {
  const rows = await feeRows(windowDays);
  const n = rows.length;
  const grossSumPct = rows.reduce((a, r) => a + r.pnl, 0);
  const feeSumPct = rows.reduce((a, r) => a + r.feePct, 0);
  const netSumPct = rows.reduce((a, r) => a + r.netPct, 0);
  const wins = rows.filter((r) => r.pnl > 0).length;
  return {
    windowDays,
    n,
    winRatePct: n ? Number(((100 * wins) / n).toFixed(1)) : 0,
    grossSumPct: Number(grossSumPct.toFixed(1)),
    grossAvgPct: n ? Number((grossSumPct / n).toFixed(2)) : 0,
    feeSumPct: Number(feeSumPct.toFixed(1)),
    feeAvgPct: n ? Number((feeSumPct / n).toFixed(2)) : 0,
    netSumPct: Number(netSumPct.toFixed(1)),
    netAvgPct: n ? Number((netSumPct / n).toFixed(2)) : 0,
    feeShareOfGrossAbsPct: Math.abs(grossSumPct) > 0 ? Number(((100 * Math.abs(feeSumPct)) / Math.abs(grossSumPct)).toFixed(1)) : 0,
    computedAt: new Date().toISOString(),
  };
}

export interface MinScoreStep {
  k: number; // nominal minScore raise (12 → 12+K)
  blockedN: number;
  blockedWrPct: number;
  blockedAvgGrossPct: number;
  blockedAvgNetPct: number; // fee-aware — a blocked row also saves its fees
  blockedNetSumPct: number;
  tp3Killed: number;
  remainingN: number;
  remainingAvgNetPct: number;
  deltaNetSumPct: number; // Σnet(remaining) − Σnet(base) — POSITIVE = tightening helps
  blockedStrategyMix: Record<string, number>;
}

export interface MinScoreCounterfactual {
  windowDays: number;
  cohortN: number;
  unparsedN: number;
  winnerHeadroomMedian: number | null;
  loserHeadroomMedian: number | null;
  headroomSeparates: boolean; // does |score|−eff carry outcome information?
  steps: MinScoreStep[];
  verdict: string;
  computedAt: string;
}

function median(a: number[]): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * Sweep nominal-minScore raises over the settled ledger. The admission bar the
 * engine actually applies is effMin = max(12, minScore + regimeAdj + lessons +
 * probation [+ valves]); raising the nominal 12→12+K shifts EVERY effMin up by
 * K, so a settled row is counterfactually blocked iff headroom < K.
 */
export async function minScoreCounterfactual(windowDays: number, thresholds: number[] = [1, 2, 3, 4, 5, 6, 7, 8]): Promise<MinScoreCounterfactual> {
  const all = await feeRows(windowDays);
  const cohort = all.filter((r) => Number.isFinite(r.headroom));
  const baseNet = cohort.reduce((a, r) => a + r.netPct, 0);
  const winners = cohort.filter((r) => r.pnl > 0);
  const losers = cohort.filter((r) => r.pnl <= 0);
  const wMed = median(winners.map((r) => r.headroom));
  const lMed = median(losers.map((r) => r.headroom));

  const steps: MinScoreStep[] = thresholds.map((k) => {
    const blocked = cohort.filter((r) => r.headroom < k);
    const remaining = cohort.filter((r) => r.headroom >= k);
    const bGross = blocked.reduce((a, r) => a + r.pnl, 0);
    const bNet = blocked.reduce((a, r) => a + r.netPct, 0);
    const lNet = remaining.reduce((a, r) => a + r.netPct, 0);
    const mix: Record<string, number> = {};
    for (const r of blocked) mix[r.strategy] = (mix[r.strategy] ?? 0) + 1;
    return {
      k,
      blockedN: blocked.length,
      blockedWrPct: blocked.length ? Number(((100 * blocked.filter((r) => r.pnl > 0).length) / blocked.length).toFixed(1)) : 0,
      blockedAvgGrossPct: blocked.length ? Number((bGross / blocked.length).toFixed(2)) : 0,
      blockedAvgNetPct: blocked.length ? Number((bNet / blocked.length).toFixed(2)) : 0,
      blockedNetSumPct: Number(bNet.toFixed(1)),
      tp3Killed: blocked.filter((r) => r.status === "TP3").length,
      remainingN: remaining.length,
      remainingAvgNetPct: remaining.length ? Number((lNet / remaining.length).toFixed(2)) : 0,
      deltaNetSumPct: Number((lNet - baseNet).toFixed(1)),
      blockedStrategyMix: mix,
    };
  });

  const best = [...steps].sort((a, b) => b.deltaNetSumPct - a.deltaNetSumPct)[0];
  const separates = wMed !== null && lMed !== null && Math.abs(wMed - lMed) >= 2;
  const verdict =
    best && best.deltaNetSumPct > Math.max(10, 0.02 * Math.abs(baseNet))
      ? `best raise +${best.k} nets ΔΣnet ${best.deltaNetSumPct > 0 ? "+" : ""}${best.deltaNetSumPct}% — evidence supports a bounded tighten`
      : `no raise clears its cost — headroom median winners ${wMed ?? "–"} vs losers ${lMed ?? "–"}: the score-above-bar carries no outcome edge; losses live in fees/concentration/strategy, not marginal scores`;

  return {
    windowDays,
    cohortN: cohort.length,
    unparsedN: all.length - cohort.length,
    winnerHeadroomMedian: wMed,
    loserHeadroomMedian: lMed,
    headroomSeparates: separates,
    steps,
    verdict,
    computedAt: new Date().toISOString(),
  };
}
