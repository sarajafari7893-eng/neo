// ── FlowRadar Neo v8.2 VERDICT-CORE (server-only) ──
// Operator mandate 2026-09-08: «...و جورنال را به هسته مرکزی برای یادگیری
// عمیق از دلایل ارسال کند، از این طریق هم موتور و هم من میتوانیم دقیقا کدام
// دلایل رد و تایید بر چه اساس است و وضعیت را بررسی کنیم.»
//
// Division of labour (converged with the parallel review loop):
//   · lib/gate-journal.ts — the CAPTURE surface: every threshold verdict,
//     hard gate block and deployment journaled (memory rings + JSONL).
//   · THIS module — the LEARNING surface: the central AI core cadence that
//     studies the journal (gateJournalForCore + shadowVetoForCore grounding),
//     derives grounded findings via the LLM research desk (aiVerdictLearn),
//     and persists the state consumed by /api/gauge (GateGaugeDTO.core) and
//     the analyst grounding. Honesty contract: only measured numbers enter
//     the bundle; since SHADOW-VETO Phase 0 (2026-09-09) the fence is
//     outcome-tracked — real linkage for hair-thin passes, clearly-labeled
//     PAPER outcomes for fence rejects.

import { db } from "@/lib/db";
import { gateJournalForCore } from "@/lib/gate-journal";
import { shadowVetoForCore } from "@/lib/shadow-veto";
import { svTelemetryNarrative } from "@/lib/sv-telemetry"; // v10.2 — the core studies its own feed wiring
import { fourpackNarrative } from "@/lib/fourpack-journal"; // v10.8 — the core studies the GOVERNOR FOUR-PACK journal

export interface VerdictCoreLesson {
  at: string;
  scope: string;
  pattern: string;
  action: string;
  label: string; // MODEL | HEURISTIC
  confidence: number;
  evidence?: string;
}

/** Mirrors GateGaugeDTO["core"] so /api/gauge can pass it straight through. */
export interface VerdictCoreState {
  runs: number;
  lastRunAt: string | null;
  lastAnswer: string | null;
  lessons: VerdictCoreLesson[];
}

// ── DETERMINISTIC LESSON VERIFIER (VERDICT-CORE audit 2026-11-05, operator mandate)
// The LLM lesson-writer was caught twice in cycle #1410: a fabricated quantifier
// ("8/8 PUMPUSDT" — actual 1/8) and a category error (symbols called strategies).
// Contract: every numeric claim a lesson makes is re-checked against the SAME
// measured rows the model studied; failures are ANNOTATED (never silently
// rewritten) and confidence is capped (مصوبه (ج)). Fail-open — verification
// must never break the learning cycle.

const VERIFIER_SYMBOL_RE = /\b([A-Z0-9]{3,12}USDT)\b/g;
// "8/8 PUMPUSDT" AND the compressed form "8/8 boundary rejects (ZECUSDT, PUMPUSDT)"
// (cycle #1411 showed the model bridges the quantifier to the symbol with prose)
const VERIFIER_QUANT_RE = /(\d{1,3})\s*\/\s*(\d{1,3})(?:[^\n]{0,40}?)([A-Z0-9]{3,12}USDT)/g;
// census forms: "703 REGIME" (cycle #1410) AND "REGIME violations (684/800)" (cycle #1411)
const VERIFIER_BLOCK_RE = /(\d{2,7})\s+(REGIME|MEMORY|STRATEGY|LEARNED|FLOW|DECISIVE|ONSET-RETEST|RISK-CLUSTER)\b/g;
const VERIFIER_BLOCK_FRAC_RE = /\b(REGIME|MEMORY|STRATEGY|LEARNED|FLOW|DECISIVE|ONSET-RETEST|RISK-CLUSTER)\b[^.\n]{0,30}?(\d{2,7})\s*\/\s*\d{2,7}/g;

interface VerifierCtx {
  boundarySamples: Array<{ symbol: string; direction: string }>;
  stats: {
    windowHours: number;
    blocks: Array<{ gate: string; count: number }>;
    blocksRingSaturated?: boolean;
    blocksRingSize?: number;
  };
}

interface VerifierResult {
  evidence: string | undefined;
  confidence: number;
  corrected: boolean;
}

