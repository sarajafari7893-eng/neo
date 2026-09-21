// v8.4.2 OPERATOR MANDATE (bridge msgs 861802356/357, 2026-09-12T09:06Z):
// «آستانه ورود به سیگنال ها رو به ۲۵ کاهش بده و ثابت نگه دار»
//   1. Lower the signal entry threshold to 25 …
//   2. … and KEEP IT FIXED.
// Ground truth at execution: minScore had drifted 32 → 45 (AI-SUPERVISOR
// quality-raise valve walks +5 per cycle to its ceiling 45; the AUTO-RELIEF
// valve only fires on a 6h-total deploy drought, which the occasional probe
// deploy keeps resetting). Best sweep score across 29 markets was 20/100 —
// nothing could pass. This script: (a) cuts minScore to 25, (b) engages
// minScorePinned=1 so EVERY automatic writer (governor set_min_score,
// AUTO-RELIEF, SUPERVISOR raise, advisor apply) is suppressed — only an
// explicit future operator mandate may move or unpin it.
// Executed through the DESIGNED write semantics (direct read-merge-write on
// the gate EngineSetting + audit), same path as op-minscore-cut.js.
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

const KEY = 'gate';
const NEW_MIN = 25;
const [LO, HI] = [12, 60];

(async () => {
  const row = await db.engineSetting.findUnique({ where: { key: KEY } });
  if (!row) throw new Error('gate EngineSetting missing — refusing to create blind');
  const cur = JSON.parse(row.value);
  const prev = cur.minScore;
  const prevPin = cur.minScorePinned ?? 0;
  const next = { ...cur, minScore: Math.min(HI, Math.max(LO, NEW_MIN)), minScorePinned: 1 };
  await db.engineSetting.update({ where: { key: KEY }, data: { value: JSON.stringify(next) } });

  // Audit — mirrors fireEvent()'s DB write (relay intentionally not fired; operator gets the reply directly)
  await db.signalEvent.create({
    data: {
      signalId: null,
      symbol: null,
      type: 'ENGINE',
      level: 'info',
      message: `OPERATOR MANDATE (audited): MIN_SCORE ${prev} → ${next.minScore} + PIN ENGAGED (minScorePinned 0→1) — «آستانه ورود به سیگنال ها رو به ۲۵ کاهش بده و ثابت نگه دار» (bridge 2026-09-12). minScore is now operator-owned: governor set_min_score, AUTO-RELIEF, SUPERVISOR quality-raise and advisor apply are all suppressed while the pin holds. Effective threshold stays minScore + regime/chase thrAdj; SHORT-GUARD L2, REGIME-GUARD L2, FLOW-VETO ≤−15 and the learned gates remain evidence-based and unchanged.`,
    },
  });

  console.log(`OK — minScore ${prev} → ${next.minScore}, minScorePinned ${prevPin} → 1 (written + audited)`);
  await db.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
