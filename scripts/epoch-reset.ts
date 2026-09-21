// ── NEXUS//SIGNALS EPOCH-2 RESET (operator mandate 2026-09-08) ──
// «سیستم و بالانس ریست بشه تا روند کالیبراسیون و ردیابی بهتر اجرا بشه»
// Wipes the trading ledger + all learned calibration state so the fresh
// calibration is produced ONLY by the real backtest (directive 4), then the
// engine re-activates on the verified best sample. Balance resets to the
// $100 seed automatically (equity = ACCOUNT_START + realized + unrealized).
// SAFETY: a pre-reset encrypted snapshot was taken (nexus-snapshot-20260908-110543).
// Run: bun scripts/epoch-reset.ts

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const SETTLED = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];

// calibration/learned state keys that MUST reset with the epoch
const CALIBRATION_KEYS = [
  "calibration",
  "backtest",
  "backtest.runs",
  "backtest.autotune",
  "volcause.study",
  "duration.forensics",
  "gate", // gate knobs reset to CLAMP defaults — the backtest re-picks minScore
  "epoch", // replaced below with the EPOCH-2 record
];

// infrastructure keys intentionally PRESERVED: ai (thought mode), telegram/relay,
// learner.auto (always-on), notify*, engine.* — the operating plant survives,
// only the learning + ledger reset.

async function main() {
  const [priorSignals, priorSettled, priorActive] = await Promise.all([
    db.signal.count(),
    db.signal.count({ where: { status: { in: SETTLED } } }),
    db.signal.count({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } } }),
  ]);
  const pnlAgg = await db.signal.aggregate({ _sum: { pnlPercent: true, marginUsd: true } });
  const eventsBefore = await db.signalEvent.count();

  // ── wipe ledger ──
  const ev = await db.signalEvent.deleteMany({});
  const sig = await db.signal.deleteMany({});
  const adv = await db.advisorProposal.deleteMany({});
  const vc = await db.volCauseEvent.deleteMany({});

  // ── wipe learned calibration state ──
  let wipedKeys: string[] = [];
  const all = await db.engineSetting.findMany({ select: { key: true } });
  wipedKeys = all.filter((r) => CALIBRATION_KEYS.includes(r.key)).map((r) => r.key);
  for (const key of CALIBRATION_KEYS) {
    await db.engineSetting.deleteMany({ where: { key } });
  }

  // ── EPOCH-3 fix: ttl-gate telemetry is a MONOTONIC counter that must reset with
  // the ledger — leaving it behind surfaced phantom TTL_EXT=58 on Session Stats
  // while CREATED showed 00 (operator bug report 2026-09-08). Wipe it explicitly.
  await db.engineSetting.deleteMany({ where: { key: "ttl-gate" } });

  // ── EPOCH-2 record ──
  const epoch = {
    epoch: 2,
    resetAt: new Date().toISOString(),
    operator: "mandate 2026-09-08: «سیستم و بالانس ریست بشه» + flow scanner + backtest calibration",
    prior: {
      signals: priorSignals,
      settled: priorSettled,
      active: priorActive,
      events: eventsBefore,
      sumPnlPercent: Number((pnlAgg._sum.pnlPercent ?? 0).toFixed(2)),
      sumMarginUsd: Number((pnlAgg._sum.marginUsd ?? 0).toFixed(2)),
      note: "equity was $70.44 (mark) — resets to the $100 seed",
    },
    preservedKeys: all.filter((r) => !CALIBRATION_KEYS.includes(r.key)).map((r) => r.key),
    snapshotBefore: "nexus-snapshot-20260908-110543.zip (encrypted + off-site)",
  };
  await db.engineSetting.create({ data: { key: "epoch", value: JSON.stringify(epoch) } });

  await db.signalEvent.create({
    data: {
      type: "SYSTEM",
      level: "ai",
      message: `EPOCH-2 INITIATED — operator reset mandate executed: ledger wiped (${sig.count} signals, ${ev.count} events, ${adv.count} advisor proposals, ${vc.count} vol-cause rows), calibration state cleared (${wipedKeys.join(", ") || "none"}), balance reseeded to $100. Sequence: multi-TF flow scanner comes online → real-backtest calibration grid → senior-engineer verification → engine activation on the verified best sample. Prior epoch archived in snapshot nexus-snapshot-20260908-110543 + calibration-latest.json.`,
    },
  });

  console.log(
    `EPOCH-2 RESET OK — signals:-${sig.count} events:-${ev.count} proposals:-${adv.count} volcause:-${vc.count} · keys-cleared:[${wipedKeys.join(",")}] · balance→$100 · archived:${epoch.snapshotBefore}`,
  );
}

main()
  .catch((e) => {
    console.error("EPOCH-2 RESET FAILED:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
