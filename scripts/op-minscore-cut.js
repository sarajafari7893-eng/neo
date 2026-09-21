// v8.4.1 OPERATOR MANDATE (bridge msg 861802348, 2026-09-11T17:37Z):
// «آستانه عددی برای عبور سیگنال را کاهش بده» — lower the numeric signal-pass threshold.
// minScore was found at 45 (clamp 12–60, default 35) — the strictest tier of the
// no-signals stack. Cut → 32: a real easing (−13 pts) that stays well above the
// noise floor of 12, honors the v6.0 clamps, and leaves the effective per-candidate
// threshold (minScore + regime/chase thrAdj) meaningful. Executed through the
// DESIGNED write semantics (putGateSettings: read-merge-clamp-write, 15s cache)
// because the operator HTTP PUT was removed in v6.0; the AI governor remains the
// ongoing owner and may re-tune with fresh telemetry (audited either way).
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

const KEY = 'gate';
const NEW_MIN = 32;
const [LO, HI] = [12, 60];

(async () => {
  const row = await db.engineSetting.findUnique({ where: { key: KEY } });
  if (!row) throw new Error('gate EngineSetting missing — refusing to create blind');
  const cur = JSON.parse(row.value);
  const prev = cur.minScore;
  const next = { ...cur, minScore: Math.min(HI, Math.max(LO, NEW_MIN)) };
  await db.engineSetting.update({ where: { key: KEY }, data: { value: JSON.stringify(next) } });

  // Audit — mirrors fireEvent()'s DB write (relay intentionally not fired; operator gets the reply directly)
  await db.signalEvent.create({
    data: {
      signalId: null,
      symbol: null,
      type: 'ENGINE',
      level: 'info',
      message: `OPERATOR MANDATE (audited): MIN_SCORE ${prev} → ${next.minScore} (clamp ${LO}–${LO && HI}) — «آستانه عددی برای عبور سیگنال را کاهش بده». Effective threshold stays minScore + regime/chase thrAdj; SHORT-GUARD L2, REGIME-GUARD L2, FLOW-VETO ≤−15 and the AI-SWING memory gate remain evidence-based and unchanged. Governor retains tuning authority (hysteresis + clamps).`,
    },
  });

  console.log(`OK — minScore ${prev} → ${next.minScore} written + audited (signalEvent row created)`);
  await db.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
