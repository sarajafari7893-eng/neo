/**
 * scripts/annotate-quality-flags.ts — v10.18 PHASE-0 verification tool
 * (operator option A, 2026-09-24). IDEMPOTENT — safe to re-run.
 *
 * ORIGIN: ADVISORY-20260924-matrix-radar hypothesized 200 "degenerate births"
 * (entryPrice==stopLoss) and 31 "impossible SL-with-+pnl" settlements. The
 * v10.18 forensic re-audit CORRECTED both hypotheses (honesty contract):
 *   · all 200 entry==SL rows carry initialStopLoss != stopLoss and 197/200
 *     went green first (maxPnlPercent ≥ 8%) — they are v5.4/R2 BE-TRAIL
 *     breakeven exits, legitimate mechanics, NOT birth defects;
 *   · the +pnl "SL" rows are TP1-TRAILED stops (stopLossNext = tp1) — the
 *     designed "+1R locked on the runner" path, already counted as wins by
 *     the TP-proven ledger (isTpWin).
 * Zero rows qualify for historical flagging, so this tool performs NO
 * data mutation on Signal rows. The qualityFlag column + the engine guards
 * (DEGEN-STOP birth guard, settlement integrity guard) stay as permanent
 * anti-regression rails for any future row that genuinely violates geometry.
 *
 * What it DOES:
 *   1. verifies the corrected forensics live (BE-trail vs true-birth counts)
 *   2. flips EngineSetting "pump.authority" → "gated" (v10.18 retired DIRECT
 *      authority; the stored state must match code reality) — idempotent
 *   3. prints the decision-grade cohort ledger with the PLATFORM win
 *      definition (isTpWin: reachedTp≥1 OR status TP*) — NOT status-only
 *      counts, which understate the book (the advisory's own lesson)
 *
 * Run: bun scripts/annotate-quality-flags.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const WIN_STATUSES = new Set(["TP1", "TP2", "TP3"]);

async function main() {
  console.log("── v10.18 clean-ledger verification ──");

  // 1) corrected forensics
  const [entrySl, trueBirths, greenFirst, wrongSide] = await Promise.all([
    db.$queryRawUnsafe<{ n: number }[]>(`SELECT COUNT(*) n FROM Signal WHERE status = 'SL' AND entryPrice = stopLoss`),
    db.$queryRawUnsafe<{ n: number }[]>(`SELECT COUNT(*) n FROM Signal WHERE status = 'SL' AND entryPrice = stopLoss AND initialStopLoss = stopLoss`),
    db.$queryRawUnsafe<{ n: number }[]>(`SELECT COUNT(*) n FROM Signal WHERE status = 'SL' AND entryPrice = stopLoss AND maxPnlPercent >= 8`),
    db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(*) n FROM Signal WHERE status = 'SL' AND entryPrice != stopLoss AND reachedTp = 0
        AND (initialStopLoss IS NULL OR initialStopLoss = stopLoss)
        AND ((direction = 'LONG' AND stopLoss > entryPrice) OR (direction = 'SHORT' AND stopLoss < entryPrice))`,
    ),
  ]);
  console.log(`entry==SL rows: ${entrySl[0]?.n ?? 0} · true degenerate births (initial==stop==entry): ${trueBirths[0]?.n ?? 0} · green-first BE-trails: ${greenFirst[0]?.n ?? 0} · true wrong-side anomalies: ${wrongSide[0]?.n ?? 0}`);

  // 2) pump.authority → gated (code truth; UI badge reads the same value)
  await db.engineSetting.upsert({
    where: { key: "pump.authority" },
    create: { key: "pump.authority", value: "gated" },
    update: { value: "gated" },
  });
  console.log("pump.authority → gated (v10.18: DIRECT emission retired)");

  // 3) cohort ledger, platform win definition (7d + lifetime)
  const ledger = async (sinceMs: number | null, label: string) => {
    const rows = (await db.$queryRawUnsafe<{ src: string; n: number; wins: number; avgPnl: number }[]>(
      `SELECT CASE WHEN tags LIKE '%pump%' OR tags LIKE '%dump%' THEN 'pump' ELSE 'other' END src,
              COUNT(*) n,
              SUM(CASE WHEN reachedTp >= 1 OR status IN ('TP1','TP2','TP3') THEN 1 ELSE 0 END) wins,
              ROUND(AVG(pnlPercent), 2) avgPnl
        FROM Signal
        WHERE status != 'ACTIVE' AND closedAt IS NOT NULL ${sinceMs ? `AND closedAt > ${sinceMs}` : ""}
        GROUP BY src`,
    )) as Array<{ src: string; n: number; wins: number; avgPnl: number }>;
    for (const r of rows) console.log(`${label} ${r.src}: n=${Number(r.n)} WR=${Number(r.n) ? ((Number(r.wins) / Number(r.n)) * 100).toFixed(1) : "n/a"}% avgPnl=${r.avgPnl}%`);
  };
  await ledger(Date.now() - 7 * 86400_000, "7d ");
  await ledger(null, "ALL");

  const flagged = await db.signal.count({ where: { qualityFlag: { not: null } } });
  console.log(`qualityFlag rows (reserved for future integrity events): ${flagged}`);
}

main()
  .catch((e) => {
    console.error("verification failed:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
