// ── NEXUS//SIGNALS — ENTRY-QUALITY GATE (LIVE-HARDENING phase 6) ────────────
// WHY: signal SCORE measures confluence strength; it does NOT measure whether
// this specific ENTRY is structurally good. The research findings (28 real
// fast-kill cases; 42.9% never went green; worst bucket 0–5m win rate 8.6%)
// say the dominant failure mode is LATE / OVEREXTENDED entries — exactly what
// a score does not see. This layer is DETERMINISTIC and SEPARATE from the
// score: a 90-score signal can still be a STRONG_REJECT entry.
//
// Decision states (spec): STRONG_PASS | GRAY_ZONE | STRONG_REJECT.
// LAW: GRAY_ZONE must NOT become live-eligible merely because deployment
// volume is low. Only STRONG_PASS entries can ever be LIVE_ELIGIBLE; GRAY
// deploys are admitted (paper) but permanently tagged EQ-GRAY so the ledger
// can A/B them; STRONG_REJECT blocks AUTO deploys outright (operator-forced
// deploys may proceed, audited, at half size).
//
// Fail-conservative: ANY missing input ⇒ dataComplete=false ⇒ GRAY_ZONE
// (never silently pass on unknown data).

export type EntryQualityState = "STRONG_PASS" | "GRAY_ZONE" | "STRONG_REJECT";

export interface EQInput {
  extensionAtr: number | null; // distance of entry from EMA/impulse anchor in ATR units (overextension)
  flowPersistMin: number | null; // consecutive minutes of same-direction aggressor flow (persistence, NOT one snapshot)
  spreadBps: number | null; // venue spread at decision time (execution quality)
  spikeOneShot: boolean | null; // flow spike confined to a single snapshot/minute (suspect)
  chasePct: number | null; // % price already ran beyond the modeled entry zone (late-entry)
  chaseCapPct: number; // operator knob — max acceptable chase
  dataComplete: boolean;
}

export interface EQDecision {
  state: EntryQualityState;
  reasons: string[];
  lateEntry: boolean;
  overextended: boolean;
  oneShot: boolean;
}

export const EQ_RULES = {
  MAX_EXTENSION_ATR: 2.2, // ≥ ⇒ overextended (impulse exhausted territory)
  MIN_FLOW_PERSIST_MIN: 3, // < ⇒ single-snapshot flow not trusted
  MAX_SPREAD_BPS: 12, // above ⇒ execution drag dominates edge
  GRAY_EXTENSION_ATR: 1.5, // 1.5–2.2 ATR ⇒ ambiguity band
} as const;

export function classifyEntry(q: EQInput): EQDecision {
  const reasons: string[] = [];
  const lateEntry = q.chasePct !== null && q.chasePct > q.chaseCapPct;
  const overextended = q.extensionAtr !== null && q.extensionAtr >= EQ_RULES.MAX_EXTENSION_ATR;
  const oneShot = q.spikeOneShot === true || (q.flowPersistMin !== null && q.flowPersistMin < EQ_RULES.MIN_FLOW_PERSIST_MIN);

  // ── STRONG_REJECT limbs (deterministic) ──
  if (lateEntry) reasons.push(`late entry: chase ${q.chasePct?.toFixed(2)}% > cap ${q.chaseCapPct}% (price already ran beyond modeled zone)`);
  if (overextended) reasons.push(`overextended: ${q.extensionAtr?.toFixed(2)} ATR from anchor ≥ ${EQ_RULES.MAX_EXTENSION_ATR} (impulse exhaustion)`);
  if (q.spreadBps !== null && q.spreadBps > EQ_RULES.MAX_SPREAD_BPS) reasons.push(`execution quality: spread ${q.spreadBps.toFixed(1)}bps > ${EQ_RULES.MAX_SPREAD_BPS}bps`);
  if (q.spikeOneShot === true) reasons.push("flow spike confined to one snapshot — no persistence evidence");
  if (!q.dataComplete) reasons.push("entry-quality inputs incomplete — conservatively not a PASS");
  const strongReject = lateEntry || overextended || (q.spreadBps !== null && q.spreadBps > EQ_RULES.MAX_SPREAD_BPS) || q.spikeOneShot === true;

  if (strongReject) return { state: "STRONG_REJECT", reasons, lateEntry, overextended, oneShot };

  // ── GRAY_ZONE limbs ──
  if (!q.dataComplete) return { state: "GRAY_ZONE", reasons, lateEntry, overextended, oneShot };
  if (oneShot) { reasons.push(`flow persistence weak: ${q.flowPersistMin?.toFixed(0)}min < ${EQ_RULES.MIN_FLOW_PERSIST_MIN}min — not one-shot enough to reject, not persistent enough to trust`); return { state: "GRAY_ZONE", reasons, lateEntry, overextended, oneShot }; }
  if (q.extensionAtr !== null && q.extensionAtr >= EQ_RULES.GRAY_EXTENSION_ATR) { reasons.push(`extension ${q.extensionAtr.toFixed(2)} ATR in ambiguity band [${EQ_RULES.GRAY_EXTENSION_ATR}, ${EQ_RULES.MAX_EXTENSION_ATR})`); return { state: "GRAY_ZONE", reasons, lateEntry, overextended, oneShot }; }

  return { state: "STRONG_PASS", reasons, lateEntry, overextended, oneShot };
}

/** Spec law, encoded: only STRONG_PASS may ever be live-eligible. */
export function liveEligibleFromQuality(state: EntryQualityState): boolean {
  return state === "STRONG_PASS";
}

export const EQ_TAG: Record<EntryQualityState, string> = {
  STRONG_PASS: "EQ-STRONG",
  GRAY_ZONE: "EQ-GRAY",
  STRONG_REJECT: "EQ-REJECT",
};
