// ── FlowRadar Neo v6.1 DYNAMIC EXPIRY GATE (server-only) ────────────────
// Post-expiry afterlife evidence showed most expiries reach TP afterwards
// (64% would-have-won at the time of implementation). This module owns the
// gate: a DETERMINISTIC policy evaluator (every input measured) plus the
// telemetry loop the AI governor uses to tune its own knobs
// (set_ttl_extend_max / set_ttl_extend_minutes / set near-TP band via gates).
// Zero manual modes — the governor is the only policy authority.

import { db } from "@/lib/db";
import type { Signal } from "@prisma/client";
import type { GateSettings } from "@/lib/gate-settings";

const TTL_GATE_KEY = "ttl-gate";

export interface TtlGateTelemetry {
  extended: number; // grants issued
  tpAfter: number; // extended signals that resolved TP1/TP2/TP3
  slAfter: number; // extended signals that stopped out
  reExpired: number; // extended signals that expired anyway
  capturedUsd: number; // Σ NET usd captured by extended TP resolutions
  denied: number; // v6.1.1 — expiries the gate declined
  deniedNearTp: number; // v6.1.1 — denials where the next TP sat within 2× the near band (the operator's pain metric)
  updatedAt: string;
}

const EMPTY: TtlGateTelemetry = { extended: 0, tpAfter: 0, slAfter: 0, reExpired: 0, capturedUsd: 0, denied: 0, deniedNearTp: 0, updatedAt: "1970-01-01T00:00:00.000Z" };

export async function getTtlTelemetry(): Promise<TtlGateTelemetry> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: TTL_GATE_KEY } });
    if (!row) return { ...EMPTY };
    return { ...EMPTY, ...(JSON.parse(row.value) as Partial<TtlGateTelemetry>) };
  } catch {
    return { ...EMPTY };
  }
}

