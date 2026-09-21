const { Database } = require("bun:sqlite");
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
console.log("=== tables ===");
for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[]) console.log(r.name);
console.log("=== Signal schema ===");
for (const r of db.prepare("PRAGMA table_info(Signal)").all() as any[]) console.log(r.name, r.type);
db.close();
