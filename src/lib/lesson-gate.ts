import type { DeepLearnLesson } from "@/lib/tp3-lab";

// ── v9.3 LESSON GATE — deep-learn lessons → entry threshold (operator mandate ب) ──
// Audit finding (2026-09-13): the deep-learn module had produced 100+ research
// runs / 180+ lessons, but ZERO of them reached the deploy path — the entry gate
// consumed only GateSettings + caches, so "learning" never touched "trading".
// This module closes that loop DETERMINISTICALLY (no LLM in the hot path):
//   · SL-scope lessons      → raise the effective threshold (anti-repeat-loss)
//   · MIXED-scope lessons   → small threshold raise
//   · TP3_FULL-scope lessons→ small threshold discount (what worked, admit more)
// Keyword polarity is parsed from the lesson's own pattern/action text, the
// contribution is confidence-weighted, only fresh (≤6h) lessons count, and the
// total adjustment is asymmetrically clamped to [−3, +8] — anti-loss bias first,
// the gate may never loosen more than it can tighten. Every deployment's gate
// journal carries the `lesson` term so the operator can audit the injection.

export interface LessonGateResult {
  adj: number; // signed threshold adjustment (added to effMin)
  note: string | null; // journal note (which lessons spoke and how much)
  applied: number; // how many lessons contributed
}

const CACHE_MS = 5 * 60_000; // deep-learn cycles every ~30min — a 5min cache is fresh
const FRESH_MS = 6 * 3600_000; // lessons older than 6h no longer speak
const MIN_CONFIDENCE = 60; // below this the lesson is research noise
const CLAMP_LO = -3; // max loosening (TP3_FULL evidence only)
const CLAMP_HI = 8; // max tightening (anti-loss bias)
const SCOPE_WEIGHT: Record<DeepLearnLesson["scope"], number> = { SL: 1.2, MIXED: 1.0, TP3_FULL: 0.8 };

// tighten-polarity verbs (loss avoidance language) vs loosen-polarity (edge-admission language)
const TIGHTEN_RE = /(tighten|rais\w*|avoid|reduc\w*|skip|block|filter|require|suppress|throttle|narrow|refuse|lower the size|cut|veto|chop|late)/;
const LOOSEN_RE = /(widen|relax|admit|allow|permit|keep buying|reward|stretch|favored|works)/;

let cache: { at: number; res: LessonGateResult } | null = null;

function evalLessons(lessons: DeepLearnLesson[]): LessonGateResult {
  const now = Date.now();
  let adj = 0;
  let applied = 0;
  const bits: string[] = [];
  for (const l of lessons) {
    const atMs = new Date(l.at).getTime();
    if (!Number.isFinite(atMs) || now - atMs > FRESH_MS) continue;
    if (l.confidence < MIN_CONFIDENCE) continue;
    const text = `${l.pattern} ${l.action}`.toLowerCase();
    const tighten = TIGHTEN_RE.test(text);
    const loosen = !tighten && LOOSEN_RE.test(text);
    if (!tighten && !loosen) continue;
    // contribution 0..~3.6 per lesson, scaled by scope weight (loss lessons weigh most)
    const base = ((Math.min(100, l.confidence) - MIN_CONFIDENCE) / (100 - MIN_CONFIDENCE)) * 3 * (SCOPE_WEIGHT[l.scope] ?? 1);
    if (tighten) {
      adj += base;
      applied++;
      if (bits.length < 3) bits.push(`${l.scope}:${l.label} +${base.toFixed(1)}`);
    } else if (l.scope === "TP3_FULL") {
      // only FULL-TAKE-PROFIT lessons may loosen the gate — loss lessons never do
      adj -= base * 0.5;
      applied++;
      if (bits.length < 3) bits.push(`TP3_FULL:${l.label} −${(base * 0.5).toFixed(1)}`);
    }
  }
  const clamped = Math.max(CLAMP_LO, Math.min(CLAMP_HI, adj));
  const rounded = Math.round(clamped * 2) / 2; // half-point granularity
  return {
    adj: rounded,
    applied,
    note: applied > 0 ? `LESSON-GATE ${rounded >= 0 ? "+" : ""}${rounded} (${bits.join(" · ")}${bits.length < applied ? ` +${applied - bits.length} more` : ""})` : null,
  };
}

/** Deterministic threshold adjustment from the fresh deep-learn lesson ring. */
export async function lessonThrAdj(): Promise<LessonGateResult> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.res;
  let res: LessonGateResult = { adj: 0, note: null, applied: 0 };
  try {
    // dynamic import — tp3-lab drags the AI stack; keep it off the engine's
    // static import graph (cycle-safe, boot-path-light)
    const { getDeepLearnState } = await import("@/lib/tp3-lab");
    const st = await getDeepLearnState();
    if (st.lessons.length > 0) res = evalLessons(st.lessons);
  } catch {
    /* fail-open: no lessons → no adjustment */
  }
  cache = { at: Date.now(), res };
  return res;
}
