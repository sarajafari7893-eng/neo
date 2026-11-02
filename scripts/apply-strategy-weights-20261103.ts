// ── STRATEGY WEIGHTS reallocation 2026-11-03 (operator mandate trace 1a19e8f351a779ad) ──
// One-field policy change from the FRESH 2026-11-03 audit (scripts/
// strategy-audit-20261103.ts, .data/strategy-audit-20261103.out) + the
// root-cause forensics (.data/weakness-rootcause-20261103.out):
//
//   · MEAN-REVERT ×0.5 → ×0.25 (clamp floor — deactivate-by-ledger).
//     Evidence: 30d n=266 TPwr 18.0% pos 39.1% net −$26.40 (PT-era −$12.50,
//     FULL −$28.40) — NO positive cohort anywhere (best cell CHOP|SHORT
//     +$5.50 gross vs $15.07 fees); avg MFE 0.36R → reversions do not run.
//     The REAL deploy-flow valve is already active: strategy.probation has
//     held MEAN-REVERT since 2026-10-05T12:41Z (effMin +5 double-confirm,
//     auto-eval 30min TTL). Post-FLAT-10 this weight is tag/ledger-level
//     (margin stays exactly $10) — it encodes the operator decision and
//     keeps STRATW cohort tags consistent with the probation state.
//     Simulation (linear counterfactual on the 30d ledger, IF sizing were
//     active): −26.40 × (0.25/0.5 − 1) = +$13.20 saved.
//
//   · BREAKOUT ×1.25 UNCHANGED — the audit found a usable positive pattern
//     (operator's OR-branch): 5m leg n=76 net +$73.28 pos 73.7% and
//     TREND-UP|LONG n=165 +$57.37; linear sim says cutting to ×0.5 would
//     have COST −$38.54 on the 30d window. Its rot (1h leg n=98 −$36.52,
//     avg MFE 0.32R) is fenced by the auto entry-levers gate (n≥100 bar —
//     cohort sits at 98) + SURROGATE-BREAKOUT gate + advisor RULE-1.
//   · AI-SWING ×1.0 UNCHANGED (workhorse: 30d +$49.65, 7d +$60.43; focus is
//     achieved by concentration — its weight share rises 25%→36.4%).
//   · AI-SCALP ×0.25, MOMENTUM ×1.0 UNCHANGED (floor / neutral, OOS leg).
//
// Mirrors POST /api/strategy-weights EXACTLY (same row shape src/lib/
// strategy-weights.ts reads, same ENGINE SignalEvent audit template).
// Engine picks the row up live via strategyWeightFor() (15s cache) — NO
// restart needed. FLAT-10 untouched: margin stays exactly $10.
// Run: bun scripts/apply-strategy-weights-20261103.ts
import { db } from "@/lib/db";

const KEY = "strategy.weights";
const UPDATED_BY = "operator-mandate-1a19e8f351a779ad";
const STRATEGY_LIST = ["AI-SCALP", "MEAN-REVERT", "MOMENTUM", "BREAKOUT", "AI-SWING"] as const;
const W_LO = 0.25;
const W_HI = 2.0;

function sanitize(raw: { enabled?: boolean; weights?: Record<string, unknown>; updatedAt?: unknown; updatedBy?: unknown }) {
  const weights: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.weights ?? {})) {
    const num = Number(v);
    if (Number.isFinite(num)) weights[String(k).toUpperCase().slice(0, 24)] = Math.min(W_HI, Math.max(W_LO, Math.round(num * 100) / 100));
  }
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
    weights,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === "string" ? (raw.updatedBy as string).slice(0, 80) : null,
  };
}

async function main(): Promise<void> {
  const curRow = await db.engineSetting.findUnique({ where: { key: KEY } });
  const cur = curRow ? sanitize(JSON.parse(curRow.value)) : { enabled: false, weights: {} as Record<string, number>, updatedAt: null, updatedBy: null };
  const next = sanitize({
    enabled: true,
    weights: { "AI-SCALP": 0.25, "MEAN-REVERT": 0.25, MOMENTUM: 1.0, BREAKOUT: 1.25, "AI-SWING": 1.0 },
    updatedAt: new Date().toISOString(),
    updatedBy: UPDATED_BY,
  });

  await db.engineSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });

  const transitions = STRATEGY_LIST.map((s) => `${s} ×${cur.weights[s] ?? 1}→×${next.weights[s] ?? 1}`).join(" · ");
  const live = STRATEGY_LIST.map((s) => `${s}:×${next.weights[s] ?? 1}`).join(" ");
  const message =
    `STRATEGY WEIGHTS v10.6: enabled ${cur.enabled ? "true" : "false"} → ${next.enabled ? "true" : "false"} · ${transitions} — ` +
    `per-strategy margin multiplier TAG/LEDGER layer post-FLAT-10 (margin stays exactly $10; real deploy valve = strategy.probation, MEAN-REVERT on probation since 2026-10-05T12:41Z effMin+5) · ` +
    `ACTIVE ${live} (updated ${next.updatedAt} by ${next.updatedBy}) — ` +
    `evidence: FRESH 2026-11-03 audit (scripts/strategy-audit-20261103.ts, 30d clean n=1898): MEAN-REVERT n=266 TPwr18% pos39.1% net −$26.40 no positive cohort avgMFE 0.36R → clamp floor; ` +
    `BREAKOUT usable positive pattern kept (5m n=76 +$73.28 pos73.7%, TREND-UP|LONG +$57.37; 1h rot n=98 −$36.52 fenced by entry-levers n≥100 gate at 98 + SURROGATE gate + advisor RULE-1); ` +
    `AI-SWING workhorse 30d +$49.65 7d +$60.43 → ×1.0 (share 25%→36.4%); AI-SCALP ×0.25 floor; MOMENTUM ×1.0 neutral OOS leg. ` +
    `Sim (linear, if sizing active): +$13.20. Operator mandate trace 1a19e8f351a779ad.`;

  const ev = await db.signalEvent.create({ data: { signalId: null, symbol: null, type: "ENGINE", level: "ai", message } });

  console.log("=== strategy.weights applied (2026-11-03 mandate) ===");
  console.log("before:", JSON.stringify(cur));
  console.log("after :", JSON.stringify(next));
  console.log("audit SignalEvent:", ev.id, "(type ENGINE, level ai)");
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("apply-strategy-weights-20261103 FAILED:", e);
  process.exitCode = 1;
  try {
    await db.$disconnect();
  } catch {}
});
