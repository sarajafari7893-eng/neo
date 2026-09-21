// ── FlowRadar Neo v6.6 AI ADVISOR LOOP (server-only) ────────────────────────
// Operator mandate (2026-09-07, Q3): the engine core could not reach the
// calibration conclusions on its own — the governor only tunes numeric knobs,
// it cannot invent NEW filtering policy or judge a guard trial. The advisor
// closes that loop, exactly as the operator specified:
//   1. READ the realized ledger (strategies, regimes, TTL telemetry, trials)
//      on a fixed cadence (6h, deterministic — no LLM call needed);
//   2. PROPOSE evidence-grounded changes — existing gate knobs ONLY, always
//      inside the hard clamps, each carrying its measured evidence;
//   3. WAIT for operator approval (AI CORE advisor panel / API / Telegram);
//   4. APPLY only after an explicit APPROVE — via the same putGateSettings
//      channel the governor uses, clamped and audited as an ENGINE event;
//   5. LEARN from rejections — two consecutive REJECTs on one knob put it on a
//      7-day cooldown so the advisor cannot nag.
// The advisor NEVER applies anything on its own — «بدون اجازه» is a hard
// invariant, enforced by making approve an explicit operator action.

import { db } from "@/lib/db";
import type { AdvisorProposal } from "@prisma/client";
import { getGateSettings, putGateSettings, gateClamps, describeGate, type GateSettings } from "@/lib/gate-settings";
import { getTtlTelemetry } from "@/lib/ttl-gate";
import { fireEvent } from "@/lib/engine";
import { sendDirect } from "@/lib/notify";

const ADVISOR_STATE_KEY = "advisor.state";
const CYCLE_INTERVAL_MS = 6 * 3600_000; // 4 evidence cycles/day — the 00:00 Tehran daily report carries the queue
const STALE_PENDING_MS = 7 * 86_400_000; // unanswered proposals expire after 7 days
const REJECT_COOLDOWN_MS = 7 * 86_400_000; // 2 consecutive rejects → knob frozen 7 days
const APPLIED_QUIET_MS = 72 * 3600_000; // after an apply, give the knob 72h before re-proposing
const MAX_PROPOSALS_PER_CYCLE = 2;
const MIN_BUCKET_N = 12; // minimum settled rows before a strategy rule may fire
const BO_EXP_TARGET_N = 20; // BREAKOUT trial verdict threshold (approved spec)

export interface AdvisorState {
  cycles: number;
  lastRunAt: string | null;
  lastBoExpVerdictAt: number | null; // once-per-day throttle for the trial-verdict event
}

const EMPTY_STATE: AdvisorState = { cycles: 0, lastRunAt: null, lastBoExpVerdictAt: null };

