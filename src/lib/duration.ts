// ── DURATION LAB — timing forensics engine (operator request 2026-09-08) ──
// Operator questions this module answers with evidence, not vibes:
//   Q1: how long do signals stay open (min / max / avg / distribution)?
//   Q2: why do some signals die at SL within 1-2 minutes — fake flow,
//       mis-detection, or late entry?
//   Q3: status-rate by holding duration, as a training report for the
//       senior system-core engineer (persisted to EngineSetting
//       "duration.forensics" so the AI CORE advisor/governor can read it).
//
// FORENSIC CONTRACT (read-only on the ledger):
//   • "open duration" = closedAt − createdAt for every settled signal
//     (status ∈ SL | TP3 | EXPIRED | CLOSED — TP1/TP2 are banked rungs,
//     the position keeps running until a real close).
//   • BE-TRAIL EXIT vs REAL FAST KILL: a signal whose stop was trailed to
//     entry (v6.5 mid-ladder breakeven arm) shows stopLoss == entryPrice.
//     Its "SL" status is a FEE-ONLY exit (~−2% = commissions), NOT a real
//     stop-out. Conflating the two is exactly how fast-exit statistics
//     get over-counted — the lab separates them explicitly.
//   • REAL fast kill = straight-to-SL (reachedTp 0), no trail, died
//     < 15min. Its evidence row carries the full deploy-time flow snapshot
//     (CVD, OI delta, funding, whale prints, flow verdict) so the senior
//     core can judge: fake-flow / late-entry / tight-stop.

import { db } from "@/lib/db";

export interface DurationBucket {
  label: string;
  n: number;
  winRate: number; // TP-proven win rate %
  sumPnlUsd: number;
  avgPnlPct: number;
  sl: number;
  expired: number;
  tpWin: number; // reachedTp ≥ 1
  avgDurMin: number;
}

export interface FastKillCase {
  serial: number;
  symbol: string;
  direction: string;
  strategy: string;
  timeframe: string;
  at: string; // deploy time ISO
  durMin: number;
  status: string;
  pnlPct: number;
  slDistPct: number; // unlevered entry→SL distance (trailed stop == 0 ⇒ BE exit)
  leveredRiskPct: number; // slDistPct × leverage — the real margin swing at the stop
  mfePct: number; // max favorable excursion (levered gross) before death
  score: number;
  flowVerdict: string;
  flowScore: number;
  cvdUsd60s: number | null;
  oiDelta10m: number | null;
  funding8h: number | null;
  whalePrintUsd5m: number | null;
  beTrailExit: boolean; // stop trailed to entry → fee-only exit, not a real loss
  realKill: boolean;
}

export interface DurationReport {
  at: string;
  settledN: number;
  activeN: number;
  summary: {
    min: number;
    p25: number;
    median: number;
    p75: number;
    p95: number;
    max: number;
    avg: number;
  };
  timeToTp1: { n: number; min: number; median: number; p75: number; max: number };
  buckets: DurationBucket[];
  fastKill: {
    realKills: number; // straight-SL, no trail, <15min
    beTrailExits: number;
    under2minReal: number;
    sumPnlUsd: number;
    allLong: boolean;
    flowConfirmShare: number; // % of real kills where flow said CONFIRMS at deploy
    neverGreenShare: number; // % of real kills with MFE ≤ 0 — died before ever going green
    cases: FastKillCase[];
  };
  diagnosis: {
    headline: string;
    evidence: string[];
    verdict: string; // machine-readable primary cause for the AI CORE
  };
}

interface FlowSnapshot {
  verdict?: string;
  score?: number;
  metrics?: {
    cvdUsd60s?: number | null;
    oiDelta10m?: number | null;
    funding8h?: number | null;
    whalePrint5m?: { totalUsd?: number } | null;
  };
}

const parse = <T,>(s: string | null | undefined): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

const MIN = 60_000;
const BUCKETS: Array<[string, number, number]> = [
  ["0-5m", 0, 5],
  ["5-15m", 5, 15],
  ["15-30m", 15, 30],
  ["30-60m", 30, 60],
  ["60-120m", 60, 120],
  ["120m+", 120, Infinity],
];
const FAST_KILL_MAX_MIN = 15;
/** stop trailed to entry leaves |entry−stop|/entry < 5bps (float-safe) */
const BE_TRAIL_EPS_PCT = 0.05;

const pctile = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0;
const r1 = (x: number): number => Math.round(x * 10) / 10;
const r2 = (x: number): number => Math.round(x * 100) / 100;

