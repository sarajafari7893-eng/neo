// SENTINEL-20261124-DATA-HISTORY — StableFlow backfill cleanup + verify
// bun:sqlite note (learned live): db.query(sql, params) does NOT bind params on
// this bun build — Statement.all()/get() must receive them, or SQL must inline
// integers. All queries below inline numeric literals (no injection surface —
// constants only).
import { Database } from "bun:sqlite";
const db = new Database("db/custom.db");

const MONTH_START = 1793491200000;           // 2026-11-01T00:00Z
const WINDOW_END  = Date.UTC(2026, 10, 25);  // exclusive
const DAY = 86400000;

// live-covered (asset, day) pairs from NON-backfill rows
const rows = db.query(`SELECT asset, ts, source FROM StableFlowEvent WHERE ts >= ${MONTH_START} AND ts < ${WINDOW_END}`).all();
const liveDay = new Set();
for (const r of rows) {
  if (r.source === "BACKFILL") continue;
  liveDay.add(`${r.asset}@${Math.floor(Number(r.ts) / DAY)}`);
}

// delete redundant BACKFILL rows on days that already had live coverage
let deleted = 0;
const bf = db.query(`SELECT id, asset, ts FROM StableFlowEvent WHERE source='BACKFILL' AND ts >= ${MONTH_START} AND ts < ${WINDOW_END}`).all();
const delStmt = db.prepare("DELETE FROM StableFlowEvent WHERE id = ?");
for (const r of bf) {
  const day = Math.floor(Number(r.ts) / DAY);
  if (liveDay.has(`${r.asset}@${day}`)) { delStmt.run(String(r.id)); deleted++; }
}
console.log(`redundant BACKFILL rows deleted (day already had LIVE rows): ${deleted}`);
console.log(`BACKFILL rows kept (true gap days): ${bf.length - deleted}`);

// final daily coverage of the month — TOTAL/USDT/USDC/DAI/USDE/USDS
const cov = db.query(
  `SELECT date(ts/1000,'unixepoch') d,
          COUNT(*) n,
          SUM(source='BACKFILL') bf
   FROM StableFlowEvent WHERE ts >= ${MONTH_START} AND ts < ${WINDOW_END}
   GROUP BY d ORDER BY d`).all();
console.log("--- month daily coverage (rows, of which BACKFILL) ---");
for (const r of cov) console.log(`  ${r.d}: rows=${r.n} backfill=${r.bf}`);

const gapCheck = db.query(
  `SELECT date(ts/1000,'unixepoch') d, COUNT(DISTINCT asset) a
   FROM StableFlowEvent WHERE ts >= ${MONTH_START} AND ts < ${WINDOW_END}
   GROUP BY d ORDER BY d`).all();
const zeroDays = [];
for (let d = Math.floor(MONTH_START / DAY); d < Math.floor(WINDOW_END / DAY); d++) {
  const found = gapCheck.find((r) => Math.floor(new Date(r.d + "T00:00:00Z").getTime() / DAY) === d);
  if (!found) zeroDays.push(new Date(d * DAY).toISOString().slice(0, 10));
}
console.log("days with ZERO rows remaining:", JSON.stringify(zeroDays));
db.close();
