// ── NEXUS//SIGNALS v13.0 CORE-REVERT knob (server-only) ──
// Operator mandate 2026-10-24 («پیشنهاد من سیستم به همان وضعیت برگردد و با
// دیتای موجود نقاط ضعف را فیلتر کند») after the W42 performance audit:
//   · v12.7 era (10-21 → 10-23 15:18): 111 signals, WR 60.4%, +$39.74,
//     median event→entry delay 13.2min — the SUCCESSFUL core configuration.
//   · v12.8/v12.9 era (10-23 15:31 → now): confirmation stack (CHASE-EXTREME,
//     FLUSH-EXHAUSTION/KNIFE-CATCH/STOP-FLOOR, SINGLE-VENUE, NO-BINANCE +12,
//     SURROGATE-FLOW cap, MULTI-VENUE clamp, STALE-BAR) DOUBLED the median
//     delay to 27.4min and starved the board behind a 200+ veto wall, while
//     the hard-SL class it targeted kept printing (7× −61.2% on 10-24 alone).
// enabled=true (default) → the v12.8+ hard gates become ADVISORY: they keep
// journaling (gate-journal audit trail preserved for future recalibration)
// but never refuse a deploy — deploy semantics return to the v12.7 core.
// Weaknesses are filtered from EXISTING data instead (STALE-CHASE gate +
// REARM-BRAKE-BE window in engine.ts), not by new blocking regimes.
// enabled=false → exact v12.9 blocking behavior, one EngineSetting flip.
// Cached 30s per process; fail-open to the operator mandate default.

import { db } from "@/lib/db";

export interface CoreRevertCfg {
  enabled: boolean;
}

const DEFAULT_CFG: CoreRevertCfg = { enabled: true };
const CACHE_MS = 30_000;

const g = globalThis as unknown as { __nexusCoreRevert?: { at: number; val: CoreRevertCfg } };

export async function getCoreRevert(): Promise<CoreRevertCfg> {
  const hit = g.__nexusCoreRevert;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.val;
  let val: CoreRevertCfg = { ...DEFAULT_CFG };
  try {
    const row = await db.engineSetting.findUnique({ where: { key: "core-revert" } });
    if (row) {
      const p = JSON.parse(row.value) as Partial<CoreRevertCfg>;
      if (typeof p.enabled === "boolean") val = { enabled: p.enabled };
    }
  } catch {
    /* fail-open → operator-mandate default (enabled) */
  }
  g.__nexusCoreRevert = { at: Date.now(), val };
  return val;
}