async function getState(): Promise<AdvisorState> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: ADVISOR_STATE_KEY } });
    if (!row) return { ...EMPTY_STATE };
    return { ...EMPTY_STATE, ...(JSON.parse(row.value) as Partial<AdvisorState>) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

async function putState(next: AdvisorState): Promise<void> {
  await db.engineSetting.upsert({
    where: { key: ADVISOR_STATE_KEY },
    create: { key: ADVISOR_STATE_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
}

// ── evidence gathering (read-only) ──────────────────────────────────────────

export interface StrategyBucket {
  strategy: string;
  n: number;
  wins: number;
  pnlUsd: number;
  expectancyPct: number;
}

export interface LedgerStats {
  settled: number;
  strategies: StrategyBucket[];
  shortBook: { n: number; pnlUsd: number; expectancyPct: number };
  boExp: { n: number; wins: number; pnlUsd: number; pf: number | null };
  ttl: Awaited<ReturnType<typeof getTtlTelemetry>>;
  last20PnlUsd: number;
  gate: GateSettings;
}

export async function gatherLedgerStats(): Promise<LedgerStats> {
  const settled = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
    select: { strategy: true, direction: true, pnlPercent: true, marginUsd: true, reachedTp: true, tags: true, closedAt: true },
    orderBy: { closedAt: "desc" },
  });

  const byStrat = new Map<string, { n: number; wins: number; pnl: number; pct: number }>();
  let shortN = 0;
  let shortPnl = 0;
  let shortPct = 0;
  const monthAgo = Date.now() - 30 * 86_400_000;

  for (const s of settled) {
    const usd = (s.marginUsd * s.pnlPercent) / 100;
    const win = s.reachedTp >= 1;
    const b = byStrat.get(s.strategy) ?? { n: 0, wins: 0, pnl: 0, pct: 0 };
    b.n++;
    if (win) b.wins++;
    b.pnl += usd;
    b.pct += s.pnlPercent;
    byStrat.set(s.strategy, b);
    if (s.direction === "SHORT" && s.closedAt && s.closedAt.getTime() >= monthAgo) {
      shortN++;
      shortPnl += usd;
      shortPct += s.pnlPercent;
    }
  }

  const strategies: StrategyBucket[] = [...byStrat.entries()]
    .map(([strategy, b]) => ({ strategy, n: b.n, wins: b.wins, pnlUsd: Number(b.pnl.toFixed(2)), expectancyPct: Number((b.pct / Math.max(1, b.n)).toFixed(2)) }))
    .sort((a, b) => a.pnlUsd - b.pnlUsd);

  // BREAKOUT trial cohort (breakoutGuard=1 arm) — tags contain BO-EXP
  const expRows = settled.filter((s) => s.tags.split(",").includes("BO-EXP"));
  let grossWin = 0;
  let grossLoss = 0;
  for (const s of expRows) {
    const usd = (s.marginUsd * s.pnlPercent) / 100;
    if (usd >= 0) grossWin += usd;
    else grossLoss += Math.abs(usd);
  }

  const ttl = await getTtlTelemetry();
  const last20 = settled.slice(0, 20);

  return {
    settled: settled.length,
    strategies,
    shortBook: { n: shortN, pnlUsd: Number(shortPnl.toFixed(2)), expectancyPct: shortN ? Number((shortPct / shortN).toFixed(2)) : 0 },
    boExp: {
      n: expRows.length,
      wins: expRows.filter((s) => s.reachedTp >= 1).length,
      pnlUsd: Number((grossWin - grossLoss).toFixed(2)),
      pf: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 99 : null,
    },
    ttl,
    last20PnlUsd: Number(last20.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0).toFixed(2)),
    gate: await getGateSettings(),
  };
}

// ── proposal rules (deterministic, each with hard evidence gates) ───────────

interface ProposalDraft {
  knob: keyof GateSettings;
  proposedValue: number;
  direction: "TIGHTEN" | "LOOSEN";
  rationale: string;
  evidence: Record<string, unknown>;
}

function inClamp(knob: keyof GateSettings, v: number): number {
  const [lo, hi] = gateClamps()[knob];
  return Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
}

function draftProposals(st: LedgerStats): ProposalDraft[] {
  const drafts: ProposalDraft[] = [];
  const clamps = gateClamps();

  // RULE 1 — BREAKOUT trial verdict (operator-approved experiment window):
  // ≥20 BO-EXP settles with PF ≤ 1.2 → propose restoring the veto (breakoutGuard 2).
  if (st.gate.breakoutGuard === 1 && st.boExp.n >= BO_EXP_TARGET_N && st.boExp.pf !== null && st.boExp.pf <= 1.2) {
    drafts.push({
      knob: "breakoutGuard",
      proposedValue: 2,
      direction: "TIGHTEN",
      rationale: `BREAKOUT conditional trial FAILED its window — ${st.boExp.n} settles, PF ${st.boExp.pf} ≤ 1.2 (net ${st.boExp.pnlUsd >= 0 ? "+" : ""}$${st.boExp.pnlUsd}); restore full veto`,
      evidence: { trial: "BO-EXP", n: st.boExp.n, pf: st.boExp.pf, pnlUsd: st.boExp.pnlUsd, wins: st.boExp.wins, window: `PF>1.2 over ≥${BO_EXP_TARGET_N}` },
    });
  }

  // RULE 2 — strategy bleed: a strategy with ≥12 settles and expectancy < −2%/trade
  // tightens the BASE threshold (the regime thrAdj already adds per-candidate surcharge).
  const worst = st.strategies.find((s) => s.n >= MIN_BUCKET_N && s.expectancyPct < -2);
  if (worst && st.gate.minScore < clamps.minScore[1]) {
    drafts.push({
      knob: "minScore",
      proposedValue: inClamp("minScore", st.gate.minScore + 5),
      direction: "TIGHTEN",
      rationale: `worst strategy ${worst.strategy}: expectancy ${worst.expectancyPct}%/trade over ${worst.n} settles — admit only higher-confluence setups (+5 MIN_SCORE)`,
      evidence: { strategy: worst.strategy, n: worst.n, expectancyPct: worst.expectancyPct, pnlUsd: worst.pnlUsd, wins: worst.wins },
    });
  }

  // RULE 3 — SHORT book still bleeding (30d window, ≥20 shorts) → shave size further.
  if (st.shortBook.n >= 20 && st.shortBook.pnlUsd < 0 && st.shortBook.expectancyPct < -1.5 && st.gate.shortSizeMult > clamps.shortSizeMult[0]) {
    drafts.push({
      knob: "shortSizeMult",
      proposedValue: inClamp("shortSizeMult", st.gate.shortSizeMult - 0.1),
      direction: "TIGHTEN",
      rationale: `SHORT book 30d: ${st.shortBook.n} settles, ${st.shortBook.expectancyPct}%/trade, net ${st.shortBook.pnlUsd >= 0 ? "+" : ""}$${st.shortBook.pnlUsd} — cut size ×${st.gate.shortSizeMult.toFixed(2)}→×${inClamp("shortSizeMult", st.gate.shortSizeMult - 0.1).toFixed(2)}`,
      evidence: st.shortBook,
    });
  }

  // RULE 4 — TTL near-TP pain: many denials where the next TP sat just outside
  // the band AND extensions that ran mostly to TP → widen the band +0.5.
  if (st.ttl.denied >= 8 && st.ttl.deniedNearTp / st.ttl.denied >= 0.4 && st.ttl.tpAfter >= st.ttl.slAfter && st.gate.ttlNearTpPct < clamps.ttlNearTpPct[1]) {
    drafts.push({
      knob: "ttlNearTpPct",
      proposedValue: inClamp("ttlNearTpPct", st.gate.ttlNearTpPct + 0.5),
      direction: "LOOSEN",
      rationale: `${st.ttl.denied} expiry denials, ${st.ttl.deniedNearTp} with next TP inside 2× band (${Math.round((100 * st.ttl.deniedNearTp) / st.ttl.denied)}%), extended trades resolve TP ${st.ttl.tpAfter} vs SL ${st.ttl.slAfter} — widen band +0.5%`,
      evidence: { denied: st.ttl.denied, deniedNearTp: st.ttl.deniedNearTp, tpAfter: st.ttl.tpAfter, slAfter: st.ttl.slAfter, capturedUsd: st.ttl.capturedUsd },
    });
  }

  // RULE 5 — rolling drawdown: last 20 settles ≤ −$10 → de-risk the sizing knob.
  if (st.last20PnlUsd <= -10 && st.gate.riskPerTrade > clamps.riskPerTrade[0]) {
    drafts.push({
      knob: "riskPerTrade",
      proposedValue: inClamp("riskPerTrade", st.gate.riskPerTrade - 0.15),
      direction: "TIGHTEN",
      rationale: `last 20 settles sum ${st.last20PnlUsd >= 0 ? "+" : ""}$${st.last20PnlUsd} — drawdown protocol shrinks margin sizing ×${st.gate.riskPerTrade.toFixed(2)}→×${inClamp("riskPerTrade", st.gate.riskPerTrade - 0.15).toFixed(2)}`,
      evidence: { last20PnlUsd: st.last20PnlUsd, riskPerTrade: st.gate.riskPerTrade },
    });
  }

  return drafts;
}

/** A knob is blocked when a PENDING proposal exists, a fresh APPLY is still
 * settling (72h), or two consecutive REJECTs triggered the 7-day cooldown.
 * v10.6 (operator unpin mandate 2026-09-15): REJECTs that were PROCEDURAL
 * (blocked by the operator PIN — applyNote carries "OPERATOR PIN") no longer
 * count toward the anti-flap cooldown. The cooldown exists so the advisor
 * cannot nag after the OPERATOR judged a proposal on its evidence; a PIN block
 * is not such a judgment — it is the old mandate speaking. Without this, an
 * unpinned minScore would stay silently frozen until ~09-22 for rejects the
 * operator never evidentially made. */
async function knobBlocked(knob: string): Promise<boolean> {
  const recent = await db.advisorProposal.findMany({ where: { knob }, orderBy: { createdAt: "desc" }, take: 6 });
  if (recent.some((p) => p.status === "PENDING")) return true;
  const evidential = (p: (typeof recent)[number]) => !(p.status === "REJECTED" && (p.applyNote ?? "").includes("OPERATOR PIN"));
  const last = recent.find((p) => evidential(p));
  if (last?.decidedAt) {
    if (last.status === "APPLIED" && Date.now() - last.decidedAt.getTime() < APPLIED_QUIET_MS) return true;
    if (last.status === "REJECTED") {
      const rejects = recent.filter((p) => p.status === "REJECTED" && evidential(p));
      const twoConsecutive = rejects.length >= 2 && rejects[0].decidedAt && rejects[1].decidedAt;
      if (twoConsecutive && rejects[0].decidedAt && Date.now() - rejects[0].decidedAt.getTime() < REJECT_COOLDOWN_MS) return true;
    }
  }
  return false;
}

async function expireStale(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_PENDING_MS);
  const r = await db.advisorProposal.updateMany({ where: { status: "PENDING", createdAt: { lt: cutoff } }, data: { status: "EXPIRED", decidedAt: new Date() } });
  return r.count;
}

