// ── v9.0 LIFECYCLE LEARNING (operator request 2026-09-12) ────────────────
// «بررسی کن پیگیری و یادگیری این نتایج استفاده میشه؟» — the operator asked
// whether TTL-extension, BE-trail and afterlife results actually FEED learning.
// Audit finding: the per-signal tracking existed (ttlExtensions, afterlife,
// maxPostPnlPercent, BE_TRAIL events) and was DISPLAYED, but the AUTO-LEARNER
// never consumed any of it. This module closes that gap: on every 6h learner
// cycle it measures the three lifecycle mechanisms end-to-end, persists the
// evidence to EngineSetting("lifecycle.learning"), and emits one audited
// ENGINE line the governor + advisor can read. Deterministic — no LLM calls.
//
// What each mechanism is judged on (evidence, not vibes):
//   TTL EXTENSION GATE — extended signals: captured (reachedTp ≥ 1) vs
//     still-expired; NET usd captured; post-expiry would-have-won rate tells
//     whether denials were right (if denied expiries keep hitting TP after
//     TTL, the gate is too tight — the advisor can propose looser knobs).
//   BE-TRAIL ARM (v8.4 R2) — armed signals: rescued (TP-proven or ≥0 NET)
//     vs fee-only exit vs still stopped below entry (a stopped-after-arm is
//     a DEFINITIVE-ARM contract violation → surfaced loudly).
//   AFTERLIFE TRACKING — resolution quality: 48h-window coverage (every
//     EXPIRED must end with a resolved afterlife state), would-have-won %.

import { db } from "./db";

const KEY = "lifecycle.learning";
const MIN_INTERVAL_MS = 5 * 3600_000; // ride the 6h learner cadence, self-guarded
let lastRunAt = 0;

export interface LifecycleLearning {
  at: string;
  ttlGate: {
    signalsWithExt: number;
    grants: number;
    capturedN: number;
    expiredN: number;
    capturedUsd: number;
    expiredUsd: number;
    captureRatePct: number | null;
    verdict: string;
  };
  beTrail: {
    signals: number;
    rescued: number;
    feeOnly: number;
    stopped: number;
    rescueRatePct: number | null;
    verdict: string;
  };
  afterlife: {
    expiredTotal: number;
    resolved: number;
    tracking: number;
    wouldHaveWonPct: number | null;
    avgPostMfe: number | null;
    verdict: string;
  };
  conclusion: string;
}

