// ── FlowRadar Neo stats builder (server-only) ──
import { db } from "@/lib/db";
import type { PlatformStats, SignalDTO, AfterlifeStats, LifecycleStats, FlowDTO, TpFunnel, PnlLedger, PnlLedgerRow, PnlLedgerTotals } from "@/lib/api-types";
import type { Signal } from "@prisma/client";
import { ACCOUNT_START_USD, feeBreakdown } from "@/lib/accounting";
import { getTtlTelemetry } from "@/lib/ttl-gate";

const WIN_STATUSES = new Set(["TP1", "TP2", "TP3"]);
const LOSS_STATUSES = new Set(["SL"]);

/**
 * v5.4 TP-PROVEN WIN ACCOUNTING (operator request):
 * a signal counts as a WIN the moment it touches TP1/TP2/TP3 — even if it is
 * still running, stops out at breakeven afterwards, or expires later. The
 * `reachedTp` ledger column survives every terminal status, so the win-rate
 * process now measures the full TP ladder instead of only final outcomes.
 */
const isTpWin = (s: Signal): boolean => s.reachedTp >= 1 || WIN_STATUSES.has(s.status);
/** settled = closed OR TP-proven (an open signal that already banked TP1 belongs in the rate). */
const isSettledOrProven = (s: Signal): boolean => !!s.closedAt || s.reachedTp >= 1;

export function pnlUsd(s: Signal): number {
  return (s.marginUsd * s.pnlPercent) / 100;
}

// ── v6.2 NET EST PNL LEDGER helpers ──────────────────────────────
// Bucket semantics (honest, by final status):
//   EXPIRED → auto-closed at TTL mark (NET incl. fees) · TP → TP1/TP2/TP3 ladder exits
//   STOP → SL (effective/trailed stop) · OTHER → CLOSED (delisted-orphan force-close)
// NET EST PNL per signal = marginUsd × pnlPercent / 100 — the engine stores pnlPercent
// already fee-aware NET (taker ×2 + pro-rated funding), matching account.balance semantics.
// v6.2 (operator mandate: «فرمول EST PNL % باید بر اساس نتیجه واقعی سیگنالها
// محاسبه شود»): EST PNL % = Σ of each signal's ACTUAL engine-recorded result
// (fee-NET, levered pnlPercent). The old idealized norm (TP +50% / STOP −30%)
// is GONE — the % ledger is now reality-based: a TP that closed at +34% counts
// +34, an SL contained at −58% counts −58, an expiry at the mark counts its
// realized mark %. avgPct = per-trade expectancy (Σ% / trades).
// Buckets are ASIA/TEHRAN local days/weeks/months (+03:30, no DST since 2022)
// per the architecture review — the operator's daily boundary, not UTC's.
type LedgerBucket = "expired" | "tp" | "stop" | "other";

/** Asia/Tehran fixed offset (UTC+03:30 — Iran abolished DST in 2022). */
const TZ_OFFSET_MIN = 210;
/** Shift a timestamp into Tehran-local wall time (then read UTC parts). */
function tzLocal(d: Date): Date {
  return new Date(d.getTime() + TZ_OFFSET_MIN * 60_000);
}

function ledgerBucketOf(status: string): LedgerBucket {
  if (status === "EXPIRED") return "expired";
  if (status === "SL") return "stop";
  if (status === "CLOSED") return "other";
  return "tp"; // TP1 | TP2 | TP3
}

function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // shift to this week's Thursday (ISO)
  const isoYear = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

interface LedgerAccum {
  expiredUsd: number; tpUsd: number; stopUsd: number; otherUsd: number;
  expiredN: number; tpN: number; stopN: number; otherN: number;
  estPct: number;
}

function emptyAccum(): LedgerAccum {
  return { expiredUsd: 0, tpUsd: 0, stopUsd: 0, otherUsd: 0, expiredN: 0, tpN: 0, stopN: 0, otherN: 0, estPct: 0 };
}

