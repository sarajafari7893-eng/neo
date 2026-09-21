// OP-ENGINE-QA-0907 — read-only evidence pack for the operator's 6 questions.
// NO writes. NO engine changes. Prisma client over db/custom.db.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const r2 = (x) => Number(x.toFixed(2));
const usd = (s) => (s.marginUsd * s.pnlPercent) / 100;
const isWin = (s) => usd(s) > 0;
const regimeOf = (tags) => { const t = (tags || "").split(",").find((x) => x.startsWith("REGIME-")); return t ? t.replace("REGIME-", "") : "UNKNOWN"; };

const settled = await db.signal.findMany({
  where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
});
const SETTLED_STATUS = new Set(["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"]);
const closed = settled; // alias
console.log(`== COHORT == settled=${settled.length} net=$${r2(settled.reduce((a, s) => a + usd(s), 0))} WR=${r2(100 * settled.filter(isWin).length / settled.length)}%`);

// ─────────────────────────── Q5: REGIME LEDGER ───────────────────────────
console.log(`\n== Q5 REGIME (settled, all time) ==`);
const byReg = new Map();
for (const s of settled) {
  const k = regimeOf(s.tags);
  const c = byReg.get(k) ?? { n: 0, w: 0, pnl: 0 };
  c.n++; if (isWin(s)) c.w++; c.pnl += usd(s);
  byReg.set(k, c);
}
for (const [k, c] of [...byReg.entries()].sort((a, b) => b.n - a.n))
  console.log(`  ${k.padEnd(10)} n=${String(c.n).padStart(3)} WR=${r2(100 * c.w / c.n)}% net=$${r2(c.pnl)}`);

console.log(`\n== Q5b REGIME × STRATEGY (net $) ==`);
const byRS = new Map();
for (const s of settled) {
  const k = `${regimeOf(s.tags)} × ${s.strategy}`;
  const c = byRS.get(k) ?? { n: 0, w: 0, pnl: 0 };
  c.n++; if (isWin(s)) c.w++; c.pnl += usd(s);
  byRS.set(k, c);
}
for (const [k, c] of [...byRS.entries()].sort((a, b) => a.pnl - b.pnl))
  console.log(`  ${k.padEnd(28)} n=${String(c.n).padStart(3)} WR=${r2(100 * c.w / c.n)}% net=$${r2(c.pnl)}`);

