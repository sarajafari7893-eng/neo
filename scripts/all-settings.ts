const { Database } = require("bun:sqlite");
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
for (const r of db.prepare("SELECT key, value, updatedAt FROM EngineSetting ORDER BY updatedAt DESC").all() as any[]) {
  console.log("■", r.key, "@", r.updatedAt, "→", (r.value||"").slice(0, 260));
}
db.close();
