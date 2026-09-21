// ── FlowRadar Neo TP3 DEEP-LAB + DEEP-LEARN LOOP (server-only, v5.4) ──
// Operator request: full-TP (TP3) signals get their OWN calculator with a
// deeper learning cycle, and both full-TP + stopped-out signals go through an
// LLM research Q&A ("why did this win big / why did this die?"). The resulting
// lessons are persisted, broadcast to the event feed, injected into every AI
// agent's grounding (chat / governor / card briefs), and audited in EngineSetting.

import { db } from "@/lib/db";
import type { Signal } from "@prisma/client";
// v8.2 GATE GAUGE — the central core studies the LIVE confirm/reject ledger
// (boundary-band verdicts + hard blocks with their full reason payload)
// alongside the terminal outcomes, so lessons attribute RESULTS to REASONS.
import { gateJournalForCore } from "@/lib/gate-journal";
import { shadowVetoForCore } from "@/lib/shadow-veto";
import { svTelemetryNarrative } from "@/lib/sv-telemetry"; // v10.2 — the core studies its own feed wiring
import { fourpackNarrative } from "@/lib/fourpack-journal"; // v10.8 — the core studies the GOVERNOR FOUR-PACK journal

// ─────────────────────────────────────────────────────────────
// TP3 LAB — the separate full-TP calculator
// ─────────────────────────────────────────────────────────────

export interface Tp3Case {
  serial: number;
  symbol: string;
  direction: string;
  strategy: string;
  outcome: "TP3_FULL" | "SL";
  confidence: number;
  riskReward: number;
  timeframe: string;
  holdMinutes: number;
  reachedTp: number;
  maxPnlPercent: number;
  netPnlPercent: number;
  flowVerdict: string | null;
  flowScore: number | null;
  regimeTag: string | null;
  tags: string[];
  factorVotes: Array<{ factor: string; vote: number }> | null;
  occurredAt: string;
}

export interface Tp3Lab {
  windowDays: number;
  fullTp: {
    count: number;
    ratePct: number;
    avgConfidence: number;
    avgRr: number;
    avgHoldMin: number;
    flowConfirmShare: number;
    topTags: Array<[string, number]>;
    topSymbols: Array<[string, number]>;
    byStrategy: Record<string, number>;
  };
  stopped: {
    count: number;
    avgConfidence: number;
    avgHoldMin: number;
    flowConflictShare: number;
    topTags: Array<[string, number]>;
    byStrategy: Record<string, number>;
  };
  contrast: { confDelta: number; rrDelta: number; note: string };
  recentCases: Tp3Case[];
}

function tagList(s: { tags: string | null }): string[] {
  return (s.tags ?? "").split(",").filter(Boolean);
}

