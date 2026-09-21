import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toSignalDTO } from "@/lib/stats";

export const dynamic = "force-dynamic";

/** GET /api/signals/[id] */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const sig = await db.signal.findUnique({ where: { id }, include: { events: { orderBy: { createdAt: "asc" } } } });
  if (!sig) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { events, ...s } = sig;
  return NextResponse.json({
    signal: toSignalDTO(s),
    timeline: events.map((e) => ({
      id: e.id,
      type: e.type,
      level: e.level,
      message: e.message,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}

/** PATCH /api/signals/[id]
 *  { action: "NOTES", notes: string }         — operator journal upsert
 *  { action: "TAGS", tags: string[] }         — operator tag editor (normalized;
 *                                              v10.16: MERGES with engine cohort tags —
 *                                              removing a protected tag → 409, no mutation)
 *  { action: "CLOSE" }                        — DISABLED (v6.0): exits are engine-managed (TP/SL/TTL) — no manual lifecycle control
 */
const NOTES_MAX = 2000;
const NOTES_TS = () => new Date().toISOString().slice(11, 19) + "Z";

const TAGS_MAX = 8;
const TAG_LEN_MAX = 28;

/* ── v10.16 PROTECTED ENGINE COHORT TAGS (audit 4-f) ─────────────────────
 * The engine stamps every signal with cohort tags its gates/filters slice on
 * AT SETTLE TIME (evidence: src/lib/engine.ts, tag composition ~1814-1865):
 *   EPOCH-2          engine.ts:1838 — ledger epoch; memory-gate + calibration
 *                    filter on it (engine.ts:757,766; calibration.ts; raw-cal.ts:115)
 *   RAW-CAL          engine.ts:1852 — capture cohort; raw-cal.ts:217,266-270 +
 *                    rawcal-quality.ts:300 filter on it (R6 quality gate!)
 *   RADAR-TTL        engine.ts:1855 — radar cohort; resolve checks it for the
 *                    no-extension rule (engine.ts:551 tags.split(",").includes)
 *   MG-PROBE         engine.ts:1861 — memory-gate hysteresis cohort; probe
 *                    block queries it (engine.ts:788 tags contains)
 *   G4-PROBE         engine.ts:1858 — G4 recovery-probe cohort evidence
 *   BO-EXP           engine.ts:1848 — breakout trial A/B arm the advisor judges
 *   VOL-ONSET-RETEST engine.ts:1827 — fast-kill A/B arm ("judged exactly like BO-EXP")
 *   RISK-CAP         engine.ts:1828 — risk-capped A/B arm (same advisor cohort)
 *   DISLOCATION-HALF engine.ts:1864 — v10.15 warn-band adverse-selection cohort
 *   MTF-ALIGNED / MTF-CONFLICT / MTF-CONSENSUS
 *                    engine.ts:1840-1841 — multi-TF flow board A/B arms
 *   STRATW- / STRAT-PROB- prefixes
 *                    engine.ts:1831,1834 — parametrized sizing cohorts
 *                    (STRATW-x1.15, STRAT-PROB-x0.50) — prefix-protected.
 * NOTE: DECISIVE and VOL-BARRIER (also named by the audit) are GATE-JOURNAL
 * gate names (engine.ts:1614,1655 recordGateBlock), NOT signal tags; BE-TRAIL
 * appears only in a comment (engine.ts:444) — none are signal tags, so they
 * are not protected here. Informational chips (WHALE-PRINT, LIQ-SWEEP,
 * FUNDING-SKEW-*, EVENT-TRIGGER, CROWD-CUT, VOLCAUSE-*) stay freely editable.
 * Behavior: a TAGS edit that would REMOVE any protected tag present on the
 * record → 409 without mutating; otherwise the result is the UNION of the
 * operator's tags and the protected tags that existed before (merge, not
 * replace) — free-text operator tags remain fully editable. */
const PROTECTED_TAGS = [
  "EPOCH-2",
  "RAW-CAL",
  "RADAR-TTL",
  "MG-PROBE",
  "G4-PROBE",
  "BO-EXP",
  "VOL-ONSET-RETEST",
  "RISK-CAP",
  "DISLOCATION-HALF",
  "MTF-ALIGNED",
  "MTF-CONFLICT",
  "MTF-CONSENSUS",
] as const;
const PROTECTED_TAG_PREFIXES = ["STRATW-", "STRAT-PROB-"] as const;

/** A record tag is protected when it is an exact cohort literal or carries a
 * protected cohort prefix (parametrized sizing cohorts). Returns the FULL tag
 * (so removal checks and the merge union operate on the record's real tag). */
function protectedTagOf(tag: string): string | null {
  if ((PROTECTED_TAGS as readonly string[]).includes(tag)) return tag;
  return PROTECTED_TAG_PREFIXES.some((p) => tag.startsWith(p)) ? tag : null;
}

/** Normalize raw operator tags → uppercase kebab tokens (deduped, capped).
 *  "  my edge! " → "MY-EDGE" · "#vwap" → "VWAP" · junk stripped. */
function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const token = item
      .trim()
      .replace(/^#+/, "")
      .toUpperCase()
      .replace(/\s+/g, "-")
      .replace(/[^A-Z0-9-]/g, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, TAG_LEN_MAX);
    if (token && !out.includes(token)) out.push(token);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  /* ── operator journal ─────────────────────────────────── */
  if (body.action === "NOTES") {
    const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, NOTES_MAX) : "";
    const sig = await db.signal.findUnique({ where: { id } });
    if (!sig) return NextResponse.json({ error: "not found" }, { status: 404 });

    const updated = await db.signal.update({
      where: { id },
      data: { operatorNotes: notes, notesUpdatedAt: notes ? new Date() : null },
    });
    return NextResponse.json({ signal: toSignalDTO(updated), savedAt: NOTES_TS() });
  }

  /* ── operator tags ───────────────────────────────────── */
  if (body.action === "TAGS") {
    const tags = normalizeTags(body.tags);
    const sig = await db.signal.findUnique({ where: { id } });
    if (!sig) return NextResponse.json({ error: "not found" }, { status: 404 });

    // v10.16 MERGE-NOT-REPLACE (audit 4-f): the old code replaced the whole
    // tags string, so a routine operator edit silently ERASED the engine cohort
    // tags (EPOCH-2, RAW-CAL, MG-PROBE, …) that gates filter on at settle time.
    const before = (sig.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const protectedBefore = [...new Set(before.map(protectedTagOf).filter((t): t is string => t !== null))];
    // removal guard — refuse BEFORE any mutation (409, nothing written)
    const removed = protectedBefore.filter((t) => !tags.includes(t));
    if (removed.length > 0) {
      return NextResponse.json(
        { error: "protected engine cohort tags cannot be removed", protected: removed },
        { status: 409 },
      );
    }
    // union: protected tags that existed before + the operator's free-text tags
    // (protected first so the TAGS_MAX budget can never crowd them back out;
    // normalizeTags already caps the submitted set at TAGS_MAX)
    const merged: string[] = [...protectedBefore];
    for (const t of tags) if (!merged.includes(t)) merged.push(t);

    const updated = await db.signal.update({
      where: { id },
      data: { tags: merged.join(",") },
    });
    return NextResponse.json({ signal: toSignalDTO(updated), savedAt: NOTES_TS() });
  }

  /* ── v6.0 TOTAL AUTONOMY: manual close removed ─────────── */
  if (body.action === "CLOSE") {
    return NextResponse.json(
      { error: "manual close disabled — position exits are engine-managed (TP1/TP2/TP3 ladder, stop, TTL) under total autonomy" },
      { status: 423 },
    );
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
