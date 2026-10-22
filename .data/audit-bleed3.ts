// BLEED-FORENSIC v1 (trace 1a15ddbdbabf84a9) — read-only
// Q1: how much is the book bleeding (windows)?  Q2: did GATE vetoes block profit or save capital?
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout=2500");
const NOW = Math.floor(Date.now() / 1000);

console.log("=== A) REALIZED BOOK (executed only, status SL/TP3/CLOSED) ===");
for (const [label, h] of [["24h", 24], ["7d", 168], ["14d", 336], ["30d", 720]] as const) {
  const r = db.query(
    `SELECT COUNT(*) n,
     ROUND(100.0*SUM(CASE WHEN reachedTp>=1 THEN 1 ELSE 0 END)/COUNT(*),1) tp1,
     ROUND(100.0*SUM(CASE WHEN status='SL' THEN 1 ELSE 0 END)/COUNT(*),1) sl,
     ROUND(SUM(pnlPercent*marginUsd/100.0),2) gross,
     ROUND(SUM(COALESCE(feeUsd,0)+COALESCE(swapUsd,0)),2) fees
     FROM Signal WHERE status IN ('SL','TP3','CLOSED') AND closedAt IS NOT NULL
     AND closedAt > (${NOW}-${h*3600})*1000`).get() as any;
  if (r && r.n > 0) console.log(`${label} | n=${r.n} | TP1%=${r.tp1} | SL%=${r.sl} | gross=$${r.gross} | fees=$${r.fees} | net≈$${(r.gross - r.fees).toFixed(2)}`);
  else console.log(`${label} | n=0`);
}

console.log("\n=== B) 7d by strategy (n | TP1% | SL% | net$) ===");
const t = db.query(
  `SELECT strategy, COUNT(*) n,
   ROUND(100.0*SUM(CASE WHEN reachedTp>=1 THEN 1 ELSE 0 END)/COUNT(*),1) tp1,
   ROUND(100.0*SUM(CASE WHEN status='SL' THEN 1 ELSE 0 END)/COUNT(*),1) sl,
   ROUND(SUM(pnlPercent*marginUsd/100.0 - COALESCE(feeUsd,0) - COALESCE(swapUsd,0)),2) net
   FROM Signal WHERE status IN ('SL','TP3','CLOSED') AND closedAt IS NOT NULL
   AND closedAt > (${NOW}-604800)*1000 GROUP BY strategy ORDER BY net`).all();
for (const r of t) console.log(`${r.strategy} | n=${r.n} | TP1=${r.tp1}% | SL=${r.sl}% | $${r.net}`);

console.log("\n=== C) worst 8 losers 24h ===");
const w = db.query(
  `SELECT symbol, strategy, direction, status, ROUND(pnlPercent,1) pnl, ROUND(pnlPercent*marginUsd/100.0,2) usd,
   datetime(closedAt/1000,'unixepoch') closed
   FROM Signal WHERE status IN ('SL','TP3','CLOSED') AND closedAt > (${NOW}-86400)*1000 ORDER BY usd LIMIT 8`).all();
for (const r of w) console.log(`${r.closed} ${r.symbol} ${r.strategy} ${r.direction} ${r.status} ${r.pnl}% $${r.usd}`);

console.log("\n=== D) GATE-VETO COUNTERFACTUAL (near-miss journal, tier=GATE, settled) ===");
const nm = readFileSync("/home/z/my-project/.data/near-miss.jsonl", "utf8").trim().split("\n")
  .map((l) => { try { return JSON.parse(l).v; } catch { return null; } })
  .filter((v): v is any => v && v.tier === "GATE");
const settled = nm.filter((v) => v.status !== "OPEN" && v.status !== "ACTIVE");
const sum = (arr: any[], f: (x: any) => number) => arr.reduce((a, x) => a + (f(x) || 0), 0);
const d24 = settled.filter((v) => Date.now() - v.at < 86400e3);
const d7 = settled.filter((v) => Date.now() - v.at < 7 * 86400e3);
const stats = (label: string, arr: any[]) => {
  if (arr.length === 0) { console.log(`${label} | n=0`); return; }
  const tp1 = arr.filter((v) => (v.reachedTp ?? 0) >= 1).length;
  const sl = arr.filter((v) => v.status === "SL").length;
  console.log(`${label} | n=${arr.length} | TP1%=${(100 * tp1 / arr.length).toFixed(1)} | SL%=${(100 * sl / arr.length).toFixed(1)} | whatIfPnL=$${sum(arr, (v) => v.pnlUsd).toFixed(2)}`);
};
stats("ALL settled (since NM-1)", settled);
stats("7d settled", d7);
stats("24h settled", d24);

console.log("\n=== D2) veto tier distribution (all 24h rows incl. open) ===");
const nm24 = nm.filter((v) => Date.now() - v.at < 86400e3);
const byTier: Record<string, number> = {};
for (const v of nm24) byTier[v.tier] = (byTier[v.tier] ?? 0) + 1;
console.log(JSON.stringify(byTier), "total24h:", nm24.length);

console.log("\n=== E) gate-journal census 24h (k=b, v.gate) ===");
const gj = readFileSync("/home/z/my-project/.data/gate-journal.jsonl", "utf8").trim().split("\n");
const by: Record<string, number> = {};
let n24 = 0;
for (const l of gj) {
  try { const r = JSON.parse(l); if (r.k === "b" && Date.now() - r.v.at < 86400e3) { by[r.v.gate] = (by[r.v.gate] ?? 0) + 1; n24++; } } catch { /* skip */ }
}
console.log(JSON.stringify(by), "total24h:", n24);
console.log("REARM-BRAKE all-time:", gj.filter((l) => l.includes("REARM-BRAKE")).length);

console.log("\n=== F) issuance funnel 14d ===");
const f = db.query(
  `SELECT SUM(CASE WHEN status IN ('SL','TP3','CLOSED') THEN 1 ELSE 0 END) entered,
   SUM(CASE WHEN status='EXPIRED' THEN 1 ELSE 0 END) expired,
   COUNT(*) total FROM Signal WHERE createdAt > (${NOW}-1209600)*1000`).get() as any;
console.log(`issued=${f.total} entered=${f.entered} expired=${f.expired} entryRate=${(100 * f.entered / f.total).toFixed(1)}%`);

console.log("\n=== G) RAWCAL ===");
const rl = readFileSync("/home/z/my-project/.data/rawcal-telemetry.jsonl", "utf8").trim().split("\n");
const last = JSON.parse(rl[rl.length - 1] ?? "{}");
console.log(`issued=${last.issued}/${last.issuedTotal} settledRaw=${last.settledRaw} winsRaw=${last.winsRaw} rawWR=${(100 * (last.winsRaw ?? 0) / Math.max(1, last.settledRaw ?? 1)).toFixed(1)}%`);
db.close();
