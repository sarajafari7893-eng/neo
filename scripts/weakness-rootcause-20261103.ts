// ── WEAKNESS ROOT-CAUSE 2026-11-03 (operator mandate trace 1a19e8f351a779ad item ②) ──
// READ-ONLY forensics of WHY BREAKOUT/MEAN-REVERT underperform and WHERE the
// catastrophic tail comes from. bun:sqlite readonly, never writes.
// R_row (levered %) = |entry−SL|/entry × lev × 100 · MFE in levered % (maxPnlPercent)
//   · BE-trail arms at 0.5R  → if MFE < 0.5R the brake NEVER armed
//   · 0.25R floor candidate  → saved iff MFE ≥ 0.25R
// Run: bun scripts/weakness-rootcause-20261103.ts
import { Database } from "bun:sqlite";

interface Row {
  strategy: string; status: string; direction: string; pnlPercent: number;
  maxPnlPercent: number; leverage: number; entryPrice: number;
  initialStopLoss: number | null; stopLoss: number; tags: string | null;
  createdAt: number;
}

const db = new Database("db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout = 8000;");
const now = Date.now();
const rows = db.query(`
  SELECT strategy,status,direction,pnlPercent,maxPnlPercent,leverage,entryPrice,
         initialStopLoss,stopLoss,tags,CAST(createdAt AS REAL) AS createdAt
  FROM Signal
  WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','CLOSED') AND qualityFlag IS NULL
    AND CAST(createdAt AS REAL) >= ${now - 30 * 86400e3}
`).all() as unknown as Row[];

const Rof = (r: Row) => {
  const sl = r.initialStopLoss ?? r.stopLoss;
  return sl && r.entryPrice ? (Math.abs(r.entryPrice - sl) / r.entryPrice) * r.leverage * 100 : NaN;
};
const tagOf = (t: string | null, p: string) => {
  if (!t) return "?";
  const x = t.split(",").map((s) => s.trim()).find((s) => s.startsWith(p));
  return x ? x.slice(p.length) : "?";
};
const tehH = (ms: number) => Math.floor((ms + 12600000) / 3600000) % 24;

function report(title: string, rs: Row[]): void {
  const n = rs.length;
  if (!n) { console.log(`${title}: n=0`); return; }
  const withR = rs.filter((r) => Number.isFinite(Rof(r)) && Rof(r) > 0.1 && Rof(r) <= 200);
  const noArm = withR.filter((r) => r.maxPnlPercent < 0.5 * Rof(r)).length;   // BE-trail never armed
  const sav25 = withR.filter((r) => r.maxPnlPercent >= 0.25 * Rof(r)).length; // 0.25R floor would catch
  const sav50 = withR.filter((r) => r.maxPnlPercent >= 0.5 * Rof(r)).length;  // BE armed but still bled
  const avgLev = rs.reduce((s, r) => s + r.leverage, 0) / n;
  const lev12 = rs.filter((r) => r.leverage >= 12).length;
  const night = rs.filter((r) => tehH(r.createdAt) >= 23 || tehH(r.createdAt) <= 4).length;
  const avgMfeR = withR.length ? withR.reduce((s, r) => s + r.maxPnlPercent / Rof(r), 0) / withR.length : NaN;
  const sum = rs.reduce((s, r) => s + r.pnlPercent, 0);
  console.log(`${title}`);
  console.log(`  n=${n} · Σpnl=${sum.toFixed(1)}% · avgLev=${avgLev.toFixed(1)} (lev≥12: ${lev12} = ${((lev12 / n) * 100).toFixed(0)}%) · Tehran 23-04h: ${night} = ${((night / n) * 100).toFixed(0)}%`);
  console.log(`  MFE/R: avg=${avgMfeR.toFixed(2)}R · BE-trail هرگز مسلح نشد (MFE<0.5R): ${noArm}/${withR.length} = ${((noArm / withR.length) * 100).toFixed(0)}% · نجات‌پذیر با کف 0.25R: ${sav25} · مسلح‌شده ولی خونریزی ادامه: ${sav50}`);
  const byStrat = new Map<string, number>();
  const byRegime = new Map<string, number>();
  for (const r of rs) {
    byStrat.set(r.strategy, (byStrat.get(r.strategy) ?? 0) + 1);
    const k = `${tagOf(r.tags, "REGIME-")}|${r.direction}`;
    byRegime.set(k, (byRegime.get(k) ?? 0) + 1);
  }
  console.log(`  byStrat: ${[...byStrat.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  console.log(`  topRegime: ${[...byRegime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
}

console.log("═".repeat(110));
console.log("ROOT-CAUSE 30d — catastrophic tail & weak-cohort anatomy (clean ledger)");
console.log("═".repeat(110));
report("A) کلاس فاجعه (pnl ≤ −50%) — همهٔ کتاب", rows.filter((r) => r.pnlPercent <= -50));
report("B) کلاس ضعیف (−50% < pnl ≤ −15%) — همهٔ کتاب", rows.filter((r) => r.pnlPercent <= -15 && r.pnlPercent > -50));
report("C) BREAKOUT تمام 30d", rows.filter((r) => r.strategy === "BREAKOUT"));
report("D) MEAN-REVERT تمام 30d", rows.filter((r) => r.strategy === "MEAN-REVERT"));
report("E) AI-SWING CHOP|LONG (ضعیف‌ترین خانهٔ کارhorse)", rows.filter((r) => r.strategy === "AI-SWING" && tagOf(r.tags, "REGIME-") === "CHOP" && r.direction === "LONG"));
report("F) BREAKOUT تایم‌فریم 1h (leg پوسیده)", rows.filter((r) => r.strategy === "BREAKOUT" && r.status && r.tags !== null && (r as Row & { timeframe?: string }).timeframe === "1h"));

// F needs timeframe — re-query with the column
const rowsTf = db.query(`
  SELECT strategy,status,direction,pnlPercent,maxPnlPercent,leverage,entryPrice,
         initialStopLoss,stopLoss,tags,timeframe,CAST(createdAt AS REAL) AS createdAt
  FROM Signal
  WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','CLOSED') AND qualityFlag IS NULL
    AND CAST(createdAt AS REAL) >= ${now - 30 * 86400e3}
`).all() as unknown as Array<Row & { timeframe: string }>;
report("F) BREAKOUT تایم‌فریم 1h (leg پوسیده)", rowsTf.filter((r) => r.strategy === "BREAKOUT" && r.timeframe === "1h"));
report("G) BREAKOUT تایم‌فریم 5m (لبهٔ زنده)", rowsTf.filter((r) => r.strategy === "BREAKOUT" && r.timeframe === "5m"));

// probation entry date
const ts = 1791204071263;
console.log(`\nPROBATION MEAN-REVERT since: ${new Date(ts).toISOString()} (re-eval live, 30min TTL)`);
db.close();
console.log("(read-only complete — no writes)");
