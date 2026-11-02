// ── STRATEGY-AUDIT 2026-11-03 (operator mandate, trace 1a19e8f351a779ad) ──
// READ-ONLY forensic audit of the settled ledger, bun:sqlite readonly — the
// same access pattern as scripts/audit-*.ts (the app process keeps sole
// Prisma ownership; this script never writes).
//
// Operator's 4-item mission:
//   ① Audit positive usable patterns OR disable BREAKOUT/MEAN-REVERT (weak)
//      + sharper focus on AI-SWING.
//   ② Deep root-cause of the disabled strategies' weakness.
//   ③ Continue OOS collection to ≥300 settled per strategy (promotion bar).
//   ④ Shadow-sim of the no-touch floor candidate (separate script).
//
// Accounting conventions (mirrors the 2026-10-25 DOCTRINE-PEAK-QA audit):
//   · CLEAN rows only: qualityFlag IS NULL (clean-ledger doctrine v10.18).
//   · SETTLED: TP1|TP2|TP3|SL|EXPIRED|CLOSED (ACTIVE excluded).
//   · TP-PROVEN win: reachedTp ≥ 1 (engine v6.5 accounting — BE-trail closes
//     at positive pnl still count reachedTp=0, that is exactly the winRate
//     26%-vs-65% dual-rate story of 2026-11-02).
//   · POSITIVE-PNL win: pnlPercent > 0 (the honest second rate).
//   · netUsd = Σ(pnlPercent/100 × marginUsd) − Σ feeUsd − Σ swapUsd
//     (pnlPercent is levered & fee-EXCLUSIVE per audit-agt-1017 convention).
//   · createdAt is mixed-type in SQLite (80k epoch-numeric + 1 legacy ISO
//     text row, lesson of the 2026-11-02 type-confusion fake-alarm) → every
//     time math goes through CAST(createdAt AS REAL); the ISO row casts to
//     ~2026.0 and is naturally excluded by epoch-ms predicates.
//   · Regime/flow/lever read from the tags column (REGIME-*, FLOW-*,
//     STRATW-*, GS-*), Tehran session from CAST(createdAt AS REAL)+3.5h.
// Run: bun scripts/strategy-audit-20261103.ts
import { Database } from "bun:sqlite";

const DB = "db/custom.db";
const db = new Database(DB, { readonly: true });
db.exec("PRAGMA busy_timeout = 8000;");

interface Row {
  strategy: string; status: string; direction: string; reachedTp: number;
  pnlPercent: number; maxPnlPercent: number; marginUsd: number;
  feeUsd: number; swapUsd: number; leverage: number; confidence: number;
  timeframe: string; symbol: string; tags: string | null;
  beBankedFrac: number | null; createdAt: number;
}

const SETTLED = "('TP1','TP2','TP3','SL','EXPIRED','CLOSED')";
const now = Date.now();
const WINDOWS: Array<[string, number]> = [
  ["7d", now - 7 * 86400e3],
  ["14d", now - 14 * 86400e3],
  ["30d", now - 30 * 86400e3],
  ["PT(26Oct)", 1792000000 * 1000], // 2026-10-26 ~00:00Z — peak-tune era (tp1RMult back to 1.0)
  ["FULL", 0],
];
const STRATS = ["AI-SWING", "BREAKOUT", "MEAN-REVERT", "AI-SCALP", "MOMENTUM"];

function rows(sinceMs: number, strat?: string): Row[] {
  const where = strat
    ? `strategy='${strat}' AND status IN ${SETTLED} AND qualityFlag IS NULL AND CAST(createdAt AS REAL) >= ${sinceMs}`
    : `status IN ${SETTLED} AND qualityFlag IS NULL AND CAST(createdAt AS REAL) >= ${sinceMs}`;
  return db.query(`SELECT strategy,status,direction,reachedTp,pnlPercent,maxPnlPercent,marginUsd,feeUsd,swapUsd,leverage,confidence,timeframe,symbol,tags,beBankedFrac,CAST(createdAt AS REAL) AS createdAt FROM Signal WHERE ${where}`).all() as unknown as Row[];
}

