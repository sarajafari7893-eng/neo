// SENTINEL-20261124-DATA-HISTORY — post-recovery readback (readonly)
// NOTE: numeric literals inlined; string keys inline — no param binding needed.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
const db = new Database("db/custom.db", { readonly: true });

// gate row (full) — standing mandate: all decisive knobs open after reset
const gate = db.query(`SELECT value, updatedAt FROM EngineSetting WHERE key='gate'`).get();
if (gate) {
  try {
    const g = JSON.parse(gate.value);
    const pick = ["minScore", "minScorePinned", "decisiveFilter", "decisiveErMin", "volBarrier", "shortGuard", "chaseThrAdj", "dislocationGate", "regimeGuard", "dlConfFloor", "maxLevCap"];
    const out = {};
    for (const k of pick) if (k in g) out[k] = g[k];
    console.log("gate row:", JSON.stringify(out));
  } catch { console.log("gate row raw:", String(gate.value).slice(0, 300)); }
}
for (const key of ["strat-pause.state", "shadowveto.config"]) {
  const r = db.query(`SELECT value FROM EngineSetting WHERE key='${key}'`).get();
  if (r) {
    let v = r.value;
    try { const j = JSON.parse(v); if (j.pauses) { v = JSON.stringify(Object.fromEntries(Object.entries(j.pauses).map(([k, p]) => [k, p.enabled]))); } else { v = String(v).slice(0, 220); } } catch {}
    console.log(`${key}:`, String(v).slice(0, 220));
  }
}
db.close();

// RAW-CAL heartbeat
try { console.log("heartbeat:", readFileSync(".data/rawcal-run-heartbeat.txt", "utf8").trim().slice(0, 220)); }
catch (e) { console.log("heartbeat: MISSING", e.message); }

// fapi ban window
try {
  const b = JSON.parse(readFileSync(".data/fapi-gate/bans.json", "utf8"));
  const now = Date.now();
  const ips = Object.entries(b.ipBans ?? {}).map(([ip, until]) => `${ip.slice(0, 12)}:${Math.max(0, Math.round((Number(until) - now) / 60000))}m`);
  console.log("fapi bans remaining:", ips.join(" ") || "none");
} catch (e) { console.log("bans: unreadable"); }
console.log("readback done");
