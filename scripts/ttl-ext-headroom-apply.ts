// ── v10.18 TTL-EXTENSION HEADROOM — audited knob change (R3 follow-up) ──
// Operator order 2026-09-21 «پیشنهادات بعدی را کامل و مهندسی انجام بده»:
// R3 report flagged "EXPIRED dominance + near-misses" → TTL tuning as the
// highest-leverage strategy fix. Forensics (2026-09-21, readonly ledger):
//   · EXPIRED splits into fizzle (reachedTp=0, avg −5.8% levered) and
//     TP1-runner (reachedTp≥1, 41/41 positive, avg +28.5% levered).
//   · Extension-eligible cohort: 55 signals with ≥1 grant → 16.4% reached a
//     TP vs 4.7% book baseline (selection-biased, but the mechanism is
//     self-limiting: it only fires within ttlNearTpPct of the next TP).
//   · True near-miss cohort (never touched TP1, MFE ≥70% of TP1 distance):
//     only ~22 lifetime — 16 of them had NO grant (not near TP at expiry, so
//     more headroom cannot save those), but 6 with grants averaged +17.8%.
// Change: ttlExtendMax 1→2 (restore the legacy grant headroom — 39 historical
// rows ran at ext=2). Bounded cost: +60min of life ONLY for trades already
// within 3% unlevered of their next TP. Reversible: one-line revert.
// Audited: prints before/after + writes a SYSTEM event via the engine feed.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const row = await db.engineSetting.findUnique({ where: { key: "gate" } });
  if (!row) throw new Error("gate settings row missing");
  const gate = JSON.parse(row.value) as Record<string, number>;
  const before = gate.ttlExtendMax;
  if (before === 2) {
    console.log(JSON.stringify({ ok: true, already: true, ttlExtendMax: 2 }));
    return;
  }
  gate.ttlExtendMax = 2;
  await db.engineSetting.update({ where: { key: "gate" }, data: { value: JSON.stringify(gate) } });
  const after = JSON.parse((await db.engineSetting.findUnique({ where: { key: "gate" } }))!.value) as Record<string, number>;
  await db.signalEvent.create({
    data: {
      signalId: null,
      type: "SYSTEM",
      symbol: null,
      level: "info",
      message: `GATE KNOB CHANGE (v10.18, audited) — ttlExtendMax ${before}→${after.ttlExtendMax} (grant headroom restored; evidence: extension-eligible cohort 16.4% TP-rate vs 4.7% baseline, mechanism self-limits to trades within ${gate.ttlNearTpPct}% of next TP; R3 TTL-tuning follow-up, operator order 2026-09-21). Reversible via one-line revert.`,
    },
  });
  console.log(JSON.stringify({ ok: true, before, after: after.ttlExtendMax, audited: "SYSTEM event written" }));
}

main()
  .catch((e) => {
    console.error("APPLY FAILED:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