function topN(counter: Map<string, number>, n: number): Array<[string, number]> {
  return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Parse the regime tag out of the deployment tags (REGIME-*). */
function regimeOf(tags: string[]): string | null {
  return tags.find((t) => t.startsWith("REGIME-")) ?? null;
}

/** Case-file mapper — module scope so both buildTp3Lab and runDeepLearnCycle share it. */
function toCase(s: Signal): Tp3Case {
  let votes: Array<{ factor: string; vote: number }> | null = null;
  if (s.factorsJson) {
    try {
      const parsed = JSON.parse(s.factorsJson) as Array<{ factor?: string; vote?: number }>;
      votes = parsed.map((v) => ({ factor: String(v.factor ?? "?"), vote: Number(v.vote ?? 0) }));
    } catch {
      votes = null;
    }
  }
  let flowVerdict: string | null = null;
  let flowScore: number | null = null;
  if (s.flowJson) {
    try {
      const f = JSON.parse(s.flowJson) as { verdict?: string; score?: number };
      flowVerdict = f.verdict ?? null;
      flowScore = typeof f.score === "number" ? f.score : null;
    } catch {
      /* keep nulls */
    }
  }
  const tags = tagList(s);
  return {
    serial: s.serial,
    symbol: s.symbol,
    direction: s.direction,
    strategy: s.strategy,
    outcome: s.status === "TP3" ? "TP3_FULL" : "SL",
    confidence: s.confidence,
    riskReward: s.riskReward,
    timeframe: s.timeframe,
    holdMinutes: s.closedAt && s.createdAt ? Math.round((s.closedAt.getTime() - s.createdAt.getTime()) / 60_000) : 0,
    reachedTp: s.reachedTp,
    maxPnlPercent: s.maxPnlPercent,
    netPnlPercent: s.pnlPercent,
    flowVerdict,
    flowScore,
    regimeTag: regimeOf(tags),
    tags,
    factorVotes: votes,
    occurredAt: (s.closedAt ?? s.createdAt).toISOString(),
  };
}

export async function buildTp3Lab(windowDays = 14): Promise<Tp3Lab> {
  const since = new Date(Date.now() - windowDays * 24 * 3600_000);
  const rows = await db.signal.findMany({
    where: { status: { in: ["TP3", "SL"] }, closedAt: { gte: since } },
    orderBy: { closedAt: "desc" },
    take: 120,
  });

  const full = rows.filter((s) => s.status === "TP3");
  const stopped = rows.filter((s) => s.status === "SL");
  const cases = rows.map(toCase);
  const fullCases = cases.filter((c) => c.outcome === "TP3_FULL");
  const stoppedCases = cases.filter((c) => c.outcome === "SL");

  const countTags = (list: typeof cases) => {
    const m = new Map<string, number>();
    for (const c of list) for (const t of c.tags) if (!t.startsWith("REGIME-")) m.set(t, (m.get(t) ?? 0) + 1);
    return topN(m, 4);
  };
  const countStrategy = (list: typeof cases) => {
    const m: Record<string, number> = {};
    for (const c of list) m[c.strategy] = (m[c.strategy] ?? 0) + 1;
    return m;
  };
  const countSymbols = (list: typeof cases) => {
    const m = new Map<string, number>();
    for (const c of list) m.set(c.symbol, (m.get(c.symbol) ?? 0) + 1);
    return topN(m, 4);
  };
  const avg = (nums: number[]): number => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);

  const fullTp = {
    count: fullCases.length,
    ratePct: rows.length ? Number(((fullCases.length / rows.length) * 100).toFixed(1)) : 0,
    avgConfidence: Math.round(avg(fullCases.map((c) => c.confidence))),
    avgRr: Number(avg(fullCases.map((c) => c.riskReward)).toFixed(2)),
    avgHoldMin: Math.round(avg(fullCases.map((c) => c.holdMinutes))),
    flowConfirmShare: fullCases.length ? Number(((fullCases.filter((c) => c.flowVerdict === "CONFIRMS").length / fullCases.length) * 100).toFixed(0)) : 0,
    topTags: countTags(fullCases),
    topSymbols: countSymbols(fullCases),
    byStrategy: countStrategy(fullCases),
  };
  const stoppedStats = {
    count: stoppedCases.length,
    avgConfidence: Math.round(avg(stoppedCases.map((c) => c.confidence))),
    avgHoldMin: Math.round(avg(stoppedCases.map((c) => c.holdMinutes))),
    flowConflictShare: stoppedCases.length ? Number(((stoppedCases.filter((c) => c.flowVerdict === "CONFLICTS").length / stoppedCases.length) * 100).toFixed(0)) : 0,
    topTags: countTags(stoppedCases),
    byStrategy: countStrategy(stoppedCases),
  };

  const confDelta = fullTp.avgConfidence - stoppedStats.avgConfidence;
  const rrDelta = Number((fullTp.avgRr - avg(stoppedCases.map((c) => c.riskReward))).toFixed(2));
  const contrast = {
    confDelta,
    rrDelta,
    note:
      fullCases.length && stoppedCases.length
        ? `full-TP winners deployed at ${confDelta >= 0 ? "+" : ""}${confDelta} conviction vs stop-outs, with ${rrDelta >= 0 ? "+" : ""}${rrDelta} wider targets — winners ran ${fullTp.avgHoldMin}m avg vs ${stoppedStats.avgHoldMin}m for losers`
        : "not enough TP3/SL pairs in the window for a contrast read",
  };

  return { windowDays, fullTp, stopped: stoppedStats, contrast, recentCases: cases.slice(0, 10) };
}

// ─────────────────────────────────────────────────────────────
// DEEP-LEARN LOOP — LLM research Q&A over full-TP + stop-out cases
// ─────────────────────────────────────────────────────────────

export interface DeepLearnLesson {
  at: string;
  scope: "TP3_FULL" | "SL" | "MIXED";
  pattern: string;
  evidence: string;
  action: string;
  confidence: number;
  label: "MODEL" | "HEURISTIC";
}

export interface DeepLearnState {
  lastRunAt: string | null;
  runs: number;
  casesLearned: number;
  lessons: DeepLearnLesson[]; // ring, newest first
  lastQuestion: string | null;
  lastAnswer: string | null;
  label: "MODEL" | "HEURISTIC" | "IDLE";
}

const RING_CAP = 12;
const PERSIST_KEY = "deep-learn";
const MIN_INTERVAL_MS = 30 * 60_000; // autonomous cycle every ~30min
const state: DeepLearnState = { lastRunAt: null, runs: 0, casesLearned: 0, lessons: [], lastQuestion: null, lastAnswer: null, label: "IDLE" };