// ── cycle ────────────────────────────────────────────────────────────────────

export async function runAdvisorCycle(): Promise<{ cycle: number; queued: number; skipped: number; stats: LedgerStats }> {
  const state = await getState();
  const st = await gatherLedgerStats();
  const drafts = draftProposals(st);

  let queued = 0;
  let skipped = 0;
  for (const d of drafts) {
    if (queued >= MAX_PROPOSALS_PER_CYCLE) break;
    if (d.proposedValue === st.gate[d.knob]) continue; // already at the proposed value
    if (await knobBlocked(d.knob)) {
      skipped++;
      continue;
    }
    await db.advisorProposal.create({
      data: {
        cycle: state.cycles + 1,
        kind: "KNOB_ADJUST",
        knob: d.knob,
        currentValue: st.gate[d.knob],
        proposedValue: d.proposedValue,
        direction: d.direction,
        rationale: d.rationale,
        evidence: JSON.stringify(d.evidence),
        status: "PENDING",
      },
    });
    queued++;
  }

  // BREAKOUT trial PASSING announcement (no knob change — informational, 1/day)
  if (st.gate.breakoutGuard === 1 && st.boExp.n >= BO_EXP_TARGET_N && st.boExp.pf !== null && st.boExp.pf > 1.2 && (!state.lastBoExpVerdictAt || Date.now() - state.lastBoExpVerdictAt > 86_400_000)) {
    await fireEvent(null, null, "ENGINE", "ai", `AI ADVISOR: BREAKOUT conditional trial PASSING — ${st.boExp.n} BO-EXP settles, PF ${st.boExp.pf} > 1.2 (net +$${st.boExp.pnlUsd}); half-size regime-conditioned deployments stay active`);
    state.lastBoExpVerdictAt = Date.now();
  }

  const expired = await expireStale();
  const nextState: AdvisorState = { cycles: state.cycles + 1, lastRunAt: new Date().toISOString(), lastBoExpVerdictAt: state.lastBoExpVerdictAt };
  await putState(nextState);

  await fireEvent(
    null,
    null,
    "ENGINE",
    queued > 0 ? "ai" : "info",
    `AI ADVISOR cycle #${nextState.cycles}: ${queued} proposal${queued === 1 ? "" : "s"} queued (${skipped} knob${skipped === 1 ? "" : "s"} on cooldown/dedup, ${expired} stale expired) — awaiting OPERATOR approval in AI CORE · ledger: ${st.settled} settled, last-20 ${st.last20PnlUsd >= 0 ? "+" : ""}$${st.last20PnlUsd}`
  );
  return { cycle: nextState.cycles, queued, skipped, stats: st };
}