function accumulate(acc: LedgerAccum, s: Signal): void {
  const usd = pnlUsd(s);
  const b = ledgerBucketOf(s.status);
  acc[`${b}Usd` as keyof LedgerAccum] += usd;
  acc[`${b}N` as keyof LedgerAccum] += 1;
  acc.estPct += s.pnlPercent ?? 0; // v6.2: the ACTUAL result — no idealized norms
}

function toRow(key: string, label: string, acc: LedgerAccum): PnlLedgerRow {
  const trades = acc.expiredN + acc.tpN + acc.stopN + acc.otherN;
  return {
    key,
    label,
    expiredUsd: Number(acc.expiredUsd.toFixed(2)),
    tpUsd: Number(acc.tpUsd.toFixed(2)),
    stopUsd: Number(acc.stopUsd.toFixed(2)),
    otherUsd: Number(acc.otherUsd.toFixed(2)),
    netUsd: Number((acc.expiredUsd + acc.tpUsd + acc.stopUsd + acc.otherUsd).toFixed(2)),
    expiredN: acc.expiredN,
    tpN: acc.tpN,
    stopN: acc.stopN,
    otherN: acc.otherN,
    estPnlPct: Number(acc.estPct.toFixed(1)),
    avgPct: trades ? Number((acc.estPct / trades).toFixed(1)) : 0,
  };
}

function buildLedger(closedAll: Signal[]): PnlLedger {
  const now = Date.now();
  // v6.2: keys are ASIA/TEHRAN local calendar units (UTC+03:30 fixed) — the
  // daily boundary matches the operator's wall clock, per the architecture review.
  const windows: Array<{ range: "daily" | "weekly" | "monthly"; since: number | null; keyFn: (d: Date) => string; labelFn: (key: string) => string; cap: number }> = [
    { range: "daily", since: now - 30 * 86_400_000, keyFn: (d) => tzLocal(d).toISOString().slice(0, 10), labelFn: (k) => k.slice(5), cap: 30 },
    { range: "weekly", since: now - 84 * 86_400_000, keyFn: (d) => isoWeekKey(tzLocal(d)), labelFn: (k) => k.slice(5), cap: 12 },
    { range: "monthly", since: null, keyFn: (d) => tzLocal(d).toISOString().slice(0, 7), labelFn: (k) => k, cap: 12 },
  ];

  const totalsAcc = emptyAccum();
  let ttlExtended = 0;

  const out: PnlLedger = {
    daily: [],
    weekly: [],
    monthly: [],
    totals: { expiredUsd: 0, tpUsd: 0, stopUsd: 0, otherUsd: 0, netUsd: 0, expiredN: 0, tpN: 0, stopN: 0, otherN: 0, estPnlPct: 0, avgPct: 0, ttlExtended: 0, extCapturedUsd: 0 },
  };

  for (const s of closedAll) {
    accumulate(totalsAcc, s);
    if (s.ttlExtensions > 0) ttlExtended++;
  }

  const totals: PnlLedgerTotals = {
    expiredUsd: Number(totalsAcc.expiredUsd.toFixed(2)),
    tpUsd: Number(totalsAcc.tpUsd.toFixed(2)),
    stopUsd: Number(totalsAcc.stopUsd.toFixed(2)),
    otherUsd: Number(totalsAcc.otherUsd.toFixed(2)),
    netUsd: Number((totalsAcc.expiredUsd + totalsAcc.tpUsd + totalsAcc.stopUsd + totalsAcc.otherUsd).toFixed(2)),
    expiredN: totalsAcc.expiredN,
    tpN: totalsAcc.tpN,
    stopN: totalsAcc.stopN,
    otherN: totalsAcc.otherN,
    estPnlPct: Number(totalsAcc.estPct.toFixed(1)),
    avgPct: closedAll.length ? Number((totalsAcc.estPct / closedAll.length).toFixed(1)) : 0,
    ttlExtended,
    extCapturedUsd: 0,
  };

  for (const w of windows) {
    const maps = new Map<string, LedgerAccum>();
    for (const s of closedAll) {
      const t = s.closedAt ? new Date(s.closedAt) : null;
      if (!t) continue;
      if (w.since !== null && t.getTime() < w.since) continue;
      const key = w.keyFn(t);
      const acc = maps.get(key) ?? emptyAccum();
      accumulate(acc, s);
      maps.set(key, acc);
    }
    out[w.range] = [...maps.keys()]
      .sort()
      .slice(-w.cap)
      .map((k) => toRow(k, w.labelFn(k), maps.get(k)!));
  }

  out.totals = totals;
  return out;
}

