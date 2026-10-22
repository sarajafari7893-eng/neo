// ── FlowRadar Neo v6.4 DAILY PERFORMANCE DIGEST (server-only) ──────────────
// Operator request 2026-09-07: «هر روز ساعت 00:00 یک گزارش کوتاه و مفید از
// عملکرد روزانه به تلگرام بفرست با این تصویر». Compiles the last-24h digest
// from REAL db rows — opened/closed signals, proven-TP wins, realized net USD,
// fees, equity, best/worst trade, active book, VOL-CAUSE captures — nothing
// invented. The caption rides on the operator's DAILY.jpg artwork via
// sendDailyReport() in notify.ts.

import { db } from "@/lib/db";
import { ACCOUNT_START_USD, feeBreakdown } from "@/lib/accounting";
import { APP_NAME } from "./brand";

const TZ = "Asia/Tehran";

function tehranDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "short", day: "2-digit" }).format(d);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface DailyDigest {
  windowLabel: string;
  opened: number;
  closed: number;
  wins: number;
  stops: number;
  expired: number;
  winRatePct: number | null;
  realizedUsd: number;
  feesUsd: number;
  unrealizedUsd: number;
  equityUsd: number;
  active: number;
  best: { symbol: string; pnl: number; strategy: string } | null;
  worst: { symbol: string; pnl: number; strategy: string } | null;
  volCauseCaptures: number;
  topCause: string | null;
  /** TRUE partition of closed trades by FINAL status — bars must partition,
   * unlike wins/stops/expired which are overlapping event counts (an EXPIRED
   * trade that touched TP1 first counts in both). */
  statusMix: { tp: number; sl: number; expired: number; manual: number };
  /** closed trades in the window (worst→best mix, capped) — feeds the poster bars */
  trades: Array<{ symbol: string; pnl: number; status: string; strategy: string; direction: string }>;
  /** v10.20 — 14-day realized-equity walk (oldest→newest); last point = the
   * live equity mark (realized + open PNL). Feeds the poster sparkline. */
  equityCurve: number[];
}

/** v10.20 — 14-point daily equity walk over the trailing 14 Tehran-day
 * buckets. Realized equity from settled rows only; the FINAL point is the
 * live equity mark (realized + open PNL) so the curve ends where the
 * dashboard stands right now. Fail-soft: [] on any error (poster hides the
 * panel instead of inventing data). */
