// ── TP-REGRESSION AUDIT (operator round 2026-10-20, trace 1a15936c6a6b6789) ──
// Operator report: «هیچ سیگنالی تی‌پی نمی‌شود؛ نرخ TP ≈10% در حالی که گذشته >50% بود»
// This audit measures it, no assertions — evidence only.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const SETTLED_IN = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];
const day = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  const now = new Date();
  const since = new Date(now.getTime() - 45 * 864e5);

  // 1) All signals in the last 30 days
  const sigs = await db.signal.findMany({
    where: { createdAt: { gte: since } },
    select: {
      createdAt: true, status: true, reachedTp: true, pnlPercent: true, maxPnlPercent: true,
      closedAt: true, strategy: true, engine: true, qualityFlag: true, confidence: true,
      tags: true, ttlMinutes: true, symbol: true, direction: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // ── daily cohort table ──
  type C = { n: number; settled: number; tp1: number; sl: number; expired: number; sumPnl: number; sumMax: number; confSum: number };
  const byDay = new Map<string, C>();
  for (const s of sigs) {
    const k = day(s.createdAt);
    const c = byDay.get(k) ?? { n: 0, settled: 0, tp1: 0, sl: 0, expired: 0, sumPnl: 0, sumMax: 0, confSum: 0 };
    c.n++; c.confSum += s.confidence;
    if (SETTLED_IN.includes(s.status)) {
      c.settled++;
      if (s.reachedTp >= 1) c.tp1++;
      if (s.status === "SL") c.sl++;
      if (s.status === "EXPIRED") c.expired++;
    }
    c.sumPnl += s.pnlPercent; c.sumMax += s.maxPnlPercent;
    byDay.set(k, c);
  }
  console.log("=== DAILY COHORTS (deploy-day; tp1Rate = reachedTp≥1 / settled) ===");
  console.log("day        | dep | sett | TP1%  | SL%  | EXP% | avgPnl% | avgMaxPnl% | conf");
  for (const [k, c] of [...byDay.entries()].sort()) {
    const tp1r = c.settled ? (100 * c.tp1) / c.settled : NaN;
    const slr = c.settled ? (100 * c.sl) / c.settled : NaN;
    const exr = c.settled ? (100 * c.expired) / c.settled : NaN;
    console.log(
      `${k} | ${String(c.n).padStart(3)} | ${String(c.settled).padStart(4)} | ${isFinite(tp1r) ? tp1r.toFixed(0).padStart(4) : "  -"}% | ${isFinite(slr) ? slr.toFixed(0).padStart(3) : "-"}% | ${isFinite(exr) ? exr.toFixed(0).padStart(3) : "-"}% | ${(c.sumPnl / c.n).toFixed(2).padStart(7)} | ${(c.sumMax / c.n).toFixed(2).padStart(10)} | ${(c.confSum / c.n).toFixed(0)}`
    );
  }

  // ── window comparison ──
  const win = (fromDaysAgo: number, toDaysAgo: number) => {
    const a = new Date(now.getTime() - fromDaysAgo * 864e5); // older bound
    const b = new Date(now.getTime() - toDaysAgo * 864e5); // newer bound
    const rows = sigs.filter((s) => s.createdAt >= a && s.createdAt < b && SETTLED_IN.includes(s.status) && !s.qualityFlag);
    const tp1 = rows.filter((s) => s.reachedTp >= 1).length;
    const sl = rows.filter((s) => s.status === "SL").length;
    const exp = rows.filter((s) => s.status === "EXPIRED").length;
    const maxP = rows.reduce((acc, s) => acc + s.maxPnlPercent, 0);
    const pnl = rows.reduce((acc, s) => acc + s.pnlPercent, 0);
    return { n: rows.length, tp1r: rows.length ? (100 * tp1) / rows.length : NaN, slr: rows.length ? (100 * sl) / rows.length : NaN, expr: rows.length ? (100 * exp) / rows.length : NaN, avgMax: rows.length ? maxP / rows.length : NaN, avgPnl: rows.length ? pnl / rows.length : NaN };
  };
  console.log("\n=== WINDOW COMPARISON (clean ledger, no qualityFlag) ===");
  for (const [a, b] of [[45, 38], [38, 31], [31, 24], [24, 17], [17, 10], [10, 7], [7, 3], [3, 0]] as const) {
    const w = win(a, b);
    console.log(`D-${String(a).padStart(2)}→D-${String(b).padStart(2)}: n=${String(w.n).padStart(3)} TP1=${isFinite(w.tp1r) ? w.tp1r.toFixed(1) + "%" : " -"} SL=${isFinite(w.slr) ? w.slr.toFixed(1) + "%" : "-"} EXPIRED=${isFinite(w.expr) ? w.expr.toFixed(1) + "%" : "-"} avgMaxPnl=${isFinite(w.avgMax) ? w.avgMax.toFixed(2) + "%" : "-"} avgPnl=${isFinite(w.avgPnl) ? w.avgPnl.toFixed(2) + "%" : "-"}`);
  }

  // ── weekly TP1 trend (all statuses, qualityFlag excluded) ──
  console.log("\n=== WEEKLY TP1 TREND (45d) ===");
  const wk = new Map<string, { n: number; tp1: number }>();
  for (const s of sigs) {
    if (!SETTLED_IN.includes(s.status) || s.qualityFlag) continue;
    const week = Math.floor((now.getTime() - s.createdAt.getTime()) / (7 * 864e5));
    const k = `W-${week}`;
    const c = wk.get(k) ?? { n: 0, tp1: 0 };
    c.n++; if (s.reachedTp >= 1) c.tp1++;
    wk.set(k, c);
  }
  for (const [k, c] of [...wk.entries()].sort((x, y) => parseInt(x[0].slice(2)) - parseInt(y[0].slice(2)))) {
    console.log(`${k}: n=${String(c.n).padStart(4)} TP1%=${((100 * c.tp1) / c.n).toFixed(1)}`);
  }

  // 2) knob changes — EngineSetting recent updates
  const settings = await db.engineSetting.findMany({ orderBy: { updatedAt: "desc" }, take: 30 });
  console.log("\n=== ENGINE SETTINGS (30 most recent updates) ===");
  for (const s of settings) {
    const v = s.value?.slice(0, 160) ?? "";
    console.log(`${s.updatedAt.toISOString().slice(0, 16)}  ${s.key} = ${v}`);
  }

  // 3) event-type daily counts (last 10d)
  const ev = await db.signalEvent.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - 10 * 864e5) } },
    select: { type: true, level: true, createdAt: true, message: true },
  });
  const evDay = new Map<string, Map<string, number>>();
  for (const e of ev) {
    const k = day(e.createdAt), t = e.type + (e.level === "warn" || e.level === "error" ? `:${e.level}` : "");
    const m = evDay.get(k) ?? new Map<string, number>();
    m.set(t, (m.get(t) ?? 0) + 1); evDay.set(k, m);
  }
  console.log("\n=== EVENT TYPES / DAY (10d) ===");
  for (const [k, m] of [...evDay.entries()].sort()) {
    const line = [...m.entries()].sort((x, y) => y[1] - x[1]).map(([t, c]) => `${t}:${c}`).join(" ");
    console.log(`${k}  ${line}`);
  }

  // 4) sensor freshness
  const [flowMax, flowCount, pumpLast, pumpOut, fsMax, ppCount, maSim, maLive] = await Promise.all([
    db.flowScan.aggregate({ _max: { updatedAt: true } }),
    db.flowScan.count(),
    db.pumpTrack.findMany({ orderBy: { detectedAt: "desc" }, take: 5, select: { symbol: true, kind: true, phase: true, outcome: true, detectedAt: true, score: true, mfePct: true } }),
    db.pumpTrack.groupBy({ by: ["outcome"], _count: true }),
    db.futuresSnapshot.aggregate({ _max: { ts: true }, where: { source: "LIVE" } }),
    db.pricePoint.count({ where: { createdAt: { gte: new Date(now.getTime() - 3600e3) } } }),
    db.marketAsset.count({ where: { source: "sim" } }),
    db.marketAsset.count(),
  ]);
  console.log("\n=== SENSOR FRESHNESS ===");
  console.log(`FlowScan rows=${flowCount} maxUpdatedAt=${flowMax._max.updatedAt?.toISOString() ?? "null"}`);
  console.log(`FuturesSnapshot(LIVE) maxTs=${fsMax._max.ts?.toISOString() ?? "null"}`);
  console.log(`PricePoint last-1h=${ppCount}`);
  console.log(`MarketAsset sim=${maSim}/${maLive}`);
  console.log(`PumpTrack outcomes: ${pumpOut.map((r) => `${r.outcome ?? "open"}:${r._count}`).join(" ")}`);
  console.log("PumpTrack last5: " + pumpLast.map((p) => `${p.symbol}(${p.kind},${p.phase},${p.outcome ?? "-"},s${p.score},${p.detectedAt.toISOString().slice(5, 16)})`).join(" · "));

  // 5) supervisor thoughts
  const thoughts = await db.agentThought.findMany({ where: { agent: "SUPERVISOR" }, orderBy: { createdAt: "desc" }, take: 10 });
  console.log("\n=== SUPERVISOR THOUGHTS (last 10) ===");
  for (const t of thoughts) console.log(`${t.createdAt.toISOString().slice(0, 16)} [${t.phase}] ${t.thought.slice(0, 220)}`);

  // 6) fill ledger daily slip/latency (last 5d)
  const fills = await db.fillLedger.findMany({ where: { createdAt: { gte: new Date(now.getTime() - 5 * 864e5) } }, select: { createdAt: true, slipBps: true, latencyMs: true } });
  const fillDay = new Map<string, { n: number; slip: number; lat: number; latN: number }>();
  for (const f of fills) {
    const k = day(f.createdAt);
    const c = fillDay.get(k) ?? { n: 0, slip: 0, lat: 0, latN: 0 };
    c.n++; c.slip += f.slipBps; if (f.latencyMs) { c.lat += f.latencyMs; c.latN++; }
    fillDay.set(k, c);
  }
  console.log("\n=== FILL LEDGER (5d) ===");
  for (const [k, c] of [...fillDay.entries()].sort()) console.log(`${k} n=${c.n} avgSlip=${(c.slip / c.n).toFixed(1)}bps avgLat=${c.latN ? (c.lat / c.latN).toFixed(0) + "ms" : "-"}`);

  // 7) deploy cadence per 6h bucket (last 3d) — is the engine still DEPLOYING?
  const deploys = sigs.filter((s) => s.createdAt >= new Date(now.getTime() - 3 * 864e5));
  console.log("\n=== DEPLOY CADENCE (3d, 6h buckets, Tehran) ===");
  const bucket = new Map<string, number>();
  for (const s of deploys) {
    const d = new Date(s.createdAt.getTime() + 3.5 * 3600e3); // UTC+3:30
    const k = `${d.toISOString().slice(5, 10)} ${String(Math.floor((d.getUTCHours()) / 6) * 6).padStart(2, "0")}:xx`;
    bucket.set(k, (bucket.get(k) ?? 0) + 1);
  }
  for (const [k, c] of [...bucket.entries()].sort()) console.log(`${k} UTC+3:30 → ${c} deploys`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
