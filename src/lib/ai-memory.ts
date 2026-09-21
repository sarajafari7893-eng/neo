// ── FlowRadar Neo grounded AI memory (server-only) ──
// Builds a 100% measured object from the DB — the exact JSON injected into the
// analyst system prompt (anti-hallucination rules apply).

import { db } from "@/lib/db";
import { ACCOUNT_START_USD } from "./accounting";
import { getFeedStatus } from "./market-feed";
import { getFlowStatus } from "./flow";
import { getBacktest } from "./backtest";
import { getCalibration } from "./calibration";
import { readPersistedPumpPerformance, type PumpPerformance } from "./pump-performance";
import { rawCalStatus } from "./raw-cal";

export interface EngineMemory {
  account: {
    startUsd: number;
    equity: number;
    realizedNetUsd: number;
    feesPaidUsd: number;
    openPositions: number;
  };
  realized: {
    resolved: number;
    wins: number;
    losses: number;
    expired: number;
    winRate: number;
    netPnlUsd: number;
    sampleCaveat: string;
  };
  perStrategy: Array<{ strategy: string; n: number; wins: number; netPnlUsd: number }>;
  perSymbol: Array<{ symbol: string; n: number; wins: number; netPnlUsd: number }>;
  lastResolved: Array<{ serial: number; symbol: string; direction: string; strategy: string; status: string; netPnlPercent: number; heldMinutes: number; feesUsd: number }>;
  open: Array<{ serial: number; symbol: string; direction: string; strategy: string; confidence: number; entryPrice: number }>;
  feed: { source: string; host: string | null; latencyMs: number | null; flowCovered: number };
  backtest: { ranAt: string; n: number; winRate: number; wilsonLB: number; avgNetPct: number; verdict: string } | null;
  calibration: { status: string; settled: number; target: number; movingFactors: number; rows: Array<{ factor: string; weight: number; n: number; winRate: number; avgPct?: number; pnlUsd?: number; expectancy?: number; netPct?: number; profitFactor?: number }> };
  // v9.1 — central-intelligence extensions (operator mandate 2026-09-13):
  pumpRadar?: {
    headline: string;
    totals: PumpPerformance["totals"];
    perKind: PumpPerformance["perKind"];
    window24h: PumpPerformance["window24h"];
    authority: string;
    note: string;
  };
  rawCal?: {
    armed: boolean;
    issuedTotal: number;
    settledRaw: number;
    winsRaw: number;
    rawWinRatePct: number | null;
    settledN: number;
    target: number;
    paceLine?: string | null;
    qualityLine?: string | null;
    r6Gate?: string | null;
    note: string;
  };
  dataBasis: string;
}