export async function bumpTtlTelemetry(patch: Partial<Omit<TtlGateTelemetry, "updatedAt">>): Promise<void> {
  try {
    const cur = await getTtlTelemetry();
    const next: TtlGateTelemetry = {
      extended: cur.extended + (patch.extended ?? 0),
      tpAfter: cur.tpAfter + (patch.tpAfter ?? 0),
      slAfter: cur.slAfter + (patch.slAfter ?? 0),
      reExpired: cur.reExpired + (patch.reExpired ?? 0),
      capturedUsd: Number((cur.capturedUsd + (patch.capturedUsd ?? 0)).toFixed(2)),
      denied: cur.denied + (patch.denied ?? 0),
      deniedNearTp: cur.deniedNearTp + (patch.deniedNearTp ?? 0),
      updatedAt: new Date().toISOString(),
    };
    await db.engineSetting.upsert({ where: { key: TTL_GATE_KEY }, create: { key: TTL_GATE_KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
  } catch {
    /* telemetry is best-effort — never block signal resolution */
  }
}

/** live 20-minute price momentum from recorded PricePoint history (unlevered %) */
async function momentum20m(symbol: string, price: number): Promise<number> {
  const since = new Date(Date.now() - 20 * 60_000);
  const [oldest, newest] = await Promise.all([
    db.pricePoint.findFirst({ where: { symbol, createdAt: { gte: since } }, orderBy: { createdAt: "asc" } }),
    db.pricePoint.findFirst({ where: { symbol, createdAt: { gte: since } }, orderBy: { createdAt: "desc" } }),
  ]);
  if (!oldest || !newest || oldest.price <= 0) return 0; // sparse tape → neutral pass
  return ((price - oldest.price) / oldest.price) * 100;
}

/**
 * Evaluate whether a maturing signal earns a TTL extension. All inputs are
 * measured; the reason string is written into the audited feed event either
 * way (granted OR denied) so the operator sees WHY every expiry happened.
 *
 * ── v6.6 SMART TTL (operator-approved, item ③ of the calibration package) ──
 * Evidence (Q4 forensics, signalEvent time-to-TP): median TP touch lands at
 * ~46m, but AI-SWING targets sit further out — the global 1.5% near-TP band
 * almost never catches a swing rung, so swings expired while still on-track.
 * 1. PER-STRATEGY BAND — AI-SWING qualifies with a widened 8–10% band
 *    (max(gate.ttlNearTpPct×2, 8)); the governor knob keeps global authority
 *    (×2 up to its 5% clamp → 10% ceiling for swings).
 * 2. MFE<0 DENIAL — an extension is never granted to a trade under water at
 *    expiry (previously implicit; now an explicit audited denial rule).
 * 3. RE-ARM — after the extension budget is spent, a signal that is IN PROFIT
 *    and sits within HALF the band earns exactly ONE more grant (hard cap 2
 *    total, lifetime 3×TTL cap still applies). The near-TP pull-back-then-
 *    re-approach pattern no longer kills on-track runners.
 */
export interface TtlDecision {
  grant: boolean;
  reason: string;
  nearTp: boolean; // next rung sat within 2× the near-TP band (feeds the denial pain metric)
}

export async function evaluateTtlExtension(s: Signal, price: number, movePct: number, gate: GateSettings, now: Date): Promise<TtlDecision> {
  const nextTp = s.status === "ACTIVE" ? s.tp1 : s.status === "TP1" ? s.tp2 : s.tp3;
  const distTpPct = (Math.abs(nextTp - price) / price) * 100; // remaining unlevered journey to the next rung
  const band = s.strategy === "AI-SWING" ? Math.max(gate.ttlNearTpPct * 2, 8) : gate.ttlNearTpPct; // v6.6 per-strategy widening
  const bandNote = s.strategy === "AI-SWING" ? ` (AI-SWING widened band ${band.toFixed(1)}% = max(${gate.ttlNearTpPct}%×2, 8))` : "";
  const nearTp = distTpPct <= band * 2;
  const swingNote = s.strategy === "AI-SWING" ? ` · band ${band.toFixed(1)}% (AI-SWING)` : "";
  // 1) budget — each signal gets at most ttlExtendMax grants (0 disables);
  //    v6.6 RE-ARM: one extra grant beyond budget when in profit AND within
  //    half the band — hard cap 2 grants total, never when the gate is off.
  const rearm =
    gate.ttlExtendMax > 0 &&
    s.ttlExtensions === gate.ttlExtendMax &&
    s.ttlExtensions < 2 &&
    movePct > 0 &&
    distTpPct <= band / 2;
  if (s.ttlExtensions >= gate.ttlExtendMax && !rearm) {
    return { grant: false, nearTp, reason: `extension budget spent (${s.ttlExtensions}/${gate.ttlExtendMax})${s.ttlExtensions < 2 ? " · re-arm needs profit + <" + (band / 2).toFixed(1) + "% to next TP" : ""}` };
  }
  // 2) lifetime cap — extensions can never exceed 3× the original TTL
  const ageMin = (now.getTime() - s.createdAt.getTime()) / 60_000;
  if (ageMin >= s.ttlMinutes * 3) return { grant: false, nearTp, reason: `lifetime cap 3×TTL reached (${Math.round(ageMin)}m)` };
  // 3) v6.6 MFE<0 DENIAL — never add time to a trade under water at expiry
  //    (explicit rule; the 60%-of-risk-distance guard below stays as the harder backstop)
  if (movePct < 0) return { grant: false, nearTp, reason: `under water ${movePct.toFixed(2)}% at expiry — MFE<0 never extends` };
  // 4) drawdown guard — never add time to a trade that already spent 60% of its risk distance
  const slDistPct = Math.abs((s.entryPrice - s.stopLoss) / s.entryPrice) * 100;
  if (movePct <= -(0.6 * slDistPct)) return { grant: false, nearTp, reason: `drawdown ${movePct.toFixed(2)}% ≥ 60% of risk distance` };
  // 5a) qualification — near the next unbanked TP rung (v6.6 widened for AI-SWING)
  if (distTpPct <= band) {
    const slope = await momentum20m(s.symbol, price);
    return {
      grant: true,
      nearTp,
      reason: `${rearm ? "RE-ARM " : ""}next TP only ${distTpPct.toFixed(2)}% away (≤${band}% band${swingNote}) · 20m momentum ${slope >= 0 ? "+" : ""}${slope.toFixed(2)}%`,
    };
  }
  // 5b) v6.1.1 journey-progress rule — in profit AND past the midpoint to the next rung.
  // Afterlife evidence: profitable maturing trades usually finish the trip (64% would-have-won);
  // a shallow pullback in the last 20m must not kill a trade that already covered >50% of the way.
  if (movePct > 0 && movePct >= distTpPct) {
    const slope = await momentum20m(s.symbol, price);
    const journey = movePct + distTpPct;
    return { grant: true, nearTp, reason: `${rearm ? "RE-ARM " : ""}in profit +${movePct.toFixed(2)}% — covered ${(journey > 0 ? (100 * movePct) / journey : 0).toFixed(0)}% of the journey to next TP (${distTpPct.toFixed(2)}% away, 20m ${slope >= 0 ? "+" : ""}${slope.toFixed(2)}%)${bandNote}` };
  }
  // 5c) qualification — profitably afloat with constructive tape
  if (movePct > 0) {
    const slope = await momentum20m(s.symbol, price);
    if (slope >= 0) return { grant: true, nearTp, reason: `${rearm ? "RE-ARM " : ""}in profit +${movePct.toFixed(2)}% with constructive tape (20m +${slope.toFixed(2)}%)${bandNote}` };
  }
  const slope = nearTp ? await momentum20m(s.symbol, price) : 0;
  return { grant: false, nearTp, reason: `no qualification — TP ${distTpPct.toFixed(2)}% away, move ${movePct.toFixed(2)}%, 20m momentum ${slope >= 0 ? "+" : ""}${slope.toFixed(2)}%${bandNote}` };
}
