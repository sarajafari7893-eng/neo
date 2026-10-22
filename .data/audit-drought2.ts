import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "fs";
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout=2500");
const now = Date.now();

console.log("=== GATE-JOURNAL: last 24h veto/pass census ===");
const lines = readFileSync("/home/z/my-project/.data/gate-journal.jsonl", "utf8").trim().split("\n");
const cut = now - 24 * 3600 * 1000;
const census: Record<string, number> = {};
const symbolsByGate: Record<string, Map<string, number>> = {};
let newest = 0, oldest = Infinity;
for (const ln of lines) {
  try {
    const j = JSON.parse(ln);
    const v = j.k === "b" ? j.v : null;
    const at = j.k === "b" ? v.at : j.v.at;
    if (at < cut) continue;
    if (at > newest) newest = at;
    if (at < oldest) oldest = at;
    const gate = j.k === "b" ? v.gate : "PASS(" + j.v.source + ")";
    census[gate] = (census[gate] || 0) + 1;
    if (j.k === "b") {
      symbolsByGate[gate] = symbolsByGate[gate] || new Map();
      symbolsByGate[gate].set(v.symbol, (symbolsByGate[gate].get(v.symbol) || 0) + 1);
    }
  } catch {}
}
console.log(`window: ${new Date(oldest).toISOString()} → ${new Date(newest).toISOString()}`);
for (const [g, n] of Object.entries(census).sort((a, b) => b[1] - a[1])) {
  console.log(`${g.padEnd(22)} ${n}`);
  if (symbolsByGate[g]) {
    const top = [...symbolsByGate[g].entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`   top: ${top.map(([s, c]) => s + "×" + c).join("  ")}`);
  }
}

console.log("\n=== LAST 10 ISSUED (created) signals with analysis head ===");
const last = db.prepare(`
  SELECT symbol, direction, strategy, status, createdAt, confidence,
         substr(COALESCE(analysis,''),1,110) a
  FROM Signal ORDER BY createdAt DESC LIMIT 10
`).all() as any[];
for (const r of last) console.log(`${new Date(r.createdAt).toISOString()} ${r.symbol.padEnd(12)} ${String(r.direction).padEnd(6)} ${String(r.strategy).slice(0, 12).padEnd(12)} ${String(r.status).padEnd(8)} conf=${r.confidence} | ${(r.a || "").replace(/\n/g, " ")}`);
db.close();