function tagOf(tags: string | null, prefix: string): string {
  if (!tags) return "?";
  const t = tags.split(",").map((x) => x.trim()).find((x) => x.startsWith(prefix));
  return t ? t.slice(prefix.length) : "?";
}

interface Agg {
  n: number; tpProv: number; posPnl: number; sumPct: number; sumUsd: number;
  fee: number; swap: number; beBanked: number; slPos: number;
  mfe1: number; mfe2: number; mfe3: number; avgMax: number;
}
function agg(rs: Row[]): Agg {
  const a: Agg = { n: rs.length, tpProv: 0, posPnl: 0, sumPct: 0, sumUsd: 0, fee: 0, swap: 0, beBanked: 0, slPos: 0, mfe1: 0, mfe2: 0, mfe3: 0, avgMax: 0 };
  for (const r of rs) {
    if (r.reachedTp >= 1) a.tpProv++;
    if (r.pnlPercent > 0) a.posPnl++;
    a.sumPct += r.pnlPercent;
    a.sumUsd += (r.pnlPercent / 100) * (r.marginUsd || 10);
    a.fee += r.feeUsd || 0;
    a.swap += r.swapUsd || 0;
    if (r.beBankedFrac != null) a.beBanked++;
    if (r.status === "SL" && r.pnlPercent > 0) a.slPos++;
    if (r.maxPnlPercent >= 1) a.mfe1++;
    if (r.maxPnlPercent >= 2) a.mfe2++;
    if (r.maxPnlPercent >= 3) a.mfe3++;
    a.avgMax += r.maxPnlPercent;
  }
  if (a.n) a.avgMax /= a.n;
  return a;
}
function line(label: string, a: Agg): string {
  const net = a.sumUsd - a.fee - a.swap;
  const wr = a.n ? ((a.tpProv / a.n) * 100).toFixed(1) : "-";
  const pr = a.n ? ((a.posPnl / a.n) * 100).toFixed(1) : "-";
  return `${label.padEnd(22)} n=${String(a.n).padStart(4)} · TPwr=${String(wr).padStart(5)}% · pos=${String(pr).padStart(5)}% · avg=${(a.n ? a.sumPct / a.n : 0).toFixed(2)}% · net=$${net.toFixed(2)} (fee $${a.fee.toFixed(2)}) · BEbank=${a.beBanked} · SL+=$${a.slPos} · MFE≥1%=${a.mfe1} ≥2%=${a.mfe2} ≥3%=${a.mfe3} · avgMax=${a.avgMax.toFixed(2)}%`;
}

console.log("═".repeat(120));
console.log("STRATEGY-AUDIT 2026-11-03 — settled CLEAN ledger (qualityFlag IS NULL), net = gross$(pnl%×margin) − fees − swaps");
console.log("═".repeat(120));
for (const s of STRATS) {
  console.log(`\n──── ${s} ────`);
  for (const [w, since] of WINDOWS) {
    const rs = rows(since, s);
    if (rs.length) console.log(line(w, agg(rs)));
  }
}

console.log("\n" + "═".repeat(120));
console.log("BOOK TOTAL per window");
console.log("═".repeat(120));
for (const [w, since] of WINDOWS) console.log(line(w, agg(rows(since))));

