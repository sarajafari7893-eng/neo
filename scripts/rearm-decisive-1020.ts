// OP-AUDIT-TP-1020 follow-up — operator mandate 2026-10-20 (trace 1a159580c9333451)
// «توصیهٔ مهندسی ترتیب ۱ سپس ۲ … را کامل و مهندسی اجرا کن» — proposal ② approved:
// RE-ARM the DECISIVE-EXCURSION filter with a real ER floor.
//
// State found in the ledger (audit 2026-10-20): decisiveFilter=0 (OFF) and
// decisiveErMin=0.00 — the no-travel/chase vetoes from v10.6 were disarmed by the
// Task-42 re-arm sweep, so L1 taker-sweep chases deploys into dead tape again and
// the resolved cohort starves (TP-proven rate ~10% vs win∪ 57%).
//
// This script (idempotent, audited):
//   1. merges decisiveFilter=1 (lenient ×0.85 first-decision bar) + decisiveErMin=0.12
//      (absolute chop floor) into the persisted EngineSetting "gate" row — every other
//      key is preserved byte-for-byte (putGateSettings merge semantics),
//   2. appends an ENGINE SignalEvent so the change is visible in the terminal feed,
//   3. prints before/after.
// All other disarmed knobs (volBarrier, dislocationGate) stay as they are — the
// operator approved ONLY proposals ① and ②; minScore 17 [PINNED] is untouched.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const TARGET = { decisiveFilter: 1, decisiveErMin: 0.12 };

async function main() {
  const row = await db.engineSetting.findUnique({ where: { key: "gate" } });
  const before = row ? (JSON.parse(row.value) as Record<string, unknown>) : {};
  console.log("BEFORE:", JSON.stringify({ decisiveFilter: before.decisiveFilter, decisiveErMin: before.decisiveErMin }));

  const after = { ...before, ...TARGET };
  await db.engineSetting.upsert({
    where: { key: "gate" },
    create: { key: "gate", value: JSON.stringify(after) },
    update: { value: JSON.stringify(after) },
  });

  await db.signalEvent.create({
    data: {
      type: "ENGINE",
      symbol: null,
      level: "info",
      message:
        "DECISIVE-EXCURSION RE-ARMED (operator mandate 2026-10-20 trace 1a159580c9333451 — OP-AUDIT-TP-1020 proposal ② approved): decisiveFilter 0→1 (lenient ×0.85 first-decision bar) · decisiveErMin 0→0.12 (absolute chop floor). Rationale: filter was disarmed at ER≥0.00, so L1 taker-sweep chases deploys into no-travel tape and the resolved cohort starves (TP-proven ~10% vs win∪ 57%). Interacts coherently with the v12.6 TP1 re-rank: the first decision now = 0.55R, so the projection bar is fdMult·R — reachable-but-meaningful; the ER floor remains the anti-chase spine. Scoped by construction to auto/capture deploys (RAW-CAL included); operator-forced and radar direct-authority deploys bypass as documented.",
    },
  });

  const check = await db.engineSetting.findUnique({ where: { key: "gate" } });
  const val = check ? (JSON.parse(check.value) as Record<string, unknown>) : {};
  console.log("AFTER:", JSON.stringify({ decisiveFilter: val.decisiveFilter, decisiveErMin: val.decisiveErMin }));
  console.log("minScore preserved:", JSON.stringify({ minScore: val.minScore, minScorePinned: val.minScorePinned }));
  console.log("volBarrier (untouched, operator approved only ①②):", val.volBarrier);
}

main()
  .finally(() => db.$disconnect())
  .catch((e) => {
    console.error("REARM FAILED:", e);
    process.exit(1);
  });