console.log(`\n== Q5c DEPLOY MIX by regime (all signals incl ACTIVE — why chop dominates) ==`);
const all = await db.signal.findMany({ select: { tags: true, status: true, createdAt: true, engine: true } });
const mixAll = new Map(); const mix24 = new Map();
const dayAgo = Date.now() - 86_400_000;
for (const s of all) {
  const k = regimeOf(s.tags);
  mixAll.set(k, (mixAll.get(k) ?? 0) + 1);
  if (new Date(s.createdAt).getTime() >= dayAgo) mix24.set(k, (mix24.get(k) ?? 0) + 1);
}
console.log(`  ALL-TIME:`, [...mixAll.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
console.log(`  LAST 24H:`, [...mix24.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));

// ─────────────────────────── Q1: BREAKOUT ───────────────────────────
console.log(`\n== Q1 BREAKOUT deep-dive (settled) ==`);
const bo = settled.filter((s) => s.strategy === "BREAKOUT");
const boBy = (label, fn) => {
  const m = new Map();
  for (const s of bo) { const k = fn(s); const c = m.get(k) ?? { n: 0, w: 0, pnl: 0 }; c.n++; if (isWin(s)) c.w++; c.pnl += usd(s); m.set(k, c); }
  for (const [k, c] of [...m.entries()].sort((a, b) => a.pnl - b.pnl)) console.log(`  ${label.padEnd(14)} ${String(k).padEnd(12)} n=${String(c.n).padStart(3)} WR=${r2(100 * c.w / c.n)}% net=$${r2(c.pnl)}`);
};
console.log(`  TOTAL: n=${bo.length} WR=${r2(100 * bo.filter(isWin).length / (bo.length || 1))}% net=$${r2(bo.reduce((a, s) => a + usd(s), 0))}`);
boBy("regime", (s) => regimeOf(s.tags));
boBy("conf", (s) => s.confidence >= 90 ? "90-99" : s.confidence >= 80 ? "80-89" : "70-79");
boBy("dir", (s) => s.direction);
const boMfeFails = bo.filter((s) => s.maxPnlPercent < 5 && s.pnlPercent <= 0).length;
console.log(`  instant-fail (MFE<5% lev AND net<=0): ${boMfeFails}/${bo.length}`);
const boByVer = new Map();
for (const s of bo) { const v = (s.engine || "").includes("v6.3") ? "v6.3+" : (s.engine || "?"); const c = boByVer.get(v) ?? { n: 0, w: 0, pnl: 0 }; c.n++; if (isWin(s)) c.w++; c.pnl += usd(s); boByVer.set(v, c); }
for (const [k, c] of boByVer) console.log(`  engine=${k.padEnd(16)} n=${c.n} WR=${r2(100 * c.w / c.n)}% net=$${r2(c.pnl)}`);
console.log(`  winners profile: ${bo.filter(isWin).map((s) => `${s.symbol}:${s.direction.slice(0,1)}/${regimeOf(s.tags).replace("REGIME-","")}/c${s.confidence}/+$${r2(usd(s))}`).join(", ") || "none"}`);

// ─────────────── Q2: EXIT POLICY SIM (ACTUAL vs FULL@TP1 vs POLICY-B) ───────────────
// Cohort: settled trades that PROVED TP1 (reachedTp>=1). reachedTp=0 trades are
// identical under all three policies (no TP1 → no partial/exit change).
console.log(`\n== Q2 EXIT-POLICY SIM on TP1-proven settled trades ==`);
const tp1Proven = settled.filter((s) => s.reachedTp >= 1);
const neverTp1 = settled.filter((s) => s.reachedTp === 0);
const dirSign = (s) => (s.direction === "LONG" ? 1 : -1);
const pnlTp1Lev = (s) => dirSign(s) * ((s.tp1 - s.entryPrice) / s.entryPrice) * 100 * s.leverage;
let act = 0, full = 0, polB = 0;
const rows = [];
for (const s of tp1Proven) {
  const a = usd(s);
  const cost = s.feeUsd + s.swapUsd; // same cost basis for all policies (documented approx)
  const f = (s.marginUsd * pnlTp1Lev(s)) / 100 - cost;
  // Policy B: 50% out at TP1; remainder: stop@entry → 0 if price ever returned (SL status or final<=0), else runs to actual final
  const leg1 = (s.marginUsd * pnlTp1Lev(s)) / 200 - cost / 2;
  const returned = s.status === "SL" || s.pnlPercent <= 0;
  const leg2Pct = returned ? 0 : s.pnlPercent;
  const b = leg1 + (s.marginUsd * leg2Pct) / 200 - cost / 2;
  act += a; full += f; polB += b;
  rows.push({ sym: s.symbol, st: s.status, a, f, b, tp1Lev: pnlTp1Lev(s) });
}
console.log(`  cohort n=${tp1Proven.length} (never-TP1 settled n=${neverTp1.length}, identical under all policies: actual=$${r2(neverTp1.reduce((x, s) => x + usd(s), 0))})`);
console.log(`  ACTUAL (current engine):        $${r2(act)}`);
console.log(`  POLICY FULL-EXIT@TP1:           $${r2(full)}`);
console.log(`  POLICY B (50%@TP1+stop→entry):  $${r2(polB)}`);
const afterTp1 = new Map();
for (const s of tp1Proven) afterTp1.set(s.status, (afterTp1.get(s.status) ?? 0) + 1);
console.log(`  post-TP1 final status mix:`, [...afterTp1.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
const runners = tp1Proven.filter((s) => s.status === "TP2" || s.status === "TP3");
const givers = tp1Proven.filter((s) => s.status === "SL" || (s.status === "EXPIRED" && s.pnlPercent <= 0));
console.log(`  RUNNERS (→TP2/TP3): n=${runners.length} avg final lev%=${r2(runners.reduce((x, s) => x + s.pnlPercent, 0) / (runners.length || 1))}`);
console.log(`  GIVE-BACKS (TP1 then ≤0): n=${givers.length} avg TP1-lev%=${r2(givers.reduce((x, s) => x + pnlTp1Lev(s), 0) / (givers.length || 1))} avg final=$${r2(givers.reduce((x, s) => x + usd(s), 0) / (givers.length || 1))}`);
rows.sort((x, y) => (y.f - y.a) - (x.f - x.a));
console.log(`  biggest FULL@TP1 gains vs actual: ${rows.slice(0, 5).map((r) => `${r.sym}/${r.st} act$${r2(r.a)}→full$${r2(r.f)}`).join(", ")}`);
console.log(`  biggest FULL@TP1 sacrifices:     ${rows.slice(-5).reverse().map((r) => `${r.sym}/${r.st} act$${r2(r.a)}→full$${r2(r.f)}`).join(", ")}`);

// ─────────────────────────── Q4: TTL ───────────────────────────
console.log(`\n== Q4 TTL forensics ==`);
const byStrat = new Map();
for (const s of settled) {
  const c = byStrat.get(s.strategy) ?? { n: 0, ttl: 0, extN: 0, expN: 0, expPostTp: 0, postMfe: 0, win: 0, pnl: 0 };
  c.n++; c.ttl += s.ttlMinutes; if (s.ttlExtensions > 0) c.extN++;
  if (s.status === "EXPIRED") { c.expN++; if (["TP1_HIT", "TP2_HIT", "TP3_HIT"].includes(s.afterlife ?? "")) { c.expPostTp++; c.postMfe += s.maxPostPnlPercent; } }
  if (isWin(s)) c.win++; c.pnl += usd(s);
  byStrat.set(s.strategy, c);
}
for (const [k, c] of [...byStrat.entries()].sort((a, b) => b.n - a.n))
  console.log(`  ${k.padEnd(12)} n=${String(c.n).padStart(3)} avgTTL=${Math.round(c.ttl / c.n)}m ext>0=${c.extN} WR=${r2(100 * c.win / c.n)}% net=$${r2(c.pnl)} | EXPIRED ${c.expPostTp}/${c.expN} hit-TP-after-expiry (avg post-MFE ${r2(c.postMfe / (c.expPostTp || 1))}% lev)`);

// time-to-first-TP for TP winners vs their TTL
const events = await db.signalEvent.findMany({ where: { type: { in: ["TP1", "TP2", "TP3"] } }, select: { signalId: true, type: true, createdAt: true } });
const firstTp = new Map();
for (const e of events) {
  if (!e.signalId) continue;
  const t = new Date(e.createdAt).getTime();
  if (!firstTp.has(e.signalId) || t < firstTp.get(e.signalId)) firstTp.set(e.signalId, t);
}
const lateness = [];
for (const s of settled) {
  const t = firstTp.get(s.id);
  if (!t) continue;
  const mins = (t - new Date(s.createdAt).getTime()) / 60000;
  lateness.push({ strat: s.strategy, mins, ttl: s.ttlMinutes, late: mins > s.ttlMinutes });
}
const late = lateness.filter((x) => x.late);
console.log(`  TP-proven trades with a TP event timestamp: n=${lateness.length}; hit TP AFTER their TTL would have expired: ${late.length} (${r2(100 * late.length / lateness.length)}%) — median time-to-TP ${lateness.sort((a, b) => a.mins - b.mins)[Math.floor(lateness.length / 2)]?.mins.toFixed(0)}m`);
const lateByStrat = new Map();
for (const x of late) { const c = lateByStrat.get(x.strat) ?? { n: 0 }; c.n++; lateByStrat.set(x.strat, c); }
console.log(`  post-TTL TP hits by strategy:`, [...lateByStrat.entries()].map(([k, v]) => `${k}=${v.n}`).join(", "));

// ext cohort
const ext = settled.filter((s) => s.ttlExtensions > 0);
console.log(`  TTL-extended cohort: n=${ext.length} WR=${r2(100 * ext.filter(isWin).length / (ext.length || 1))}% net=$${r2(ext.reduce((a, s) => a + usd(s), 0))}`);
const extDist = new Map();
for (const s of ext) extDist.set(s.ttlExtensions, (extDist.get(s.ttlExtensions) ?? 0) + 1);
console.log(`  extensions dist:`, [...extDist.entries()].map(([k, v]) => `ext=${k}:${v}`).join(" "));

// ─────────────────────────── state keys ───────────────────────────
console.log(`\n== GOVERNOR/GATE STATE ==`);
for (const key of ["gate", "regime.telemetry", "ttl.telemetry", "calibration", "backtest"]) {
  const row = await db.engineSetting.findUnique({ where: { key } });
  if (row) console.log(`  ${key} = ${(row.value || "").slice(0, 300)}`);
}
const postFix = settled.filter((s) => (s.engine || "").includes("v6.5"));
console.log(`  v6.5 post-fix settled: n=${postFix.length} net=$${r2(postFix.reduce((a, s) => a + usd(s), 0))}`);
await db.$disconnect();