// ── regime / direction / session / confidence / timeframe cells (30d) ──
console.log("\n" + "═".repeat(120));
console.log("CELLS — 30d window (regime × direction, Tehran session, confidence, timeframe, flow)");
console.log("═".repeat(120));
const R30 = rows(now - 30 * 86400e3);
function cells(rs: Row[], keyFn: (r: Row) => string, title: string): void {
  const map = new Map<string, Row[]>();
  for (const r of rs) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  console.log(`\n· ${title}`);
  const entries = [...map.entries()].sort((a, b) => agg(b[1]).sumUsd - agg(a[1]).sumUsd);
  for (const [k, v] of entries) {
    if (v.length < 4) continue;
    console.log(line(`  ${k}`, agg(v)));
  }
}
for (const s of ["AI-SWING", "BREAKOUT", "MEAN-REVERT"]) {
  const rs = R30.filter((r) => r.strategy === s);
  if (!rs.length) continue;
  console.log(`\n──── ${s} (30d n=${rs.length}) ────`);
  cells(rs, (r) => `${tagOf(r.tags, "REGIME-")}|${r.direction}`, "REGIME × DIRECTION");
  cells(rs, (r) => tagOf(r.tags, "FLOW-"), "FLOW");
  cells(rs, (r) => { const h = Math.floor((r.createdAt + 12600000) / 3600000) % 24; return `Tehran ${String(h).padStart(2, "0")}h`; }, "TEHRAN HOUR (n≥4)");
  cells(rs, (r) => `conf ${r.confidence < 60 ? "<60" : r.confidence < 70 ? "60-69" : r.confidence < 80 ? "70-79" : "80+"}`, "CONFIDENCE BAND");
  cells(rs, (r) => r.timeframe, "TIMEFRAME");
}

// ── AI-SWING symbol table (30d, n≥5) — the operator's focus strategy ──
console.log("\n──── AI-SWING SYMBOLS 30d (n≥5, by net) ────");
cells(R30.filter((r) => r.strategy === "AI-SWING"), (r) => r.symbol, "SYMBOL");

// ── M-3: OOS promotion bar (≥300 per strategy) progress ──
console.log("\n" + "═".repeat(120));
console.log("OOS PROMOTION BAR — settled CLEAN since 2026-09-19 baseline freeze (protocol §2) · operator bar = ≥300 per strategy");
console.log("═".repeat(120));
const OOS_START = 1789027200000; // 2026-09-19T07:17Z approx (protocol anchor)
const pace14 = new Map<string, number>();
for (const s of STRATS) {
  const r14 = rows(now - 14 * 86400e3, s).length;
  pace14.set(s, r14 / 14);
}
for (const s of STRATS) {
  const oosN = rows(OOS_START, s).length;
  const p = pace14.get(s) ?? 0;
  const rem = Math.max(0, 300 - oosN);
  const eta = rem === 0 ? "DONE" : p > 0 ? `${(rem / p).toFixed(0)}d @ ${p.toFixed(1)}/day` : "STALLED (0/day)";
  console.log(`${s.padEnd(13)} OOS=${String(oosN).padStart(5)}/300 (${Math.min(100, (oosN / 300) * 100).toFixed(0)}%) · pace14d=${p.toFixed(1)}/day · ETA→300: ${eta}`);
}
const active = db.query(`SELECT strategy, COUNT(*) n FROM Signal WHERE status='ACTIVE' GROUP BY strategy`).all() as Array<{ strategy: string; n: number }>;
console.log("ACTIVE now:", JSON.stringify(active));

// ── M-2 inputs: worst cohort forensics — biggest single losses 14d ──
console.log("\n──── WORST 12 CLEAN TRADES 14d (root-cause probes) ────");
const worst = rows(now - 14 * 86400e3).sort((a, b) => (a.pnlPercent) - (b.pnlPercent)).slice(0, 12);
for (const r of worst) {
  const d = new Date(r.createdAt).toISOString().slice(5, 16).replace("T", " ");
  console.log(`${d}Z ${r.strategy.padEnd(12)} ${r.symbol.padEnd(12)} ${r.direction.padEnd(5)} lev${String(r.leverage).padStart(2)} pnl=${r.pnlPercent.toFixed(1)}% max=${r.maxPnlPercent.toFixed(1)}% ${r.status.padEnd(7)} ${tagOf(r.tags, "REGIME-")} ${tagOf(r.tags, "FLOW-")}`);
}
db.close();
console.log("\n(read-only audit complete — no writes performed)");