function verifyLessonFinding(
  finding: { pattern: string; evidence?: string; confidence: number },
  ctx: VerifierCtx,
): VerifierResult {
  try {
    const text = `${finding.pattern} ${finding.evidence ?? ""}`;
    const notes: string[] = [];
    let corrected = false;

    // ① quantifier check — "N/M SYMBOL" vs the boundary files actually studied
    for (const m of text.matchAll(new RegExp(VERIFIER_QUANT_RE.source, "g"))) {
      const sym = m[3];
      const claimed = Number(m[1]);
      const actual = ctx.boundarySamples.filter((s) => s.symbol === sym).length;
      if (actual < claimed) {
        corrected = true;
        notes.push(`QUANTIFIER-MISMATCH ${sym}: claimed ${m[1]}/${m[2]}, the boundary files studied contain ${actual}`);
      }
    }

    // ② hard-block census check — block counts vs a saturated ring snapshot
    //    (both word orders: "703 REGIME" and "REGIME violations (684/800)")
    const censusA = [...text.matchAll(new RegExp(VERIFIER_BLOCK_RE.source, "g"))]
      .filter((m) => Number(m[1]) >= 50).map((m) => m[2]);
    const censusB = [...text.matchAll(new RegExp(VERIFIER_BLOCK_FRAC_RE.source, "g"))]
      .filter((m) => Number(m[2]) >= 50).map((m) => m[1]);
    const citesBlockCensus = censusA.length > 0 || censusB.length > 0; // only census-scale numbers, not "1/7 flagged"
    if (citesBlockCensus && ctx.stats.blocksRingSaturated) {
      corrected = true;
      const gates = [...new Set([...censusA, ...censusB])].join(", ");
      notes.push(`RING-SNAPSHOT ${gates ? `(${gates}) ` : ""}block counts here are the newest ~${ctx.stats.blocksRingSize ?? 800} accepted records (≈60-90min churn), not the ${ctx.stats.windowHours}h census`);
    }

    // symbol-presence sanity: a lesson naming a symbol absent from the studied rows
    for (const m of text.matchAll(new RegExp(VERIFIER_SYMBOL_RE.source, "g"))) {
      const sym = m[1];
      const inBoundary = ctx.boundarySamples.some((s) => s.symbol === sym);
      const inBlocks = ctx.stats.blocks.some((b) => (b.gate === "REGIME" || b.gate === "MEMORY") && b.count > 0); // weak proxy — block lastReason not per-symbol here
      if (!inBoundary && !inBlocks && ctx.boundarySamples.length > 0) {
        corrected = true;
        notes.push(`SYMBOL-UNVERIFIED ${sym}: not present in the boundary files studied this cycle`);
        break; // one flag per finding is enough
      }
    }

    let confidence = Math.round(finding.confidence);
    if (corrected) {
      confidence = Math.min(confidence, 70); // (ج) cap for corrected lessons
    } else if (
      new RegExp(VERIFIER_QUANT_RE.source).test(text) ||
      [...text.matchAll(new RegExp(VERIFIER_BLOCK_RE.source, "g"))].some((m) => Number(m[1]) >= 50) ||
      [...text.matchAll(new RegExp(VERIFIER_BLOCK_FRAC_RE.source, "g"))].some((m) => Number(m[2]) >= 50)
    ) {
      confidence = Math.min(confidence, 90); // (ج) cap for verified numeric lessons
    }

    const evidence = notes.length
      ? `${finding.evidence ?? finding.pattern} [VERIFIER: ${notes.join("; ")}]`
      : finding.evidence;
    return { evidence, confidence, corrected };
  } catch {
    // fail-open — never break the cycle on verifier bugs
    return { evidence: finding.evidence, confidence: Math.round(finding.confidence), corrected: false };
  }
}

const STATE_KEY = "verdictcore.state";
const LAST_RUN_KEY = "verdictcore.lastRun";
const AUTO_INTERVAL_MS = 30 * 60_000;
const MIN_SAMPLES = 5; // below this the journal is too thin for a cycle
const LESSON_CAP = 6;

const EMPTY_STATE: VerdictCoreState = { runs: 0, lastRunAt: null, lastAnswer: null, lessons: [] };

