// ── SMC GOVERNANCE RESTORE (v6.7, 2026-09-08) ──
// Restores the gate values the OPERATOR actually owns:
//   minScore 38 → 50   (operator APPROVED the advisor's 45→50 proposal at
//                       16:27:30Z; the governor's pre-freeze cycle drifted it
//                       to 35→38 — the BO-EXP trial freeze now blocks future
//                       governor writes, this script restores the baseline)
//   flowVetoScore 25 → 8 (ship value at v6.6; governor drift to the clamp max
//                       25 made the flow veto nearly inert — FLOW-VETO ≤−8
//                       was the audited-live setting the whole negative-LLM
//                       evidence chain was built on)
// Idempotent: re-running only confirms the values, never double-flips.
// The BO-EXP trial cohort (BO-EXP tag) is judged on operator-owned gates.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const row = await db.engineSetting.findUnique({ where: { key: "gate" } });
  const gate = row ? (JSON.parse(row.value) as Record<string, number>) : {};
  const before = { minScore: gate.minScore, flowVetoScore: gate.flowVetoScore };

  gate.minScore = 50;
  gate.flowVetoScore = 8;

  await db.engineSetting.upsert({
    where: { key: "gate" },
    create: { key: "gate", value: JSON.stringify(gate) },
    update: { value: JSON.stringify(gate) },
  });

  console.log(`[SMC-RESTORE] gate minScore ${before.minScore} → 50 · flowVetoScore ${before.flowVetoScore} → 8`);
  console.log(`[SMC-RESTORE] rationale: operator-approved minScore=50 (advisor APPLIED 16:27:30Z) + pre-drift flowVeto=8; BO-EXP trial freeze now guards both from governor writes`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error("[SMC-RESTORE] FAILED:", e);
  process.exit(1);
});