export async function buildEngineMemory(symbol?: string): Promise<EngineMemory> {
  const [allSignals, backtest, cal] = await Promise.all([
    db.signal.findMany({ orderBy: { createdAt: "desc" }, take: 400 }),
    getBacktest(),
    getCalibration(),
  ]);

  const settled = allSignals.filter((s) => ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"].includes(s.status));
  const open = allSignals.filter((s) => ["ACTIVE", "TP1", "TP2"].includes(s.status));
  // v5.4 TP-proven accounting: a TP1/TP2/TP3 touch is a win, even if the trade
  // later stopped out at breakeven or expired — matches the analytics section.
  const isTpWin = (s: { reachedTp: number; status: string; pnlPercent: number }): boolean => s.reachedTp >= 1 || ["TP1", "TP2", "TP3"].includes(s.status) || (s.pnlPercent > 0 && !["SL"].includes(s.status));
  const wins = settled.filter(isTpWin).length;
  const netPnl = settled.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const feesPaid = settled.reduce((a, s) => a + s.feeUsd + s.swapUsd, 0);
  const unrealized = open.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);

  const stratAcc = new Map<string, { n: number; wins: number; net: number }>();
  const symAcc = new Map<string, { n: number; wins: number; net: number }>();
  for (const s of settled) {
    const st = stratAcc.get(s.strategy) ?? { n: 0, wins: 0, net: 0 };
    st.n++;
    if (isTpWin(s)) st.wins++;
    st.net += (s.marginUsd * s.pnlPercent) / 100;
    stratAcc.set(s.strategy, st);
    const sy = symAcc.get(s.symbol) ?? { n: 0, wins: 0, net: 0 };
    sy.n++;
    if (isTpWin(s)) sy.wins++;
    sy.net += (s.marginUsd * s.pnlPercent) / 100;
    symAcc.set(s.symbol, sy);
  }

  const feed = getFeedStatus();
  const flow = getFlowStatus();

  // v9.1 central-intelligence extensions — radar performance journal + RAW-CAL
  // capture status (operator mandate 2026-09-13). Best-effort: these read the
  // same DB; any failure degrades to undefined, never breaks the memory build.
  let pumpRadar: EngineMemory["pumpRadar"];
  let rawCal: EngineMemory["rawCal"];
  try {
    const [perf, rc] = await Promise.all([readPersistedPumpPerformance(), rawCalStatus()]);
    if (perf) {
      pumpRadar = {
        headline: perf.headline,
        totals: perf.totals,
        perKind: perf.perKind,
        window24h: perf.window24h,
        authority: perf.totals.spawnedSignals > 0 ? "radar-spawned signals live" : "no radar signal yet",
        note: "PUMP/DUMP RADAR performance journal — read via EngineSetting pump.performance; success criteria are fixed at declaration (honest detector)",
      };
    }
    rawCal = {
      armed: rc.armed,
      issuedTotal: rc.issuedTotal,
      settledRaw: rc.settledRaw,
      winsRaw: rc.winsRaw,
      rawWinRatePct: rc.rawWinRatePct,
      settledN: rc.settledN,
      target: rc.target,
      paceLine: null,
      note: rc.armed
        ? `RAW-CAL capture mode ARMED — unfiltered records issue into this book (anti-flood: ≥${rc.spacingMin}min spacing, ≤${rc.maxOpen} open); auto-cancels at ${rc.target} settled, then the new calibration takes command`
        : `RAW-CAL capture mode OFF — filtered operation under central-intelligence command`,
    };
    // v9.2 pace digest — the central intelligence reads the RHYTHM, not just the count
    const { computeRawcalPace } = await import("./rawcal-telemetry");
    const pace = await computeRawcalPace().catch(() => null);
    if (pace) {
      rawCal.paceLine =
        `PACE: issue ${pace.issueRate3hPerH}/h (3h) · since arm ${pace.issueRateSinceArmPerH}/h · settle ${pace.settleRate3hPerH}/h (3h) · obs spacing ${pace.observedSpacingMin.mean ?? "—"}min · cadence ${pace.cadenceGrade}` +
        (pace.etaHours !== null ? ` · ETA to ${pace.target} ≈ ${pace.etaHours}h` : " · ETA unknown (no settle signal yet)") +
        (pace.etaSteadyHours !== null ? ` · steady-state ETA ≈ ${pace.etaSteadyHours}h @ ${pace.steadyRatePerH ?? "—"}/h` : "") +
        (pace.stalls.issueStallMin || pace.stalls.settleStallMin ? ` · STALL watch: issue ${pace.stalls.issueStallMin ?? "—"}m / settle ${pace.stalls.settleStallMin ?? "—"}m` : " · no stalls");
    }
    // v9.3 sample-quality digest — the central intelligence reads whether the
    // raw cohort is HEALTHY enough for the R6 calibration to rest on
    const { computeRawcalQuality, r6GateLine } = await import("./rawcal-quality");
    const q = await computeRawcalQuality().catch(() => null);
    if (q) {
      rawCal.qualityLine = r6GateLine(q);
      rawCal.r6Gate = `GATE ${q.gate.verdict} · healthy ${q.healthy}/${q.settledRaw} · review ${q.review} · censored ${q.censored}${q.warnings.length ? ` · ${q.warnings.length} warning(s)` : ""}`;
    }
  } catch {
    /* extensions are optional — memory stays grounded without them */
  }

  const focus = symbol ? allSignals.filter((s) => s.symbol === symbol) : [];
  const settledPool = focus.length ? focus : allSignals;

  const lastResolved = settledPool
    .filter((s) => ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"].includes(s.status))
    .slice(0, 8)
    .map((s) => ({
      serial: s.serial,
      symbol: s.symbol,
      direction: s.direction,
      strategy: s.strategy,
      status: s.status,
      netPnlPercent: Number(s.pnlPercent.toFixed(2)),
      heldMinutes: s.closedAt && s.createdAt ? Math.round((s.closedAt.getTime() - s.createdAt.getTime()) / 60_000) : 0,
      feesUsd: Number((s.feeUsd + s.swapUsd).toFixed(3)),
    }));

  return {
    account: {
      startUsd: ACCOUNT_START_USD,
      equity: Number((ACCOUNT_START_USD + netPnl + unrealized).toFixed(2)),
      realizedNetUsd: Number(netPnl.toFixed(3)),
      feesPaidUsd: Number(feesPaid.toFixed(3)),
      openPositions: open.length,
    },
    realized: {
      resolved: settled.length,
      wins,
      losses: settled.length - wins,
      expired: settled.filter((s) => s.status === "EXPIRED").length,
      winRate: settled.length ? Number(((wins / settled.length) * 100).toFixed(1)) : 0,
      netPnlUsd: Number(netPnl.toFixed(3)),
      sampleCaveat: settled.length < 20 ? `LOW-CONFIDENCE — only ${settled.length} resolved live signals; conclusions are not statistically meaningful until n>=20` : "sample adequate",
    },
    perStrategy: [...stratAcc.entries()].map(([strategy, v]) => ({ strategy, n: v.n, wins: v.wins, netPnlUsd: Number(v.net.toFixed(3)) })).sort((a, b) => b.n - a.n).slice(0, 8),
    perSymbol: [...symAcc.entries()].map(([symbol, v]) => ({ symbol, n: v.n, wins: v.wins, netPnlUsd: Number(v.net.toFixed(3)) })).sort((a, b) => b.n - a.n).slice(0, 8),
    lastResolved,
    open: open.slice(0, 8).map((s) => ({ serial: s.serial, symbol: s.symbol, direction: s.direction, strategy: s.strategy, confidence: s.confidence, entryPrice: s.entryPrice })),
    feed: { source: feed.source, host: feed.host, latencyMs: feed.latencyMs, flowCovered: flow.covered },
    backtest: backtest ? { ranAt: backtest.ranAt, n: backtest.n, winRate: backtest.winRate, wilsonLB: backtest.wilsonLB, avgNetPct: backtest.avgNetPct, verdict: backtest.verdict } : null,
    calibration: { status: cal.status, settled: cal.settled, target: cal.target, movingFactors: cal.rows.length, rows: cal.rows },
    pumpRadar,
    rawCal,
    dataBasis: "LIVE-ONLY — every figure measured from this terminal's own DB and live Binance/multi-exchange feeds. Zero seeded or simulated rows.",
  };
}

export function memoryPromptBlock(m: EngineMemory): string {
  return [
    "VERIFIED ENGINE MEMORY (ground truth — cite ONLY these numbers):",
    JSON.stringify(m),
    "ANTI-HALLUCINATION RULES:",
    "1. Every number you output must come from this memory JSON or the user's message.",
    "2. If a figure is missing, literally say 'data not available yet'.",
    `3. Respect the sample caveat: ${m.realized.sampleCaveat}`,
    m.dataBasis,
  ].join("\n");
}
