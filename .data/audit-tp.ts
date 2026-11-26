import {Database} from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db", {readonly: true});
db.exec("PRAGMA busy_timeout=2500");

const NOW = Math.floor(Date.now()/1000);

console.log("=== PER-DAY last 21d (closedAt): d | n | tp1% | sl% | sumUsd ===");
const rows = db.query(
  `SELECT date(datetime(closedAt/1000, 'unixepoch')) d, COUNT(*) n,
   ROUND(100.0*SUM(CASE WHEN reachedTp>=1 THEN 1 ELSE 0 END)/COUNT(*),1) tp1,
   ROUND(100.0*SUM(CASE WHEN status='SL' THEN 1 ELSE 0 END)/COUNT(*),1) sl,
   ROUND(SUM(pnlPercent*marginUsd/100.0),2) usd
   FROM Signal WHERE status IN ('SL','TP3','CLOSED','EXPIRED') AND closedAt IS NOT NULL
   AND closedAt > (?-86400*21)*1000 GROUP BY d ORDER BY d DESC`).all(NOW);
for (const r of rows) console.log(r.d, "|", r.n, "|", r.tp1, "|", r.sl, "|", r.usd);

console.log("\n=== ENTERED-COHORT (excl EXPIRED) TP1 by period ===");
const periods: [string, string][] = [
  ["2d", `closedAt > (${NOW}-86400*2)*1000`],
  ["3-7d", `closedAt <= (${NOW}-86400*2)*1000 AND closedAt > (${NOW}-86400*7)*1000`],
  ["8-14d", `closedAt <= (${NOW}-86400*7)*1000 AND closedAt > (${NOW}-86400*14)*1000`],
  ["15-30d", `closedAt <= (${NOW}-86400*14)*1000 AND closedAt > (${NOW}-86400*30)*1000`],
  [">30d", `closedAt <= (${NOW}-86400*30)*1000`],
];
for (const [lbl, cond] of periods) {
  const r = db.query(
    `SELECT COUNT(*) n, ROUND(100.0*SUM(CASE WHEN reachedTp>=1 THEN 1 ELSE 0 END)/COUNT(*),1) tp1,
     ROUND(SUM(pnlPercent*marginUsd/100.0),2) usd
     FROM Signal WHERE status IN ('SL','TP3','CLOSED') AND closedAt IS NOT NULL AND ${cond}`).get() as any;
  console.log(lbl, "| entered:", r.n, "| tp1%:", r.tp1, "| usd:", r.usd);
}

console.log("\n=== DETECTION LAYER EVIDENCE on last 40 issued signals ===");
const sigs = db.query(
  `SELECT symbol, strategy, datetime(createdAt/1000,'unixepoch') ts,
   length(flowJson) flen, length(factorsJson) factlen, qualityFlag
   FROM Signal ORDER BY createdAt DESC LIMIT 40`).all() as any[];
const noFlow = sigs.filter(s => !s.flen || s.flen < 10).length;
console.log("signals with flowJson empty/short:", noFlow, "/", sigs.length);
for (const s of sigs.slice(0, 12)) console.log(s.ts, s.symbol, s.strategy, "flowLen:", s.flen, "factLen:", s.factlen, "q:", s.qualityFlag);

console.log("\n=== flowJson content sample (newest signal) ===");
const fs = db.query(`SELECT flowJson FROM Signal WHERE flowJson IS NOT NULL AND length(flowJson)>10 ORDER BY createdAt DESC LIMIT 1`).get() as any;
if (fs) console.log(fs.flowJson.slice(0, 500));

console.log("\n=== SignalEvent types last 24h (detection heartbeat evidence) ===");
const evs = db.query(
  `SELECT type, COUNT(*) n FROM SignalEvent WHERE createdAt > (?-86400)*1000 GROUP BY type ORDER BY n DESC`).all(NOW*1000);
for (const e of evs) console.log(e.type, e.n);

db.close();
