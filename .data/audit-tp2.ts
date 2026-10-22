import {Database} from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db", {readonly: true});
db.exec("PRAGMA busy_timeout=2500");
const NOW = Math.floor(Date.now()/1000);

console.log("=== TODAY bleeding by strategy: n | tp1% | sl% | avgPnl | usd ===");
const t = db.query(
  `SELECT strategy, COUNT(*) n,
   ROUND(100.0*SUM(CASE WHEN reachedTp>=1 THEN 1 ELSE 0 END)/COUNT(*),1) tp1,
   ROUND(100.0*SUM(CASE WHEN status='SL' THEN 1 ELSE 0 END)/COUNT(*),1) sl,
   ROUND(AVG(pnlPercent),2) avgPnl,
   ROUND(SUM(pnlPercent*marginUsd/100.0),2) usd
   FROM Signal WHERE status IN ('SL','TP3','CLOSED') AND closedAt IS NOT NULL
   AND closedAt > (${NOW}-86400)*1000 GROUP BY strategy ORDER BY usd`).all();
for (const r of t) console.log(r.strategy, "|", r.n, "|", r.tp1, "|", r.sl, "|", r.avgPnl, "|", r.usd);

console.log("\n=== worst 8 losers today ===");
const w = db.query(
  `SELECT symbol, strategy, direction, status, ROUND(pnlPercent,2) pnl, ROUND(pnlPercent*marginUsd/100.0,2) usd, datetime(closedAt/1000,'unixepoch') closed
   FROM Signal WHERE status IN ('SL','TP3','CLOSED') AND closedAt > (${NOW}-86400)*1000 ORDER BY usd LIMIT 8`).all();
for (const r of w) console.log(r.closed, r.symbol, r.strategy, r.direction, r.status, r.pnl + "%", r.usd + "$");

console.log("\n=== SignalEvent sample (createdAt format) ===");
const e = db.query(`SELECT type, createdAt FROM SignalEvent ORDER BY createdAt DESC LIMIT 3`).all();
for (const r of e) console.log(r.type, r.createdAt);

console.log("\n=== EXPIRED vs ENTERED issuance last 14d (funnel) ===");
const f = db.query(
  `SELECT SUM(CASE WHEN status IN ('SL','TP3','CLOSED') THEN 1 ELSE 0 END) entered,
   SUM(CASE WHEN status='EXPIRED' THEN 1 ELSE 0 END) expired
   FROM Signal WHERE createdAt > (${NOW}-86400*14)*1000`).get() as any;
console.log("entered:", f.entered, "expired:", f.expired, "entryRate%:", (100*f.entered/(f.entered+f.expired)).toFixed(1));
db.close();