export async function computeLifecycleLearning(): Promise<LifecycleLearning> {
  const [extSignals, beGroups, expiredAll] = await Promise.all([
    db.signal.findMany({
      where: { ttlExtensions: { gt: 0 } },
      select: { id: true, ttlExtensions: true, reachedTp: true, closedAt: true, status: true, marginUsd: true, pnlPercent: true },
    }),
    db.signalEvent.groupBy({ by: ["signalId"], where: { type: "BE_TRAIL" } }),
    db.signal.findMany({
      where: { status: "EXPIRED" },
      select: { afterlife: true, maxPostPnlPercent: true },
    }),
  ]);

  // ── TTL extension gate efficacy ──
  const grants = extSignals.reduce((a, s) => a + s.ttlExtensions, 0);
  const extCaptured = extSignals.filter((s) => s.reachedTp >= 1);
  const extExpired = extSignals.filter((s) => s.reachedTp === 0);
  const capturedUsd = extCaptured.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const expiredUsd = extExpired.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const captureRate = extSignals.length ? (extCaptured.length / extSignals.length) * 100 : null;
  const ttlVerdict =
    captureRate === null
      ? "no extended signals yet — gate idle"
      : captureRate >= 50
        ? `extension budget EARNING — ${extCaptured.length}/${extSignals.length} extended signals reached TP (${capturedUsd >= 0 ? "+" : ""}$${capturedUsd.toFixed(2)} NET)`
        : captureRate >= 25
          ? `extension budget MIXED — ${extCaptured.length}/${extSignals.length} captured (${capturedUsd >= 0 ? "+" : ""}$${capturedUsd.toFixed(2)} NET vs ${expiredUsd >= 0 ? "+" : ""}$${expiredUsd.toFixed(2)} expired-leg)`
          : `extension budget LEAKING — only ${extCaptured.length}/${extSignals.length} captured; advisor may tighten ttlExtendMax`;

  // ── BE-trail arm efficacy ──
  const beIds = beGroups.map((g) => g.signalId).filter((x): x is string => !!x);
  const beSigs = beIds.length
    ? await db.signal.findMany({
        where: { id: { in: beIds } },
        select: { reachedTp: true, closedAt: true, pnlPercent: true },
      })
    : [];
  const beRescued = beSigs.filter((s) => s.reachedTp >= 1 || (s.closedAt && s.pnlPercent > 0)).length;
  const beFeeOnly = beSigs.filter((s) => s.closedAt && s.reachedTp === 0 && s.pnlPercent <= 0 && s.pnlPercent > -1).length;
  const beStopped = beSigs.filter((s) => s.closedAt && s.reachedTp === 0 && s.pnlPercent <= -1).length;
  const rescueRate = beSigs.length ? (beRescued / beSigs.length) * 100 : null;
  const beVerdict =
    beSigs.length === 0
      ? "no breakeven arms yet — R2 idle"
      : beStopped > 0
        ? `⚠ ${beStopped} armed signal(s) closed below entry — DEFINITIVE-ARM contract needs audit`
        : rescueRate! >= 50
          ? `R2 arm WORKING — ${beRescued}/${beSigs.length} armed signals rescued (TP-proven or ≥0); ${beFeeOnly} fee-only exits`
          : `R2 arm contained — ${beFeeOnly}/${beSigs.length} fee-only exits (risk retired, no below-entry losses)`;

  // ── afterlife tracking quality ──
  const resolvedRows = expiredAll.filter((s) => s.afterlife && s.afterlife !== "TRACKING");
  const trackingN = expiredAll.filter((s) => s.afterlife === "TRACKING").length;
  const wouldWin = resolvedRows.filter((s) => ["TP1_HIT", "TP2_HIT", "TP3_HIT"].includes(s.afterlife ?? "")).length;
  const wouldHaveWonPct = resolvedRows.length ? (wouldWin / resolvedRows.length) * 100 : null;
  const avgPostMfe = expiredAll.length ? expiredAll.reduce((a, s) => a + s.maxPostPnlPercent, 0) / expiredAll.length : null;
  const alVerdict =
    resolvedRows.length === 0
      ? "no resolved afterlife windows yet"
      : wouldHaveWonPct! >= 50
        ? `expiry still cuts winners (${wouldWin}/${resolvedRows.length} would-have-won) — expiry-gate knobs stay under governor review`
        : `expiry decisions validated — only ${wouldWin}/${resolvedRows.length} would-have-won post-TTL`;

  const conclusion =
    `TTL ${extCaptured.length}/${extSignals.length} captured · BE ${beRescued}/${beSigs.length} rescued · ` +
    `AFTERLIFE ${resolvedRows.length}/${expiredAll.length} resolved (${wouldHaveWonPct === null ? "n/a" : `${wouldHaveWonPct!.toFixed(0)}% would-win`})`;

  return {
    at: new Date().toISOString(),
    ttlGate: {
      signalsWithExt: extSignals.length,
      grants,
      capturedN: extCaptured.length,
      expiredN: extExpired.length,
      capturedUsd: Number(capturedUsd.toFixed(2)),
      expiredUsd: Number(expiredUsd.toFixed(2)),
      captureRatePct: captureRate === null ? null : Number(captureRate.toFixed(1)),
      verdict: ttlVerdict,
    },
    beTrail: {
      signals: beSigs.length,
      rescued: beRescued,
      feeOnly: beFeeOnly,
      stopped: beStopped,
      rescueRatePct: rescueRate === null ? null : Number(rescueRate.toFixed(1)),
      verdict: beVerdict,
    },
    afterlife: {
      expiredTotal: expiredAll.length,
      resolved: resolvedRows.length,
      tracking: trackingN,
      wouldHaveWonPct: wouldHaveWonPct === null ? null : Number(wouldHaveWonPct.toFixed(0)),
      avgPostMfe: avgPostMfe === null ? null : Number(avgPostMfe.toFixed(2)),
      verdict: alVerdict,
    },
    conclusion,
  };
}

/** Ride the AUTO-LEARNER 6h cadence: measure + persist + one audited event. */
export async function recordLifecycleLearning(): Promise<LifecycleLearning | null> {
  if (Date.now() - lastRunAt < MIN_INTERVAL_MS) return null;
  lastRunAt = Date.now();
  try {
    const report = await computeLifecycleLearning();
    await db.engineSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: JSON.stringify(report) },
      update: { value: JSON.stringify(report) },
    });
    // No bare "<" anywhere — the message may mirror to Telegram HTML.
    const line = `LIFECYCLE LEARNER — ${report.conclusion} · TTL: ${report.ttlGate.verdict} · BE: ${report.beTrail.verdict} · AFTERLIFE: ${report.afterlife.verdict}`;
    await import("./engine").then((m) => m.fireEvent(null, null, "ENGINE", "ai", line));
    return report;
  } catch (e) {
    console.error("[lifecycle-learning]", e);
    return null;
  }
}

export async function getLifecycleLearning(): Promise<LifecycleLearning | null> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    return row ? (JSON.parse(row.value) as LifecycleLearning) : null;
  } catch {
    return null;
  }
}