export async function buildStats(): Promise<PlatformStats> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
  // v10.18 CLEAN-LEDGER DOCTRINE (operator option A, 2026-09-24) — headline
  // analytics exclude qualityFlag rows (DEGEN_STOP / INVERTED_STOP /
  // RESTORE_CATCHUP — reserved classes for genuine ledger-integrity events).
  // Forensic note: the v10.18 audit found ZERO historical rows qualifying
  // (the 200 entry==SL rows are legit BE-trail exits; the +pnl "SL" rows are
  // legit TP1-trails) — the filter is a permanent anti-poisoning rail. The
  // paper ACCOUNT keeps full history (balance continuity); ANALYTICS stay
  // clean and the dataQuality counters surface what was excluded.
  const signals = await db.signal.findMany({
    where: { createdAt: { gte: weekAgo }, qualityFlag: null },
    orderBy: { createdAt: "asc" },
  });

  const closed = signals.filter((s) => s.closedAt);
  const settledOrProven = signals.filter(isSettledOrProven);
  const wins = settledOrProven.filter(isTpWin);
  const losses = closed.filter((s) => LOSS_STATUSES.has(s.status) && !isTpWin(s));
  const expired = closed.filter((s) => s.status === "EXPIRED");
  const active = signals.filter((s) => !s.closedAt);

  const totalPnlUsd = closed.reduce((acc, s) => acc + pnlUsd(s), 0);
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const pnl24hUsd = closed.filter((s) => s.closedAt && s.closedAt >= dayAgo).reduce((acc, s) => acc + pnlUsd(s), 0);

  const sortedByPnl = [...closed].sort((a, b) => pnlUsd(b) - pnlUsd(a));
  const best = sortedByPnl[0];
  const worst = sortedByPnl[sortedByPnl.length - 1];

  // streak (scan closed newest → oldest)
  const closedDesc = [...closed].sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
  let streak = { type: "win" as "win" | "loss", count: 0 };
  if (closedDesc.length) {
    const firstWin = isTpWin(closedDesc[0]);
    streak.type = firstWin ? "win" : "loss";
    for (const s of closedDesc) {
      const isW = isTpWin(s);
      const isL = LOSS_STATUSES.has(s.status) && !isTpWin(s);
      if (streak.type === "win" && isW) streak.count++;
      else if (streak.type === "loss" && isL) streak.count++;
      else break;
    }
  }

  // equity curve by day
  const byDay = new Map<string, number>();
  for (const s of closed) {
    if (!s.closedAt) continue;
    const key = s.closedAt.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + pnlUsd(s));
  }
  const days = [...byDay.keys()].sort();
  let cum = 0;
  const equityCurve = days.map((d) => {
    const daily = byDay.get(d) ?? 0;
    cum += daily;
    return { date: d.slice(5), cum: Number(cum.toFixed(2)), daily: Number(daily.toFixed(2)) };
  });

  // by symbol — TP-proven accounting (settled-or-proven in the denominator)
  const symMap = new Map<string, { count: number; wins: number; pnl: number }>();
  for (const s of settledOrProven) {
    const e = symMap.get(s.symbol) ?? { count: 0, wins: 0, pnl: 0 };
    e.count++;
    if (isTpWin(s)) e.wins++;
    e.pnl += pnlUsd(s);
    symMap.set(s.symbol, e);
  }
  const bySymbol = [...symMap.entries()]
    .map(([symbol, e]) => ({ symbol, ...e, pnl: Number(e.pnl.toFixed(2)) }))
    .sort((a, b) => b.pnl - a.pnl);

  // direction
  const byDirection = {
    long: signals.filter((s) => s.direction === "LONG").length,
    short: signals.filter((s) => s.direction === "SHORT").length,
  };

  // timeframe — TP-proven accounting
  const tfMap = new Map<string, { count: number; wins: number; pnl: number }>();
  for (const s of settledOrProven) {
    const e = tfMap.get(s.timeframe) ?? { count: 0, wins: 0, pnl: 0 };
    e.count++;
    if (isTpWin(s)) e.wins++;
    e.pnl += pnlUsd(s);
    tfMap.set(s.timeframe, e);
  }
  const tfOrder = ["5m", "15m", "1h", "4h"];
  const byTimeframe = tfOrder
    .filter((tf) => tfMap.has(tf))
    .map((tf) => {
      const e = tfMap.get(tf)!;
      return { timeframe: tf, ...e, pnl: Number(e.pnl.toFixed(2)) };
    });

  // strategy — TP-proven accounting
  const stMap = new Map<string, { count: number; wins: number; pnl: number; conf: number }>();
  for (const s of settledOrProven) {
    const e = stMap.get(s.strategy) ?? { count: 0, wins: 0, pnl: 0, conf: 0 };
    e.count++;
    if (isTpWin(s)) e.wins++;
    e.pnl += pnlUsd(s);
    e.conf += s.confidence;
    stMap.set(s.strategy, e);
  }
  const byStrategy = [...stMap.entries()].map(([strategy, e]) => ({
    strategy,
    count: e.count,
    wins: e.wins,
    pnl: Number(e.pnl.toFixed(2)),
    avgConfidence: Math.round(e.conf / Math.max(1, e.count)),
  }));

  // confidence buckets
  const buckets = [
    { bucket: "60-70", min: 60, max: 70 },
    { bucket: "70-80", min: 70, max: 80 },
    { bucket: "80-90", min: 80, max: 90 },
    { bucket: "90+", min: 90, max: 101 },
  ];
  const confidenceBuckets = buckets.map((b) => {
    const inB = settledOrProven.filter((s) => s.confidence >= b.min && s.confidence < b.max);
    const w = inB.filter(isTpWin).length;
    return {
      bucket: b.bucket,
      count: inB.length,
      wins: w,
      winRate: inB.length ? Math.round((w / inB.length) * 100) : 0,
    };
  });

  // ── v5.4 TP FUNNEL — ladder depth analytics (TP1 → TP2 → full TP3 vs SL/EXPIRED) ──
  const tp3Closed = closed.filter((s) => s.status === "TP3");
  const tp1Hits = signals.filter((s) => s.reachedTp >= 1).length;
  const tp2Hits = signals.filter((s) => s.reachedTp >= 2).length;
  const tpFunnel: TpFunnel = {
    settledOrProven: settledOrProven.length,
    tp1Hits,
    tp2Hits,
    tp3FullWins: tp3Closed.length,
    slLosses: closed.filter((s) => s.status === "SL").length,
    expired: expired.length,
    tp1Rate: settledOrProven.length ? Number(((tp1Hits / settledOrProven.length) * 100).toFixed(1)) : 0,
    tp2Rate: settledOrProven.length ? Number(((tp2Hits / settledOrProven.length) * 100).toFixed(1)) : 0,
    fullTpRate: closed.length ? Number(((tp3Closed.length / closed.length) * 100).toFixed(1)) : 0,
    avgRrFullWins: tp3Closed.length ? Number((tp3Closed.reduce((a, s) => a + s.riskReward, 0) / tp3Closed.length).toFixed(2)) : 0,
    avgConfFullWins: tp3Closed.length ? Math.round(tp3Closed.reduce((a, s) => a + s.confidence, 0) / tp3Closed.length) : 0,
    avgHoldTp3Min: tp3Closed.length ? Math.round(tp3Closed.reduce((a, s) => a + (s.closedAt && s.createdAt ? (s.closedAt.getTime() - s.createdAt.getTime()) / 60_000 : 0), 0) / tp3Closed.length) : 0,
  };

  // 2026-09-17 operator audit fix: equityCurve.cum is cumulative PnL (relative
  // to the $100 start), so the raw reduce returned 0 whenever the account was
  // net-negative → STREAK card showed "peak equity $0.00". Peak ACCOUNT equity
  // = start balance + best cumulative PnL on the curve (start itself = 0 cum,
  // so a never-in-profit account peaks at exactly the start balance).
  const peakEquity =
    ACCOUNT_START_USD + equityCurve.reduce((m, p) => Math.max(m, p.cum), 0);

  // ── Paper account ($100 start, NET accounting, fee-aware) ──
  const START_BALANCE = ACCOUNT_START_USD;
  const [openSignals, assets, ttlTel] = await Promise.all([
    db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } } }),
    db.marketAsset.findMany({ select: { symbol: true, price: true } }),
    getTtlTelemetry(),
  ]);
  const allTimeClosed = await db.signal.findMany({
    where: { closedAt: { not: null } },
    select: { marginUsd: true, pnlPercent: true, feeUsd: true, swapUsd: true, entryPrice: true, direction: true, leverage: true, createdAt: true, closedAt: true, status: true, stopLoss: true, reachedTp: true, ttlExtensions: true },
  });
  const realizedAllTime = allTimeClosed.reduce((acc, s) => acc + (s.marginUsd * s.pnlPercent) / 100, 0);
  const feesPaidAllTime = allTimeClosed.reduce((acc, s) => acc + s.feeUsd + s.swapUsd, 0);
  const priceMap = new Map(assets.map((a) => [a.symbol, a.price]));

  let unrealized = 0;
  let exposureUsd = 0;
  for (const s of openSignals) {
    const price = priceMap.get(s.symbol);
    if (!price) continue;
    const move = ((price - s.entryPrice) / s.entryPrice) * (s.direction === "LONG" ? 1 : -1) * 100; // UNLEVERED move %
    const heldMin = Math.max(0, (Date.now() - s.createdAt.getTime()) / 60_000);
    const fb = feeBreakdown(s.marginUsd, s.leverage, move, heldMin); // unrealized NET (accrued funding)
    unrealized += fb.netUsd;
    exposureUsd += s.marginUsd;
  }

  const balance = Number((START_BALANCE + realizedAllTime).toFixed(2));
  const equity = Number((balance + unrealized).toFixed(2));
  const account = {
    startBalance: START_BALANCE,
    balance,
    equity,
    unrealizedPnl: Number(unrealized.toFixed(2)),
    exposureUsd: Number(exposureUsd.toFixed(2)),
    freeMargin: Number((equity - exposureUsd).toFixed(2)),
    marginUsedPct: equity > 0 ? Number(((exposureUsd / equity) * 100).toFixed(1)) : 0,
    openPositions: openSignals.length,
    feesPaid: Number(feesPaidAllTime.toFixed(3)),
  };

  // ── EXPIRED afterlife stats (Bug 5 — شفافیت چرخه عمر) ──
  const expiredAll = await db.signal.findMany({ where: { status: "EXPIRED" }, select: { afterlife: true, maxPostPnlPercent: true } });
  const afterlife: AfterlifeStats = {
    tracking: expiredAll.filter((s) => s.afterlife === "TRACKING").length,
    tp1: expiredAll.filter((s) => s.afterlife === "TP1_HIT").length,
    tp2: expiredAll.filter((s) => s.afterlife === "TP2_HIT").length,
    tp3: expiredAll.filter((s) => s.afterlife === "TP3_HIT").length,
    sl: expiredAll.filter((s) => s.afterlife === "SL_HIT").length,
    flat: expiredAll.filter((s) => s.afterlife === "FLAT").length,
    avgPostMfe: expiredAll.length ? Number((expiredAll.reduce((a, s) => a + s.maxPostPnlPercent, 0) / expiredAll.length).toFixed(2)) : 0,
    wouldHaveWonPct: expiredAll.length ? Number(((expiredAll.filter((s) => ["TP1_HIT", "TP2_HIT", "TP3_HIT"].includes(s.afterlife ?? "")).length / expiredAll.length) * 100).toFixed(0)) : 0,
  };

  // ── v9.0 LIFECYCLE AUDIT (operator request 2026-09-12) ──
  // Lifetime counters for the Session Stats rows the 120-event terminal window
  // used to erase: BE_TRAIL / TTL_EXTENDED are counted from SignalEvent, the
  // AFTERLIFE row now carries tracking + RESOLVED outcomes, and the BE-trail
  // arm efficacy is measured end-to-end (rescued vs fee-only vs stopped).
  // 30s memo keeps the extra queries off the hot 5s pulse path.
  const lifecycle = await buildLifecycleStats();

  // ── v6.1 NET EST PNL LEDGER — all-time bucketed EXPIRED/TP/STOP realized NET usd
  const pnlLedger = buildLedger(allTimeClosed as Signal[]);
  pnlLedger.totals.extCapturedUsd = Number(ttlTel.capturedUsd.toFixed(2));
  // EPOCH-2 hardening (operator bug report «Session Stats داده های اشتباهی دارد»):
  // ttlTelemetry is a MONOTONIC global counter that can outlive signal resets —
  // with the ledger empty it previously injected phantom TTL_EXT grants (58 vs 00
  // created). The per-signal ledger is the display truth; telemetry may only RAISE
  // the count when the ledger itself already shows extension activity.
  if (ttlTel.extended > pnlLedger.totals.ttlExtended && pnlLedger.totals.ttlExtended > 0) {
    pnlLedger.totals.ttlExtended = ttlTel.extended;
  }

  // ── v10.18 DATA-QUALITY TRANSPARENCY — what the clean ledger excludes ──
  const flagGroups = await db.signal.groupBy({ by: ["qualityFlag"], where: { qualityFlag: { not: null } }, _count: { _all: true } });
  const flagCount = (f: string) => flagGroups.find((g) => g.qualityFlag === f)?._count._all ?? 0;
  const dataQuality = {
    excludedTotal: flagGroups.reduce((a, g) => a + g._count._all, 0),
    degenStop: flagCount("DEGEN_STOP"),
    invertedStop: flagCount("INVERTED_STOP"),
    restoreCatchup: flagCount("RESTORE_CATCHUP"),
  };

  return {
    totalSignals: signals.length,
    activeCount: active.length,
    wins: wins.length,
    losses: losses.length,
    expired: expired.length,
    winRate: settledOrProven.length ? Math.round((wins.length / settledOrProven.length) * 100) : 0,
    totalPnlUsd: Number(totalPnlUsd.toFixed(2)),
    pnl24hUsd: Number(pnl24hUsd.toFixed(2)),
    avgPnlPercent: closed.length ? Number((closed.reduce((a, s) => a + s.pnlPercent, 0) / closed.length).toFixed(2)) : 0,
    bestTrade: best ? { symbol: best.symbol, pnlPercent: best.pnlPercent, pnlUsd: Number(pnlUsd(best).toFixed(2)) } : null,
    worstTrade: worst ? { symbol: worst.symbol, pnlPercent: worst.pnlPercent, pnlUsd: Number(pnlUsd(worst).toFixed(2)) } : null,
    streak,
    avgRiskReward: signals.length ? Number((signals.reduce((a, s) => a + s.riskReward, 0) / signals.length).toFixed(2)) : 0,
    avgConfidence: signals.length ? Math.round(signals.reduce((a, s) => a + s.confidence, 0) / signals.length) : 0,
    totalVolumeUsd: signals.reduce((a, s) => a + s.marginUsd, 0),
    equityCurve,
    bySymbol,
    byDirection,
    byTimeframe,
    byStrategy,
    confidenceBuckets,
    peakEquity: Number(peakEquity.toFixed(2)),
    account,
    afterlife,
    dataQuality,
    lifecycle,
    tpFunnel,
    pnlLedger,
  };
}

