import { db } from "@/lib/db";
async function main() {
  const last = await db.advisorProposal.findFirst({ orderBy: { cycle: "desc" }, select: { cycle: true } });
  const cycle = (last?.cycle ?? 0) + 1;
  const evidence = JSON.stringify({
    sim: ".data/no-touch-floor-sim-20261103.json",
    bounds30d: "optimistic +$639.64 (floor +2% lev) / +$448.85 (0.25R) — pessimistic −$553.08 / −$417.64 (winner truncation); 0.5R: +$268.82 / −$291.00",
    rootCause: "deep tail = small-cap CHOP-SHORT full stop-outs (MFE up to +19.3% lev → close −63%); R-arm 0.5×SLdist unreachable when ATR-huge (slAtrMult 2.5) → arm never fires",
    proposal: "beArmRMult 0.5 → 0.35 (earlier BE arm; data-layer knob via putGateSettings, 15s pickup) — path-based 1m replay RECOMMENDED before approval; truth between the two bounds",
    mandate: "operator 2026-11-03 trace 1a19e8f351a779ad ④ (کاندید شبیه‌سازی shadow کف no-touch — delivered as two-bounded shadow sim)",
  });
  await db.advisorProposal.create({ data: {
    cycle, kind: "KNOB_ADJUST", knob: "beArmRMult", currentValue: 0.5, proposedValue: 0.35,
    direction: "TIGHTEN",
    rationale: "no-touch floor candidate: arm the BE floor 30% earlier so the deep give-back tail (MFE≥+15% lev → close −63%) gets harvested; earlier arm banks 25% sooner and retires -1R risk sooner",
    evidence, status: "PENDING",
  }});
  console.log("AdvisorProposal queued: cycle", cycle, "knob beArmRMult 0.5→0.35 PENDING");
  await db.$disconnect();
}
main();