async function equityCurvePoints(currentEquity: number): Promise<number[]> {
  const N = 14;
  const start = Date.now() - (N - 1) * 86_400_000;
  try {
    const [inWin, before] = await Promise.all([
      db.signal.findMany({
        where: { closedAt: { gte: new Date(start) }, status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
        select: { closedAt: true, pnlPercent: true, marginUsd: true },
      }),
      db.signal.findMany({
        where: { closedAt: { lt: new Date(start) }, status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
        select: { pnlPercent: true, marginUsd: true },
      }),
    ]);
    const base = before.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0) + ACCOUNT_START_USD;
    const buckets = new Array<number>(N).fill(0);
    for (const s of inWin) {
      if (!s.closedAt) continue;
      const idx = Math.floor((s.closedAt.getTime() - start) / 86_400_000);
      if (idx >= 0 && idx < N) buckets[idx]! += (s.marginUsd * s.pnlPercent) / 100;
    }
    const pts: number[] = [];
    let cum = 0;
    for (let i = 0; i < N - 1; i++) {
      cum += buckets[i]!;
      pts.push(Number((base + cum).toFixed(2)));
    }
    pts.push(currentEquity); // live mark — realized + open PNL
    return pts;
  } catch {
    return [];
  }
}

/** Shared digest builder — 24h for the daily report, 7×24h for the weekly
 * report (v10.20). Same honest math, one implementation, zero drift. */
async function buildDigest(sinceMs: number): Promise<DailyDigest> {
  const since = new Date(Date.now() - sinceMs);

  const [openedSigs, closedSigs, activeSigs, volCauses] = await Promise.all([
    db.signal.findMany({ where: { createdAt: { gte: since } }, select: { id: true } }),
    db.signal.findMany({
      where: { closedAt: { gte: since }, status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
      select: { symbol: true, strategy: true, status: true, pnlPercent: true, marginUsd: true, reachedTp: true, feeUsd: true, swapUsd: true, direction: true },
    }),
    db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { pnlPercent: true, marginUsd: true } }),
    db.volCauseEvent.findMany({ where: { detectedAt: { gte: since } }, select: { primaryCause: true } }),
  ]);

  // win = a proven TP level (consistent with the engine's TP-proven accounting)
  const wins = closedSigs.filter((s) => s.reachedTp >= 1).length;
  const stops = closedSigs.filter((s) => s.status === "SL").length;
  const expired = closedSigs.filter((s) => s.status === "EXPIRED").length;
  const realizedUsd = closedSigs.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const feesUsd = closedSigs.reduce((a, s) => a + s.feeUsd + s.swapUsd, 0);
  const unrealizedUsd = activeSigs.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);

  // lifetime equity — SAME math as the dashboard (stats.ts): mark open
  // positions to the LIVE market price with accrued funding via feeBreakdown
  const [lifeSettled, activeFull, assets] = await Promise.all([
    db.signal.findMany({ where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } }, select: { pnlPercent: true, marginUsd: true } }),
    db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { symbol: true, direction: true, entryPrice: true, marginUsd: true, leverage: true, createdAt: true } }),
    db.marketAsset.findMany({ select: { symbol: true, price: true } }),
  ]);
  const lifeRealized = lifeSettled.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const priceMap = new Map(assets.map((a) => [a.symbol, a.price]));
  let lifeUnreal = 0;
  for (const s of activeFull) {
    const price = priceMap.get(s.symbol);
    if (!price) continue;
    const move = ((price - s.entryPrice) / s.entryPrice) * (s.direction === "LONG" ? 1 : -1) * 100;
    const heldMin = Math.max(0, (Date.now() - s.createdAt.getTime()) / 60_000);
    lifeUnreal += feeBreakdown(s.marginUsd, s.leverage, move, heldMin).netUsd;
  }

  const sortedByPnl = [...closedSigs].sort((a, b) => b.pnlPercent - a.pnlPercent);
  const best = sortedByPnl[0] ?? null;
  const worst = sortedByPnl.length > 0 ? sortedByPnl[sortedByPnl.length - 1]! : null;

  const causeCounts = new Map<string, number>();
  for (const v of volCauses) causeCounts.set(v.primaryCause, (causeCounts.get(v.primaryCause) ?? 0) + 1);
  const topCause = [...causeCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  const equityUsd = Number((ACCOUNT_START_USD + lifeRealized + lifeUnreal).toFixed(2));
  const equityCurve = await equityCurvePoints(equityUsd);

  return {
    windowLabel: `${tehranDateStr(since)} → ${tehranDateStr(new Date())} (Tehran)`,
    opened: openedSigs.length,
    closed: closedSigs.length,
    wins,
    stops,
    expired,
    winRatePct: closedSigs.length > 0 ? Math.round((wins / closedSigs.length) * 100) : null,
    realizedUsd: Number(realizedUsd.toFixed(2)),
    feesUsd: Number(feesUsd.toFixed(2)),
    unrealizedUsd: Number(unrealizedUsd.toFixed(2)),
    equityUsd,
    active: activeSigs.length,
    best: best ? { symbol: best.symbol, pnl: best.pnlPercent, strategy: best.strategy } : null,
    worst: worst && worst.pnlPercent < 0 ? { symbol: worst.symbol, pnl: worst.pnlPercent, strategy: worst.strategy } : null,
    volCauseCaptures: volCauses.length,
    topCause: topCause?.[0] ?? null,
    statusMix: {
      tp: closedSigs.filter((s) => s.status === "TP1" || s.status === "TP2" || s.status === "TP3").length,
      sl: stops,
      expired,
      manual: closedSigs.filter((s) => s.status === "CLOSED").length,
    },
    trades: [...sortedByPnl]
      .sort((a, b) => Math.abs(b.pnlPercent) - Math.abs(a.pnlPercent))
      .slice(0, 5)
      .map((s) => ({ symbol: s.symbol, pnl: s.pnlPercent, status: s.status, strategy: s.strategy, direction: s.direction })),
    equityCurve,
  };
}

export async function buildDailyDigest(): Promise<DailyDigest> {
  return buildDigest(24 * 3600_000);
}

/** v10.20 WEEKLY DIGEST — the last 7×24h through the exact same honest
 * pipeline as the daily report (same fields, same equity math). Sent once
 * per Iranian week (Sat→Fri) via /api/report/weekly. */
export async function buildWeeklyDigest(): Promise<DailyDigest> {
  return buildDigest(7 * 24 * 3600_000);
}

/** Compact HTML caption — Telegram caps photos captions at 1024 chars.
 * v6.6: `advisorBlock` (from advisor.advisorCaptionBlock()) rides along so the
 * operator sees pending calibration proposals in the same 00:00 report. */