// ── v9.0 LIFECYCLE AUDIT builder (30s memo — pulse-safe) ──────────────
let lcMemo: { at: number; v: LifecycleStats } | null = null;
const LC_MEMO_MS = 30_000;

async function buildLifecycleStats(): Promise<LifecycleStats> {
  if (lcMemo && Date.now() - lcMemo.at < LC_MEMO_MS) return lcMemo.v;
  try {
    const [beTrail, beTrailGroups, ttlExtEvents, extAgg, extSigGroups, lifetimeSignals, tp1Hits, tp2Hits, tp3ClosedN, tp3AfterlifeN, slN, expiredN] = await Promise.all([
      db.signalEvent.count({ where: { type: "BE_TRAIL" } }),
      db.signalEvent.groupBy({ by: ["signalId"], where: { type: "BE_TRAIL" } }),
      db.signalEvent.count({ where: { type: "TTL_EXTENDED" } }),
      db.signal.aggregate({ _sum: { ttlExtensions: true } }),
      db.signal.groupBy({ by: ["id"], where: { ttlExtensions: { gt: 0 } } }),
      // v10.3 TRUE-LIFETIME session stats — straight DB aggregates over ALL rows
      db.signal.count(),
      db.signal.count({ where: { reachedTp: { gte: 1 } } }),
      db.signal.count({ where: { reachedTp: { gte: 2 } } }),
      db.signal.count({ where: { status: "TP3" } }),
      db.signal.count({ where: { afterlife: "TP3_HIT" } }),
      db.signal.count({ where: { status: "SL" } }),
      db.signal.count({ where: { status: "EXPIRED" } }),
    ]);
    const beSignalIds = beTrailGroups.map((g) => g.signalId).filter((x): x is string => !!x);
    const beSigs = beSignalIds.length
      ? await db.signal.findMany({ where: { id: { in: beSignalIds } }, select: { status: true, reachedTp: true, pnlPercent: true, closedAt: true } })
      : [];
    const rescued = beSigs.filter((s) => s.reachedTp >= 1 || (s.closedAt && s.pnlPercent > 0)).length;
    const feeOnly = beSigs.filter((s) => s.closedAt && s.reachedTp === 0 && s.pnlPercent <= 0 && s.pnlPercent > -1).length;
    const stopped = beSigs.filter((s) => s.closedAt && s.reachedTp === 0 && s.pnlPercent <= -1).length;
    const extIds = extSigGroups.map((g) => g.id);
    // NET usd captured by extended signals = Σ(margin × pnlPercent/100) over the
    // TP-proven subset — one small findMany keeps the math exact, not approximated.
    const extWinners = extIds.length
      ? await db.signal.findMany({ where: { id: { in: extIds }, reachedTp: { gte: 1 } }, select: { marginUsd: true, pnlPercent: true } })
      : [];
    const ttlCapturedUsd = extWinners.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
    const tracking = await db.signal.count({ where: { status: "EXPIRED", afterlife: "TRACKING" } });
    const resolved = await db.signal.count({ where: { status: "EXPIRED", afterlife: { in: ["TP1_HIT", "TP2_HIT", "TP3_HIT", "SL_HIT", "FLAT"] } } });
    const v: LifecycleStats = {
      beTrail,
      beTrailSignals: beSignalIds.length,
      beTrailRescued: rescued,
      beTrailFeeOnly: feeOnly,
      beTrailStopped: stopped,
      ttlExtendedEvents: ttlExtEvents,
      ttlExtendedGrants: extAgg._sum.ttlExtensions ?? 0,
      ttlSignalsWithExt: extIds.length,
      ttlCapturedUsd: Number(ttlCapturedUsd.toFixed(2)),
      afterlifeResolved: resolved,
      afterlifeTracking: tracking,
      afterlifeTotal: resolved + tracking,
      learningWired: true, // wired into the 6h AUTO-LEARNER cycle (lifecycle-learning.ts)
      lifetimeSignals,
      tp1HitsLifetime: tp1Hits,
      tp2HitsLifetime: tp2Hits,
      tp3HitsLifetime: tp3ClosedN + tp3AfterlifeN, // closed TP3 + post-expiry TP3 hits
      slLifetime: slN,
      expiredLifetime: expiredN,
    };
    lcMemo = { at: Date.now(), v };
    return v;
  } catch {
    // honest zero-state on transient DB hiccups — the panel must not NaN
    return {
      beTrail: 0, beTrailSignals: 0, beTrailRescued: 0, beTrailFeeOnly: 0, beTrailStopped: 0,
      ttlExtendedEvents: 0, ttlExtendedGrants: 0, ttlSignalsWithExt: 0, ttlCapturedUsd: 0,
      afterlifeResolved: 0, afterlifeTracking: 0, afterlifeTotal: 0, learningWired: false,
      lifetimeSignals: 0, tp1HitsLifetime: 0, tp2HitsLifetime: 0, tp3HitsLifetime: 0,
      slLifetime: 0, expiredLifetime: 0,
    };
  }
}

