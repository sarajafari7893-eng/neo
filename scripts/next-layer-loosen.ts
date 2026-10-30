// ── NEXT-LAYER LOOSEN (trace 1a18f1e500a55ab5 — operator authorization
// «هوش مرکزی مجاز به شل شدن لایه های بعدی برای راستی آزمایی صدور سیگنال است») ──
// Evidence (pipeline-stage-forensics, 90min): 471 candidates scored (data path
// ALIVE — regime classification requires 80 live candles), 289 PASSed the score
// gate (minScore NOT the wall), and REGIME-CHOP killed 1015/1113 (642 CHOP-LONG
// vetoes + 373 BR/MOM/SCALP) with SHORT-GUARD killing 42. The engine gate knob
// is a DB key ("gate") read live (15s cache) — FLAT-10 untouched.
// Loosening (explicit operator-softening paths built into the code):
//   regimeGuard 1 → 0  (regime.ts L0 "explicit operator softening only" ladder)
//   shortGuard  1 → 0  (R1 HTF-align requirement off — 42 blocks/90min)
// Everything else preserved (minScore=17 stays PINNED — score gate proven not
// the wall; AI-SCALP strat-pause stays — operator-approved deep-negative pause;
// physical/data-integrity gates stay).
// Fully reversible: previous values recorded in EngineSetting "gate.diagnostic-loosen".
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const row = await db.engineSetting.findUnique({ where: { key: "gate" } });
  if (!row) throw new Error("gate knob missing");
  const cur = JSON.parse(row.value) as Record<string, number>;
  const prev = { regimeGuard: cur.regimeGuard, shortGuard: cur.shortGuard };
  console.log("current:", JSON.stringify({ regimeGuard: cur.regimeGuard, shortGuard: cur.shortGuard, minScore: cur.minScore, minScorePinned: cur.minScorePinned }));
  if (!APPLY) { console.log("DRY-RUN — rerun with --apply"); return; }

  const next = { ...cur, regimeGuard: 0, shortGuard: 0 };
  await db.engineSetting.update({ where: { key: "gate" }, data: { value: JSON.stringify(next) } });

  const record = {
    action: "NEXT-LAYER-LOOSEN",
    trace: "1a18f1e500a55ab5",
    operatorAuth: "هوش مرکزی مجاز به شل شدن لایه های بعدی برای راستی آزمایی صدور سیگنال است",
    evidence: "90min forensics: 471 scored / 289 score-PASS (minScore not the wall) / REGIME-CHOP 1015 of 1113 blocks (642 CHOP-LONG + 373 BR/MOM/SCALP) / SHORT-GUARD 42 — data path proven alive (regime rulings need 80 live candles)",
    changed: { regimeGuard: { from: prev.regimeGuard, to: 0 }, shortGuard: { from: prev.shortGuard, to: 0 } },
    kept: { minScore: cur.minScore, minScorePinned: cur.minScorePinned, stratPauseAISCALP: "kept (operator-approved)", physicalGates: "kept" },
    risk: "EQ-100 ledger: CHOP-LONG cohort bled historically — verification window at fixed 2$ margin; revert when issuance verified",
    reverted: false,
    revert: { regimeGuard: prev.regimeGuard, shortGuard: prev.shortGuard },
    at: new Date().toISOString(),
  };
  await db.engineSetting.upsert({
    where: { key: "gate.diagnostic-loosen" },
    create: { key: "gate.diagnostic-loosen", value: JSON.stringify(record) },
    update: { value: JSON.stringify(record) },
  });
  await db.signalEvent.create({
    data: {
      type: "SYSTEM",
      level: "ai",
      message: `NEXT-LAYER-LOOSEN (operator authorization, trace 1a18f1e500a55ab5): regimeGuard 1→0 + shortGuard 1→0 for signal-issuance verification — 90min evidence: data path ALIVE (471 scored, regime rulings need 80 live candles), score gate NOT the wall (289 PASS), REGIME-CHOP killed 1015/1113 (642 CHOP-LONG + 373 BR/MOM/SCALP), SHORT-GUARD 42. minScore=17 stays pinned (not the wall); AI-SCALP pause + physical gates kept. Revert values recorded in gate.diagnostic-loosen.`,
    },
  });
  console.log("APPLIED: regimeGuard=0 shortGuard=0 · journal + revert record written (server cache ≤15s)");
}

main()
  .catch((e) => { console.error("LOOSEN FAILED:", e); process.exit(1); })
  .finally(() => db.$disconnect());
