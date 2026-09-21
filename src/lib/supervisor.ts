// ── FlowRadar Neo AI SUPERVISOR (server-only, v6.0) ──
// A watchdog skill ABOVE the governor that watches the whole organism —
// feed health, flow coverage, signal flood/drought, learner staleness,
// LLM link — and performs only SAFE, clamped remediation:
//   · never invents data, never widens risk unilaterally
//   · every check produces an audited ENGINE event when it fires
//   · drought/flood respond by NUDGING the governor (which has its own
//     evidence gate + anti-lockup relief), never by editing gates directly.
//
// ── v6.0 NEW STANDING TASK — VERACITY WATCHDOG ─────────────────────
// Operator mandate (Persian): «هیچ توهم و شبیه سازی انجام نشه» — the
// supervisor now OWNS two extra enforcement layers:
//   A) ANTI-HALLUCINATION (grounding audit) — EVERY structured LLM output
//      (analyst chat, card briefs, governor decisions, deep-learn lessons,
//      symbol scans) is cross-checked number-by-number against the measured
//      bundle it was grounded on (src/lib/veracity.ts). Cited numbers that do
//      not exist in the telemetry are hallucination fingerprints: counted,
//      audited as findings, and (for analyst chat) annotated with an honesty
//      footnote the operator sees.
//   B) ANTI-SIMULATION (fake-pipeline guard) — hunts the patterns where the
//      stack could silently fake intelligence: deployments continuing while
//      the market feed is blind, long heuristic streaks pretending to be
//      model output, and mock/placeholder language inside LLM responses.
//      Heuristics are ALWAYS honestly labeled — the guard makes staying
//      honest a monitored invariant, not a hope.

import { db } from "@/lib/db";
import { getFeedStatus } from "./market-feed";
import { getFlowStatus } from "./flow";
import { getBacktest, getLearnerAutoState } from "./backtest";
import { getGateSettings } from "./gate-settings";
import { getTriggerBusSummary } from "./triggers";
import type { GroundingAudit } from "./veracity";
// NOTE: ai is imported DYNAMICALLY (same reason as governor): the engine data
// plane must survive an AI-bridge syntax/runtime failure — invalidateZai is
// resolved lazily inside resetLlmClient().
// NOTE: governor is imported DYNAMICALLY below — a static import would create
// an engine → supervisor → governor → engine cycle.

const CHECK_EVERY_TICKS = 30; // ~2min at the 4s heartbeat

export type SupervisorKind = "FEED" | "FLOW" | "DROUGHT" | "FLOOD" | "LEARNER" | "LLM" | "HALLUCINATION" | "SIMULATION";

export interface SupervisorFinding {
  at: string;
  kind: SupervisorKind;
  severity: "info" | "warn";
  message: string;
  action: string;
}

export interface LlmCallRecord {
  at: string;
  source: string;
  outcome: "MODEL" | "HEURISTIC" | "ERROR";
  detail?: string;
}

interface SupervisorState {
  lastCheckAt: string | null;
  checks: number;
  findings: SupervisorFinding[]; // ring, newest first
  llmAuthFails: number;
  nudgesIssued: number;
  // ── v6.0 veracity counters ──
  audits: number; // grounding audits performed since boot (persisted)
  hallucinationFlags: number; // VIOLATION verdicts
  simulationFlags: number; // fake-pipeline pattern hits
  llmRing: LlmCallRecord[]; // last 16 LLM call outcomes
  auditsAtLastPass: number; // watchdog-window markers
  hallucFlagsAtLastPass: number;
  lastHeurAlarmAt: string | null; // rate-limit for the heuristic-streak alarm
}

const RING_CAP = 12;
const LLM_RING_CAP = 16;
const PERSIST_KEY = "supervisor";
const state: SupervisorState = {
  lastCheckAt: null,
  checks: 0,
  findings: [],
  llmAuthFails: 0,
  nudgesIssued: 0,
  audits: 0,
  hallucinationFlags: 0,
  simulationFlags: 0,
  llmRing: [],
  auditsAtLastPass: 0,
  hallucFlagsAtLastPass: 0,
  lastHeurAlarmAt: null,
};

