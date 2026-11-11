// OPS AUDIT 2026-11-11 — drought forensics + winner-cohort audit (readonly)
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
const DAY = 86400000;
const now = Date.now();
const q = (sql, p = []) => db.query(sql).all(...p);
const iso = (t) => new Date(t).toISOString();

console.log("### 1) FULL EngineSetting rows of interest");
for (const k of ["gate", "strat-pause.state", "shadowveto.config", "rawcal.state", "governor-modules.mode", "sizing.mode", "strategy.weights"]) {
  const r = q("SELECT value FROM EngineSetting WHERE key=?", [k])[0];
  if (r) console.log(`-- ${k}: ${r.value}`);
}

console.log("\n### 2) Open signals / last activity");
console.log("open ACTIVE:", q("SELECT COUNT(*) n FROM Signal WHERE status='ACTIVE'")[0].n);
const lc = q("SELECT MAX(createdAt) mx FROM Signal")[0].mx;
console.log("last signal createdAt:", iso(lc), `(${((now - lc) / 3600000).toFixed(1)}h ago)`);
console.log("last engine event:", iso(q("SELECT MAX(createdAt) mx FROM SignalEvent")[0].mx));

console.log("\n### 3) RAW-CAL issuance per Tehran-day (last 6 days)");
const rawRows = q("SELECT createdAt FROM Signal WHERE tags LIKE '%RAW-CAL%'");
const tehranDay = (t) => new Date(t + 3.5 * 3600000).toISOString().slice(0, 10);
const dayMap = new Map();
for (const r of rawRows) {
  const d = tehranDay(r.createdAt);
  dayMap.set(d, (dayMap.get(d) ?? 0) + 1);
}
for (const [d, n] of [...dayMap.entries()].sort().slice(-6)) console.log(`  ${d}: ${n} issued`);

console.log("\n### 4) Settled clean book aggregates");
const rows = q(`SELECT symbol, direction, strategy, status, reachedTp, marginUsd, pnlPercent, tags, createdAt, serial FROM Signal WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','CLOSED') AND qualityFlag IS NULL`);
console.log("settled clean rows:", rows.length);
const win = (r) => r.reachedTp >= 1 || r.status === "TP1" || r.status === "TP2" || r.status === "TP3";
function stat(rs) {
  const n = rs.length;
  if (!n) return { n: 0 };
  let wins = 0, net = 0, pnl = 0;
  for (const r of rs) { if (win(r)) wins++; net += (r.marginUsd * r.pnlPercent) / 100; pnl += r.pnlPercent; }
  return { n, wrPct: +(100 * wins / n).toFixed(1), netUsd: +net.toFixed(2), avgPnlPct: +(pnl / n).toFixed(2) };
}
function group(rs, keyFn, label, minN = 1) {
  const m = new Map();
  for (const r of rs) { const k = keyFn(r); if (k === null) continue; const a = m.get(k) ?? []; a.push(r); m.set(k, a); }
  const out = [...m.entries()].map(([k, v]) => [k, stat(v)]).filter(([, s]) => s.n >= minN).sort((a, b) => (b[1].netUsd ?? 0) - (a[1].netUsd ?? 0));
  console.log(`  -- ${label}`);
  for (const [k, s] of out) console.log(`     ${k}: n=${s.n} WR=${s.wrPct}% net=$${s.netUsd} avg=${s.avgPnlPct}%`);
}
const regime = (r) => r.tags?.split(",").find((t) => t.startsWith("REGIME-"))?.replace("REGIME-", "") ?? "NONE";
const hasTag = (r, t) => ("," + (r.tags ?? "") + ",").includes("," + t + ",");
const W = { all: 0, d10: now - 10 * DAY, d7: now - 7 * DAY, d3: now - 3 * DAY, d1: now - DAY, d14: now - 14 * DAY };
const inW = (r, w) => !w || r.createdAt >= w;

