import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/radar-probation — v10.18 PHASE-2 ACCEPTANCE GATE
 * (operator option A, 2026-09-24: «کل سیستم بر پایه MARKET MATRIX و
 * PUMP/DUMP RADAR» — radar-primary WITH gates, measured, not assumed).
 *
 * Cohorts (v10.18 era only — the consolidated engine vintage):
 *   radar    — deployments born from PUMP/DUMP RADAR nominations (tags carry
 *              the PUMP/DUMP kind), now passing the FULL gate stack after the
 *              DIRECT-authority bypass was retired.
 *   baseline — all other v10.18 deployments (event-trigger bus spawns).
 *
 * Win definition mirrors stats.ts isTpWin (TP-proven ledger): reachedTp ≥ 1
 * OR status ∈ {TP1,TP2,TP3} — NOT status-only counts (the advisory's own
 * lesson: status-only understate the book, 23.2% real vs 3.6% apparent).
 *
 * VERDICT (audited evidence basis at retirement time, 7d window:
 * pump WR 17.7% / avg −1.67% vs other 23.2% / +3.04%):
 *   PENDING — radar settled < 30 OR window < 14d (not enough evidence)
 *   PASS    — radar WR ≥ baseline WR AND radar avgPnl > 0
 *   FAIL    — otherwise → the operator may order re-gating or re-tuning;
 *             every FAIL candidate row stays qualityFlag-clean and auditable.
 */
const RADAR_TAGS = ["PUMP", "DUMP"] as const;
const MIN_SETTLED = 30;
const WINDOW_DAYS = 14;

export async function GET() {
  try {
    const rows = await db.signal.findMany({
      where: { engine: { contains: "v10.18" } },
      select: {
        tags: true, status: true, reachedTp: true, pnlPercent: true,
        marginUsd: true, closedAt: true, createdAt: true, qualityFlag: true,
      },
    });

    const isRadar = (t: string | null) => !!t && RADAR_TAGS.some((k) => t.includes(k));
    const isWin = (r: { reachedTp: number; status: string }) => r.reachedTp >= 1 || ["TP1", "TP2", "TP3"].includes(r.status);

    const cohort = (radar: boolean) => {
      const all = rows.filter((r) => isRadar(r.tags) === radar);
      const settled = all.filter((r) => r.closedAt);
      const wins = settled.filter(isWin);
      const avgPnl = settled.length ? settled.reduce((a, r) => a + r.pnlPercent, 0) / settled.length : 0;
      const avgPnlUsd = settled.length ? settled.reduce((a, r) => a + (r.marginUsd * r.pnlPercent) / 100, 0) / settled.length : 0;
      const created = all.map((r) => r.createdAt.getTime());
      return {
        created: all.length,
        settled: settled.length,
        tpProvenWins: wins.length,
        winRatePct: settled.length ? Number(((wins.length / settled.length) * 100).toFixed(1)) : null,
        avgPnlPct: Number(avgPnl.toFixed(2)),
        avgPnlUsd: Number(avgPnlUsd.toFixed(3)),
        firstCreatedAt: created.length ? new Date(Math.min(...created)).toISOString() : null,
        lastCreatedAt: created.length ? new Date(Math.max(...created)).toISOString() : null,
        integrityFlagged: all.filter((r) => r.qualityFlag).length,
      };
    };

    const radar = cohort(true);
    const baseline = cohort(false);
    const startedAt = [radar.firstCreatedAt, baseline.firstCreatedAt].filter(Boolean).map((s) => new Date(s as string).getTime());
    const windowStart = startedAt.length ? new Date(Math.min(...startedAt)).toISOString() : null;
    const windowDays = startedAt.length ? Number(((Date.now() - Math.min(...startedAt)) / 86400_000).toFixed(2)) : 0;

    let verdict: "PENDING" | "PASS" | "FAIL" = "PENDING";
    let reason = `evidence insufficient — radar settled ${radar.settled}/${MIN_SETTLED}, window ${windowDays.toFixed(1)}/${WINDOW_DAYS}d`;
    if (radar.settled >= MIN_SETTLED && windowDays >= WINDOW_DAYS && baseline.settled > 0) {
      if ((radar.winRatePct ?? 0) >= (baseline.winRatePct ?? 100) && radar.avgPnlPct > 0) {
        verdict = "PASS";
        reason = "radar cohort meets the gate: WR ≥ baseline AND avgPnl > 0 over ≥14d with ≥30 settles";
      } else {
        verdict = "FAIL";
        reason = `radar cohort missed the gate: WR ${radar.winRatePct}% vs baseline ${baseline.winRatePct}% · avgPnl ${radar.avgPnlPct}% — operator decides re-gate/re-tune`;
      }
    }

    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
      gate: { minSettled: MIN_SETTLED, windowDays: WINDOW_DAYS, winDefinition: "TP-proven (reachedTp≥1 OR status TP1/TP2/TP3) — mirrors stats.isTpWin" },
      verdict,
      reason,
      windowStart,
      windowDays,
      radar,
      baseline,
      context: {
        note: "DIRECT-authority bypass retired 2026-09-24 — radar emissions pass the full gate stack",
        auditBasis7d: { pump: { n: 203, winRatePct: 17.7, avgPnlPct: -1.67 }, other: { n: 151, winRatePct: 23.2, avgPnlPct: 3.04 } },
      },
    });
  } catch (err) {
    // degraded-200 doctrine (same as /api/sentinel): monitoring must never 500
    return NextResponse.json({ ok: false, at: new Date().toISOString(), error: err instanceof Error ? err.message : "unknown" });
  }
}