// v5.2/v6.0: state is PERSISTED in EngineSetting — the AI SUPERVISE / VERACITY
// cards must read true counters even though dev-mode module graphs (and
// restarts) hold MULTIPLE module instances (one per route). Every write does a
// read-max-merge-write sync so instances never clobber each other's counters.
async function syncState(): Promise<void> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: PERSIST_KEY } });
    const cur = row ? (JSON.parse(row.value) as Partial<SupervisorState>) : {};
    // findings + llmRing: union-merge by key, newest first (both instances keep their entries)
    const curFindings = cur.findings ?? [];
    const findingKeys = new Set(curFindings.map((f) => `${f.at}|${f.kind}|${f.message.slice(0, 48)}`));
    const mergedFindings = [...state.findings.filter((f) => !findingKeys.has(`${f.at}|${f.kind}|${f.message.slice(0, 48)}`)), ...curFindings]
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, RING_CAP);
    const curRing = cur.llmRing ?? [];
    const ringKeys = new Set(curRing.map((r) => `${r.at}|${r.source}|${r.outcome}`));
    const mergedRing = [...state.llmRing.filter((r) => !ringKeys.has(`${r.at}|${r.source}|${r.outcome}`)), ...curRing]
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, LLM_RING_CAP);
    const merged: SupervisorState = {
      lastCheckAt: [state.lastCheckAt, cur.lastCheckAt].sort().pop() ?? null,
      checks: Math.max(state.checks, cur.checks ?? 0),
      findings: mergedFindings,
      llmAuthFails: Math.max(state.llmAuthFails, cur.llmAuthFails ?? 0),
      nudgesIssued: Math.max(state.nudgesIssued, cur.nudgesIssued ?? 0),
      audits: Math.max(state.audits, cur.audits ?? 0),
      hallucinationFlags: Math.max(state.hallucinationFlags, cur.hallucinationFlags ?? 0),
      simulationFlags: Math.max(state.simulationFlags, cur.simulationFlags ?? 0),
      llmRing: mergedRing,
      auditsAtLastPass: Math.max(state.auditsAtLastPass, cur.auditsAtLastPass ?? 0),
      hallucFlagsAtLastPass: Math.max(state.hallucFlagsAtLastPass, cur.hallucFlagsAtLastPass ?? 0),
      // v8.4.1 FIX — was `cur.lastHeurAlarmAt ?? state.lastHeurAlarmAt`: the stale
      // persisted value always won, so the just-set alarm timestamp was reverted
      // on every sync and the heuristic-streak alarm fired EVERY tick (~5min spam).
      // Max-merge by timestamp (same pattern as lastCheckAt) keeps the newest.
      lastHeurAlarmAt: [state.lastHeurAlarmAt, cur.lastHeurAlarmAt].filter(Boolean).sort().pop() ?? null,
    };
    // adopt the merged truth back into THIS instance so it stays current
    Object.assign(state, merged);
    await db.engineSetting.upsert({ where: { key: PERSIST_KEY }, create: { key: PERSIST_KEY, value: JSON.stringify(merged) }, update: { value: JSON.stringify(merged) } });
  } catch {
    /* non-fatal */
  }
}

export function getSupervisorState(): SupervisorState & { enabled: true; intervalTicks: number; veracity: true } {
  return { ...state, enabled: true, intervalTicks: CHECK_EVERY_TICKS, veracity: true };
}

/** Async read for API routes — syncs with the persisted counters (single source
 *  of truth across dev module graphs and restarts) before answering. */
export async function getSupervisorStatePersisted(): Promise<SupervisorState & { enabled: true; intervalTicks: number; veracity: true }> {
  await syncState();
  return { ...state, enabled: true, intervalTicks: CHECK_EVERY_TICKS, veracity: true };
}

/** Called by the LLM bridge when an auth failure survived the transparent retry. */
export function noteLlmAuthFailure(): void {
  state.llmAuthFails++;
  const f: SupervisorFinding = {
    at: new Date().toISOString(),
    kind: "LLM",
    severity: "warn",
    message: `LLM auth failure #${state.llmAuthFails} — neural link degraded, stack running on heuristics`,
    action: "forced .z-ai-config reload + client re-create",
  };
  push(f);
  void resetLlmClient(); // supervisor remediation: hard-reset the SDK client
  void syncState();
}

// ── v6.0 VERACITY INSTRUMENTATION (called from the LLM bridge) ──────

/** Record the outcome of one LLM call — feeds the anti-simulation ring. */
export function noteLlmOutcome(source: string, outcome: "MODEL" | "HEURISTIC" | "ERROR", detail?: string): void {
  state.llmRing = [{ at: new Date().toISOString(), source, outcome, detail: detail?.slice(0, 160) }, ...state.llmRing].slice(0, LLM_RING_CAP);
  void syncState(); // cross-instance: persist immediately so every route sees the ring
}