export async function getVerdictCoreState(): Promise<VerdictCoreState> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: STATE_KEY } });
    if (!row) return EMPTY_STATE;
    const parsed = JSON.parse(row.value) as Partial<VerdictCoreState>;
    return {
      runs: Number(parsed.runs) || 0,
      lastRunAt: parsed.lastRunAt ?? null,
      lastAnswer: parsed.lastAnswer ?? null,
      lessons: Array.isArray(parsed.lessons) ? parsed.lessons.slice(0, LESSON_CAP) : [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

async function saveState(state: VerdictCoreState): Promise<void> {
  await db.engineSetting.upsert({
    where: { key: STATE_KEY },
    create: { key: STATE_KEY, value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  });
}

/** Run one VERDICT-CORE cycle: journal → grounded LLM research → persist. */
export async function runVerdictLearn(windowHours = 12): Promise<VerdictCoreState> {
  const journal = await gateJournalForCore(windowHours, 10);
  const stats = journal.stats;

  if (stats.samples === 0) {
    const prev = await getVerdictCoreState();
    const state: VerdictCoreState = {
      ...prev,
      lastAnswer: `Gate journal is empty for the last ${windowHours}h — no threshold verdicts to study yet. The gauge accrues rows automatically (real deploy evaluations + the shadow sweep).`,
    };
    await saveState(state);
    return state;
  }

  // The grounding bundle — ONLY measured numbers (gate-journal guarantees it)
  // v8.2 SHADOW-VETO Phase 0: the fence is now OUTCOME-TRACKED (real linkage
  // for hair-thin passes, honest paper ledger for fence rejects) — the doctrine
  // line and the arms bundle below replace the old OBSERVING-only contract.
  const shadow = await shadowVetoForCore(6).catch(() => ({ narrative: "SHADOW-VETO: unavailable this cycle.", verdictFiles: [] as string[] }));
  // v10.2 SV-TELEMETRY — arm feed wiring narrative (best-effort, never blocks)
  const svTel = await svTelemetryNarrative().catch(() => "SV-TELEMETRY: unavailable this cycle.");
  // v10.8 FOUR-PACK journal — governance module verdicts (R1 risk / R2 time / R5 canary / R6 senior-review)
  const fpTel = await fourpackNarrative().catch(() => "FOUR-PACK: unavailable this cycle.");
  const grounding = [
    `VERDICT-CORE STUDY WINDOW: last ${windowHours}h of the engine's own deploy-gate journal.`,
    journal.narrative,
    "BOUNDARY CASE FILES (candidates that stood exactly on the confirm/reject border):",
    ...(journal.boundaryFiles.length ? journal.boundaryFiles : ["(none in window)"]),
    "HARD GATE BLOCKS:",
    ...(journal.blockFiles.length ? journal.blockFiles : ["(none in window)"]),
    "SHADOW-VETO EVIDENCE (AI-core Phase 0 — your own veto-only second opinion at the fence, outcome-tracked):",
    shadow.narrative,
    ...(shadow.verdictFiles.length ? shadow.verdictFiles : ["(no adjudications yet)"]),
    svTel,
    fpTel,
    "DOCTRINE: veto-only, fail-open, revocable. Real outcomes = settled trades; fence-reject outcomes = PAPER trades with base geometry (directional-edge evidence, never presented as real PnL). Promotion to live veto power requires ≥30 settled per arm + Wilson-LB separation — never claim it before the arms say so.",
  ].join("\n");

  // Adapt the journal stats to the research-desk contract (aiVerdictLearn)
  const adapted = {
    total: stats.samples,
    rejectedScore: stats.byBand.REJECT,
    deployed: stats.deploys,
    boundary: stats.byBand.BOUNDARY,
    avgMarginRejected: stats.boundary?.avgGap ?? null,
    topRejectDrivers: stats.opposeReasons.map((r) => ({ code: r.factor, n: r.count })),
    topConfirmDrivers: stats.confirmReasons.map((r) => ({ code: r.factor, n: r.count })),
  };

  // aiVerdictLearn never throws — it degrades to a deterministic heuristic read
  const { aiVerdictLearn } = await import("@/lib/ai");
  const res = await aiVerdictLearn(grounding, adapted);

  // DETERMINISTIC VERIFICATION — every finding's numeric claims re-checked
  // against the rows the model actually studied (audit 2026-11-05, مصوبه ب/ج)
  const verifierCtx: VerifierCtx = {
    boundarySamples: journal.boundarySamples.map((s) => ({ symbol: s.symbol, direction: s.direction })),
    stats: {
      windowHours: stats.windowHours,
      blocks: stats.blocks.map((b) => ({ gate: b.gate, count: b.count })),
      blocksRingSaturated: stats.blocksRingSaturated,
      blocksRingSize: stats.blocksRingSize,
    },
  };
  const verified = res.findings.map((f) => verifyLessonFinding(f, verifierCtx));
  const correctedCount = verified.filter((v) => v.corrected).length;

  const prev = await getVerdictCoreState();

  // HISTORY HEALING — persisted lessons from earlier cycles keep their original
  // unverified text (e.g. #1410's "8/8 PUMPUSDT" sat at confidence 100). Re-verify
  // every stored lesson that does not already carry a verifier tag; annotate + cap
  // when it fails against the CURRENT studied rows. Verified-clean history is
  // left untouched (no silent downgrades).
  const healedPrev = prev.lessons.map((l) => {
    if ((l.evidence ?? l.pattern).includes("[VERIFIER:")) return l;
    const v = verifyLessonFinding(
      { pattern: l.pattern, evidence: l.evidence, confidence: l.confidence },
      verifierCtx,
    );
    if (!v.corrected) return l;
    return { ...l, confidence: Math.min(l.confidence, v.confidence), evidence: v.evidence ?? l.evidence };
  });
  const healedCount = healedPrev.filter((l, i) => l !== prev.lessons[i]).length;

  const nowIso = new Date().toISOString();
  const lessons: VerdictCoreLesson[] = res.findings.map((f, i) => ({
    at: nowIso,
    scope: "GATE-JOURNAL",
    pattern: f.evidence ? `${f.pattern} — ev: ${f.evidence}` : f.pattern,
    action: f.action,
    label: res.label,
    confidence: verified[i]?.confidence ?? Math.round(f.confidence),
    evidence: verified[i]?.evidence ?? f.evidence,
  }));

  const state: VerdictCoreState = {
    runs: prev.runs + 1,
    lastRunAt: nowIso,
    lastAnswer: correctedCount > 0 ? `${res.digest} [VERIFIER: ${correctedCount} lesson(s) annotated/corrected against the studied rows this cycle]` : res.digest,
    lessons: [...lessons, ...healedPrev].slice(0, LESSON_CAP),
  };
  await saveState(state);

  // audit line in the engine stream (dynamic import — engine imports this module)
  await import("@/lib/engine")
    .then((m) =>
      m.fireEvent(
        null,
        null,
        "ENGINE",
        "ai",
        `VERDICT-CORE cycle #${state.runs} (${res.label}) — studied ${stats.samples} gate verdicts (${stats.byBand.BOUNDARY} boundary · ${stats.byBand.REJECT} rejects · ${stats.deploys} deploys) — top reject driver ${adapted.topRejectDrivers[0]?.code ?? "n/a"}, top confirm driver ${adapted.topConfirmDrivers[0]?.code ?? "n/a"} — verifier: ${correctedCount}/${res.findings.length} findings + ${healedCount} history lessons annotated — lessons persisted to the central core`,
      )
    )
    .catch(() => undefined);

  return state;
}

/** Auto cadence — engine tick calls this; self-throttled to 30min. */
export async function maybeAutoVerdictLearn(): Promise<void> {
  try {
    const lastRow = await db.engineSetting.findUnique({ where: { key: LAST_RUN_KEY } });
    const last = lastRow ? new Date(lastRow.value).getTime() : 0;
    if (Date.now() - last < AUTO_INTERVAL_MS) return;
    await db.engineSetting.upsert({
      where: { key: LAST_RUN_KEY },
      create: { key: LAST_RUN_KEY, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    });
    // journal too thin → skip the LLM burn, retry next cadence
    const probe = await gateJournalForCore(12, 1);
    if (probe.stats.samples < MIN_SAMPLES) return;
    await runVerdictLearn(12);
  } catch (e) {
    console.error("[verdict-core]", e);
  }
}
