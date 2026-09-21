// ── FlowRadar Neo v10.0 — SHADOW MODULES REGISTRY (server-only) ─────────────
// Single registry + scheduler for the four operator-approved modules
// (mandate 2026-09-15: «اجرای چهار ماژول را مهندسی شده و کامل انجام بده»):
//   · R1 RISK GOVERNOR  — sizing verdict by regime/vol/drawdown slope, CHOP
//     bleed + 0.5x replay + 10-15x de-leverage evidence; SHADOW journals and
//     queues clamped AdvisorProposals / ENGAGED applies via the clamped gate
//     channel (≥6h apart, audited).
//   · R2 TIME GOVERNOR  — Tehran-hour realized table, TOXIC/PRIME tiers with
//     size weights (×0.5–×1.1); honest-shadow advisory (no hour knob exists —
//     deploy-path wiring is a separate operator decision).
//   · R5 UI-CANARY      — black-box probes of pulse / rawcal / flows /
//     ai-memory / bridge with payload-shape checks; ENGAGED pages Telegram
//     after 3 consecutive RED verdicts.
//   · R6 SENIOR-REVIEW  — nightly Tehran audit agent; ≤3 advisor-compatible
//     PENDING proposals per run + one Telegram digest; always read-only.
//
// The operator authority mode is ONE global switch (EngineSetting
// "governor-modules.mode", default SHADOW) — /api/governors + the
// GOVERNOR MODULES card and the engine rail below all read the same key.
// Shadow-first doctrine: modules never touch the engine deploy path.

import { db } from "@/lib/db";
import { maybeRunRiskGovernor, runRiskGovernor, getRiskGovernorState, type RiskGovernorState } from "@/lib/risk-governor";
import { maybeRunTimeGovernor, runTimeGovernor, getTimeGovernorState, type TimeGovernorState } from "@/lib/time-governor";
import { maybeRunCanary, runCanary, getCanaryState, type CanaryState } from "@/lib/ui-canary";
import { maybeRunSeniorReview, runSeniorReview, getSeniorReviewState, type SeniorReviewState } from "@/lib/senior-review";
import { fireEvent } from "@/lib/engine";

const MODE_KEY = "governor-modules.mode";
export type ModuleId = "risk-governor" | "time-governor" | "ui-canary" | "senior-review";
export type ModuleMode = "SHADOW" | "ENGAGED";

export interface ModuleMeta {
  id: ModuleId;
  label: string;
  roadmap: string;
  desc: string;
  engagedEffect: string;
}

export const MODULES: ModuleMeta[] = [
  {
    id: "risk-governor",
    label: "RISK GOVERNOR",
    roadmap: "R1",
    desc: "Sizing verdict by regime × volatility × drawdown slope. CHOP bleed, 0.5x replay and the 10-15x de-leverage band are the grounding evidence.",
    engagedEffect: "applies riskPerTrade (and heavy-defense leveredRiskCap trim) through the clamped gate channel, ≥6h apart, audited",
  },
  {
    id: "time-governor",
    label: "TIME GOVERNOR",
    roadmap: "R2",
    desc: "24h Tehran realized-performance table with TOXIC/PRIME tiers and per-hour size weights (×0.5–×1.1).",
    engagedEffect: "weights marked ACTIVE in the verdict + senior-review digest; deploy-path hour wiring stays operator-gated (no hour knob exists)",
  },
  {
    id: "ui-canary",
    label: "UI-CANARY",
    roadmap: "R5",
    desc: "Lightweight visual watchdog: black-box probes of the dashboard data plane with payload-shape validation.",
    engagedEffect: "pages Telegram after 3 consecutive RED verdicts (≥6h between pages)",
  },
  {
    id: "senior-review",
    label: "SENIOR-REVIEW",
    roadmap: "R6",
    desc: "Nightly Tehran audit agent: ledger + RAW-CAL + the three sibling modules, queues ≤3 evidence-backed AdvisorProposals.",
    engagedEffect: "always read-only; its proposals flow through the standard advisor approve/reject channel",
  },
];

export async function getMode(): Promise<ModuleMode> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: MODE_KEY } });
    if (row && JSON.parse(row.value).mode === "ENGAGED") return "ENGAGED";
  } catch {
    /* default SHADOW */
  }
  return "SHADOW";
}

export async function putMode(mode: ModuleMode): Promise<void> {
  const prev = await getMode();
  await db.engineSetting.upsert({ where: { key: MODE_KEY }, create: { key: MODE_KEY, value: JSON.stringify({ mode, at: Date.now() }) }, update: { value: JSON.stringify({ mode, at: Date.now() }) } });
  if (prev !== mode) {
    const label = mode === "ENGAGED" ? MODULES.map((m) => (m.id === "senior-review" ? null : m.label)).filter(Boolean).join("/") : "SHADOW-FIRST";
    void fireEvent(null, null, "SYSTEM", mode === "ENGAGED" ? "success" : "info", `SHADOW MODULES authority → ${mode} by operator — ${label} ${mode === "ENGAGED" ? "empowered (clamped, audited)" : "observe-and-propose only"}`).catch(() => undefined);
  }
}

export interface ShadowModulesSnapshot {
  mode: ModuleMode;
  riskGovernor: RiskGovernorState;
  timeGovernor: TimeGovernorState;
  canary: CanaryState;
  seniorReview: SeniorReviewState;
}

export async function getShadowModulesSnapshot(): Promise<ShadowModulesSnapshot> {
  const [mode, riskGovernor, timeGovernor, canary, seniorReview] = await Promise.all([
    getMode(),
    getRiskGovernorState(),
    getTimeGovernorState(),
    getCanaryState(),
    getSeniorReviewState(),
  ]);
  return { mode, riskGovernor, timeGovernor, canary, seniorReview };
}

// ── scheduler (engine tick entry — fire-and-forget) ─────────────────────────

let running = false;

export async function maybeRunShadowModules(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const mode = await getMode();
    await Promise.allSettled([
      maybeRunCanary(mode), // 15min internal throttle
      maybeRunRiskGovernor(mode), // 60min internal throttle
      maybeRunTimeGovernor(), // 6h internal throttle
      maybeRunSeniorReview(), // once per Tehran night, after the daily report
    ]);
  } catch {
    /* never break the tick */
  } finally {
    running = false;
  }
}

// ── manual actions (API "run now") ──────────────────────────────────────────

export async function runModuleNow(id: ModuleId): Promise<{ ok: boolean; error?: string }> {
  const mode = await getMode();
  switch (id) {
    case "risk-governor":
      await runRiskGovernor(mode);
      return { ok: true };
    case "time-governor":
      await runTimeGovernor();
      return { ok: true };
    case "ui-canary":
      await runCanary(mode);
      return { ok: true };
    case "senior-review":
      await runSeniorReview();
      return { ok: true };
    default:
      return { ok: false, error: "unknown module" };
  }
}
