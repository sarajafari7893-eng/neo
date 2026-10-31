// CHOP-TP FEATURE AUDIT (read-only) — operator order 2026-10-31 trace 1a1937b74e767b61:
// «بررسی کن چه ویژگی‌هایی در رژیم CHOP منجر به تی‌پی شدن ولی الان استفاده نمیشه؟»
// Ledger truth: every Signal row carries its deploy-time REGIME-* tag (regimeTagOf).
// No engine edit — FLAT-10 untouched. Output = evidence for the operator decision.
import { db } from "../src/lib/db";

interface Row { strategy: string; direction: string; status: string; reachedTp: number; pnlPercent: number; confidence: number; riskReward: number; timeframe: string; marginUsd: number; afterlife: string | null; tags: string; factorsJson: string | null; createdAt: Date; }

const rows: Row[] = await db.$queryRawUnsafe(`
  SELECT strategy, direction, status, reachedTp, pnlPercent, confidence, riskReward,
         timeframe, marginUsd, afterlife, tags, factorsJson, createdAt
  FROM Signal WHERE tags LIKE '%REGIME-CHOP%'`);

const settled = rows.filter(r => ["TP1","TP2","TP3","SL","EXPIRED","CLOSED"].includes(r.status));
const win = (r: Row) => (r.reachedTp ?? 0) >= 1;
const net = (rs: Row[]) => rs.reduce((a, r) => a + (r.pnlPercent / 100) * r.marginUsd, 0);

function cell(rs: Row[]) {
  const s = rs.filter(r => ["TP1","TP2","TP3","SL","EXPIRED","CLOSED"].includes(r.status));
  const w = s.filter(win);
  const tp1 = s.filter(r => (r.reachedTp ?? 0) >= 1).length;
  const tp2 = s.filter(r => (r.reachedTp ?? 0) >= 2).length;
  const tp3 = s.filter(r => (r.reachedTp ?? 0) >= 3).length;
  const pnl = net(s);
  return { n: rs.length, settled: s.length, tp1, tp2, tp3, wr: s.length ? +(100 * w.length / s.length).toFixed(1) : 0, pnlUsd: +pnl.toFixed(2) };
}

console.log(`== CHOP ledger (all rows tagged REGIME-CHOP): ${rows.length} rows, ${settled.length} settled ==\n`);

