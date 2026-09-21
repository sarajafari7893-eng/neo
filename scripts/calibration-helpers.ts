// Shared plumbing for the EPOCH-2 calibration lab (see calibration-epoch2.ts).
import { db } from "@/lib/db";

export { runBacktest, runAutotune, getAutotune } from "@/lib/backtest";
export { putGateSettings } from "@/lib/gate-settings";
export type { BacktestResult } from "@/lib/backtest";

/** Wilson lower bound (95%) — mirrors backtest.ts's internal implementation. */
export function wilsonLowerBound(wins: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom) * 100;
}

/** Gate write + SYSTEM audit row (the settings API path is HTTP-only; scripts go direct). */
export async function putGateSettingsWithAudit(next: { minScore: number }): Promise<void> {
  const { putGateSettings, describeGate } = await import("@/lib/gate-settings");
  const gate = await putGateSettings(next);
  await db.signalEvent.create({
    data: {
      type: "SYSTEM",
      level: "ai",
      message: `GATE UPDATED (EPOCH-2 calibration): MIN_SCORE → ${gate.minScore} — ${describeGate(gate)}`,
    },
  });
}
