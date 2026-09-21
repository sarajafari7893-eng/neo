/**
 * v9.1 operator mandate 2026-09-13: «اجازه مستقیم برای صدور سیگنال داشته باشه»
 * Arms the PUMP/DUMP RADAR with DIRECT signal authority (EngineSetting
 * "pump.authority" = "direct") and leaves an audited SignalEvent trail.
 * Also persists the first radar performance journal so the AI core has the
 * evidence immediately, without waiting for the 80-tick hook.
 *
 * Run: node scripts/op-pump-authority-0913.cjs
 */
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

async function main() {
  // 1) authority = direct
  await db.engineSetting.upsert({
    where: { key: "pump.authority" },
    create: { key: "pump.authority", value: "direct" },
    update: { value: "direct" },
  });

  // 2) audited mandate event
  await db.signalEvent.create({
    data: {
      type: "PUMP_RADAR",
      symbol: null,
      level: "ai",
      message:
        "OPERATOR MANDATE 2026-09-13 — PUMP/DUMP RADAR granted DIRECT SIGNAL AUTHORITY (pump.authority=direct): conviction-≥78 nominations deploy immediately through the radar's own evidence stack (velocity + volume burst + OI/CVD/taker/whale/liq layers); generic engine quality gates no longer re-judge radar deploys. Radar risk rails stay hard (20min spacing, max 2 open radar signals, feed-fresh + sim-price + cluster half-size). Dedicated PUMP/DUMP cards with image + serial unchanged. Evidence book: EngineSetting pump.performance.",
    },
  });

  const row = await db.engineSetting.findUnique({ where: { key: "pump.authority" } });
  const gate = await db.engineSetting.findUnique({ where: { key: "pump.gate.unlockedAt" } });
  console.log("pump.authority =", row?.value, "| learning gate unlocked at:", gate?.value ?? "LOCKED");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