export async function maybeRunAdvisor(): Promise<void> {
  try {
    const state = await getState();
    if (state.lastRunAt && Date.now() - new Date(state.lastRunAt).getTime() < CYCLE_INTERVAL_MS) return;
    await runAdvisorCycle();
  } catch (e) {
    console.error("[advisor] cycle failed:", e);
  }
}

export async function forceRunAdvisor(): Promise<{ cycle: number; queued: number; skipped: number }> {
  const r = await runAdvisorCycle();
  return { cycle: r.cycle, queued: r.queued, skipped: r.skipped };
}

// ── operator decision (the ONLY path to apply) ──────────────────────────────

export async function decideProposal(id: string, approve: boolean): Promise<{ ok: boolean; error?: string; proposal?: AdvisorProposal }> {
  const p = await db.advisorProposal.findUnique({ where: { id } });
  if (!p) return { ok: false, error: "proposal not found" };
  if (p.status !== "PENDING") return { ok: false, error: `proposal is ${p.status} — only PENDING can be decided` };

  if (!approve) {
    const updated = await db.advisorProposal.update({ where: { id }, data: { status: "REJECTED", decidedAt: new Date() } });
    await fireEvent(null, null, "ENGINE", "info", `AI ADVISOR: proposal #${p.cycle} REJECTED by operator — ${p.knob} ${p.currentValue}→${p.proposedValue} stays untouched (rejection cooldown armed)`);
    void notifyDecision(updated).catch(() => undefined);
    return { ok: true, proposal: updated };
  }

  const clamps = gateClamps();
  // v8.4.2 OPERATOR PIN — «ثابت نگه دار»: a pinned minScore is operator-owned.
  // Even an advisor proposal approval may not move it; the operator must lift
  // the pin first (explicit bridge mandate → audited script).
  if (p.knob === "minScore" && (await getGateSettings()).minScorePinned === 1) {
    const live = (await getGateSettings()).minScore;
    await db.advisorProposal.update({ where: { id }, data: { status: "REJECTED", decidedAt: new Date(), applyNote: `OPERATOR PIN active — minScore fixed at ${live} (bridge mandate 2026-09-12); unpin required before any change` } });
    await fireEvent(null, null, "ENGINE", "info", `AI ADVISOR: proposal #${p.cycle} BLOCKED by OPERATOR PIN — minScore is fixed at ${live} (bridge mandate 2026-09-12 «و ثابت نگه دار»); the operator must lift the pin first`);
    return { ok: false, error: `minScore is PINNED at ${live} by operator mandate — unpin first` };
  }
  // v10.9 APPLY-GUARD (SUPERVISOR proposal 19:08Z, operator-approved 2026-09-15
  // «دستورات سوپروایزر را کامل و مهندسی انجام بده»): config-drift check-before-
  // apply. A proposal is a delta from the live value AT PROPOSAL TIME — if the
  // live knob moved since, applying the stale delta lands on the wrong
  // end-state (real case: cycle-39 proposed 30→35 while live had already moved
  // to 38 = accidental LOOSEN). Re-check live at apply; auto-reject on drift.
  const liveNow = await getGateSettings();
  const liveKnob = (liveNow as unknown as Record<string, number | undefined>)[p.knob];
  if (typeof liveKnob === "number" && liveKnob !== p.currentValue) {
    const updated = await db.advisorProposal.update({
      where: { id },
      data: {
        status: "REJECTED",
        decidedAt: new Date(),
        applyNote: `APPLY-GUARD: live ${p.knob}=${liveKnob} drifted from proposal base ${p.currentValue} — stale proposal auto-rejected (check-before-apply); re-propose from current value`,
      },
    });
    await fireEvent(null, null, "ENGINE", "info", `AI ADVISOR: proposal #${p.cycle} AUTO-REJECTED by APPLY-GUARD — live ${p.knob}=${liveKnob} vs proposal base ${p.currentValue} (stale delta would misapply); nothing touched`);
    void notifyDecision(updated).catch(() => undefined);
    return { ok: false, error: `stale proposal — live ${p.knob} is ${liveKnob}, proposal based on ${p.currentValue}` };
  }

  const [lo, hi] = clamps[p.knob as keyof GateSettings] ?? [p.proposedValue, p.proposedValue];
  const clampedValue = Math.min(hi, Math.max(lo, p.proposedValue));
  const next = await putGateSettings({ [p.knob]: clampedValue } as Partial<GateSettings>);
  const updated = await db.advisorProposal.update({
    where: { id },
    data: { status: "APPLIED", decidedAt: new Date(), appliedAt: new Date(), applyNote: describeGate(next) },
  });
  await fireEvent(null, null, "ENGINE", "ai", `AI ADVISOR: proposal #${p.cycle} APPROVED by operator — ${p.knob} ${p.currentValue}→${clampedValue} applied via governor channel · ${describeGate(next)}`);
  void notifyDecision(updated).catch(() => undefined);
  return { ok: true, proposal: updated };
}