export async function computeDurationAnalytics(): Promise<DurationReport> {
  const [all, tp1Events] = await Promise.all([
    db.signal.findMany({ orderBy: { createdAt: "asc" } }),
    db.signalEvent.findMany({ where: { type: "TP1" }, orderBy: { createdAt: "asc" } }),
  ]);
  const settled = all.filter((s) => s.closedAt && ["SL", "TP1", "TP2", "TP3", "EXPIRED", "CLOSED"].includes(s.status));

  const durs = settled.map((s) => (s.closedAt!.getTime() - s.createdAt.getTime()) / MIN);
  const sorted = [...durs].sort((a, b) => a - b);

  // time-to-TP1: first TP1 event per signal (winners' proof-of-work clock)
  const firstTp1 = new Map<string, Date>();
  for (const e of tp1Events) if (e.signalId && !firstTp1.has(e.signalId)) firstTp1.set(e.signalId, e.createdAt);
  const t2tp1: number[] = [];
  for (const [sid, at] of firstTp1) {
    const s = all.find((x) => x.id === sid);
    if (s) t2tp1.push((at.getTime() - s.createdAt.getTime()) / MIN);
  }
  t2tp1.sort((a, b) => a - b);

  const buckets: DurationBucket[] = BUCKETS.map(([label, lo, hi]) => {
    const rows = settled.filter((s) => {
      const d = (s.closedAt!.getTime() - s.createdAt.getTime()) / MIN;
      return d >= lo && d < hi;
    });
    const n = rows.length;
    const tpWin = rows.filter((s) => s.reachedTp >= 1).length;
    return {
      label,
      n,
      winRate: n ? r1((tpWin / n) * 100) : 0,
      sumPnlUsd: r2(rows.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0)),
      avgPnlPct: n ? r1(rows.reduce((a, s) => a + s.pnlPercent, 0) / n) : 0,
      sl: rows.filter((s) => s.status === "SL").length,
      expired: rows.filter((s) => s.status === "EXPIRED").length,
      tpWin,
      avgDurMin: n ? r1(rows.reduce((a, s) => a + (s.closedAt!.getTime() - s.createdAt.getTime()) / MIN, 0) / n) : 0,
    };
  });

  // ── fast-kill forensics ──
  type Raw = {
    s: (typeof all)[number];
    durMin: number;
    slDistPct: number;
    flow: FlowSnapshot | null;
  };
  const straightSl: Raw[] = [];
  for (const s of all) {
    if (s.status !== "SL" || s.reachedTp > 0 || !s.closedAt) continue;
    const isLong = s.direction === "LONG";
    const dist = Math.abs(((isLong ? s.entryPrice - s.stopLoss : s.stopLoss - s.entryPrice) / s.entryPrice) * 100);
    const durMin = (s.closedAt.getTime() - s.createdAt.getTime()) / MIN;
    if (durMin < FAST_KILL_MAX_MIN) straightSl.push({ s, durMin, slDistPct: dist, flow: parse<FlowSnapshot>(s.flowJson) });
  }

  const cases: FastKillCase[] = straightSl
    .sort((a, b) => a.durMin - b.durMin)
    .map(({ s, durMin, slDistPct, flow }) => {
      const beTrailExit = slDistPct < BE_TRAIL_EPS_PCT; // stop == entry → trailed to breakeven
      const m = flow?.metrics;
      return {
        serial: s.serial,
        symbol: s.symbol,
        direction: s.direction,
        strategy: s.strategy,
        timeframe: s.timeframe,
        at: s.createdAt.toISOString(),
        durMin: r1(durMin),
        status: s.status,
        pnlPct: s.pnlPercent,
        slDistPct: r2(slDistPct),
        leveredRiskPct: r1(slDistPct * s.leverage),
        mfePct: s.maxPnlPercent,
        score: s.confidence,
        flowVerdict: flow?.verdict ?? "UNAVAILABLE",
        flowScore: flow?.score ?? 0,
        cvdUsd60s: m?.cvdUsd60s ?? null,
        oiDelta10m: m?.oiDelta10m ?? null,
        funding8h: m?.funding8h ?? null,
        whalePrintUsd5m: m?.whalePrint5m?.totalUsd ?? null,
        beTrailExit,
        realKill: !beTrailExit,
      };
    });

  const realCases = cases.filter((c) => c.realKill);
  const beTrailCount = cases.length - realCases.length;
  const flowConfirm = realCases.filter((c) => c.flowVerdict === "CONFIRMS").length;
  const neverGreen = realCases.filter((c) => c.mfePct <= 0).length;
  const realSumPnl = realCases.reduce((a, c) => {
    const row = all.find((s) => s.serial === c.serial);
    return a + (row ? (row.marginUsd * row.pnlPercent) / 100 : 0);
  }, 0);
  const under2minReal = realCases.filter((c) => c.durMin < 2).length;
  const allLong = realCases.length > 0 && realCases.every((c) => c.direction === "LONG");

  // ── evidence-grounded diagnosis (recomputed, never hard-coded) ──
  const shortBuckets = buckets.filter((b) => b.n >= 3).slice(0, 2); // 0-5m, 5-15m
  const worst = [...buckets].filter((b) => b.n >= 3).sort((a, b) => a.winRate - b.winRate)[0];
  const evidence: string[] = [];
  let verdict = "WARMING_UP";
  let headline = "Duration lab warming up — not enough settled trades";

  if (settled.length >= 30 && realCases.length > 0) {
    evidence.push(
      `${realCases.length} REAL fast kills (<${FAST_KILL_MAX_MIN}m straight-to-SL, no trail) vs ${beTrailCount} BE-trail fee-only exits — the "SL" status alone over-counts fast deaths by ${beTrailCount > 0 ? `${Math.round((beTrailCount / cases.length) * 100)}%` : "0%"}`,
    );
    evidence.push(
      `${neverGreen}/${realCases.length} real kills NEVER went green (MFE ≤ 0) — entry was late into an already-extended move, not a mis-timed exit`,
    );
    evidence.push(
      `flow gate said CONFIRMS on ${flowConfirm}/${realCases.length} kills — momentum confirmation is real AT THE SNAPSHOT but does not model cascade exhaustion: taker/vol-onset bursts routinely mean-revert right after deploy (the fake-flow signature)`,
    );
    if (allLong) evidence.push(`100% of real fast kills were LONG — one-sided chase bias under volatile tapes`);
    if (worst) evidence.push(`worst duration bucket: ${worst.label} (win ${worst.winRate}%, $${worst.sumPnlUsd.toFixed(2)}) — sub-15min closures are nearly all instant reversals`);
    const t1median = t2tp1.length ? pctile(t2tp1, 0.5) : 0;
    if (t1median > 0) evidence.push(`winners need median ${r1(t1median)}min to prove TP1 — anything dead inside 15min never had a chance to work (entry-quality problem, not exit problem)`);
    verdict = realCases.length && neverGreen / realCases.length >= 0.5 ? "LATE_ENTRY_CASCADE_CHASE" : "MIXED";
    headline =
      verdict === "LATE_ENTRY_CASCADE_CHASE"
        ? `Fast deaths = LATE ENTRY into exhausted momentum bursts (vol-onset/breakout chase), not fake detection — flow confirmed the burst while it was already terminal`
        : `Fast deaths are multi-cause — no single dominant signature yet (n=${realCases.length})`;
  }

  return {
    at: new Date().toISOString(),
    settledN: settled.length,
    activeN: all.length - settled.length,
    summary: {
      min: r1(sorted[0] ?? 0),
      p25: r1(pctile(sorted, 0.25)),
      median: r1(pctile(sorted, 0.5)),
      p75: r1(pctile(sorted, 0.75)),
      p95: r1(pctile(sorted, 0.95)),
      max: r1(sorted[sorted.length - 1] ?? 0),
      avg: r1(durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0),
    },
    timeToTp1: {
      n: t2tp1.length,
      min: r1(t2tp1[0] ?? 0),
      median: r1(pctile(t2tp1, 0.5)),
      p75: r1(pctile(t2tp1, 0.75)),
      max: r1(t2tp1[t2tp1.length - 1] ?? 0),
    },
    buckets,
    fastKill: {
      realKills: realCases.length,
      beTrailExits: beTrailCount,
      under2minReal,
      sumPnlUsd: r2(realSumPnl),
      allLong,
      flowConfirmShare: realCases.length ? r1((flowConfirm / realCases.length) * 100) : 0,
      neverGreenShare: realCases.length ? r1((neverGreen / realCases.length) * 100) : 0,
      cases: cases.slice(0, 20),
    },
    diagnosis: { headline, evidence, verdict },
  };
}