// 1) strategy × direction matrix — mapped against CURRENT rules
const stratDir = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.strategy}|${r.direction}`;
  if (!stratDir.has(k)) stratDir.set(k, []);
  stratDir.get(k)!.push(r);
}
const CUR: Record<string, string> = {
  "AI-SWING|SHORT": "LIVE (tax ladder ×0.7/×0.85)",
  "MEAN-REVERT|SHORT": "LIVE (tax ladder ×0.7/×0.85)",
  "AI-SWING|LONG": "VETOED (CHOP-LONG guard>=1)",
  "MEAN-REVERT|LONG": "VETOED (CHOP-LONG guard>=1)",
  "BREAKOUT|LONG": "VETOED (hard, both dir)",
  "BREAKOUT|SHORT": "VETOED (hard, both dir)",
  "MOMENTUM|LONG": "VETOED (hard, both dir)",
  "MOMENTUM|SHORT": "VETOED (hard, both dir)",
  "AI-SCALP|LONG": "VETOED + STRAT-PAUSE (book-wide)",
  "AI-SCALP|SHORT": "VETOED + STRAT-PAUSE (book-wide)",
};
console.log("== strategy × direction (current rule in parens) ==");
for (const [k, rs] of [...stratDir.entries()].sort((a, b) => net(b[1]) - net(a[1]))) {
  const c = cell(rs);
  console.log(`${k.padEnd(22)} [${(CUR[k] ?? "?").padEnd(36)}] n=${String(c.n).padStart(4)} tp1=${String(c.tp1).padStart(3)} tp2=${String(c.tp2).padStart(3)} tp3=${String(c.tp3).padStart(3)} WR=${String(c.wr).padStart(5)}% net=$${c.pnlUsd}`);
}

// 2) TP-hit features on the LIVE path (CHOP SHORT, admitted strategies): confidence bands
console.log("\n== CHOP SHORT (AI-SWING+MEAN-REVERT) TP hits by confidence band ==");
const live = rows.filter(r => r.direction === "SHORT" && (r.strategy === "AI-SWING" || r.strategy === "MEAN-REVERT"));
for (const [lo, hi] of [[0, 59], [60, 69], [70, 79], [80, 100]]) {
  const band = live.filter(r => r.confidence >= lo && r.confidence <= hi);
  const c = cell(band);
  console.log(`conf ${lo}-${hi}: n=${String(c.n).padStart(4)} settled=${String(c.settled).padStart(4)} tp1=${String(c.tp1).padStart(3)} tp2=${String(c.tp2).padStart(3)} WR=${String(c.wr).padStart(5)}% net=$${c.pnlUsd}`);
}

// 3) confidence × tax ladder: winners whose confidence sat BELOW current tax thresholds
//    (strong chop: +10 on pinned 17 → needs raw score >= 27; moderate: +6 → >= 23)
console.log("\n== CHOP SHORT winners by confidence < tax-floor simulation ==");
const lw = live.filter(win);
const below23 = lw.filter(r => r.confidence < 23).length;
const below27 = lw.filter(r => r.confidence < 27).length;
console.log(`winners total=${lw.length} · winners with conf<23 (would fail moderate tax floor 17+6)=${below23} · conf<27 (strong tax floor 17+10)=${below27}`);

// 4) timeframe features
console.log("\n== CHOP SHORT TP hits by timeframe ==");
for (const tf of ["5m", "15m", "1h", "4h"]) {
  const c = cell(live.filter(r => r.timeframe === tf));
  console.log(`tf=${tf}: n=${String(c.n).padStart(4)} tp1=${String(c.tp1).padStart(3)} tp2=${String(c.tp2).padStart(3)} WR=${String(c.wr).padStart(5)}% net=$${c.pnlUsd}`);
}

// 5) factor-vote features of TP winners (confluence votes at deploy)
const voteAgg = new Map<string, { n: number; tp: number }>();
for (const r of lw) {
  try {
    const f = r.factorsJson ? JSON.parse(r.factorsJson) : [];
    for (const v of (Array.isArray(f) ? f : [])) {
      if (v?.vote === "YES" || v?.vote === 1 || v?.vote === true) {
        const k = String(v.name ?? v.factor ?? "?");
        const e = voteAgg.get(k) ?? { n: 0, tp: 0 };
        e.n++; e.tp++;
        voteAgg.set(k, e);
      }
    }
  } catch {}
}
// baseline: same factor across ALL settled CHOP SHORT rows
const baseAgg = new Map<string, { n: number; tp: number }>();
for (const r of live.filter(x => ["TP1","TP2","TP3","SL","EXPIRED","CLOSED"].includes(x.status))) {
  try {
    const f = r.factorsJson ? JSON.parse(r.factorsJson) : [];
    for (const v of (Array.isArray(f) ? f : [])) {
      if (v?.vote === "YES" || v?.vote === 1 || v?.vote === true) {
        const k = String(v.name ?? v.factor ?? "?");
        const e = baseAgg.get(k) ?? { n: 0, tp: 0 };
        e.n++;
        if (win(r)) e.tp++;
        baseAgg.set(k, e);
      }
    }
  } catch {}
}
console.log("\n== factor YES-vote → TP1-hit lift (CHOP SHORT, winners vs all settled) ==");
for (const [k, e] of [...voteAgg.entries()].sort((a, b) => b[1].tp - a[1].tp).slice(0, 12)) {
  const base = baseAgg.get(k);
  const wr = e.n ? +(100 * e.tp / e.n).toFixed(0) : 0;
  const bwr = base && base.n ? +(100 * base.tp / base.n).toFixed(0) : 0;
  console.log(`${k.padEnd(28)} winners-YES=${String(e.n).padStart(3)} (WR-on-YES ${wr}%) · all-YES n=${base?.n ?? 0} (WR-on-YES ${bwr}%)`);
}

// 6) afterlife: expired CHOP SHORTs that still reached TP afterwards (re-arm evidence)
const al = settled.filter(r => r.status === "EXPIRED" && (r.reachedTp ?? 0) >= 1);
console.log(`\n== afterlife: EXPIRED-yet-TP1 CHOP SHORT = ${al.filter(r=>r.direction==="SHORT").length} (LONG: ${al.filter(r=>r.direction==="LONG").length}) ==`);

// 7) total unused TP mass: TP hits inside currently-vetoed cells
const vetoedCells = rows.filter(r => {
  const k = `${r.strategy}|${r.direction}`;
  return CUR[k]?.startsWith("VETOED");
});
const vc = cell(vetoedCells);
console.log(`\n== currently-VETOED CHOP cells (unused capacity): n=${vc.n} settled=${vc.settled} tp1=${vc.tp1} tp2=${vc.tp2} tp3=${vc.tp3} net=$${vc.pnlUsd} ==`);
await db.$disconnect();