async function notifyDecision(p: AdvisorProposal): Promise<void> {
  const line = p.status === "APPLIED" ? `✅ ADVISOR APPLY: ${p.knob} ${p.currentValue}→${p.proposedValue} (${p.direction})` : `❌ ADVISOR REJECTED: ${p.knob} ${p.currentValue}→${p.proposedValue} stays`;
  await sendDirect(line);
}

// ── surface helpers (API + Telegram) ────────────────────────────────────────

export async function advisorSnapshot() {
  const [state, proposals, stats] = await Promise.all([
    getState(),
    db.advisorProposal.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
    gatherLedgerStats(),
  ]);
  const pending = proposals.filter((p) => p.status === "PENDING");
  return {
    state,
    pendingCount: pending.length,
    proposals,
    experiment: {
      guard: stats.gate.breakoutGuard,
      cohortN: stats.boExp.n,
      pf: stats.boExp.pf,
      pnlUsd: stats.boExp.pnlUsd,
      targetN: BO_EXP_TARGET_N,
      threshold: 1.2,
      verdict: stats.boExp.n < BO_EXP_TARGET_N ? "COLLECTING" : stats.boExp.pf !== null && stats.boExp.pf > 1.2 ? "PASSING" : "FAILING",
    },
    stats: {
      settled: stats.settled,
      last20PnlUsd: stats.last20PnlUsd,
      strategies: stats.strategies,
      shortBook: stats.shortBook,
    },
  };
}

/** Compact block appended to the Telegram daily caption — pending decisions only. */
export async function advisorCaptionBlock(): Promise<string> {
  try {
    const pending = await db.advisorProposal.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "desc" }, take: 2 });
    if (pending.length === 0) return "🧠 <b>AI ADVISOR</b>: no pending proposals — calibration queue empty";
    const lines = pending.map((p) => `• <b>${p.direction}</b> ${p.knob.replace(/([A-Z])/g, " $1").toLowerCase()}: ${p.currentValue}→${p.proposedValue}`);
    return `🧠 <b>AI ADVISOR</b> — ${pending.length} proposal${pending.length > 1 ? "s" : ""} awaiting your APPROVE (AI CORE panel):\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}
