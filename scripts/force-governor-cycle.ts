// DEV UTILITY — force the next autonomous governor cycle to fire on the
// coming tick gate by rewinding lastRunAt. Does NOT change any gate value.
import { db } from "../src/lib/db";

const KEY = "governor";
const row = await db.engineSetting.findUnique({ where: { key: KEY } });
if (!row) {
  console.log("governor state row missing — cycle will use defaults");
  process.exit(0);
}
const cfg = JSON.parse(row.value) as { intervalMin?: number; cycles?: number; lastRunAt?: string | null };
const old = new Date(Date.now() - 3 * 3600_000).toISOString();
cfg.lastRunAt = old;
await db.engineSetting.update({ where: { key: KEY }, data: { value: JSON.stringify(cfg) } });
console.log(`governor lastRunAt rewound → ${old} (was ${row.value.slice(0, 160)})`);
process.exit(0);