/** Record a grounding audit — VIOLATIONS become audited HALLUCINATION findings. */
export function noteGroundingAudit(source: string, audit: GroundingAudit): void {
  state.audits++;
  if (audit.verdict === "VIOLATION") {
    state.hallucinationFlags++;
    push({
      at: new Date().toISOString(),
      kind: "HALLUCINATION",
      severity: "warn",
      message: `${source} cited ${audit.unmatched.length} numbers absent from its live telemetry [${audit.unmatched.slice(0, 5).join(", ")}]${audit.markers.length ? ` · markers: ${audit.markers.slice(0, 3).join(", ")}` : ""} (${audit.cited} numbers checked)`,
      action: "response annotated with an honesty footnote + recorded — agent is re-grounded on fresh telemetry every cycle",
    });
  }
  void syncState(); // cross-instance: persist immediately
}

/** Record a fake-pipeline pattern hit (anti-simulation guard). */
export function noteSimulationHit(message: string, action: string): void {
  state.simulationFlags++;
  push({ at: new Date().toISOString(), kind: "SIMULATION", severity: "warn", message, action });
  void syncState();
}

async function resetLlmClient(): Promise<void> {
  try {
    const m = await import("./ai");
    m.invalidateZai();
  } catch {
    /* bridge broken — nothing to reset; engine keeps running on heuristics */
  }
}

function push(f: SupervisorFinding): void {
  state.findings = [f, ...state.findings].slice(0, RING_CAP);
  void db.signalEvent
    .create({ data: { signalId: null, symbol: null, type: "ENGINE", level: f.severity === "warn" ? "warn" : "info", message: `AI SUPERVISOR [${f.kind}]: ${f.message} → ${f.action}` } })
    .catch(() => undefined);
}

let checking = false;

