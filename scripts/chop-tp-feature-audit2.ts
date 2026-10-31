// CHOP-TP FEATURE AUDIT v2 (read-only) — deep drill after v1 (trace 1a1937b74e767b61)
// ① factor-vote lift on the LIVE path (signed votes: negative=bearish=short-confirming)
// ② positive pockets INSIDE currently-vetoed cells (conf band × tf × flow verdict)
// ③ flow-verdict / MTF-bias features on CHOP SHORT winners
import { db } from "../src/lib/db";

interface Row { strategy: string; direction: string; status: string; reachedTp: number; pnlPercent: number; confidence: number; timeframe: string; marginUsd: number; factorsJson: string | null; flowJson: string | null; mtfJson: string | null; afterlife: string | null; tags: string }
const rows: Row[] = await db.$queryRawUnsafe(`SELECT strategy, direction, status, reachedTp, pnlPercent, confidence, timeframe, marginUsd, factorsJson, flowJson, mtfJson, afterlife, tags FROM Signal WHERE tags LIKE '%REGIME-CHOP%'`);
const SETTLED = ["TP1","TP2","TP3","SL","EXPIRED","CLOSED"];
const settled = rows.filter(r => SETTLED.includes(r.status));
const win = (r: Row) => (r.reachedTp ?? 0) >= 1;

// ① LIVE path factor lift — CHOP SHORT AI-SWING/MEAN-REVERT
const live = settled.filter(r => r.direction === "SHORT" && (r.strategy === "AI-SWING" || r.strategy === "MEAN-REVERT"));
const liveWin = live.filter(win);
const factorStats = new Map<string, { n: number; tp: number; pnl: number }>();
for (const r of live) {
  try {
    const f = JSON.parse(r.factorsJson ?? "[]") as Array<{ factor: string; vote: number }>;
    for (const v of f) {
      if (v.vote <= -8) { // strongly bearish vote (short-confirming feature)
        const e = factorStats.get(v.factor) ?? { n: 0, tp: 0, pnl: 0 };
        e.n++; if (win(r)) e.tp++; e.pnl += (r.pnlPercent / 100) * r.marginUsd;
        factorStats.set(v.factor, e);
      }
    }
  } catch {}
}
const baseWR = live.length ? +(100 * liveWin.length / live.length).toFixed(1) : 0;
console.log(`== ① CHOP SHORT live-path: strong bearish votes (vote<=-8) → TP1 lift (baseline WR ${baseWR}%) ==`);
for (const [k, e] of [...factorStats.entries()].sort((a, b) => b.n - a.n).slice(0, 10)) {
  console.log(`${k.padEnd(22)} n=${String(e.n).padStart(4)} WR=${String(+(100 * e.tp / e.n).toFixed(1)).padStart(5)}% net=$${e.pnl.toFixed(2)}`);
}

// flow verdict feature on live path
const flowStats = new Map<string, { n: number; tp: number; pnl: number }>();
for (const r of live) {
  try {
    const f = JSON.parse(r.flowJson ?? "null");
    const verdict = f?.verdict ?? "NO-DATA";
    const e = flowStats.get(verdict) ?? { n: 0, tp: 0, pnl: 0 };
    e.n++; if (win(r)) e.tp++; e.pnl += (r.pnlPercent / 100) * r.marginUsd;
    flowStats.set(verdict, e);
  } catch {}
}
console.log("\n== ③ flow verdict on CHOP SHORT live path ==");
for (const [k, e] of flowStats) console.log(`${k.padEnd(12)} n=${String(e.n).padStart(4)} WR=${String(+(100 * e.tp / e.n).toFixed(1)).padStart(5)}% net=$${e.pnl.toFixed(2)}`);

// ② positive pockets inside vetoed cells — conf × tf grid, min n=20
console.log("\n== ② positive pockets INSIDE vetoed CHOP cells (n>=20) ==");
const vetoed = settled.filter(r => r.direction === "LONG" || r.strategy === "AI-SCALP" || r.strategy === "BREAKOUT" || r.strategy === "MOMENTUM");
for (const cellName of ["AI-SWING|LONG", "MEAN-REVERT|LONG", "AI-SCALP|SHORT", "AI-SCALP|LONG"]) {
  const [st, di] = cellName.split("|");
  const cell = vetoed.filter(r => r.strategy === st && r.direction === di);
  if (!cell.length) continue;
  const c0 = { n: cell.length, tp: cell.filter(win).length, pnl: cell.reduce((a, r) => a + (r.pnlPercent / 100) * r.marginUsd, 0) };
  console.log(`\n  ${cellName}: n=${c0.n} TP1=${c0.tp} (${(100 * c0.tp / c0.n).toFixed(1)}%) net=$${c0.pnl.toFixed(2)}`);
  for (const tf of ["5m", "15m", "1h", "4h"]) {
    for (const [lo, hi] of [[60, 100], [80, 100]] as Array<[number, number]>) {
      const sub = cell.filter(r => r.timeframe === tf && r.confidence >= lo && r.confidence < (hi === 100 ? 101 : hi));
      if (sub.length < 20) continue;
      const tp = sub.filter(win).length;
      const pnl = sub.reduce((a, r) => a + (r.pnlPercent / 100) * r.marginUsd, 0);
      const mark = pnl > 0 ? " ★ POSITIVE" : "";
      console.log(`    tf=${tf} conf>=${lo}: n=${String(sub.length).padStart(3)} TP1=${String(tp).padStart(3)} (${(100 * tp / sub.length).toFixed(0)}%) net=$${pnl.toFixed(2)}${mark}`);
    }
  }
}
await db.$disconnect();
