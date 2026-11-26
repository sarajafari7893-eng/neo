// SENTINEL-20261124-DATA-HISTORY — REVERT the erroneous unpause (self-correction)
// During reset-recovery I unpaused AI-SCALP + MEAN-REVERT citing the standing
// 2026-11-06 open-gates order. Readback then revealed those pauses were the
// NEWER, deliberate performance-protection decision (2026-11-10T21:57:41.273Z,
// trace 1a1c76eb7b64d83d «افت شدید حساب») — newer mandate supersedes older
// blanket order. This script reinstates the pauses exactly (original since kept,
// original reason/by reconstructed + provenance note appended, evidence kept).
import { Database } from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db");
db.exec("PRAGMA busy_timeout=4000");

const spRow = db.query('SELECT value FROM EngineSetting WHERE key = ?').get("strat-pause.state");
if (!spRow) throw new Error("strat-pause.state row missing — aborting");
const sp = JSON.parse(spRow.value);
const nowIso = new Date().toISOString();
for (const strat of ["AI-SCALP", "MEAN-REVERT"]) {
  const p = sp.pauses?.[strat];
  if (!p) throw new Error(`${strat}: no pause row — aborting`);
  p.enabled = true;
  p.reason = "PAUSED per performance mandate 2026-11-10 (trace 1a1c76eb7b64d83d) — reinstated by SENTINEL-20261124-DATA-HISTORY after erroneous unpause during reset-recovery (self-correction, operator-visible)";
  p.by = "SENTINEL (performance mandate 2026-11-10) — reinstated SENTINEL-20261124-DATA-HISTORY";
  p.since = "2026-11-10T21:57:41.273Z"; // original pause timestamp preserved
  if (!p.evidence) p.evidence = "original evidence row was overwritten during the erroneous unpause; provenance: trace 1a1c76eb7b64d83d, since 2026-11-10T21:57:41.273Z";
}
sp.lastChangedAt = nowIso;
sp.lastChangedBy = "SENTINEL-20261124-DATA-HISTORY (revert self-correction)";
db.query('UPDATE EngineSetting SET value = ? WHERE key = ?').run(JSON.stringify(sp), "strat-pause.state");
const back = JSON.parse(db.query('SELECT value FROM EngineSetting WHERE key = ?').get("strat-pause.state").value);
console.log("strat-pause readback:", JSON.stringify(Object.fromEntries(Object.entries(back.pauses ?? {}).map(([k, v]) => [k, v.enabled]))));
for (const strat of ["AI-SCALP", "MEAN-REVERT"]) {
  const p = back.pauses?.[strat];
  if (p?.enabled !== true || p?.since !== "2026-11-10T21:57:41.273Z") throw new Error(`${strat} reinstate mismatch — aborting`);
  console.log(`  ${strat}: since=${p.since} by="${p.by}"`);
}
db.close();
console.log("OK — performance-mandate pauses reinstated (newer decision supersedes 11-06 blanket order)");