let restored = false;

async function persistState(): Promise<void> {
  try {
    await db.engineSetting.upsert({ where: { key: PERSIST_KEY }, create: { key: PERSIST_KEY, value: JSON.stringify(state) }, update: { value: JSON.stringify(state) } });
  } catch {
    /* non-fatal */
  }
}

export async function getDeepLearnState(): Promise<DeepLearnState> {
  await restoreState();
  return { ...state };
}

async function restoreState(): Promise<void> {
  if (restored) return;
  restored = true;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: PERSIST_KEY } });
    if (!row) return;
    const v = JSON.parse(row.value) as Partial<DeepLearnState>;
    if ((v.runs ?? 0) > state.runs) {
      state.lastRunAt = v.lastRunAt ?? null;
      state.runs = v.runs ?? 0;
      state.casesLearned = v.casesLearned ?? 0;
      state.lessons = v.lessons ?? [];
      state.lastQuestion = v.lastQuestion ?? null;
      state.lastAnswer = v.lastAnswer ?? null;
      state.label = v.label ?? "IDLE";
    }
  } catch {
    /* fresh start */
  }
}

/** Compact, audit-grade case file — the ONLY facts the LLM may reason over. */
function caseFile(c: Tp3Case): string {
  const flow = c.flowVerdict ? `${c.flowVerdict} ${c.flowScore !== null ? `${c.flowScore >= 0 ? "+" : ""}${c.flowScore}/25` : ""}` : "n/a";
  const votes = c.factorVotes && c.factorVotes.length ? c.factorVotes.map((v) => `${v.factor}${v.vote >= 0 ? "+" : ""}${v.vote}`).join(",") : "n/a";
  return [
    `NX-${String(c.serial).padStart(4, "0")} ${c.symbol} ${c.direction} ${c.strategy} ${c.timeframe} → ${c.outcome}`,
    `conf ${c.confidence} · RR ${c.riskReward} · held ${c.holdMinutes}m · ladder ${c.reachedTp}/3 · maxPnl ${c.maxPnlPercent.toFixed(1)}% · net ${c.netPnlPercent.toFixed(1)}%`,
    `flow ${flow} · regime ${c.regimeTag ?? "n/a"} · tags ${c.tags.join(",") || "n/a"} · votes ${votes}`,
  ].join(" | ");
}

/**
 * Deep-learn cycle: pull un-learned TP3/SL outcomes since the last run, run the
 * LLM research Q&A, persist the lessons, broadcast ONE audited feed event.
 */
