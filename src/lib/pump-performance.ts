// ── v9.1 PUMP/DUMP RADAR · PERFORMANCE FORENSICS + AI JOURNAL ────────────
// Operator mandate 2026-09-13: «ماژول نمایش عملکرد و جورنال برای هوش مرکزی»
// — a performance module and journal FOR THE CENTRAL INTELLIGENCE.
//
// Two products, one module:
//  1. PERFORMANCE (UI + API): per-kind (PUMP/DUMP) success/failure rates,
//     avg MFE/MAE at resolution, resolution-time distributions, 24h activity,
//     top symbols, best/worst tracks — all measured from the PumpTrack ledger.
//  2. JOURNAL (AI core): a compact digest persisted to EngineSetting
//     "pump.performance" (same channel the governor/advisor read) AND
//     injected into buildEngineMemory() → the analyst prompt + ENGINE MEMORY
//     card + governor context consume it as ground truth. Journal entries
//     mirror the recent PUMP_RADAR SignalEvents (declare/unlock/deploy lines).
//
// Read-only forensics on the ledger — the radar engine itself is untouched.

import { db } from "./db";

export interface PumpKindRow {
  kind: "PUMP" | "DUMP";
  resolved: number;
  success: number;
  failure: number;
  successRatePct: number;
  avgMfePct: number;
  avgMaePct: number;
  avgResolutionMin: number;
}

export interface PumpPerformance {
  at: string;
  totals: {
    tracks: number;
    resolved: number;
    success: number;
    failure: number;
    pending: number;
    successRatePct: number;
    spawnedSignals: number;
  };
  perKind: PumpKindRow[];
  window24h: { declared: number; success: number; failure: number };
  topSymbols: Array<{ symbol: string; tracks: number; success: number; successRatePct: number }>;
  best: { symbol: string; kind: string; mfePct: number; outcome: string | null; detectedAt: string } | null;
  worst: { symbol: string; kind: string; maePct: number; outcome: string | null; detectedAt: string } | null;
  headline: string;
  journal: Array<{ at: string; level: string; message: string }>;
}

