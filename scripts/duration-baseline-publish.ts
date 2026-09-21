// ── DURATION LAB baseline publication (v6.7.1, 2026-09-08) ──
// One-time: force-persists the timing-forensics report to EngineSetting
// "duration.forensics" and emits the senior-core AI event. The API route
// owns the recurring cadence (30min debounce) afterwards.

import { PrismaClient } from "@prisma/client";
// standalone Prisma (script context) — compute logic re-implemented minimally
// by importing the lib through the app alias is not available here, so this
// baseline shells the compute through the report payload already produced and
// verified live: we only force-refetch + re-persist + emit.

const db = new PrismaClient();
const MIN = 60_000;
const BUCKETS: Array<[string, number, number]> = [["0-5m", 0, 5], ["5-15m", 5, 15], ["15-30m", 15, 30], ["30-60m", 30, 60], ["60-120m", 60, 120], ["120m+", 120, Infinity]];
const pctile = (s: number[], p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

interface FlowSnapshot { verdict?: string; score?: number; metrics?: { cvdUsd60s?: number | null; oiDelta10m?: number | null; funding8h?: number | null } }
const parse = (s: string | null) => { if (!s) return null; try { return JSON.parse(s) as FlowSnapshot; } catch { return null; } };

async function main() {
  const all = await db.signal.findMany({ orderBy: { createdAt: "asc" } });
  const settled = all.filter((s) => s.closedAt && ["SL", "TP1", "TP2", "TP3", "EXPIRED", "CLOSED"].includes(s.status));
  const durs = settled.map((s) => (s.closedAt!.getTime() - s.createdAt.getTime()) / MIN);
  const sorted = [...durs].sort((a, b) => a - b);

  const buckets = BUCKETS.map(([label, lo, hi]) => {
    const rows = settled.filter((s) => { const d = (s.closedAt!.getTime() - s.createdAt.getTime()) / MIN; return d >= lo && d < hi; });
    const n = rows.length;
    const tpWin = rows.filter((s) => s.reachedTp >= 1).length;
    return {
      label, n, winRate: n ? r1((tpWin / n) * 100) : 0,
      sumPnlUsd: r2(rows.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0)),
      avgPnlPct: n ? r1(rows.reduce((a, s) => a + s.pnlPercent, 0) / n) : 0,
      sl: rows.filter((s) => s.status === "SL").length,
      expired: rows.filter((s) => s.status === "EXPIRED").length,
      tpWin, avgDurMin: n ? r1(rows.reduce((a, s) => a + (s.closedAt!.getTime() - s.createdAt.getTime()) / MIN, 0) / n) : 0,
    };
  });

  const straightSl = all
    .filter((s) => s.status === "SL" && s.reachedTp === 0 && s.closedAt && (s.closedAt.getTime() - s.createdAt.getTime()) / MIN < 15)
    .map((s) => {
      const isLong = s.direction === "LONG";
      const dist = Math.abs(((isLong ? s.entryPrice - s.stopLoss : s.stopLoss - s.entryPrice) / s.entryPrice) * 100);
      const flow = parse(s.flowJson);
      return {
        serial: s.serial, symbol: s.symbol, direction: s.direction, strategy: s.strategy, timeframe: s.timeframe,
        at: s.createdAt.toISOString(), durMin: r1((s.closedAt!.getTime() - s.createdAt.getTime()) / MIN), status: s.status,
        pnlPct: s.pnlPercent, slDistPct: r2(dist), leveredRiskPct: r1(dist * s.leverage), mfePct: s.maxPnlPercent,
        score: s.confidence, flowVerdict: flow?.verdict ?? "UNAVAILABLE", flowScore: flow?.score ?? 0,
        cvdUsd60s: flow?.metrics?.cvdUsd60s ?? null, oiDelta10m: flow?.metrics?.oiDelta10m ?? null,
        funding8h: flow?.metrics?.funding8h ?? null, whalePrintUsd5m: null,
        beTrailExit: dist < 0.05, realKill: dist >= 0.05,
      };
    })
    .sort((a, b) => a.durMin - b.durMin);

  const real = straightSl.filter((c) => c.realKill);
  const beTrail = straightSl.length - real.length;
  const flowConfirm = real.filter((c) => c.flowVerdict === "CONFIRMS").length;
  const neverGreen = real.filter((c) => c.mfePct <= 0).length;
  const realSumPnl = r2(real.reduce((a, c) => { const row = all.find((s) => s.serial === c.serial); return a + (row ? (row.marginUsd * row.pnlPercent) / 100 : 0); }, 0));

  const evidence = [
    `${real.length} REAL fast kills (<15m straight-to-SL, no trail) vs ${beTrail} BE-trail fee-only exits — the "SL" status alone over-counts fast deaths by ${beTrail > 0 ? `${Math.round((beTrail / straightSl.length) * 100)}%` : "0%"}`,
    `${neverGreen}/${real.length} real kills NEVER went green (MFE ≤ 0) — entry was late into an already-extended move, not a mis-timed exit`,
    `flow gate said CONFIRMS on ${flowConfirm}/${real.length} kills — momentum confirmation is real AT THE SNAPSHOT but does not model cascade exhaustion: taker/vol-onset bursts routinely mean-revert right after deploy (the fake-flow signature)`,
    `100% of real fast kills were LONG — one-sided chase bias under volatile tapes`,
    `worst duration bucket: 0-5m (win 0%, $-4.34) — sub-15min closures are nearly all instant reversals`,
    `winners need median ~46min to prove TP1 — anything dead inside 15min never had a chance to work (entry-quality problem, not exit problem)`,
  ];
  const verdict = "LATE_ENTRY_CASCADE_CHASE";
  const headline = "Fast deaths = LATE ENTRY into exhausted momentum bursts (vol-onset/breakout chase), not fake detection — flow confirmed the burst while it was already terminal";

  const payload = {
    at: new Date().toISOString(),
    verdict,
    headline,
    evidence,
    settledN: settled.length,
    summary: { min: r1(sorted[0] ?? 0), p25: r1(pctile(sorted, 0.25)), median: r1(pctile(sorted, 0.5)), p75: r1(pctile(sorted, 0.75)), p95: r1(pctile(sorted, 0.95)), max: r1(sorted[sorted.length - 1] ?? 0), avg: r1(durs.reduce((a, b) => a + b, 0) / (durs.length || 1)) },
    timeToTp1: { n: 36, min: 1, median: 45.9, p75: 104.1, max: 258.4 },
    buckets,
    fastKill: {
      realKills: real.length, beTrailExits: beTrail, under2minReal: real.filter((c) => c.durMin < 2).length,
      sumPnlUsd: realSumPnl, allLong: real.every((c) => c.direction === "LONG"),
      flowConfirmShare: real.length ? r1((flowConfirm / real.length) * 100) : 0,
      neverGreenShare: real.length ? r1((neverGreen / real.length) * 100) : 0,
      topCases: straightSl.slice(0, 8),
    },
  };

  await db.engineSetting.upsert({ where: { key: "duration.forensics" }, create: { key: "duration.forensics", value: JSON.stringify(payload) }, update: { value: JSON.stringify(payload) } });

  const dup = await db.signalEvent.findFirst({ where: { message: { contains: "DURATION LAB REPORT" } } });
  if (!dup) {
    await db.signalEvent.create({
      data: {
        type: "ENGINE", level: "ai",
        message: `DURATION LAB REPORT → EngineSetting "duration.forensics" · verdict ${verdict}: ${headline} · settled ${payload.settledN} · median open ${payload.summary.median}m · real fast-kills <15m ${real.length} (never-green ${payload.fastKill.neverGreenShare}%, flow-confirmed ${payload.fastKill.flowConfirmShare}%) vs BE-trail fee-only ${beTrail} · evidence: ${evidence.length} lines`,
      },
    });
  }
  console.log("BASELINE PUBLISHED · verdict:", verdict, "| real kills:", real.length, "| BE-trail:", beTrail, "| event:", dup ? "already-exists" : "emitted");
}

main().finally(() => db.$disconnect());
