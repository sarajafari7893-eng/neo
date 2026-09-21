// ── NEXUS//SIGNALS calibration snapshot (operator-approved suggestion 3+4) ──
// Dumps every EngineSetting (live calibration: gate knobs, duration.forensics,
// advisor state, relay config) + table row counts + git HEAD + db sha256 into:
//   backups/calibration-latest.json  — human-readable, diffable calibration history
//   backups/MANIFEST.json            — integrity manifest consumed by backup.sh + restore-drill.sh
// Modes:
//   (default)        write both JSON files from the LIVE db (DATABASE_URL)
//   --fingerprint-only  print ONLY the content fingerprint of whatever db DATABASE_URL points at
//                       (used by backup.sh on the VACUUM copy + restore-drill.sh on the extracted copy)
// Read-only against the target DB. Exit 1 on failure (backup.sh tolerates).
import { PrismaClient } from "@prisma/client";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const ROOT = "/home/z/my-project";
const BACKUPS = join(ROOT, "backups");

function sha256File(p: string): string {
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return "unavailable";
  }
}

// Content fingerprint — byte-layout independent (stable across VACUUM copies):
// sha256 of the JSON of per-table row counts + high-water-mark ids.
async function fingerprint(db: PrismaClient): Promise<Record<string, unknown>> {
  const [s, e, p, a, pp, v, es] = await Promise.all([
    db.signal.aggregate({ _count: true, _max: { id: true } }),
    db.signalEvent.aggregate({ _count: true, _max: { id: true } }),
    db.advisorProposal.aggregate({ _count: true, _max: { id: true } }),
    db.marketAsset.aggregate({ _count: true, _max: { id: true } }),
    db.pricePoint.aggregate({ _count: true, _max: { id: true } }),
    db.volCauseEvent.aggregate({ _count: true, _max: { id: true } }),
    db.engineSetting.aggregate({ _count: true, _max: { key: true } }),
  ]);
  return {
    Signal: [s._count, s._max.id],
    SignalEvent: [e._count, e._max.id],
    AdvisorProposal: [p._count, p._max.id],
    MarketAsset: [a._count, a._max.id],
    PricePoint: [pp._count, pp._max.id],
    VolCauseEvent: [v._count, v._max.id],
    EngineSetting: [es._count, es._max?.key ?? null],
  };
}

async function main() {
  const fingerprintOnly = process.argv.includes("--fingerprint-only");
  const db = new PrismaClient();

  if (fingerprintOnly) {
    const fp = await fingerprint(db);
    await db.$disconnect();
    console.log(createHash("sha256").update(JSON.stringify(fp)).digest("hex"));
    return;
  }

  mkdirSync(BACKUPS, { recursive: true });

  const [settings, signals, events, proposals, assets, pricePoints, volCauses] = await Promise.all([
    db.engineSetting.findMany({ orderBy: { key: "asc" } }),
    db.signal.count(),
    db.signalEvent.count(),
    db.advisorProposal.count(),
    db.marketAsset.count(),
    db.pricePoint.count(),
    db.volCauseEvent.count(),
  ]);
  const fp = await fingerprint(db);
  await db.$disconnect();

  let gitHead = "unknown";
  let gitDirty = "unknown";
  try {
    gitHead = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
    gitDirty = execSync("git status --porcelain", { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((l) => l.trim() && !/^..\s+(db\/|upload\/|backups\/|dev\.log)/.test(l.trim()))
      .length.toString();
  } catch {
    /* git unavailable */
  }

  const dbSha = sha256File(join(ROOT, "db", "custom.db"));
  const now = new Date().toISOString();

  const calibration = {
    kind: "NEXUS//SIGNALS CALIBRATION SNAPSHOT",
    createdAt: now,
    gitHead,
    gitDirtyFiles: gitDirty,
    dbSha256: dbSha,
    tableCounts: {
      Signal: signals,
      SignalEvent: events,
      AdvisorProposal: proposals,
      MarketAsset: assets,
      PricePoint: pricePoints,
      VolCauseEvent: volCauses,
      EngineSetting: settings.length,
    },
    // Live calibration = every EngineSetting row (gate knobs = operator calibration,
    // duration.forensics = AI-core training report, telegram.chatId = relay, advisor state, ...)
    engineSettings: settings.map((s) => ({ key: s.key, value: s.value, updatedAt: s.updatedAt })),
  };

  const manifest = {
    kind: "NEXUS//SIGNALS SNAPSHOT MANIFEST",
    createdAt: now,
    gitHead,
    liveDbSha256: dbSha,
    liveDbBytes: (() => {
      try {
        return readFileSync(join(ROOT, "db", "custom.db")).length;
      } catch {
        return 0;
      }
    })(),
    // byte-layout independent — recomputed from the archived db by restore-drill
    contentFingerprint: createHash("sha256").update(JSON.stringify(fp)).digest("hex"),
    rowCounts: calibration.tableCounts,
    expectInZip: [
      "src/",
      "prisma/schema.prisma",
      "mini-services/",
      "docs/",
      "scripts/",
      "Caddyfile",
      "zscripts-marker:.zscripts/",
      ".env",
      "package.json",
      "worklog.md",
      "db/custom.db",
      "MANIFEST.json",
      "calibration-latest.json",
    ],
  };

  writeFileSync(join(BACKUPS, "calibration-latest.json"), JSON.stringify(calibration, null, 2));
  writeFileSync(join(BACKUPS, "MANIFEST.json"), JSON.stringify(manifest, null, 2));

  const knobs = settings.find((s) => s.key === "gate");
  console.log(
    `CALIBRATION SNAPSHOT OK — settings:${settings.length} rows · signals:${signals} · events:${events} · git:${gitHead.slice(0, 7)} · dbSha:${dbSha.slice(0, 12)}… · gate:${knobs ? "present" : "MISSING"}`
  );
}

main().catch((e) => {
  console.error("CALIBRATION SNAPSHOT FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
