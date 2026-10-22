// NEXUS//SIGNALS — DB RESTORE MERGE v2 (trace 1a15e9b9286f74a5)
// Base = pre-reset snapshot DB (VACUUM copy) + union live-only rows by PK.
// Snapshot wins id-conflicts (it holds the October evolution the live DB lost).
// FlowScan is a board: conflict on (symbol,tf) → newer updatedAt wins.
// Lives in scripts/ so the armor align can never delete it again.
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";

const SNAP = "/tmp/restore-staging/pre-reset/db/custom.db";
const LIVE = "/home/z/my-project/db/custom.db";
const OUT = process.argv[2] ?? "/tmp/restore-staging/merged-final.db";

if (existsSync(OUT)) rmSync(OUT);
if (existsSync(OUT + "-wal")) rmSync(OUT + "-wal");
if (existsSync(OUT + "-shm")) rmSync(OUT + "-shm");

const base = new Database(SNAP, { readonly: true });
base.exec("PRAGMA busy_timeout=5000");
base.exec(`VACUUM INTO '${OUT}'`);
base.close();

const db = new Database(OUT);
db.exec("PRAGMA busy_timeout=5000");
db.exec("PRAGMA journal_mode=WAL");
db.exec(`ATTACH DATABASE '${LIVE}' AS live`);

const unionTables = [
  "Signal", "SignalEvent", "AgentThought", "AdvisorProposal", "PricePoint",
  "PumpTrack", "VolCauseEvent", "FuturesSnapshot", "MarketAsset",
];
for (const t of unionTables) {
  const before = (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
  const snapCols = (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
  const liveCols = (db.prepare(`SELECT name FROM live.pragma_table_info('${t}')`).all() as { name: string }[]).map((c) => c.name);
  const common = snapCols.filter((c) => liveCols.includes(c));
  if (snapCols.length !== liveCols.length) console.log(`${t}: schema drift snap=${snapCols.length} live=${liveCols.length} → intersect=${common.length}`);
  db.exec(`INSERT OR IGNORE INTO "${t}" (${common.map((c) => `"${c}"`).join(",")}) SELECT ${common.map((c) => `"${c}"`).join(",")} FROM live."${t}"`);
  const after = (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
  console.log(`${t}: ${before} +${after - before} (from live)`);
}

// FlowScan — board rows: (symbol,tf) conflict → newer updatedAt wins
{
  const before = (db.prepare(`SELECT COUNT(*) c FROM FlowScan`).get() as { c: number }).c;
  db.exec(`
    INSERT INTO FlowScan (id, symbol, tf, score, bias, cvdPct, trend, structure, sweep, volZ, atrPct, funding8h, oiDelta1h, updatedAt)
    SELECT id, symbol, tf, score, bias, cvdPct, trend, structure, sweep, volZ, atrPct, funding8h, oiDelta1h, updatedAt
    FROM live.FlowScan
    WHERE true
    ON CONFLICT(symbol, tf) DO UPDATE SET
      id=excluded.id, score=excluded.score, bias=excluded.bias, cvdPct=excluded.cvdPct,
      trend=excluded.trend, structure=excluded.structure, sweep=excluded.sweep,
      volZ=excluded.volZ, atrPct=excluded.atrPct, funding8h=excluded.funding8h,
      oiDelta1h=excluded.oiDelta1h, updatedAt=excluded.updatedAt
    WHERE excluded.updatedAt > FlowScan.updatedAt
  `);
  const after = (db.prepare(`SELECT COUNT(*) c FROM FlowScan`).get() as { c: number }).c;
  console.log(`FlowScan: ${before} → ${after} (board rows, newer-wins)`);
}

// EngineSetting — snapshot wins every shared key; live-only keys flow in
{
  const before = (db.prepare(`SELECT COUNT(*) c FROM EngineSetting`).get() as { c: number }).c;
  db.exec(`INSERT OR IGNORE INTO EngineSetting (key, value, updatedAt) SELECT key, value, updatedAt FROM live.EngineSetting`);
  const after = (db.prepare(`SELECT COUNT(*) c FROM EngineSetting`).get() as { c: number }).c;
  console.log(`EngineSetting: ${before} +${after - before}`);
}

db.exec("DETACH DATABASE live");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const ic = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
console.log("integrity_check:", ic);

// post-reset signal top-up verification
const sMax = (db.prepare("SELECT MAX(createdAt) mx, COUNT(*) c FROM Signal").get() as { mx: number; c: number }).c;
console.log(`Signal total: ${sMax}`);
db.close();
console.log("MERGE COMPLETE →", OUT);
