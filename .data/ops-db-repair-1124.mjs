// SENTINEL-20261124-RESET-RECOVERY — DB index repair (REINDEX + checkpoint)
// Corruption scope (probe): indexes PricePoint_symbol_createdAt_idx,
// sqlite_autoindex_PricePoint_1, FlowScan_updatedAt_idx. All table data readable.
import { Database } from "bun:sqlite";
const db = new Database("db/custom.db"); // read-write

function safe(label, fn) {
  try { console.log(label, fn()); } catch (e) { console.log(label, "ERR:", e.message); }
}

safe("checkpoint#1:", () => db.query("PRAGMA wal_checkpoint(TRUNCATE)").all());

const t0 = Date.now();
try { db.run("REINDEX"); console.log("REINDEX ok in", Date.now() - t0, "ms"); }
catch (e) { console.log("REINDEX ERR:", e.message); }

console.log("--- integrity_check (full) ---");
try {
  const rows = db.query("PRAGMA integrity_check").all();
  const msgs = rows.map(r => r.integrity_check ?? JSON.stringify(r));
  const bad = msgs.filter(m => m !== "ok");
  console.log("  verdict:", bad.length === 0 ? "OK — database is clean" : `STILL ${bad.length} issue(s)`);
  for (const m of bad.slice(0, 30)) console.log("   -", m);
} catch (e) { console.log("integrity_check ERR:", e.message); }

safe("checkpoint#2:", () => db.query("PRAGMA wal_checkpoint(TRUNCATE)").all());

safe("PricePoint rows:", () => db.query("SELECT COUNT(*) c FROM PricePoint").get().c);
safe("FlowScan rows:", () => db.query("SELECT COUNT(*) c FROM FlowScan").get().c);
safe("Signal rows:", () => db.query("SELECT COUNT(*) c FROM Signal").get().c);
safe("EngineSetting rows:", () => db.query("SELECT COUNT(*) c FROM EngineSetting").get().c);
db.close();
console.log("repair done");