export async function runDeepLearnCycle(force = false): Promise<{ ran: boolean; learned: number; reason?: string }> {
  await restoreState();
  if (!force && state.lastRunAt && Date.now() - new Date(state.lastRunAt).getTime() < MIN_INTERVAL_MS) {
    return { ran: false, learned: 0, reason: "throttled (30min)" };
  }

  const since = state.lastRunAt ? new Date(state.lastRunAt) : new Date(Date.now() - 48 * 3600_000);
  const rows = await db.signal.findMany({
    where: { status: { in: ["TP3", "SL"] }, closedAt: { gt: since } },
    orderBy: { closedAt: "asc" },
    take: 8,
  });
  if (rows.length === 0) {
    state.lastRunAt = new Date().toISOString();
    await persistState();
    return { ran: false, learned: 0, reason: "no new TP3/SL outcomes since last cycle" };
  }

  const lab = await buildTp3Lab(14);
  // v8.2 GATE GAUGE — live reason ledger for the core (boundary band + blocks)
  const gate = await gateJournalForCore(12, 8);
  // v8.2 SHADOW-VETO Phase 0 — the core's own fence adjudications + A/B arms
  const shadow = await shadowVetoForCore(6).catch(() => ({ narrative: "SHADOW-VETO: unavailable this cycle.", verdictFiles: [] as string[] }));
  // v10.2 SV-TELEMETRY — arm feed wiring narrative (best-effort, never blocks)
  const svTel = await svTelemetryNarrative().catch(() => "SV-TELEMETRY: unavailable this cycle.");
  // v10.8 FOUR-PACK journal — governance module verdicts in the research grounding
  const fpTel = await fourpackNarrative().catch(() => "FOUR-PACK: unavailable this cycle.");
  const gateGrounding = [
    `GATE JOURNAL (live, 12h): ${gate.narrative}`,
    ...gate.boundaryFiles.slice(0, 8).map((l) => `BOUNDARY VERDICT: ${l}`),
    ...gate.blockFiles.map((l) => `GATE BLOCK: ${l}`),
    `SHADOW-VETO: ${shadow.narrative}`,
    `SV-TELEMETRY: ${svTel}`,
    `FOUR-PACK: ${fpTel}`,
    ...shadow.verdictFiles.slice(0, 6).map((l) => `SHADOW ADJUDICATION: ${l}`),
  ].join("\n");
  const tp3Cases = rows.filter((r) => r.status === "TP3").map(toCase);
  const slCases = rows.filter((r) => r.status === "SL").map(toCase);
  const allCases = [...tp3Cases, ...slCases].map(caseFile).join("\n");

  const question = [
    `RESEARCH QUESTIONS for this cycle (${tp3Cases.length} full-TP, ${slCases.length} stopped-out):`,
    "1. What did the full-TP winners share at deploy time (confluence votes, flow verdict, regime, conviction, R:R) that let them run the whole ladder?",
    "2. What did the stopped-out trades show that should have been a warning?",
    "3. Which single, measurable behaviour change would most improve the next 20 deployments?",
    // v8.2 GATE GAUGE — reason-level research question fed by the live journal
    "4. GATE JOURNAL (below): the boundary band (gap −8..0 from the effective threshold) is where confirm and reject blur — which boundary reasons (thr modifiers, opposing votes, hard blocks) actually predicted later TP3 vs SL outcomes, and which gate modifier deserves tightening or loosening on that measured evidence?",
    // v8.2 SHADOW-VETO — the core's own adjudication quality
    "5. SHADOW-VETO (below): your own veto-only adjudications at the fence are now outcome-tracked — are your VETO calls landing on trades that lose and your TRADE calls on trades that win? Cite the A/B arms (real-keep / real-veto / paper-keep / paper-veto) with their Wilson-LB numbers; if any arm has <30 settled outcomes, say the evidence is still forming — never extrapolate from thin arms.",
  ].join(" ");

  const grounding = [
    "TP3 LAB CONTRAST (measured, 14d): " + lab.contrast.note,
    `FULL-TP profile: n=${lab.fullTp.count} rate ${lab.fullTp.ratePct}% avgConf ${lab.fullTp.avgConfidence} avgRR ${lab.fullTp.avgRr} flow-CONFIRMS ${lab.fullTp.flowConfirmShare}% tags ${lab.fullTp.topTags.map(([t, n]) => `${t}×${n}`).join(",") || "n/a"}`,
    `STOP-OUT profile: n=${lab.stopped.count} avgConf ${lab.stopped.avgConfidence} held ${lab.stopped.avgHoldMin}m flow-CONFLICTS ${lab.stopped.flowConflictShare}% tags ${lab.stopped.topTags.map(([t, n]) => `${t}×${n}`).join(",") || "n/a"}`,
    "CASE FILES:",
    allCases,
    // v8.2 GATE JOURNAL — the reasons layer the boundary band lives on
    gateGrounding,
  ].join("\n");

  const { aiDeepLearn } = await import("./ai");
  const result = await aiDeepLearn(grounding, question, lab);

  // persist lessons (newest first, ring-capped)
  const at = new Date().toISOString();
  const lessons: DeepLearnLesson[] = result.lessons.map((l) => ({ at, scope: l.scope, pattern: String(l.pattern).slice(0, 240), evidence: String(l.evidence).slice(0, 300), action: String(l.action).slice(0, 240), confidence: Math.max(0, Math.min(100, Math.round(Number(l.confidence) || 60))), label: result.label }));
  state.lessons = [...lessons, ...state.lessons].slice(0, RING_CAP);
  state.lastQuestion = question.slice(0, 600);
  state.lastAnswer = String(result.hypothesis ?? "").slice(0, 2400);
  state.lastRunAt = at;
  state.runs++;
  state.casesLearned += rows.length;
  state.label = result.label;
  await persistState();

  // broadcast the strongest lesson to the terminal feed (audited)
  const lead = lessons[0];
  if (lead) {
    await db.signalEvent.create({
      data: {
        signalId: null,
        symbol: null,
        type: "ENGINE",
        level: "ai",
        message: `AI DEEP-LEARN #${state.runs}: studied ${rows.length} terminal outcomes (${tp3Cases.length} full-TP / ${slCases.length} stopped) — [${lead.scope}] ${lead.pattern} → ${lead.action} (${lead.label}, conf ${lead.confidence}%) · lesson stored to agent memory`,
      },
    });
  }
  return { ran: true, learned: rows.length };
}

/** Throttled entrypoint for the engine tick. */
export async function maybeAutoDeepLearn(): Promise<void> {
  try {
    await runDeepLearnCycle(false);
  } catch (err) {
    console.error("[deep-learn]", err);
  }
}
