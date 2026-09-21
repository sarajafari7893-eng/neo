// R28 audit — read-only deep dive: signal outcomes, regime/strategy PNL,
// agent/LLM state, factor PNL share (for the calibrator redesign).
import { db } from "../src/lib/db";

async function main() {
  const settled = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
    select: { symbol: true, strategy: true, status: true, pnlPercent: true, marginUsd: true, reachedTp: true, confidence: true, riskReward: true, factorsJson: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 400,
  });
  const open = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { symbol: true, direction: true, serial: true, pnlPercent: true, createdAt: true } });

  const bucket = (s: (typeof settled)[number]) => (s.pnlPercent > 0 || s.reachedTp >= 1 ? "win" : "loss");
  const netUsd = (s: (typeof settled)[number]) => (s.marginUsd * s.pnlPercent) / 100;

  const by = (keyFn: (s: (typeof settled)[number]) => string) => {
    const m = new Map<string, { n: number; wins: number; pnlUsd: number; pnlPctSum: number }>();
    for (const s of settled) {
      const k = keyFn(s);
      const c = m.get(k) ?? { n: 0, wins: 0, pnlUsd: 0, pnlPctSum: 0 };
      c.n++; if (bucket(s) === "win") c.wins++;
      c.pnlUsd += netUsd(s); c.pnlPctSum += s.pnlPercent;
      m.set(k, c);
    }
    return [...m.entries()].sort((a, b) => a[1].pnlUsd - b[1].pnlUsd);
  };

  const fmt = (rows: Array<[string, { n: number; wins: number; pnlUsd: number; pnlPctSum: number }]>) =>
    rows.map(([k, v]) => `${k}: n=${v.n} WR=${Math.round((v.wins / v.n) * 100)}% PNL=$${v.pnlUsd.toFixed(2)} Σ%=${v.pnlPctSum.toFixed(0)}`).join("\n");

  const totalPnl = settled.reduce((a, s) => a + netUsd(s), 0);

  console.log(`SETTLED ${settled.length} · OPEN ${open.length} · NET $${totalPnl.toFixed(2)}`);
  console.log("\n== BY STATUS =="); console.log(fmt(by((s) => s.status)));
  console.log("\n== BY STRATEGY (worst first) =="); console.log(fmt(by((s) => s.strategy)));
  console.log("\n== BY TAG REGIME (from factors? use status×strategy) ==");
  console.log("\n== BY SYMBOL (worst 8) =="); console.log(fmt(by((s) => s.symbol).slice(0, 8)));

  // factor net-PNL share (strong votes only) — the calibrator redesign input
  const FACTORS = ["EMA STACK", "MACD MOMENTUM", "RSI POSITION", "RANGE BREAKOUT", "BOLLINGER EXTREME", "VOLUME CONFIRM"];
  const acc = new Map<string, { n: number; wins: number; pnlUsd: number; pnlPctSum: number }>();
  for (const f of FACTORS) acc.set(f, { n: 0, wins: 0, pnlUsd: 0, pnlPctSum: 0 });
  for (const s of settled) {
    if (!s.factorsJson) continue;
    let votes: Array<{ factor: string; vote: number }> = [];
    try { votes = JSON.parse(s.factorsJson); } catch { continue; }
    for (const v of votes) {
      const c = acc.get(v.factor);
      if (!c || Math.abs(v.vote) < 8) continue;
      c.n++; c.pnlUsd += netUsd(s); c.pnlPctSum += s.pnlPercent; if (bucket(s) === "win") c.wins++;
    }
  }
  console.log("\n== FACTOR NET-PNL SHARE (strong votes) ==");
  for (const [f, c] of acc) console.log(`${f}: n=${c.n} WR=${c.n ? Math.round((c.wins / c.n) * 100) : 0}% PNL=$${c.pnlUsd.toFixed(2)} avg=${c.n ? (c.pnlPctSum / c.n).toFixed(1) : 0}%/trade`);

  // confidence bands vs pnl
  console.log("\n== CONFIDENCE BANDS ==");
  console.log(fmt(by((s) => (s.confidence >= 80 ? "conf≥80" : s.confidence >= 70 ? "conf 70-79" : s.confidence >= 60 ? "conf 60-69" : "conf<60"))));

  // agent states
  const keys = ["governor", "governor.hysteresis", "calibration", "backtest", "backtest.autotune", "learner.auto", "ttl-gate", "gate", "supervisor", "telegram.chatId"];
  for (const k of keys) {
    const row = await db.engineSetting.findUnique({ where: { key: k } });
    if (row) console.log(`\n== ${k} ==\n${row.value.slice(0, 700)}`);
    else console.log(`\n== ${k} == (absent)`);
  }

  // LLM agent event counters (last 48h)
  const since = new Date(Date.now() - 48 * 3600_000);
  const aiEvents = await db.signalEvent.groupBy({ by: ["type"], _count: true, where: { createdAt: { gte: since }, type: { in: ["ENGINE", "SYSTEM"] } } });
  console.log("\n== ENGINE/SYSTEM events 48h ==", aiEvents.map((r) => `${r.type}:${r._count}`).join(" "));
  const recentAi = await db.signalEvent.findMany({ where: { createdAt: { gte: since }, OR: [{ message: { contains: "GOVERNOR" } }, { message: { contains: "SUPERVISOR" } }, { message: { contains: "CALIBRATION" } }] }, select: { message: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 8 });
  for (const e of recentAi) console.log(`  [${e.createdAt.toISOString().slice(5, 16)}] ${e.message.slice(0, 150)}`);

  // regime distribution from tags
  const regimeCount = new Map<string, number>();
  const sigs = await db.signal.findMany({ select: { tags: true, pnlPercent: true, reachedTp: true, marginUsd: true, status: true }, take: 400, orderBy: { createdAt: "desc" } });
  const regAcc = new Map<string, { n: number; pnl: number; wins: number }>();
  for (const s of sigs) {
    const tag = (s.tags || "").split(",").find((t) => t.startsWith("REGIME-")) ?? "NONE";
    const c = regAcc.get(tag) ?? { n: 0, pnl: 0, wins: 0 };
    c.n++; c.pnl += (s.marginUsd * s.pnlPercent) / 100; if (s.pnlPercent > 0 || s.reachedTp >= 1) c.wins++;
    regAcc.set(tag, c);
  }
  console.log("\n== BY REGIME TAG ==");
  for (const [k, v] of regAcc) console.log(`${k}: n=${v.n} WR=${Math.round((v.wins / v.n) * 100)}% PNL=$${v.pnl.toFixed(2)}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
