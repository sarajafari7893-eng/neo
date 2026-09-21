const { Database } = require("bun:sqlite");
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
for (const k of ["gate", "governor", "ai", "engine", "min_score", "thresholds"]) {
  const r = db.prepare("SELECT key, value, updatedAt FROM EngineSetting WHERE key = ?").all(k) as any[];
  if (r.length) console.log("KEY:", r[0].key, "→", (r[0].value||"").slice(0, 400), " @", r[0].updatedAt);
}
console.log("--- all keys ---");
for (const r of db.prepare("SELECT key FROM EngineSetting ORDER BY key").all() as any[]) process.stdout.write(r.key + " ");
console.log();
db.close();