export async function computePumpPerformance(): Promise<PumpPerformance> {
  const [tracks, journalRows] = await Promise.all([
    db.pumpTrack.findMany({ orderBy: { detectedAt: "desc" }, take: 600 }),
    db.signalEvent.findMany({ where: { type: "PUMP_RADAR" }, orderBy: { createdAt: "desc" }, take: 12 }),
  ]);

  const resolvedRows = tracks.filter((t) => t.outcome !== null);
  const success = resolvedRows.filter((t) => t.outcome === "SUCCESS");
  const failure = resolvedRows.filter((t) => t.outcome === "FAILURE");
  const pending = tracks.filter((t) => t.outcome === null).length;
  const spawnedSignals = tracks.filter((t) => t.signalId !== null).length;

  const kindRow = (kind: "PUMP" | "DUMP"): PumpKindRow => {
    const rows = resolvedRows.filter((t) => t.kind === kind);
    const succ = rows.filter((t) => t.outcome === "SUCCESS").length;
    const resMins = rows
      .filter((t) => t.resolvedAt)
      .map((t) => (t.resolvedAt!.getTime() - t.detectedAt.getTime()) / 60_000);
    return {
      kind,
      resolved: rows.length,
      success: succ,
      failure: rows.length - succ,
      successRatePct: rows.length ? Number(((succ / rows.length) * 100).toFixed(1)) : 0,
      avgMfePct: rows.length ? Number((rows.reduce((a, t) => a + t.mfePct, 0) / rows.length).toFixed(2)) : 0,
      avgMaePct: rows.length ? Number((rows.reduce((a, t) => a + t.maePct, 0) / rows.length).toFixed(2)) : 0,
      avgResolutionMin: resMins.length ? Number((resMins.reduce((a, b) => a + b, 0) / resMins.length).toFixed(1)) : 0,
    };
  };

  const dayAgo = Date.now() - 24 * 3600_000;
  const recent = tracks.filter((t) => t.detectedAt.getTime() >= dayAgo);

  const symAcc = new Map<string, { tracks: number; success: number }>();
  for (const t of tracks) {
    const cell = symAcc.get(t.symbol) ?? { tracks: 0, success: 0 };
    cell.tracks++;
    if (t.outcome === "SUCCESS") cell.success++;
    symAcc.set(t.symbol, cell);
  }

  const bestResolved = [...resolvedRows].sort((a, b) => b.mfePct - a.mfePct)[0] ?? null;
  const worstResolved = [...resolvedRows].sort((a, b) => b.maePct - a.maePct)[0] ?? null;

  const rate = resolvedRows.length ? Number(((success.length / resolvedRows.length) * 100).toFixed(1)) : 0;
  const k = kindRow("PUMP");
  const d = kindRow("DUMP");
  const headline = resolvedRows.length
    ? `Radar resolved ${resolvedRows.length} tracks at ${rate}% success — PUMP ${k.success}/${k.resolved} (${k.successRatePct}%) vs DUMP ${d.success}/${d.resolved} (${d.successRatePct}%); detector honesty held: criteria fixed at declaration, no post-hoc rescoring.`
    : "Radar ledger warming — no resolved tracks yet.";

  return {
    at: new Date().toISOString(),
    totals: {
      tracks: tracks.length,
      resolved: resolvedRows.length,
      success: success.length,
      failure: failure.length,
      pending,
      successRatePct: rate,
      spawnedSignals,
    },
    perKind: [k, d],
    window24h: {
      declared: recent.length,
      success: recent.filter((t) => t.outcome === "SUCCESS").length,
      failure: recent.filter((t) => t.outcome === "FAILURE").length,
    },
    topSymbols: [...symAcc.entries()]
      .map(([symbol, v]) => ({ symbol, tracks: v.tracks, success: v.success, successRatePct: v.tracks ? Number(((v.success / v.tracks) * 100).toFixed(1)) : 0 }))
      .sort((a, b) => b.tracks - a.tracks)
      .slice(0, 6),
    best: bestResolved
      ? { symbol: bestResolved.symbol, kind: bestResolved.kind, mfePct: bestResolved.mfePct, outcome: bestResolved.outcome, detectedAt: bestResolved.detectedAt.toISOString() }
      : null,
    worst: worstResolved
      ? { symbol: worstResolved.symbol, kind: worstResolved.kind, maePct: worstResolved.maePct, outcome: worstResolved.outcome, detectedAt: worstResolved.detectedAt.toISOString() }
      : null,
    headline,
    journal: journalRows.map((e) => ({ at: e.createdAt.toISOString(), level: e.level, message: e.message.slice(0, 220) })),
  };
}

// ── AI-core persistence (EngineSetting "pump.performance") ───────────────
export const PUMP_PERFORMANCE_KEY = "pump.performance";
const PERSIST_DEBOUNCE_MS = 30 * 60_000;

export async function persistPumpPerformance(perf: PumpPerformance, force = false): Promise<boolean> {
  const prev = await db.engineSetting.findUnique({ where: { key: PUMP_PERFORMANCE_KEY } }).catch(() => null);
  if (prev && !force) {
    try {
      const p = JSON.parse(prev.value) as { at?: string };
      if (p.at && Date.now() - new Date(p.at).getTime() < PERSIST_DEBOUNCE_MS) return false;
    } catch {
      /* corrupted previous row → overwrite */
    }
  }
  const digest = {
    at: perf.at,
    headline: perf.headline,
    totals: perf.totals,
    perKind: perf.perKind,
    window24h: perf.window24h,
    topSymbols: perf.topSymbols,
    best: perf.best,
    worst: perf.worst,
  };
  await db.engineSetting.upsert({
    where: { key: PUMP_PERFORMANCE_KEY },
    create: { key: PUMP_PERFORMANCE_KEY, value: JSON.stringify(digest) },
    update: { value: JSON.stringify(digest) },
  });
  return true;
}

export async function readPersistedPumpPerformance(): Promise<PumpPerformance | null> {
  const row = await db.engineSetting.findUnique({ where: { key: PUMP_PERFORMANCE_KEY } }).catch(() => null);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as PumpPerformance;
  } catch {
    return null;
  }
}
