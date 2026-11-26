// SENTINEL M2 — FlowScan freshness across symbols + BIRB gaps (READ-ONLY)
import { Database } from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout=2500");
const q = (s: string): any[] => { try { return db.query(s).all() as any[]; } catch (e: any) { return [{ __err: e.message }]; } };

const now = Date.now();
console.log("now-ms:", now, "now-Tehran:", new Date(now + 3.5 * 3600e3).toISOString().replace("T", " ").slice(0, 19));

console.log("\n=== VolCauseEvent BIRBUSDT last 6 (raw) ===");
console.log(q(`SELECT id, detectedAt, direction, change24h, onsetScore, primaryCause FROM VolCauseEvent WHERE symbol='BIRBUSDT' ORDER BY detectedAt DESC LIMIT 6`));

console.log("\n=== Events per hour last 6h (all symbols) ===");
console.log(q(`SELECT (detectedAt/3600000) hEpoch, COUNT(*) n, MIN(symbol) m FROM VolCauseEvent WHERE detectedAt > ${now - 6 * 3600e3} GROUP BY hEpoch ORDER BY hEpoch DESC LIMIT 8`));

console.log("\n=== BIRBUSDT event timeline last 24h ===");
console.log(q(`SELECT detectedAt, direction, change24h FROM VolCauseEvent WHERE symbol='BIRBUSDT' AND detectedAt > ${now - 24 * 3600e3} ORDER BY detectedAt ASC`).map(r => ({ t: new Date(r.detectedAt + 3.5 * 3600e3).toISOString().slice(11, 19) + " THR", d: r.direction, c: r.change24h })));

console.log("\n=== FlowScan staleness ranking (oldest 10 of 1h TF) ===");
console.log(q(`SELECT symbol, updatedAt FROM FlowScan WHERE tf='1h' ORDER BY updatedAt ASC LIMIT 10`).map(r => ({ s: r.symbol, ageMin: Math.round((now - r.updatedAt) / 60000) })));
console.log("=== FlowScan freshest 5 (1h TF) ===");
console.log(q(`SELECT symbol, updatedAt FROM FlowScan WHERE tf='1h' ORDER BY updatedAt DESC LIMIT 5`).map(r => ({ s: r.symbol, ageMin: Math.round((now - r.updatedAt) / 60000) })));

console.log("\n=== PricePoint last-write per key symbol (min) ===");
for (const s of ["BIRBUSDT", "IRYSUSDT", "ERAUSDT", "BMTUSDT"]) {
  console.log(q(`SELECT MAX(createdAt) last FROM PricePoint WHERE symbol='${s}'`).map(r => ({ s, ageMin: Math.round((now - r.last) / 60000) })));
}
db.close();