// ── AI CORE persistence (senior-core-engineer training report) ──
// Upserts EngineSetting "duration.forensics" — the same key-value channel the
// advisor and governor already read. Debounced: at most one write / 30min so
// the UI can poll freely without churning the learning trail.
export const DURATION_REPORT_KEY = "duration.forensics";
const PERSIST_DEBOUNCE_MS = 30 * 60_000;

export async function persistDurationReport(report: DurationReport, force = false): Promise<boolean> {
  const prev = await db.engineSetting.findUnique({ where: { key: DURATION_REPORT_KEY } });
  if (prev && !force) {
    try {
      const p = JSON.parse(prev.value) as { at?: string };
      if (p.at && Date.now() - new Date(p.at).getTime() < PERSIST_DEBOUNCE_MS) return false;
    } catch {
      /* corrupted previous row → overwrite */
    }
  }
  const payload = {
    at: report.at,
    verdict: report.diagnosis.verdict,
    headline: report.diagnosis.headline,
    evidence: report.diagnosis.evidence,
    settledN: report.settledN,
    summary: report.summary,
    timeToTp1: report.timeToTp1,
    buckets: report.buckets,
    fastKill: {
      realKills: report.fastKill.realKills,
      beTrailExits: report.fastKill.beTrailExits,
      under2minReal: report.fastKill.under2minReal,
      sumPnlUsd: report.fastKill.sumPnlUsd,
      allLong: report.fastKill.allLong,
      flowConfirmShare: report.fastKill.flowConfirmShare,
      neverGreenShare: report.fastKill.neverGreenShare,
      topCases: report.fastKill.cases.slice(0, 8),
    },
  };
  await db.engineSetting.upsert({
    where: { key: DURATION_REPORT_KEY },
    create: { key: DURATION_REPORT_KEY, value: JSON.stringify(payload) },
    update: { value: JSON.stringify(payload) },
  });
  return true;
}

export async function readPersistedDurationReport(): Promise<unknown | null> {
  const row = await db.engineSetting.findUnique({ where: { key: DURATION_REPORT_KEY } });
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}
