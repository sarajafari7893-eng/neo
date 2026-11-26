// SENTINEL-20261124-DATA-HISTORY — coverage probe of every time-series store (readonly, no writes)
import { Database } from "bun:sqlite";
const db = new Database("db/custom.db", { readonly: true });

const TABLES = [
  ["Signal", "createdAt"],
  ["SignalEvent", "createdAt"],
  ["PricePoint", "createdAt"],
  ["FuturesSnapshot", "ts"],
  ["StableFlowEvent", "ts"],
  ["VolCauseEvent", "detectedAt"],
  ["PumpTrack", "detectedAt"],
  ["FillLedger", "createdAt"],
  ["AgentThought", "createdAt"],
  ["AdvisorProposal", "createdAt"],
];

// 1) detect raw timestamp format per table
const fmt = {};
for (const [t, c] of TABLES) {
  try {
    const r = db.query(`SELECT "${c}" v FROM "${t}" ORDER BY rowid DESC LIMIT 1`).get();
    fmt[t] = r ? typeof r.v : "empty";
  } catch (e) { fmt[t] = "ERR:" + e.message; }
}
console.log("--- formats ---");
for (const [t, c] of TABLES) console.log(`  ${t}.${c}: ${fmt[t]}`);

// 2) per-table min/max/count
console.log("--- min/max/count ---");
for (const [t, c] of TABLES) {
  try {
    const r = db.query(`SELECT COUNT(*) c, MIN("${c}") mn, MAX("${c}") mx FROM "${t}"`).get();
    console.log(`  ${t}: rows=${r.c} min=${JSON.stringify(r.mn)} max=${JSON.stringify(r.mx)}`);
  } catch (e) { console.log(`  ${t}: ERR ${e.message}`); }
}

// 3) November per-day coverage for the key collection stores
const dayExpr = (t, c) => (fmt[t] === "number"
  ? `date("${c}"/1000,'unixepoch')`
  : `substr("${c}",1,10)`);
console.log("--- November per-day (Signal / SignalEvent / PricePoint / FuturesSnapshot / StableFlowEvent / VolCauseEvent) ---");
for (const [t, c] of [["Signal","createdAt"],["SignalEvent","createdAt"],["PricePoint","createdAt"],["FuturesSnapshot","ts"],["StableFlowEvent","ts"],["VolCauseEvent","detectedAt"]]) {
  try {
    const rows = db.query(
      `SELECT ${dayExpr(t,c)} d, COUNT(*) n FROM "${t}"
       WHERE ${dayExpr(t,c)} >= '2026-11-01' AND ${dayExpr(t,c)} <= '2026-11-24'
       GROUP BY d ORDER BY d`
    ).all();
    console.log(`  ${t}:`);
    if (rows.length === 0) console.log("    (no November rows)");
    for (const r of rows) console.log(`    ${r.d}: ${r.n}`);
  } catch (e) { console.log(`  ${t}: ERR ${e.message}`); }
}

// 4) pre-November sanity (older months survived?)
console.log("--- older months (should be intact) ---");
for (const [t, c] of [["Signal","createdAt"],["PricePoint","createdAt"],["FuturesSnapshot","ts"],["SignalEvent","createdAt"]]) {
  try {
    const rows = db.query(
      `SELECT substr(${dayExpr(t,c)},1,7) m, COUNT(*) n FROM "${t}" GROUP BY m ORDER BY m`
    ).all();
    console.log(`  ${t}: ` + rows.map(r => `${r.m}=${r.n}`).join(" "));
  } catch (e) { console.log(`  ${t}: ERR ${e.message}`); }
}

// 5) EngineSetting counter keys (truncate values — never print secrets)
console.log("--- EngineSetting keys ---");
try {
  const rows = db.query(`SELECT key, value, updatedAt FROM EngineSetting ORDER BY key`).all();
  for (const r of rows) {
    const v = String(r.value ?? "").slice(0, 70).replace(/[A-Za-z0-9_-]{30,}/g, "***");
    console.log(`  ${r.key} = ${v}`);
  }
} catch (e) { console.log("  EngineSetting ERR:", e.message); }

db.close();
console.log("coverage probe done");
