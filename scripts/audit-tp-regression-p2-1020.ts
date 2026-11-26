// ── TP-REGRESSION AUDIT PART 2: full settings, TP-distance cohorts, win metric ──
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const SETTLED_IN = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];

async function main() {
  const now = new Date();
  const since = new Date(now.getTime() - 45 * 864e5);

  // A) FULL text of critical settings
  const keys = ["supervisor", "gate", "duration.forensics", "backtest", "backtest.autotune", "rawcal.quality", "riskgovernor.state", "deep-learn", "strategy.probation", "regime.telemetry", "governor.log", "governor.hysteresis"];
  const rows = await db.engineSetting.findMany({ where: { key: { in: keys } } });
  for (const r of rows) {
    console.log(`\n===== ${r.key} (upd ${r.updatedAt.toISOString().slice(0, 16)}) =====`);
    console.log(r.value?.slice(0, 2600));
  }

  // B) TP1 DISTANCE cohorts — levered % distance from entry to TP1, weekly
  const sigs = await db.signal.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, status: true, reachedTp: true, pnlPercent: true, maxPnlPercent: true, entryPrice: true, tp1: true, tp2: true, tp3: true, stopLoss: true, leverage: true, strategy: true, qualityFlag: true, direction: true, closedAt: true, initialStopLoss: true },
    orderBy: { createdAt: "asc" },
  });
  const levTp1Dist = (s: { entryPrice: number; tp1: number; leverage: number }) => (Math.abs(s.tp1 - s.entryPrice) / s.entryPrice) * s.leverage * 100;
  const levSlDist = (s: { entryPrice: number; stopLoss: number; leverage: number }) => (Math.abs(s.entryPrice - s.stopLoss) / s.entryPrice) * s.leverage * 100;
  console.log("\n===== WEEKLY TP1/SL DISTANCE (levered %, median) + outcome mix =====");
  const wk = new Map<string, { n: number; d1: number[]; dsl: number[]; tp1: number; sl: number; exp: number; closedPos: number; winPnlPos: number; maxP: number[]; reachedMax: number }>();
  for (const s of sigs) {
    if (!SETTLED_IN.includes(s.status) || s.qualityFlag) continue;
    const k = `W-${Math.floor((now.getTime() - s.createdAt.getTime()) / (7 * 864e5))}`;
    const c = wk.get(k) ?? { n: 0, d1: [], dsl: [], tp1: 0, sl: 0, exp: 0, closedPos: 0, winPnlPos: 0, maxP: [], reachedMax: 0 };
    c.n++;
    c.d1.push(levTp1Dist(s)); c.dsl.push(levSlDist(s)); c.maxP.push(s.maxPnlPercent);
    if (s.reachedTp >= 1) c.tp1++;
    if (s.status === "SL") c.sl++;
    if (s.status === "EXPIRED") c.exp++;
    if (s.status === "CLOSED" && s.pnlPercent > 0) { c.closedPos++; c.winPnlPos++; }
    else if (s.pnlPercent > 0) c.winPnlPos++;
    wk.set(k, c);
  }
  const med = (a: number[]) => { if (!a.length) return NaN; const x = [...a].sort((p, q) => p - q); return x[Math.floor(x.length / 2)]; };
  for (const [k, c] of [...wk.entries()].sort((x, y) => parseInt(x[0].slice(2)) - parseInt(y[0].slice(2)))) {
    console.log(`${k}: n=${String(c.n).padStart(4)} | TP1dist med=${med(c.d1).toFixed(1)}% | SLdist med=${med(c.dsl).toFixed(1)}% | TP1hit=${((100 * c.tp1) / c.n).toFixed(1)}% | SL=${((100 * c.sl) / c.n).toFixed(0)}% | EXP=${((100 * c.exp) / c.n).toFixed(0)}% | CLOSED+=${c.closedPos} | win(pnl>0∪TP)=${((100 * c.winPnlPos) / c.n).toFixed(1)}% | maxPnl med=${med(c.maxP).toFixed(1)}%`);
  }

  // C) For settled-EXPIRED: how close did maxPnl get to TP1 distance? (near-TP expiry)
  const expd = sigs.filter((s) => s.status === "EXPIRED" && !s.qualityFlag);
  let near = 0, mid = 0, far = 0;
  for (const s of expd) {
    const tp1d = levTp1Dist(s);
    if (s.maxPnlPercent >= tp1d * 0.8) near++;
    else if (s.maxPnlPercent >= tp1d * 0.5) mid++;
    else far++;
  }
  console.log(`\nEXPIRED cohort n=${expd.length}: reached≥80% of TP1 dist=${near} (${((100 * near) / (expd.length || 1)).toFixed(0)}%), 50-80%=${mid}, <50%=${far}`);

  // D) last-3d vs mid-Sep (W-5) — same-symbol comparison of TP1 hit
  const recent = sigs.filter((s) => s.createdAt >= new Date(now.getTime() - 7 * 864e5) && SETTLED_IN.includes(s.status) && !s.qualityFlag);
  const rTp1 = recent.filter((s) => s.reachedTp >= 1).length;
  const rWin = recent.filter((s) => s.reachedTp >= 1 || s.pnlPercent > 0).length;
  console.log(`\nLAST 7d: settled=${recent.length} TP1hit=${((100 * rTp1) / recent.length).toFixed(1)}% win∪=${((100 * rWin) / recent.length).toFixed(1)}%`);

  // E) strategy mix shift: last 7d vs previous 14d
  const stratMix = (rows2: typeof sigs) => {
    const m = new Map<string, number>();
    for (const s of rows2) m.set(s.strategy, (m.get(s.strategy) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ");
  };
  console.log("\nSTRATEGY MIX last-7d: " + stratMix(recent));
  const older = sigs.filter((s) => s.createdAt < new Date(now.getTime() - 7 * 864e5) && s.createdAt >= new Date(now.getTime() - 21 * 864e5) && SETTLED_IN.includes(s.status) && !s.qualityFlag);
  console.log("STRATEGY MIX d7-21:   " + stratMix(older));

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