export function toSignalDTO(s: Signal): SignalDTO {
  let factors: SignalDTO["factors"] = null;
  if (s.factorsJson) {
    try {
      factors = JSON.parse(s.factorsJson) as SignalDTO["factors"];
    } catch {
      factors = null;
    }
  }
  let flow: SignalDTO["flow"] = null;
  if (s.flowJson) {
    try {
      const raw = JSON.parse(s.flowJson) as { verdict: string; score: number; reasons: string[]; oiWeight?: number; metrics: Record<string, unknown> };
      flow = { verdict: raw.verdict as FlowDTO["verdict"], score: raw.score, reasons: raw.reasons ?? [], oiWeight: raw.oiWeight ?? 1, metrics: { oiDelta10m: (raw.metrics.oiDelta10m as number | null) ?? null, oiDelta1h: (raw.metrics.oiDelta1h as number | null) ?? null, oiValueUsd: (raw.metrics.oiValueUsd as number | null) ?? null, cvdNetPctOfVol: (raw.metrics.cvdNetPctOfVol as number | null) ?? null, takerRatio: (raw.metrics.takerRatio as number | null) ?? null, takerMean: (raw.metrics.takerMean as number | null) ?? null, crowdLongShort: (raw.metrics.crowdLongShort as number | null) ?? null, crowdLongPct: (raw.metrics.crowdLongPct as number | null) ?? null, funding8h: (raw.metrics.funding8h as number | null) ?? null } };
    } catch {
      flow = null;
    }
  }
  return {
    ...s,
    direction: s.direction === "SHORT" ? "SHORT" : "LONG",
    status: s.status as SignalDTO["status"],
    tags: s.tags ? Array.from(new Set(s.tags.split(",").filter(Boolean))) : [],
    factors,
    flow,
    afterlife: s.afterlife ?? null,
    afterlifeAt: s.afterlifeAt?.toISOString() ?? null,
    maxPostPnlPercent: s.maxPostPnlPercent ?? 0,
    expiresAt: s.expiresAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    closedAt: s.closedAt?.toISOString() ?? null,
    notesUpdatedAt: s.notesUpdatedAt?.toISOString() ?? null,
  };
}
