// ── PUMP/DUMP RADAR END-TO-END DRILL (sandbox only) ──
// Validates the full v9.0 radar chain without waiting hours for a real pump:
//   1. tape warm-up + stage-1 candidate (synthetic surge on TESTUSDT)
//   2. stage-2 evidence scoring (honest zero-flow path for a fake symbol)
//   3. DB track resolution: horizon FAILURE + MFE SUCCESS paths
//   4. learning-gate math (5-success rule)
// Cleans up every TESTUSDT artifact (PumpTrack + SignalEvent) afterwards.
import { PrismaClient } from "@prisma/client";
import { pumpTick, pumpScreen, gatherEvidence, pumpGateAllows, PUMP_RULES } from "../src/lib/pump-dump";

const db = new PrismaClient();
const realNow = Date.now();
let fake = realNow;

(Date as unknown as { now: () => number }).now = () => fake;

const SYM = "TESTUSDT";
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ✕ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

async function main() {
  console.log("DRILL 1 — tape warm-up (70 ticks × 5s, quiet drip then surge)");
  let lastAssets = [{ symbol: SYM, price: 100, volume24h: 1e9 }];
  for (let i = 0; i < 70; i++) {
    fake += 5000;
    const surging = i >= 58; // last ~60s: price +1.5%, volume ×20
    const price = surging ? 100 * (1 + 0.015 * ((i - 57) / 12)) : 100;
    const dripPerMin = surging ? 400_000 : 20_000;
    const vol = 1e9 + (dripPerMin / 12) * (i + 1);
    lastAssets = [{ symbol: SYM, price, volume24h: vol }];
    await pumpTick(lastAssets);
  }
  const cands = pumpScreen(lastAssets);
  const c = cands.find((x) => x.symbol === SYM);
  check("stage-1 candidate detected", !!c, c ? `vel5m ${c.vel5m.toFixed(2)}% · vel1m ${c.vel1m.toFixed(2)}% · burst ${c.burstX.toFixed(1)}×` : "none");
  check("velocity ≥ rules", !!c && Math.abs(c.vel5m) >= PUMP_RULES.vel5mMinPct && Math.abs(c.vel1m) >= PUMP_RULES.vel1mMinPct);
  check("burst ≥ 3×", !!c && c.burstX >= PUMP_RULES.volBurstMinX, c ? `${c.burstX.toFixed(1)}×` : "");

  console.log("DRILL 2 — stage-2 evidence scoring (fake symbol → honest zero-flow)");
  if (c) {
    const { score, ev } = await gatherEvidence(c);
    check("score composed from velocity+burst only", score >= 40 && score <= 50, `score ${score} (flow unavailable — honest)`);
    check("evidence fields null for unknown symbol", ev.oiDelta10m === null && ev.cvdUsd60s === null);
    check("sub-declare floor without flow confirmation", score < PUMP_RULES.scoreDeclare, `${score} < ${PUMP_RULES.scoreDeclare} — no declaration on unconfirmed tape`);
  }

  console.log("DRILL 3 — DB track resolution (horizon FAILURE + MFE SUCCESS)");
  const base = Date.now();
  fake += 61_000; // cross the 60s reconcile window so pumpTick adopts the seeded rows
  const fRow = await db.pumpTrack.create({ data: { symbol: SYM, kind: "PUMP", phase: "ONSET", anchorPrice: 100, peakPrice: 100, score: 70, detectedAt: new Date(base - 95 * 60_000) } });
  await pumpTick([{ symbol: SYM, price: 101, volume24h: 2e9 }]); // +1% MFE, age 95min → horizon FAILURE
  const fAfter = await db.pumpTrack.findUnique({ where: { id: fRow.id } });
  check("horizon resolution FAILURE", fAfter?.outcome === "FAILURE" && fAfter.phase === "RESOLVED", fAfter?.successNote ?? "");

  const sRow = await db.pumpTrack.create({ data: { symbol: SYM, kind: "PUMP", phase: "ONSET", anchorPrice: 100, peakPrice: 100, score: 82, detectedAt: new Date(base - 10 * 60_000) } });
  fake += 61_000; // cross the reconcile window again for the second row
  await pumpTick([{ symbol: SYM, price: 103, volume24h: 2e9 }]); // +3% MFE ≥ +2% → SUCCESS
  const sAfter = await db.pumpTrack.findUnique({ where: { id: sRow.id } });
  check("MFE resolution SUCCESS", sAfter?.outcome === "SUCCESS" && sAfter.mfePct >= PUMP_RULES.successMovePct, sAfter?.successNote ?? "");

  console.log("DRILL 4 — learning gate math");
  const g = await pumpGateAllows();
  check("gate counts test rows", g.successful >= 1 && g.total >= 2, `${g.successful}✓/${g.failed}✕ of ${g.total}`);
  check("gate LOCKED below 5 successes", !g.unlocked && g.required === 5, g.reason);

  console.log("CLEANUP");
  const delTracks = await db.pumpTrack.deleteMany({ where: { symbol: SYM } });
  const delEvents = await db.signalEvent.deleteMany({ where: { symbol: SYM } });
  const g2 = await pumpGateAllows();
  check("test artifacts removed", delTracks.count >= 2 && g2.total === 0, `tracks ${delTracks.count} · events ${delEvents.count} · gate ${g2.successful}/${g2.total}`);

  console.log(`\nDRILL COMPLETE — ${pass} pass · ${fail} fail`);
  await db.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error("DRILL CRASHED:", e);
  await db.pumpTrack.deleteMany({ where: { symbol: SYM } }).catch(() => undefined);
  await db.signalEvent.deleteMany({ where: { symbol: SYM } }).catch(() => undefined);
  await db.$disconnect();
  process.exit(1);
});
