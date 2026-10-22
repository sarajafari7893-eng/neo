// Task 42 — re-arm the anti-chase guards to their evidence defaults (v6.7.2
// DURATION-LAB) + audited SignalEvent. Operator mandate 2026-10-17:
// «دو توصیه باقی مانده را کامل و مهندسی اجرا کن» — recommendation ①.
// putGateSettings merges partial updates (minScore/minScorePinned untouched).
import { db } from '../src/lib/db';
import { getGateSettings, putGateSettings } from '../src/lib/gate-settings';

(async () => {
  const before = await getGateSettings();
  console.log('BEFORE:', JSON.stringify({ onsetRetestGuard: before.onsetRetestGuard, chaseThrAdj: before.chaseThrAdj, minScore: before.minScore, minScorePinned: before.minScorePinned }));
  const after = await putGateSettings({ onsetRetestGuard: 1, chaseThrAdj: 6 });
  console.log('AFTER :', JSON.stringify({ onsetRetestGuard: after.onsetRetestGuard, chaseThrAdj: after.chaseThrAdj, minScore: after.minScore, minScorePinned: after.minScorePinned }));
  await db.signalEvent.create({
    data: {
      type: 'ENGINE',
      symbol: null,
      level: 'info',
      message: `GATE RE-ARM (Task-42 operator mandate): onsetRetestGuard ${before.onsetRetestGuard}→1 · chaseThrAdj ${before.chaseThrAdj}→6 — anti-chase guards restored to v6.7.2 evidence defaults (DURATION-LAB: 9 fast-kills were untested-burst chases) after the Task-41 AGTUSDT storm audit; retest gate upgraded in v11.8 to latest-eruption anchoring + both alignments (CHASE+FADE) + pre-eruption-close leg math`,
    },
  });
  console.log('audit SignalEvent written');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
