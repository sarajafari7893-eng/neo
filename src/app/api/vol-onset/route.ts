import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOnsetBoard, onsetTagStats, ONSET_RULES } from "@/lib/volOnset";

export const dynamic = "force-dynamic";

/**
 * GET /api/vol-onset — VOL-ONSET eruption radar (telemetry only).
 * Rows sorted by onsetScore desc. `hot` = live eruption per isHot() rules.
 * tagStats = learning loop: settled signals tagged VOL-ONSET vs rest (direction-
 * stratified: aligned = deployment agrees with eruption, counter = against it).
 * study = research-desk forward-return verdict (EngineSetting "vol-onset-study").
 */
export async function GET() {
  const board = await getOnsetBoard();
  const [tagStats, studyRow] = await Promise.all([onsetTagStats(), db.engineSetting.findUnique({ where: { key: "vol-onset-study" } }).catch(() => null)]);
  const study = studyRow ? (JSON.parse(studyRow.value) as { at: string; all: { n: number; wr: number | null; wilsonLB: number }; up: { n: number; meanFwd6: number | null }; down: { n: number; meanFwd6: number | null }; verdict: string }) : null;
  return NextResponse.json({
    computedAt: new Date(board.computedAt).toISOString(),
    fromCache: board.fromCache,
    universe: board.rows.length,
    hotCount: board.rows.filter((r) => r.hot).length,
    rules: {
      tfMinutes: ONSET_RULES.tfMinutes,
      eruptionMult: ONSET_RULES.eruptionMult,
      trailingBars: ONSET_RULES.trailingBars,
      hotMinutes: ONSET_RULES.hotMinutes,
      minBars: ONSET_RULES.minBars,
      halfLifeMin: ONSET_RULES.halfLifeMin,
    },
    tagStats,
    study,
    rows: board.rows,
  });
}
