// ── DURATION FORENSICS (operator request 2026-09-08) ──
// Operator questions:
//   Q1: review signals issued with the NEW tag system (v6.7 smart-money era)
//   Q2: why do some signals hit SL in <1-2 min? fake flows? mis-detection? late entry?
//   Q3: (design input) min/max/avg open duration + win-rate-by-duration for the
//       analytics page — evidence report for the senior core engineer.
// READ-ONLY: this script never mutates the ledger.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const MIN = 60_000;

interface FlowSnapshot {
  verdict?: string;
  score?: number;
  reasons?: string[];
  metrics?: {
    oiDelta10m?: number | null;
    oiDelta1h?: number | null;
    cvdUsd60s?: number | null;
    takerRatio?: number | null;
    whalePrint5m?: { count: number; totalUsd: number; maxUsd: number; buyUsd: number; sellUsd: number } | null;
    topLongShort?: number | null;
    funding8h?: number | null;
    crowdLongShort?: number | null;
  };
}
interface FactorVote { factor?: string; vote?: string; score?: number }

const parse = <T,>(s: string | null | undefined): T | null => {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
};
const tagsOf = (s: string): string[] => (s ? s.split(",").map((t) => t.trim()).filter(Boolean) : []);

async function main() {
  const all = await db.signal.findMany({ orderBy: { createdAt: "asc" } });
  const now = Date.now();

  // ══ PART A — NEW-ERA (v6.7 smart-money barcode) COHORT REVIEW ══
  const era = all.filter((s) => s.engine.includes("v6.7") || tagsOf(s.tags).includes("EPOCH-V7"));
  const v67Launch = era.length ? era[0]!.createdAt : null;
  const cohorts = ["BO-EXP", "WHALE-PRINT", "LIQ-SWEEP", "FUNDING-SKEW-LONGS-CROWDED", "FUNDING-SKEW-SHORTS-CROWDED", "CHOP-VETO"];

  console.log("════════ PART A · NEW-ERA COHORT REVIEW (v6.7 / EPOCH-V7 barcode) ════════");
  console.log(`era signals: ${era.length} (first: ${v67Launch ? v67Launch.toISOString() : "n/a"})`);
  const cohortStat = (list: typeof all, label: string) => {
    const settled = list.filter((s) => s.status !== "ACTIVE");
    const wins = settled.filter((s) => s.reachedTp >= 1);
    const sls = settled.filter((s) => s.status === "SL");
    const exp = settled.filter((s) => s.status === "EXPIRED");
    const tp = settled.filter((s) => ["TP1", "TP2", "TP3"].includes(s.status));
    const pnlUsd = settled.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
    const avgPnl = settled.length ? settled.reduce((a, s) => a + s.pnlPercent, 0) / settled.length : 0;
    console.log(
      `${label.padEnd(30)} n=${String(list.length).padStart(3)} active=${String(list.length - settled.length).padStart(3)} settled=${String(settled.length).padStart(3)} · TPwin=${wins.length} SL=${sls.length} EXP=${exp.length} liveTP=${tp.length} · winRate=${settled.length ? ((wins.length / settled.length) * 100).toFixed(0) : "-"}% · Σpnl=$${pnlUsd.toFixed(2)} avg=${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(1)}%`,
    );
    return { n: list.length, settled: settled.length, wins: wins.length };
  };
  cohortStat(era, "EPOCH-V7 (all)");
  for (const c of cohorts) cohortStat(era.filter((s) => tagsOf(s.tags).includes(c)), c);
  // settled-only view of the fastest-moving cohorts
  console.log("\n— per-signal v6.7 ledger (most recent 25) —");
  for (const s of [...era].reverse().slice(0, 25)) {
    const dur = s.closedAt ? Math.round((s.closedAt.getTime() - s.createdAt.getTime()) / MIN) : null;
    const flow = parse<FlowSnapshot>(s.flowJson);
    const cvd = flow?.metrics?.cvdUsd60s;
    const wp = flow?.metrics?.whalePrint5m;
    console.log(
      `NX-${String(s.serial).padStart(4, "0")} ${s.symbol.padEnd(12)} ${s.direction.padEnd(5)} ${s.status.padEnd(8)} rTP=${s.reachedTp} pnl=${(s.pnlPercent >= 0 ? "+" : "") + s.pnlPercent.toFixed(1)}% dur=${dur === null ? "open" : dur + "m"} score=${s.confidence} ${s.strategy.padEnd(12)} tags=[${tagsOf(s.tags).filter((t) => !["EPOCH-V7"].includes(t)).join(" ")}] cvd60s=${cvd == null ? "-" : Math.round(cvd / 1000) + "K"} whale=${wp ? "$" + Math.round(wp.totalUsd / 1000) + "K" : "-"}`,
    );
  }

  // ══ PART B — FAST-SL FORENSICS (closed to SL with zero TP banked) ══
  console.log("\n════════ PART B · FAST-SL FORENSICS (straight-to-SL, no TP banked) ════════");
  type Row = {
    s: (typeof all)[number];
    durMin: number; slDistPct: number; leveredRisk: number; mfe: number;
    flow: FlowSnapshot | null; votes: FactorVote[] | null;
  };
  const fastSl: Row[] = [];
  for (const s of all) {
    if (s.status !== "SL" || s.reachedTp > 0 || !s.closedAt) continue;
    const durMin = (s.closedAt.getTime() - s.createdAt.getTime()) / MIN;
    const isLong = s.direction === "LONG";
    const slDistPct = ((s.entryPrice - s.stopLoss) / s.entryPrice) * 100 * (isLong ? 1 : -1) * (isLong ? 1 : 1);
    const dist = Math.abs(((isLong ? s.entryPrice - s.stopLoss : s.stopLoss - s.entryPrice) / s.entryPrice) * 100);
    fastSl.push({
      s, durMin, slDistPct: dist, leveredRisk: dist * s.leverage, mfe: s.maxPnlPercent,
      flow: parse<FlowSnapshot>(s.flowJson), votes: parse<FactorVote[]>(s.factorsJson),
    });
  }
  fastSl.sort((a, b) => a.durMin - b.durMin);
  const under2 = fastSl.filter((r) => r.durMin < 2);
  const under5 = fastSl.filter((r) => r.durMin < 5);
  console.log(`straight-SL total=${fastSl.length} · <2min=${under2.length} · <5min=${under5.length}`);

  console.log("\n— 15 fastest straight-SL cases (full evidence) —");
  for (const r of fastSl.slice(0, 15)) {
    const s = r.s;
    const m = r.flow?.metrics;
    const cvd = m?.cvdUsd60s;
    const wp = m?.whalePrint5m;
    const flowScore = r.flow?.score;
    const verdict = r.flow?.verdict;
    // whale alignment with direction: LONG wants buyUsd dominance
    const wpAlign = wp && wp.totalUsd > 0 ? (s.direction === "LONG" ? wp.buyUsd - wp.sellUsd : wp.sellUsd - wp.buyUsd) : null;
    const score = (r.votes ?? []).reduce((a, v) => a + (v.score ?? 0), 0);
    console.log(
      `NX-${String(s.serial).padStart(4, "0")} ${s.createdAt.toISOString().slice(5, 16)} ${s.symbol.padEnd(12)} ${s.direction.padEnd(5)} dur=${r.durMin.toFixed(1)}m SLdist=${r.slDistPct.toFixed(2)}% (x${s.leverage} = ${r.leveredRisk.toFixed(0)}%) MFE=${(r.mfe >= 0 ? "+" : "") + r.mfe.toFixed(1)}% score=${s.confidence}(Σ=${score}) conf=${s.confidence} ${s.strategy.padEnd(12)} tf=${s.timeframe} flow=${verdict}/${flowScore} cvd60s=${cvd == null ? "-" : Math.round(cvd / 1000) + "K"} oi10m=${m?.oiDelta10m == null ? "-" : m.oiDelta10m.toFixed(2) + "%"} whale=${wp ? `$${Math.round(wp.totalUsd / 1000)}K align=${wpAlign == null ? "-" : (wpAlign >= 0 ? "+" : "") + Math.round(wpAlign / 1000) + "K"}` : "-"} funding=${m?.funding8h == null ? "-" : (m.funding8h * 100).toFixed(3) + "%"}`,
    );
  }

  // hypothesis classification on <5min cohort
  const cls = { tightSl: 0, chasingExtended: 0, flowAligned: 0, flowConflict: 0, dataMissing: 0 };
  for (const r of under5) {
    if (r.slDistPct < 0.35) cls.tightSl++;
    else if (r.mfe <= 0.2) cls.chasingExtended++;
    const v = r.flow?.verdict;
    if (v === "CONFIRMS") cls.flowAligned++;
    else if (v === "CONFLICTS") cls.flowConflict++;
    else cls.dataMissing++;
  }
  console.log(`\n<5min cohort hypothesis tally: slDist<0.35%=${cls.tightSl} · MFE≤+0.2%(never-in-profit)=${cls.chasingExtended} · flowCONFIRMS=${cls.flowAligned} flowCONFLICTS=${cls.flowConflict} other=${cls.dataMissing}`);

  // MFE distribution of the fast-SL cohort — did they EVER go green?
  const mfeBuckets = { neverGreen: 0, greenUnder5: 0, green5to15: 0, greenOver15: 0 };
  for (const r of under5) {
    if (r.mfe <= 0) mfeBuckets.neverGreen++;
    else if (r.mfe < 5) mfeBuckets.greenUnder5++;
    else if (r.mfe < 15) mfeBuckets.green5to15++;
    else mfeBuckets.greenOver15++;
  }
  console.log(`<5min MFE profile: never-green=${mfeBuckets.neverGreen} · green<5%=${mfeBuckets.greenUnder5} · green5-15%=${mfeBuckets.green5to15} · green>15%=${mfeBuckets.greenOver15}`);

  // ══ PART C — DURATION DISTRIBUTION (design input for analytics page) ══
  console.log("\n════════ PART C · DURATION DISTRIBUTION (settled, all eras) ════════");
  const settled = all.filter((s) => s.closedAt);
  const durs = settled.map((s) => (s.closedAt!.getTime() - s.createdAt.getTime()) / MIN);
  const sorted = [...durs].sort((a, b) => a - b);
  const q = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!.toFixed(1) : "-";
  const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;
  console.log(`settled=${settled.length} min=${sorted[0]?.toFixed(1)} p25=${q(0.25)} median=${q(0.5)} p75=${q(0.75)} p95=${q(0.95)} max=${sorted[sorted.length - 1]?.toFixed(1)} avg=${avg.toFixed(1)}min`);

  // time-to-TP1 for winners (first TP event)
  const tp1Events = await db.signalEvent.findMany({ where: { type: "TP1" }, orderBy: { createdAt: "asc" } });
  const bySignal = new Map<string, Date>();
  for (const e of tp1Events) if (e.signalId && !bySignal.has(e.signalId)) bySignal.set(e.signalId, e.createdAt);
  const t2tp1: number[] = [];
  for (const [sid, at] of bySignal) {
    const s = all.find((x) => x.id === sid);
    if (s) t2tp1.push((at.getTime() - s.createdAt.getTime()) / MIN);
  }
  t2tp1.sort((a, b) => a - b);
  console.log(`time-to-TP1 (winners, n=${t2tp1.length}): min=${t2tp1[0]?.toFixed(1)} median=${t2tp1[Math.floor(t2tp1.length / 2)]?.toFixed(1)} p75=${t2tp1[Math.floor(t2tp1.length * 0.75)]?.toFixed(1)} max=${t2tp1[t2tp1.length - 1]?.toFixed(1)}min`);

  // win-rate by duration bucket (settled trades, TP-proven = win)
  const buckets: Array<[string, number, number]> = [["0-5m", 0, 5], ["5-15m", 5, 15], ["15-30m", 15, 30], ["30-60m", 30, 60], ["60-120m", 60, 120], ["120m+", 120, Infinity]];
  console.log("\nwin-rate by holding duration:");
  for (const [label, lo, hi] of buckets) {
    const rows = settled.filter((s) => {
      const d = (s.closedAt!.getTime() - s.createdAt.getTime()) / MIN;
      return d >= lo && d < hi;
    });
    if (!rows.length) { console.log(`  ${label.padEnd(8)} n=0`); continue; }
    const w = rows.filter((s) => s.reachedTp >= 1).length;
    const pnl = rows.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
    const avgD = rows.reduce((a, s) => a + (s.closedAt!.getTime() - s.createdAt.getTime()) / MIN, 0) / rows.length;
    console.log(`  ${label.padEnd(8)} n=${String(rows.length).padStart(3)} win=${((w / rows.length) * 100).toFixed(0).padStart(3)}% Σpnl=$${pnl.toFixed(2)} avgDur=${avgD.toFixed(1)}m`);
  }

  // status-rate by duration bucket for <2min specifically (the operator's hot spot)
  const u2 = settled.filter((s) => (s.closedAt!.getTime() - s.createdAt.getTime()) / MIN < 2);
  if (u2.length) {
    const st: Record<string, number> = {};
    for (const s of u2) st[s.status] = (st[s.status] ?? 0) + 1;
    console.log(`\n<2min closed cohort status mix: ${Object.entries(st).map(([k, v]) => `${k}=${v}`).join(" ")} · Σpnl=$${u2.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0).toFixed(2)}`);
  }

  const active = all.filter((s) => s.status === "ACTIVE");
  const oldestActive = active.length ? Math.round((now - Math.min(...active.map((s) => s.createdAt.getTime()))) / MIN) : 0;
  console.log(`\nactive=${active.length} oldest=${oldestActive}min · full ledger=${all.length}`);
}

main().finally(() => db.$disconnect());
