// OPS AUDIT v2 2026-11-11 — fixed ms-bindings + journal k/v parse (readonly)
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
const now = Date.now();
const q = (s, p = []) => db.query(s).all(...p);
const iso = (t) => new Date(t).toISOString();
const H = (h) => now - h * 3600000;

console.log("### SignalEvent windows (ms bindings)");
console.log("26h by type:", JSON.stringify(q("SELECT type, COUNT(*) n FROM SignalEvent WHERE createdAt >= ? GROUP BY type ORDER BY n DESC", [H(26)])));
const nocand = q("SELECT COUNT(*) n, MIN(createdAt) mn, MAX(createdAt) mx FROM SignalEvent WHERE message LIKE '%scan found no live candidate%' AND createdAt >= ?", [H(26)])[0];
console.log("scan-no-candidate 26h:", nocand.n, nocand.n ? `${iso(nocand.mn)} → ${iso(nocand.mx)}` : "");
console.log("RAW-CAL ISSUE 26h:", q("SELECT COUNT(*) n FROM SignalEvent WHERE message LIKE 'RAW-CAL ISSUE%' AND createdAt >= ?", [H(26)])[0].n);
console.log("memory-skip 12h:", q("SELECT COUNT(*) n FROM SignalEvent WHERE message LIKE 'Memory gate: skipped%' AND createdAt >= ?", [H(12)])[0].n);
{
  const memRows = q("SELECT message FROM SignalEvent WHERE message LIKE 'Memory gate: skipped%' AND createdAt >= ?", [H(12)]);
  const symMap = new Map();
  for (const r of memRows) { const m = String(r.message).match(/skipped (\w+)/); if (m) symMap.set(m[1], (symMap.get(m[1]) ?? 0) + 1); }
  console.log("memory-skip by symbol 12h:", [...symMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(" "));
}
console.log("stale/starved 6h:", q("SELECT COUNT(*) n FROM SignalEvent WHERE (message LIKE '%starved%' OR message LIKE '%STALE%') AND createdAt >= ?", [H(6)])[0].n);
console.log("fapi-related 26h:", q("SELECT COUNT(*) n FROM SignalEvent WHERE message LIKE '%fapi%' AND createdAt >= ?", [H(26)])[0].n);
{
  const flood = q("SELECT substr(message,1,34) p, COUNT(*) n FROM SignalEvent WHERE createdAt >= ? AND type='ENGINE' GROUP BY p ORDER BY n DESC LIMIT 10", [H(6)]);
  console.log("ENGINE flood top10 6h:", JSON.stringify(flood));
}
console.log("last 10 events:");
for (const e of q("SELECT createdAt, type, level, substr(message,1,110) m FROM SignalEvent ORDER BY createdAt DESC LIMIT 10")) console.log(`  ${iso(e.createdAt)} [${e.type}/${e.level}] ${e.m}`);

console.log("\n### Gate journal v2 (k/v format)");
const jp = "/home/z/my-project/.data/gate-journal.jsonl";
const size = statSync(jp).size;
const txt = await Bun.file(jp).slice(Math.max(0, size - 4_000_000)).text();
const lines = txt.split("\n").filter(Boolean);
const entries = [];
for (let i = 1; i < lines.length; i++) { try { entries.push(JSON.parse(lines[i])); } catch { /* partial head */ } }
const byK = new Map();
for (const e of entries) byK.set(e.k, (byK.get(e.k) ?? 0) + 1);
console.log("k distribution (tail 4MB):", [...byK.entries()].map(([k, v]) => `${k}=${v}`).join(" "));
for (const k of byK.keys()) {
  const s = entries.find((e) => e.k === k);
  console.log(`sample k=${k}: ${JSON.stringify(s).slice(0, 380)}`);
}
// one PASS + one non-PASS sample (v body)
const pass = entries.find((e) => e?.v?.band === "PASS");
const nonpass = entries.find((e) => e?.v?.band && e?.v?.band !== "PASS");
if (pass) console.log("PASS sample v:", JSON.stringify(pass.v).slice(0, 460));
if (nonpass) console.log("NONPASS sample v:", JSON.stringify(nonpass.v).slice(0, 460));
const cut = H(24), cut3 = H(3);
const band24 = new Map(), band3 = new Map(), dirPass24 = new Map();
let n24 = 0, oldest = null;
for (const e of entries) {
  const at = Number(e?.v?.at ?? 0);
  if (!at || at < cut) continue;
  n24++; if (!oldest || at < oldest) oldest = at;
  const b = String(e?.v?.band ?? "?");
  band24.set(b, (band24.get(b) ?? 0) + 1);
  if (at >= cut3) band3.set(b, (band3.get(b) ?? 0) + 1);
  if (b === "PASS") { const d = String(e?.v?.direction ?? "?"); dirPass24.set(d, (dirPass24.get(d) ?? 0) + 1); }
}
console.log("journal rows 24h:", n24, oldest ? `(oldest ${iso(oldest)})` : "");
console.log("24h band:", [...band24.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
console.log("3h band:", [...band3.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
console.log("24h PASS by direction:", [...dirPass24.entries()].map(([k, v]) => `${k}=${v}`).join(" "));
db.close();
