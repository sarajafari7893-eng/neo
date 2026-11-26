// SENTINEL-20261124-RESET-RECOVERY — DB corruption probe (readonly, no writes)
import { Database } from "bun:sqlite";
const path = "db/custom.db";
const db = new Database(path, { readonly: true });

console.log("--- pragmas ---");
try { console.log("journal_mode:", db.query("PRAGMA journal_mode").get()); } catch (e) { console.log("journal_mode ERR:", e.message); }
try { console.log("freelist_count:", db.query("PRAGMA freelist_count").get()); } catch (e) { console.log("freelist ERR:", e.message); }
try { console.log("page_size:", db.query("PRAGMA page_size").get()); } catch (e) { console.log("page_size ERR:", e.message); }

console.log("--- integrity_check(20) ---");
try {
  const rows = db.query("PRAGMA integrity_check(20)").all();
  for (const r of rows) console.log(" ", r["integrity_check"] ?? JSON.stringify(r));
} catch (e) { console.log("integrity_check threw:", e.message); }

console.log("--- per-table probe (count + tail scan) ---");
let ok = 0, fail = 0;
const tabs = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
for (const t of tabs) {
  const n = t.name;
  try {
    const c = db.query(`SELECT COUNT(*) c FROM "${n}"`).get();
    db.query(`SELECT * FROM "${n}" ORDER BY rowid DESC LIMIT 3`).all();
    console.log(`  OK   ${n} rows=${c.c}`);
    ok++;
  } catch (e) {
    console.log(`  FAIL ${n} :: ${String(e.message).slice(0, 140)}`);
    fail++;
  }
}
console.log(`--- summary: ok=${ok} fail=${fail} ---`);
