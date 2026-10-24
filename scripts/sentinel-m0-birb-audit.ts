// SENTINEL M0/M2 — BIRBUSDT forensics v2 (READ-ONLY, schema-introspecting)
import { Database } from "bun:sqlite";

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout=2500");

const cols = (t: string): string[] =>
  (db.query(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
const q = (s: string): any[] => {
  try {
    return db.query(s).all() as any[];
  } catch (e: any) {
    return [{ __err: e.message }];
  }
};

const T = ["MarketAsset", "PricePoint", "VolCauseEvent", "FlowScan", "Signal"];
for (const t of T) console.log(`COLS ${t}:`, cols(t).join(","));

const pick = (t: string, wanted: string[]): string => {
  const have = cols(t);
  const chosen = wanted.filter((w) => have.includes(w));
  return chosen.length ? chosen.join(", ") : have.slice(0, 8).join(", ");
};

const sym = "BIRBUSDT";
const hasCol = (t: string, c: string) => cols(t).includes(c);

console.log("\n=== MarketAsset BIRB ===");
console.log(q(`SELECT * FROM MarketAsset WHERE symbol LIKE '%BIRB%'`));

console.log("\n=== PricePoint BIRB ===");
if (hasCol("PricePoint", "symbol")) {
  const tsCol = hasCol("PricePoint", "ts") ? "ts" : hasCol("PricePoint", "timestamp") ? "timestamp" : hasCol("PricePoint", "createdAt") ? "createdAt" : "";
  console.log(q(`SELECT COUNT(*) n, MIN(${tsCol}) first, MAX(${tsCol}) last FROM PricePoint WHERE symbol='${sym}'`));
  console.log("recent:", q(`SELECT ${tsCol}, ${hasCol("PricePoint","price")?"price":"*"} FROM PricePoint WHERE symbol='${sym}' ORDER BY ${tsCol} DESC LIMIT 4`));
}

console.log("\n=== VolCauseEvent BIRB ===");
const vSym = "symbol";
const vTime = hasCol("VolCauseEvent", "detectedAt") ? "detectedAt" : "createdAt";
const vOrder = vTime.endsWith("At") ? `${vTime} DESC` : vTime;
const vSel = pick("VolCauseEvent", ["id", vSym, "direction", "magnitudePct", "magnitude", "tier", "severity", vTime, "status", "source"]);
console.log(q(`SELECT ${vSel} FROM VolCauseEvent WHERE ${vSym}='${sym}' ORDER BY ${vOrder} DESC LIMIT 8`));
console.log("global recent 8:", q(`SELECT ${vSym}, ${vOrder.includes("DESC") ? vTime : vTime} , ${hasCol("VolCauseEvent","direction")?"direction":"''"} dir FROM VolCauseEvent ORDER BY ${vTime} DESC LIMIT 8`));

console.log("\n=== FlowScan BIRB ===");
if (hasCol("FlowScan", "symbol")) {
  const fTime = hasCol("FlowScan", "scannedAt") ? "scannedAt" : hasCol("FlowScan", "createdAt") ? "createdAt" : cols("FlowScan").find((c) => /At|time/i.test(c)) || cols("FlowScan")[0];
  console.log(q(`SELECT * FROM FlowScan WHERE symbol='${sym}' ORDER BY ${fTime} DESC LIMIT 3`).map((r) => JSON.stringify(r).slice(0, 500)));
}

console.log("\n=== Signal BIRB ===");
const sTime = hasCol("Signal", "createdAt") ? "createdAt" : "detectedAt";
const sSel = pick("Signal", ["id", "symbol", "side", "direction", "status", sTime, "expiresAt", "entryPrice"]);
console.log(q(`SELECT ${sSel} FROM Signal WHERE symbol='${sym}' ORDER BY ${sTime} DESC LIMIT 5`));

console.log("\n=== Signals per hour, last 12h (all symbols) — scanner alive? ===");
if (hasCol("Signal", "createdAt")) {
  console.log(q(`SELECT strftime('%H', datetime(createdAt/1000,'unixepoch','+3.5 hours')) h Tehran, COUNT(*) n FROM Signal WHERE createdAt > (CAST(strftime('%s','now') AS INTEGER)-43200)*1000 GROUP BY h ORDER BY h`));
}
db.close();
console.log("\n=== done (readonly) ===");