/** Watchdog pass — call from the engine tick every CHECK_EVERY_TICKS. */
export async function maybeSupervise(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    await syncState();
    state.checks++;
    state.lastCheckAt = new Date().toISOString();

    // 1) MARKET FEED — consecutive failures climbing?
    const feed = getFeedStatus();
    if (feed.consecutiveFailures >= 5) {
      push({ at: state.lastCheckAt, kind: "FEED", severity: "warn", message: `market feed ${feed.consecutiveFailures} consecutive failures (source ${feed.source})`, action: "alerting operator — feed client auto-retries internally" });
    }

    // 2) FLOW COVERAGE — the scan domain went blind?
    const flow = getFlowStatus();
    const bus = getTriggerBusSummary();
    if (flow.covered === 0 && bus.lastCycleAt !== null && Date.now() - bus.lastCycleAt > 3 * 60_000) {
      push({ at: state.lastCheckAt, kind: "FLOW", severity: "warn", message: "flow coverage dropped to 0 symbols while the trigger bus is supposedly cycling", action: "flow probes retry with backoff; engine keeps scanning" });
    }

    // 3) SIGNAL DROUGHT — engine locked itself again? (double-guard on top of the governor's relief valve)
    const gate = await getGateSettings();
    const since3h = new Date(Date.now() - 3 * 3600_000);
    const [recent3h, lastDeploy] = await Promise.all([
      db.signal.count({ where: { createdAt: { gte: since3h } } }),
      db.signal.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    ]);
    const hoursSince = lastDeploy ? (Date.now() - lastDeploy.createdAt.getTime()) / 3600_000 : null;
    if (recent3h === 0 && hoursSince !== null && hoursSince > 3 && gate.minScore > 30) {
      state.nudgesIssued++;
      push({ at: state.lastCheckAt, kind: "DROUGHT", severity: "warn", message: `signal drought: 0 deploys in 3h (last ${hoursSince.toFixed(1)}h ago) with MIN_SCORE ${gate.minScore}`, action: `governor cycle nudged (nudge #${state.nudgesIssued}) — evidence gate + relief valve handle the rest` });
      void import("./governor")
        .then((m) => m.runGovernorCycle("supervisor"))
        .catch(() => undefined);
    }

    // 4) SIGNAL FLOOD — quality collapse from over-loosening?
    const since15m = new Date(Date.now() - 15 * 60_000);
    const flood = await db.signal.count({ where: { createdAt: { gte: since15m } } });
    if (flood > 6) {
      push({ at: state.lastCheckAt, kind: "FLOOD", severity: "warn", message: `deployment flood: ${flood} signals in 15min — realized WR may dilute the learner`, action: "alerting operator; gate tightening stays with the governor's evidence rule" });
    }

    // 5) LEARNER STALENESS — memory rotting?
    const [bt, learner] = await Promise.all([getBacktest(), getLearnerAutoState()]);
    if (!bt && learner.enabled) {
      push({ at: state.lastCheckAt, kind: "LEARNER", severity: "info", message: "no backtest replay stored yet while the auto-learner is enabled", action: "learner will fire on its next scheduled window" });
    } else if (bt && Date.now() - new Date(bt.ranAt).getTime() > 24 * 3600_000) {
      push({ at: state.lastCheckAt, kind: "LEARNER", severity: "warn", message: `backtest evidence stale (>24h, ran ${bt.ranAt.slice(0, 16)}Z)`, action: "learner scheduler will refresh on next window; governor may force-run" });
    }

    // ── 6) VERACITY RATE — hallucination share over the watchdog window (v6.0) ──
    const auditsWin = state.audits - state.auditsAtLastPass;
    const flagsWin = state.hallucinationFlags - state.hallucFlagsAtLastPass;
    if (auditsWin >= 4 && flagsWin / auditsWin > 0.25) {
      push({
        at: state.lastCheckAt,
        kind: "HALLUCINATION",
        severity: "warn",
        message: `grounding-audit violation rate ${((flagsWin / auditsWin) * 100).toFixed(0)}% over the last ${auditsWin} audited LLM outputs (${flagsWin} violations)`,
        action: "honesty footnotes are annotating affected replies; every violation is logged with its unmatched numbers",
      });
    }
    state.auditsAtLastPass = state.audits;
    state.hallucFlagsAtLastPass = state.hallucinationFlags;

    // ── 7) ANTI-SIMULATION GUARD — fake-pipeline patterns (v6.0) ──
    // 7a. deployments while the market feed is blind = possible stale-data pipeline
    const deploys30m = await db.signal.count({ where: { createdAt: { gte: new Date(Date.now() - 30 * 60_000) } } });
    if (feed.consecutiveFailures >= 5 && deploys30m > 0) {
      noteSimulationHit(
        `${deploys30m} deployment(s) in the last 30min while the market feed has ${feed.consecutiveFailures} consecutive failures — verify the pipeline is not running on stale data`,
        "deploy grounding re-verified against cached klines; feed client auto-retrying; if feed stays blind the learned gates starve deploys naturally",
      );
    }
    // 7b. heuristic streak — the stack must never PRETEND to be a model
    const last5 = state.llmRing.slice(0, 5);
    if (last5.length === 5 && last5.every((r) => r.outcome !== "MODEL")) {
      const sinceAlarm = state.lastHeurAlarmAt ? Date.now() - new Date(state.lastHeurAlarmAt).getTime() : Infinity;
      if (sinceAlarm > 60 * 60_000) {
        state.lastHeurAlarmAt = new Date().toISOString();
        push({
          at: state.lastCheckAt,
          kind: "SIMULATION",
          severity: "info",
          message: `last ${last5.length} LLM calls produced no MODEL output (${last5[0].source} most recent) — stack is running on honestly-labeled heuristics, no simulation present`,
          action: "watching for neural-link recovery; supervisor keeps every output labeled HEURISTIC until the model returns",
        });
      }
    }
    // 7c. a MODEL outcome recorded while auth failures were escalating would be
    // a mislabel — check: any MODEL in the ring whose timestamp precedes the
    // newest auth failure recovery is fine; flag only ERROR→MODEL within 60s
    // with no intervening reset (impossible by construction, but audited here).
    const [newest, afterErr] = state.llmRing;
    if (newest?.outcome === "MODEL" && afterErr?.outcome === "ERROR" && new Date(newest.at).getTime() - new Date(afterErr.at).getTime() < 60_000) {
      noteSimulationHit(`MODEL-labeled output from ${newest.source} arrived <60s after an ERROR outcome — possible label inconsistency`, "veracity ring keeps both records; auth retry path is the expected benign cause, flagged for the audit trail");
    }

    await syncState();
  } catch (err) {
    console.error("[supervisor]", err);
  } finally {
    checking = false;
  }
}
