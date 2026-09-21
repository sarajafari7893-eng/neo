// v10.6 OPERATOR MANDATE (2026-09-15, operator chat):
// «پین minScore برداشته شود» — REMOVE the minScore operator pin.
//
// History: 2026-09-12 the operator ordered «آستانه ورود به سیگنال ها رو به ۲۵
// کاهش بده و ثابت نگه دار» → op-minscore-pin.js cut minScore to 25 AND engaged
// minScorePinned=1, suppressing every automatic writer (governor set_min_score,
// AUTO-RELIEF, SUPERVISOR quality-raise, advisor apply). 2026-09-15 the
// operator EXPLICITLY reversed the second half: the pin comes OFF.
//
// This script: minScorePinned 1 → 0. The VALUE stays 25 (the order removed the
// pin, not the level) — from now on minScore tuning returns to the evidence
// channels (governor / advisor / AUTO-RELIEF), each audited as before. The
// advisor's knobBlocked() was also fixed to stop counting PIN-blocked
// rejections toward the 7-day anti-flap cooldown (they were procedural, not
// evidential judgments).
//
// Executed through the DESIGNED write semantics (direct read-merge-write on
// the gate EngineSetting + audit), same path as op-minscore-pin.js.
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

const KEY = 'gate';

(async () => {
  const row = await db.engineSetting.findUnique({ where: { key: KEY } });
  if (!row) throw new Error('gate EngineSetting missing — refusing to create blind');
  const cur = JSON.parse(row.value);
  const prevPin = cur.minScorePinned ?? 0;
  const level = cur.minScore;
  if (prevPin === 0) {
    console.log(`NOOP — pin already ${prevPin}, minScore stays ${level}`);
    await db.$disconnect();
    return;
  }
  const next = { ...cur, minScorePinned: 0 };
  await db.engineSetting.update({ where: { key: KEY }, data: { value: JSON.stringify(next) } });

  await db.signalEvent.create({
    data: {
      signalId: null,
      symbol: null,
      type: 'ENGINE',
      level: 'ai',
      message: `OPERATOR MANDATE (audited): MIN_SCORE PIN LIFTED (minScorePinned 1→0) — «پین minScore برداشته شود» (operator 2026-09-15). The LEVEL stays minScore=${level}; tuning returns to the evidence channels (governor set_min_score, AUTO-RELIEF, SUPERVISOR quality-raise, advisor apply) — each still clamped + audited. Advisor cooldown fix shipped alongside: PIN-blocked rejections no longer count toward the 7-day anti-flap freeze (procedural ≠ evidential).`,
    },
  });

  console.log(`OK — minScorePinned ${prevPin} → 0, minScore stays ${level} (written + audited)`);
  await db.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
