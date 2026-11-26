// verify merge quality: post-reset signals + FlowScan freshness
import { Database } from "bun:sqlite";

const live = new Database("/home/z/my-project/db/custom.db", { readonly: true });
live.exec("PRAGMA busy_timeout=2500");
const merged = new Database("/tmp/restore-staging/merged.db", { readonly: true });
merged.exec("PRAGMA busy_timeout=2500");

// a) live-only signals (createdAt > snapshot cutoff 08:21 OR ids absent in merged)
const liveSignals = live.prepare("SELECT id, serial, symbol, direction, strategy, status, createdAt FROM Signal ORDER BY createdAt DESC LIMIT 20").all() as { id: string; serial: number; symbol: string; direction: string; strategy: string; status: string; createdAt: number }[];
let missing = 0;
for (const s of liveSignals) {
  const hit = merged.prepare("SELECT id FROM Signal WHERE id = ?").get(s.id);
  if (!hit) { missing++; console.log(`MISSING SIGNAL: ${s.id} NX-${s.serial} ${s.symbol} ${s.direction} ${s.strategy} ${new Date(s.createdAt).toISOString()}`); }
}
console.log(`live top-20 signals missing in merged: ${missing}`);

// max createdAt in merged vs live
const mMax = (merged.prepare("SELECT MAX(createdAt) mx FROM Signal").get() as { mx: number }).mx;
const lMax = (live.prepare("SELECT MAX(createdAt) mx FROM Signal").get() as { mx: number }).mx;
console.log(`Signal max createdAt: merged=${new Date(mMax).toISOString()} live=${new Date(lMax).toISOString()}`);

// b) FlowScan freshness: merged max updatedAt vs live max
const mFs = (merged.prepare("SELECT MAX(updatedAt) mx FROM FlowScan").get() as { mx: number }).mx;
const lFs = (live.prepare("SELECT MAX(updatedAt) mx FROM FlowScan").get() as { mx: number }).mx;
console.log(`FlowScan max updatedAt: merged=${new Date(mFs).toISOString()} live=${new Date(lFs).toISOString()}`);
const row = live.prepare("SELECT symbol, tf, updatedAt FROM FlowScan ORDER BY updatedAt DESC LIMIT 1").get() as { symbol: string; tf: string; updatedAt: number };
const mRow = merged.prepare("SELECT symbol, tf, updatedAt, score, bias FROM FlowScan WHERE symbol=? AND tf=?").get(row.symbol, row.tf) as { symbol: string; tf: string; updatedAt: number } | null;
console.log(`live newest FlowScan row: ${row.symbol}|${row.tf}@${new Date(row.updatedAt).toISOString()} → merged has ${mRow ? `same combo @${new Date(mRow.updatedAt).toISOString()}` : "NOTHING"}`);

live.close(); merged.close();