export function composeDailyCaption(d: DailyDigest, advisorBlock?: string, scope: "DAILY" | "WEEKLY" = "DAILY"): string {
  const money = (v: number) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
  const netLabel = scope === "WEEKLY" ? "Net 7d" : "Net 24h";
  const lines: string[] = [
    `📊 <b>${APP_NAME} — ${scope === "WEEKLY" ? "WEEKLY" : "DAILY"} PERFORMANCE</b>`,
    `🗓 ${esc(d.windowLabel)}`,
    "",
    `💵 ${netLabel}: <b>${money(d.realizedUsd)}</b> (fees −$${d.feesUsd.toFixed(2)})`,
    `🏦 Equity: <b>$${d.equityUsd.toFixed(2)}</b> · open PNL ${money(d.unrealizedUsd)}`,
    `📡 Deployed: <b>${d.opened}</b> · Closed: <b>${d.closed}</b> · Active now: <b>${d.active}</b>`,
    `🏆 Proven-TP wins: <b>${d.wins}</b>${d.winRatePct !== null ? ` / ${d.winRatePct}%` : ""} · 🛑 Stops: <b>${d.stops}</b> · ⏰ Expired: <b>${d.expired}</b>`,
  ];
  if (d.best) lines.push(`🥇 Best: <b>${esc(d.best.symbol)}</b> +${d.best.pnl.toFixed(1)}% (${esc(d.best.strategy)})`);
  if (d.worst) lines.push(`🩸 Worst: <b>${esc(d.worst.symbol)}</b> ${d.worst.pnl.toFixed(1)}% (${esc(d.worst.strategy)})`);
  if (d.volCauseCaptures > 0) {
    lines.push("", `🔬 VOL-CAUSE forensics: <b>${d.volCauseCaptures}</b> top-volatility capture${d.volCauseCaptures > 1 ? "s" : ""}${d.topCause ? ` — dominant cause ${esc(d.topCause)}` : ""}`);
  }
  if (advisorBlock) lines.push("", advisorBlock);
  lines.push("", "<i>🤖 FLOWRADAR-NEO AI live engine · honest numbers from settled rows only</i>");
  return lines.join("\n");
}

/** Last-send marker — guards the 00:00 cron against double-fires. */
export async function markDailySent(ok: boolean): Promise<void> {
  await db.engineSetting.upsert({
    where: { key: "dailyreport.last" },
    create: { key: "dailyreport.last", value: JSON.stringify({ at: Date.now(), ok }) },
    update: { value: JSON.stringify({ at: Date.now(), ok }) },
  });
}

export async function lastDailySentAt(): Promise<number | null> {
  const row = await db.engineSetting.findUnique({ where: { key: "dailyreport.last" } }).catch(() => null);
  if (!row) return null;
  try {
    return (JSON.parse(row.value) as { at: number }).at ?? null;
  } catch {
    return null;
  }
}

/** Last SUCCESSFUL send only — failed deliveries must never count toward
 * the once-per-day guard (otherwise a failed send would block same-day retries). */
export async function lastSuccessfulSentAt(): Promise<number | null> {
  const row = await db.engineSetting.findUnique({ where: { key: "dailyreport.last" } }).catch(() => null);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as { at: number; ok?: boolean };
    return v.ok ? v.at ?? null : null;
  } catch {
    return null;
  }
}

/** Tehran calendar-day key (Iran = UTC+03:30 fixed, no DST since 2022).
 * Two timestamps share a key iff they fall on the same Tehran date. */
export function tehranDayKey(ts: number): number {
  return Math.floor((ts + 12_600_000) / 86_400_000);
}

// ── v10.20 WEEKLY REPORT GUARD ───────────────────────────────────────────
// Iranian week: Saturday → Friday. weekKey = the Tehran-day key of the most
// recent Saturday ≤ ts, so every day inside one Iranian week shares a key.

export function tehranWeekKey(ts: number): number {
  const dow = new Date(ts + 12_600_000).getUTCDay(); // Sun=0 … Sat=6
  const daysSinceSat = (dow + 1) % 7; // Sat→0, Sun→1, … Fri→6
  return tehranDayKey(ts - daysSinceSat * 86_400_000);
}

export async function markWeeklySent(ok: boolean): Promise<void> {
  await db.engineSetting.upsert({
    where: { key: "weeklyreport.last" },
    create: { key: "weeklyreport.last", value: JSON.stringify({ at: Date.now(), ok }) },
    update: { value: JSON.stringify({ at: Date.now(), ok }) },
  });
}

export async function lastWeeklySentAt(): Promise<number | null> {
  const row = await db.engineSetting.findUnique({ where: { key: "weeklyreport.last" } }).catch(() => null);
  if (!row) return null;
  try {
    return (JSON.parse(row.value) as { at: number }).at ?? null;
  } catch {
    return null;
  }
}

/** Only successful sends count — a failed weekly delivery must be retryable. */
export async function lastWeeklySuccessfulSentAt(): Promise<number | null> {
  const row = await db.engineSetting.findUnique({ where: { key: "weeklyreport.last" } }).catch(() => null);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as { at: number; ok?: boolean };
    return v.ok ? v.at ?? null : null;
  } catch {
    return null;
  }
}
