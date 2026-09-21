// v10.6 OPERATOR MANDATE (2026-09-15, operator chat):
// «گام پیشنهادی بعدی را کامل و مهندسی انجام بده، علل های ریشه‌ای را برطرف کن»
// + «پرشدن بازوهای shadow-veto را سرعت و بهبود ببخش»
//
// This script activates the three v10.6 state changes the code ship needs:
//   1. DECISIVE-EXCURSION FILTER ON (root cause #1): gate.decisiveFilter=1
//      (lenient ×0.85 bar) + decisiveErMin=0.12 chop floor. Predicted no-touch
//      deploys are skipped pre-entry (expiredNoTouch was 75/113; bucket 30-60m
//      99/121 expired).
//   2. SHADOW-VETO ACCELERATION (REAL-arm starvation fix): windowPass 3→5,
//      dedupMs 30min→10min, budgetPerHour 8→12 (observeCapture defaults true —
//      every capture deploy now adjudicated observe-only and linked to the
//      real serial).
//   3. PER-STRATEGY SIZING STAGED (SUPERVISOR proposal, decision-ready):
//      weights staged per the 7-day ledger, enabled=false — activation is the
//      operator's explicit decision (POST /api/strategy-weights {enabled:true}).
//
// All writes go through the DESIGNED write semantics (read-merge-write on the
// respective EngineSetting keys + one audit event), like op-minscore-pin.js.
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

(async () => {
  // 1) gate settings — decisive-excursion filter ON
  const gateRow = await db.engineSetting.findUnique({ where: { key: 'gate' } });
  if (!gateRow) throw new Error('gate EngineSetting missing');
  const gate = JSON.parse(gateRow.value);
  const prevDec = gate.decisiveFilter ?? 0;
  const nextGate = { ...gate, decisiveFilter: 1, decisiveErMin: 0.12 };
  await db.engineSetting.update({ where: { key: 'gate' }, data: { value: JSON.stringify(nextGate) } });

  // 2) shadow-veto config — acceleration
  const svKey = 'shadowveto.config';
  const svRow = await db.engineSetting.findUnique({ where: { key: svKey } });
  const sv = svRow ? JSON.parse(svRow.value) : {};
  const prev = { windowPass: sv.windowPass, dedupMs: sv.dedupMs, budget: sv.budgetPerHour };
  const nextSv = { ...sv, windowPass: 5, dedupMs: 10 * 60_000, budgetPerHour: 12, observeCapture: true };
  await db.engineSetting.upsert({
    where: { key: svKey },
    create: { key: svKey, value: JSON.stringify(nextSv) },
    update: { value: JSON.stringify(nextSv) },
  });

  // 3) per-strategy weights — STAGED, disabled (operator decision pending)
  const swKey = 'strategy.weights';
  const staged = {
    enabled: false,
    weights: { 'AI-SWING': 0.5, 'AI-SCALP': 1.5, 'MEAN-REVERT': 1.25, MOMENTUM: 1.0, BREAKOUT: 0.5 },
    updatedAt: new Date().toISOString(),
    updatedBy: 'SUPERVISOR-STAGE (op-v106-activate)',
  };
  const swRow = await db.engineSetting.findUnique({ where: { key: swKey } });
  if (swRow) {
    const cur = JSON.parse(swRow.value);
    staged.enabled = cur.enabled === true; // never silently flip activation
    staged.weights = { ...staged.weights, ...(cur.weights || {}) };
  }
  await db.engineSetting.upsert({
    where: { key: swKey },
    create: { key: swKey, value: JSON.stringify(staged) },
    update: { value: JSON.stringify(staged) },
  });

  // audit
  await db.signalEvent.create({
    data: {
      signalId: null,
      symbol: null,
      type: 'ENGINE',
      level: 'ai',
      message: `V10.6 ROOT-CAUSE PACKAGE ACTIVATED (operator mandate 2026-09-15 «علت های ریشه‌ای را برطرف کن») — ① DECISIVE-EXCURSION FILTER ${prevDec}→1 (lenient ×0.85 bar, chop floor ER≥0.12): ATR-projected travel within TTL must reach 1R = min(TP1,SL) or the deploy is skipped pre-entry — targets expiredNoTouch 75/113 + bucket 30-60m 99/121 censoring. ② SHADOW-VETO ACCELERATION: windowPass ${prev.windowPass ?? 3}→5, dedupMs ${prev.dedupMs ?? 1800000}→600000, budget ${prev.budget ?? 8}→12, observeCapture=true — every RAW-CAL deploy now adjudicated observe-only + serial-linked so real-keep/real-veto fill from capture settles. ③ PER-STRATEGY SIZING STAGED (OFF): AI-SWING ×0.5 · AI-SCALP ×1.5 · MEAN-REVERT ×1.25 · MOMENTUM ×1.0 · BREAKOUT ×0.5 — awaiting operator activation via /api/strategy-weights.`,
    },
  });

  console.log(`OK — decisiveFilter ${prevDec}→1 · shadow {windowPass ${prev.windowPass ?? 3}→5, dedup ${Math.round((prev.dedupMs ?? 1800000) / 60000)}→10min, budget ${prev.budget ?? 8}→12, observe on} · strategy weights staged (enabled=${staged.enabled})`);
  await db.$disconnect();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