console.log("  [windows]");
for (const [lbl, w] of [["ALL-TIME", W.all], ["10d", W.d10], ["7d", W.d7], ["3d", W.d3], ["24h", W.d1]]) {
  const s = stat(rows.filter((r) => inW(r, w)));
  console.log(`     ${lbl}: n=${s.n} WR=${s.wrPct}% net=$${s.netUsd} avg=${s.avgPnlPct}%`);
}
console.log("  [by Tehran-day, 10d]");
group(rows.filter((r) => r.createdAt >= W.d10), (r) => tehranDay(r.createdAt), "day");
console.log("  [by strategy, 7d]");
group(rows.filter((r) => r.createdAt >= W.d7), (r) => r.strategy, "strategy-7d");
console.log("  [by strategy, all-time]");
group(rows, (r) => r.strategy, "strategy-all");
console.log("  [by regime, 7d]");
group(rows.filter((r) => r.createdAt >= W.d7), (r) => regime(r), "regime-7d");
console.log("  [by regime, all-time]");
group(rows, (r) => regime(r), "regime-all");
console.log("  [FAPI-DEG vs clean, all-time]");
group(rows, (r) => (hasTag(r, "FAPI-DEG") ? "FAPI-DEG" : "CLEAN"), "fapideg-all");
console.log("  [FAPI-DEG vs clean, last 3d]");
group(rows.filter((r) => r.createdAt >= W.d3), (r) => (hasTag(r, "FAPI-DEG") ? "FAPI-DEG" : "CLEAN"), "fapideg-3d");
console.log("  [regime x direction, 7d]");
group(rows.filter((r) => r.createdAt >= W.d7), (r) => `${regime(r)}|${r.direction}`, "regdir-7d");
console.log("  [regime x strategy x direction cells n>=12, 14d, top10 by net]");
group(rows.filter((r) => r.createdAt >= W.d14), (r) => `${regime(r)}|${r.strategy}|${r.direction}`, "cells-14d", 12);
console.log("  [feature-tag lift, 7d: with vs without]");
for (const t of ["EVENT-TRIGGER", "MTF-CONSENSUS", "high-conviction", "confluence", "SESSION-CAP", "SURR-CAP", "RISK-CAP", "RISK-DD", "LIQ-HEAT-BELOW", "VOL-REGIME-ELEVATED", "STRAT-PROB-x0.50"]) {
  const withT = rows.filter((r) => r.createdAt >= W.d7 && hasTag(r, t));
  const without = rows.filter((r) => r.createdAt >= W.d7 && !hasTag(r, t));
  const a = stat(withT), b = stat(without);
  console.log(`     ${t}: WITH n=${a.n} WR=${a.wrPct ?? "-"}% net=$${a.netUsd ?? "-"} | WITHOUT n=${b.n} WR=${b.wrPct ?? "-"}% net=$${b.netUsd ?? "-"}`);
}

console.log("\n### 5) SignalEvent last 26h");
console.log("by type:", JSON.stringify(q("SELECT type, COUNT(*) n FROM SignalEvent WHERE createdAt >= ? GROUP BY type", [iso(now - 26 * 3600e3)])));
const nocand = q("SELECT COUNT(*) n, MIN(createdAt) mn, MAX(createdAt) mx FROM SignalEvent WHERE message LIKE '%scan found no live candidate%' AND createdAt >= ?", [iso(now - 26 * 3600e3)])[0];
console.log("scan-no-candidate:", JSON.stringify(nocand));
const issue24 = q("SELECT COUNT(*) n FROM SignalEvent WHERE message LIKE 'RAW-CAL ISSUE%' AND createdAt >= ?", [iso(now - 26 * 3600e3)])[0];
console.log("RAW-CAL ISSUE events 26h:", issue24.n);
const banEv = q("SELECT COUNT(*) n, MAX(createdAt) mx FROM SignalEvent WHERE (message LIKE '%ban%' OR message LIKE '%stand-down%') AND createdAt >= ?", [iso(now - 26 * 3600e3)])[0];
console.log("ban/stand-down events 26h:", JSON.stringify(banEv));
console.log("last 12 events:");
for (const e of q("SELECT createdAt, type, level, substr(message,1,120) m FROM SignalEvent ORDER BY createdAt DESC LIMIT 12")) console.log(`  ${iso(e.createdAt)} [${e.type}/${e.level}] ${e.m}`);

console.log("\n### 6) Gate journal (last 3MB) — 24h veto families");
try {
  const jp = "/home/z/my-project/.data/gate-journal.jsonl";
  const size = statSync(jp).size;
  const txt = await Bun.file(jp).slice(Math.max(0, size - 3_000_000)).text();
  const lines = txt.split("\n").filter(Boolean);
  const entries = [];
  for (let i = 1; i < lines.length; i++) { try { entries.push(JSON.parse(lines[i])); } catch { /* partial first line */ } }
  console.log("entries parsed (tail):", entries.length);
  if (entries.length) {
    console.log("sample keys:", Object.keys(entries[0]).join(","));
    console.log("sample:", JSON.stringify(entries[entries.length - 1]).slice(0, 260));
  }
  const fam = (e) => {
    const raw = e.gate ?? e.veto ?? e.kind ?? e.type ?? e.family ?? e.reason ?? "?";
    return String(raw).split(/[\s:]/)[0].slice(0, 28);
  };
  const m24 = new Map(), m3 = new Map();
  let total24 = 0;
  for (const e of entries) {
    const at = Number(e.at ?? e.ts ?? e.t ?? 0);
    if (!at || at < now - DAY) continue;
    total24++;
    const f = fam(e);
    m24.set(f, (m24.get(f) ?? 0) + 1);
    if (at >= now - 3 * 3600e3) m3.set(f, (m3.get(f) ?? 0) + 1);
  }
  console.log(`total journal rows 24h: ${total24}`);
  console.log("24h:", [...m24.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}=${v}`).join(" · "));
  console.log("3h:", [...m3.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}=${v}`).join(" · "));
} catch (e) {
  console.log("journal error:", String(e).slice(0, 140));
}
db.close();
