// ── NEXUS OPS-SUPERVISOR v1.0 — senior-engineer recurring oversight cron ────
// Operator order 2026-09-25: «یک کرون جاب حرفه‌ای با اسکیل سوپروایزر مهندس
// ارشد برای بررسی و پیگیری و نظارت بر سیستم — هدف: وین ریت بالاتر و افزایش
// EST PNL % روزانه»
//
// A SUPERVISOR SKILL above the AI veracity supervisor (supervisor.ts, ~2min
// tactical) that runs a STRATEGIC senior-engineer cycle every 2h, riding the
// pulse heartbeat (same self-driving pattern as daily-scheduler — zero
// platform-cron dependency, warm-loop keeps the pulse alive):
//
//   1. GATHER  — deterministic KPI bundle measured server-side (never invented):
//                win-rate rolling windows (30/50/100), EST PNL today/24h
//                (engine-recorded fee-NET v6.2 semantics), RAW-CAL pace +
//                arms-fill completion, trigger-bus health, feed/REST-ban
//                state, sentinel verdict, futures-taxonomy maturity,
//                advisor queue pressure, gate snapshot.
//   2. THINK   — senior-engineer LLM pass (aiChat, veracity-grounded, strict
//                JSON contract). Falls back to honest heuristic directives
//                when the neural link is down (labeled HEURISTIC).
//   3. ACT     — bounded by design: ≤2 advisor proposals per cycle through
//                the SAME blocked/cooldown channel senior-review uses; P0
//                alerts via Telegram + audited ENGINE events. During RAW-CAL
//                calibration capture the gate knobs are FROZEN by the operator
//                mandate — proposals are skipped and routed to the
//                post-calibration agenda instead (journal NOTE).
//   4. JOURNAL — ops-supervisor.state ring (last 40 cycles) + FOUR-PACK
//                journal + one audited event per cycle.
//
// Goals tracked (operator-defined): rolling win-rate ↑, EST PNL %/day ↑.
// Fail-soft everywhere — a supervisor failure must never break the pulse.

import { db } from "@/lib/db";
import { getGateSettings, gateClamps, type GateSettings } from "@/lib/gate-settings";
import { getFeedStatus } from "@/lib/market-feed";
import { fapiBanRemainingMs } from "@/lib/fapi-gate"; // v14.0 — the real ban source (getFeedBanUntil never existed)
import { getTriggerBusSummary } from "@/lib/triggers";
import { rawCalStatus } from "@/lib/raw-cal";
import { sendDirect } from "@/lib/notify";
import { fireEvent } from "@/lib/engine";
import { recordFourPack } from "@/lib/fourpack-journal";

const KEY = "ops-supervisor.state";
const CYCLE_INTERVAL_MS = 2 * 3600_000; // the cron cadence (2h)
const PROBE_THROTTLE_MS = 10 * 60_000; // pulse-ride probe throttle
const PROPOSALS_PER_CYCLE = 2;
const APPLIED_QUIET_MS = 48 * 3600_000;
const REJECT_COOLDOWN_MS = 5 * 86_400_000;
const TG_MIN_GAP_MS = 3 * 3600_000; // digest anti-spam (CRITICAL bypasses)
const JOURNAL_CAP = 40;

export type OpsVerdict = "HEALTHY" | "WATCH" | "DEGRADE" | "CRITICAL";

const VERDICT_RANK: Record<OpsVerdict, number> = { HEALTHY: 0, WATCH: 1, DEGRADE: 2, CRITICAL: 3 };
/** Escalate-only merge — a cycle's verdict can only get worse within the pass. */
function worse(cur: OpsVerdict, next: OpsVerdict): OpsVerdict {
  return VERDICT_RANK[next] > VERDICT_RANK[cur] ? next : cur;
}

export interface OpsKpis {
  wrOverall: number | null;
  wr30: number | null;
  wr50: number | null;
  wr100: number | null;
  pnl24hUsd: number | null;
  estPnlTodayPct: number | null;
  estPnlTodayUsd: number | null;
  settledToday: number;
  issuedToday: number;
  equity: number | null;
  rawcalArmed: boolean;
  rawcalIssuedTotal: number;
  rawcalBook: string;
  rawcalArmsDone: boolean | null;
  issueStallMin: number | null;
  banActive: boolean;
  banResumeAt: string | null;
  restHealthy: boolean;
  busCounts: Record<string, number>;
  busCyclesCompleted: number;
  sentinel: string | null;
  futuresStore: string | null;
  advisorPending: number;
  lastNightAudit: string | null;
  gate: Partial<Record<keyof GateSettings, number>>;
  lastDeployAt: string | null;
}

export interface OpsDirective {
  kind: "PROPOSAL" | "ALERT" | "NOTE";
  knob?: string;
  proposedValue?: number;
  rationale: string;
  applied?: string;
}

export interface OpsCycle {
  at: string;
  verdict: OpsVerdict;
  label: "MODEL" | "HEURISTIC";
  diagnosis: string;
  rootCauses: string[];
  winRateOutlook: string;
  estPnlOutlook: string;
  directives: OpsDirective[];
  kpis: Pick<OpsKpis, "wr50" | "pnl24hUsd" | "estPnlTodayPct" | "issueStallMin">;
}

export interface OpsSupervisorState {
  at: number;
  cycles: number;
  lastRunAt: string | null;
  lastCycleAt: number | null; // epoch-ms of the last FULL cycle (cadence gate)
  lastTgAt: number | null;
  journal: OpsCycle[];
}

const EMPTY: OpsSupervisorState = { at: 0, cycles: 0, lastRunAt: null, lastCycleAt: null, lastTgAt: null, journal: [] };

const g = globalThis as unknown as { opsSupInflight?: boolean; opsSupLastProbe?: number };

async function getState(): Promise<OpsSupervisorState> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    if (row) return { ...EMPTY, ...(JSON.parse(row.value) as Partial<OpsSupervisorState>) };
  } catch {
    /* fresh */
  }
  return { ...EMPTY };
}

async function putState(next: OpsSupervisorState): Promise<void> {
  await db.engineSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
}

// ── 1. GATHER ────────────────────────────────────────────────────────────────

function tehranDayStartMs(now = Date.now()): number {
  const shifted = now + 210 * 60_000; // UTC+3:30 fixed
  const dayStart = Math.floor(shifted / 86_400_000) * 86_400_000;
  return dayStart - 210 * 60_000;
}

async function rollingWinRate(n: number): Promise<number | null> {
  const rows = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
    orderBy: { closedAt: "desc" },
    take: n,
    select: { reachedTp: true },
  });
  if (rows.length === 0) return null;
  const wins = rows.filter((r) => r.reachedTp >= 1).length;
  return Math.round((wins / rows.length) * 1000) / 10;
}

export async function gatherOpsKpis(): Promise<OpsKpis> {
  const dayStart = new Date(tehranDayStartMs());
  const dayAgo = new Date(Date.now() - 86_400_000);
  const settledStatuses = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] as const;

  const [stats, wr30, wr50, wr100, rawcal, feed, bus, gate, lastDeploy] = await Promise.all([
    import("@/lib/stats").then((m) => m.buildStats()),
    rollingWinRate(30),
    rollingWinRate(50),
    rollingWinRate(100),
    rawCalStatus(),
    Promise.resolve(getFeedStatus()),
    Promise.resolve(getTriggerBusSummary()),
    getGateSettings(),
    db.signal.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);

  const [todayAgg, settledToday, issuedToday, advisorPending, lastNight, armsFilled, pace] = await Promise.all([
    db.signal.aggregate({
      where: { closedAt: { gte: dayStart }, status: { in: [...settledStatuses] } },
      _sum: { pnlPercent: true },
      _count: true,
    }),
    db.signal.count({ where: { closedAt: { gte: dayStart }, status: { in: [...settledStatuses] } } }),
    db.signal.count({ where: { createdAt: { gte: dayStart }, tags: { contains: "RAW-CAL" } } }),
    db.advisorProposal.count({ where: { status: "PENDING" } }),
    db.engineSetting.findUnique({ where: { key: "seniorreview.state" } }).catch(() => null),
    Promise.resolve(null) as Promise<number | null>, // v14.0 — the legacy realArmsFilled probe never existed in shadow-veto; veto telemetry rides shadow-veto-latest.json
    import("@/lib/rawcal-telemetry").then((m) => m.computeRawcalPace().catch(() => null)),
  ]);

  // sentinel verdict — best-effort file read (same contract as senior-review)
  let sentinel: string | null = null;
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const raw = await fs.readFile(path.join(process.cwd(), ".data", "sentinel", "latest.json"), "utf8");
    sentinel = (JSON.parse(raw) as { verdict?: string }).verdict ?? null;
  } catch {
    /* cold */
  }

  // futures store maturity — best-effort (v10.22 five-family store)
  let futuresStore: string | null = null;
  try {
    const m = await import("@/lib/futures-taxonomy");
    const edge = await m.buildFuturesEdge();
    futuresStore = `${edge.settledRows}/${edge.maturity.target} fwd1h settled${edge.bestFilter ? ` · best ${edge.bestFilter.filter}` : ""}`;
  } catch {
    /* cold */
  }

  const srState = lastNight ? (JSON.parse(lastNight.value) as { lastRunAt?: string | null }) : null;
  const paceStall = pace?.stalls?.issueStallMin ?? null;
  const banRemainMs = fapiBanRemainingMs();
  const banUntil = banRemainMs > 0 ? Date.now() + banRemainMs : 0;

  return {
    wrOverall: stats?.winRate ?? null,
    wr30,
    wr50,
    wr100,
    pnl24hUsd: stats?.pnl24hUsd ?? null,
    estPnlTodayPct: Math.round((todayAgg._sum?.pnlPercent ?? 0) * 10) / 10,
    estPnlTodayUsd: null, // USD ledger is pct-derived (risk-normalized); the % IS the honest daily EST PNL metric
    settledToday,
    issuedToday,
    equity: stats?.account?.equity ?? null,
    rawcalArmed: rawcal.armed,
    rawcalIssuedTotal: rawcal.issuedTotal,
    rawcalBook: `${rawcal.settledN}/${rawcal.target} settled · open ${rawcal.openRaw}/${rawcal.maxOpen}`,
    rawcalArmsDone: typeof armsFilled === "number" ? armsFilled > 0 : null, // v14.0 — the probe returns a count; the state field is boolean
    issueStallMin: paceStall,
    banActive: banUntil > Date.now(),
    banResumeAt: banUntil ? new Date(banUntil).toISOString() : null,
    restHealthy: feed.source === "LIVE" || feed.source === "STALE", // v14.0 — retired cross-venue field; mapped to the Binance feed liveness
    busCounts: bus.counts ?? {},
    busCyclesCompleted: (bus as unknown as { cyclesCompleted?: number }).cyclesCompleted ?? 0,
    sentinel,
    futuresStore,
    advisorPending,
    lastNightAudit: srState?.lastRunAt ?? null,
    gate: { minScore: gate.minScore, maxActive: gate.maxActive, riskPerTrade: gate.riskPerTrade, ttlNearTpPct: gate.ttlNearTpPct, shortSizeMult: gate.shortSizeMult },
    lastDeployAt: lastDeploy?.createdAt.toISOString() ?? null,
  };
}

// ── 2. THINK ─────────────────────────────────────────────────────────────────

const SENIOR_PERSONA = `You are the NEXUS OPS-SUPERVISOR — a senior quantitative engineer (15y exp) overseeing a paper-trading signals desk running 24/7 in a sandbox. Your mission from the operator: RAISE THE WIN RATE and RAISE THE DAILY EST PNL % — honestly, with measured evidence only. You are conservative: you never invent numbers, never widen risk unilaterally, and you respect frozen calibration state. Respond with STRICT JSON only — no prose outside the JSON.`;

const DIRECTIVE_CONTRACT = `Directive kinds (whitelist):
- PROPOSAL: {kind:"PROPOSAL", knob:"<gate knob>", proposedValue:<number>, rationale:"<=200 chars"} — creates an operator-approval advisor proposal. Allowed knobs ONLY: minScore, maxActive, riskPerTrade, ttlNearTpPct, shortSizeMult, rrScale, slAtrMult, flowVetoScore. Values are clamped server-side. FORBIDDEN while RAW-CAL calibration capture is armed (weights frozen mandate).
- ALERT: {kind:"ALERT", rationale:"<=200 chars"} — urgent operator Telegram + audited event. Reserve for pipeline-down, equity drawdown, or data-integrity findings.
- NOTE: {kind:"NOTE", rationale:"<=200 chars"} — journal-only observation/agenda item.

Output STRICT JSON (no markdown fences):
{"diagnosis":"<=300 chars, evidence-cited","rootCauses":["<=120 chars each, max 3"],"verdict":"HEALTHY|WATCH|DEGRADE|CRITICAL","winRateOutlook":"<=140 chars","estPnlOutlook":"<=140 chars","directives":[...max 3...]}`;

function heuristicCycle(k: OpsKpis): OpsCycle {
  const rootCauses: string[] = [];
  const directives: OpsDirective[] = [];
  let verdict: OpsVerdict = "HEALTHY";

  // pipeline stalls first — the win-rate goal is downstream of a LIVE pipeline
  if (k.banActive) {
    rootCauses.push(`Binance REST ban active until ${k.banResumeAt?.slice(11, 16) ?? "?"}Z — scan plane blind, issuance honestly suppressed`);
    verdict = "WATCH";
    directives.push({ kind: "NOTE", rationale: `ban window — auto-resume ${k.banResumeAt?.slice(11, 16) ?? "?"}Z; ticker cache + backoff prevent escalation` });
  } else if (k.rawcalArmed && (k.issueStallMin ?? 0) > 180) {
    verdict = worse(verdict, "DEGRADE");
    rootCauses.push(`RAW-CAL issue stall ${Math.round(k.issueStallMin ?? 0)}min while armed — scans returning no candidates`);
    directives.push({ kind: "ALERT", rationale: `issuance stalled ${Math.round((k.issueStallMin ?? 0) / 60)}h while RAW-CAL armed and NO ban active — scan plane needs attention` });
  } else if (k.rawcalArmed && (k.issueStallMin ?? 0) > 90) {
    verdict = "WATCH";
    rootCauses.push(`issuance quiet ${Math.round(k.issueStallMin ?? 0)}min (spacing/no-candidate windows)`);
  }

  // win-rate outlook
  if ((k.wr50 ?? 100) < 15 || (k.pnl24hUsd ?? 0) <= -3) {
    verdict = "CRITICAL";
    rootCauses.push(`wr50 ${k.wr50 ?? "?"}% / 24h PnL ${k.pnl24hUsd ?? "?"}$ below the survival band`);
    directives.push({ kind: "ALERT", rationale: `win-rate 50-window ${k.wr50}% and 24h PnL ${k.pnl24hUsd}$ — desk bleeding, review before next cycle` });
  } else if ((k.wr50 ?? 100) < 20 || (k.pnl24hUsd ?? 0) < 0) {
    verdict = worse(verdict, "DEGRADE");
    rootCauses.push(`wr50 ${k.wr50}% with 24h PnL ${k.pnl24hUsd}$ — under the operator target band`);
    directives.push({
      kind: k.rawcalArmed ? "NOTE" : "PROPOSAL",
      ...(k.rawcalArmed ? {} : { knob: "riskPerTrade", proposedValue: 0.85 }),
      rationale: k.rawcalArmed
        ? `wr50 ${k.wr50}% — post-calibration agenda: tighten risk until the new weights prove edge (capture cohort is unfiltered by mandate)`
        : `wr50 ${k.wr50}% — shave riskPerTrade toward the evidence band until the win-rate recovers`,
    });
  }

  if (!k.restHealthy && !k.banActive) {
    directives.push({ kind: "ALERT", rationale: "Binance REST plane unhealthy outside any ban window — connectivity/DNS needs eyes" });
    verdict = worse(verdict, "WATCH");
  }
  if ((k.wr30 ?? 0) >= 35) directives.push({ kind: "NOTE", rationale: `wr30 ${k.wr30}% at/above target band — hold course` });

  return {
    at: new Date().toISOString(),
    verdict,
    label: "HEURISTIC",
    diagnosis: `HEURISTIC verdict ${verdict}: wr30/50/100 ${k.wr30}/${k.wr50}/${k.wr100}% · 24h ${k.pnl24hUsd}$ · today EST PNL ${k.estPnlTodayPct}% (${k.settledToday} settled) · RAW-CAL ${k.rawcalBook}`,
    rootCauses: rootCauses.length ? rootCauses : ["no red-flag pattern in the measured bundle"],
    winRateOutlook: (k.wr50 ?? 0) < 20 ? "below target — evidence-based tightening queued for post-calibration" : "within tolerance",
    estPnlOutlook: (k.pnl24hUsd ?? 0) < 0 ? "negative 24h — sizing discipline first, aggression later" : "non-negative — compounding path intact",
    directives,
    kpis: { wr50: k.wr50, pnl24hUsd: k.pnl24hUsd, estPnlTodayPct: k.estPnlTodayPct, issueStallMin: k.issueStallMin },
  };
}

async function llmCycle(k: OpsKpis): Promise<OpsCycle | null> {
  try {
    const { aiChat } = await import("@/lib/ai");
    const grounding = `OPS-SUPERVISOR CYCLE — MEASURED KPI BUNDLE (server-side, epoch ${new Date().toISOString()}):
${JSON.stringify(k, null, 1)}

Cite ONLY numbers present in this bundle. The desk is PAPER-trading (small USD figures are normal). RAW-CAL unfiltered capture rows deliberately have low win rate — do not propose gate changes while capture is armed.`;
    const content = await aiChat(
      [
        {
          role: "user",
          content: `${DIRECTIVE_CONTRACT}\n\nProduce your senior-engineer supervision cycle for the bundle above. Diagnose the desk against the operator goals (win rate ↑, daily EST PNL% ↑), name root causes, and issue at most 3 directives.`,
        },
      ],
      grounding,
    );
    if (content.startsWith("⚠")) return null; // neural link degraded marker
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]) as Partial<OpsCycle>;
    if (!j.diagnosis || !j.verdict || !["HEALTHY", "WATCH", "DEGRADE", "CRITICAL"].includes(j.verdict)) return null;
    return {
      at: new Date().toISOString(),
      verdict: j.verdict as OpsVerdict,
      label: "MODEL",
      diagnosis: String(j.diagnosis).slice(0, 300),
      rootCauses: (j.rootCauses ?? []).slice(0, 3).map((r) => String(r).slice(0, 120)),
      winRateOutlook: String(j.winRateOutlook ?? "").slice(0, 140),
      estPnlOutlook: String(j.estPnlOutlook ?? "").slice(0, 140),
      directives: (j.directives ?? []).slice(0, 3).map((d) => ({
        kind: (["PROPOSAL", "ALERT", "NOTE"].includes(String(d?.kind)) ? d.kind : "NOTE") as OpsDirective["kind"],
        knob: d?.knob ? String(d.knob) : undefined,
        proposedValue: typeof d?.proposedValue === "number" ? d.proposedValue : undefined,
        rationale: String(d?.rationale ?? "").slice(0, 200),
      })),
      kpis: { wr50: k.wr50, pnl24hUsd: k.pnl24hUsd, estPnlTodayPct: k.estPnlTodayPct, issueStallMin: k.issueStallMin },
    };
  } catch {
    return null;
  }
}

// ── 3. ACT (bounded) ─────────────────────────────────────────────────────────

async function knobBlocked(knob: string): Promise<boolean> {
  const recent = await db.advisorProposal.findMany({ where: { knob }, orderBy: { createdAt: "desc" }, take: 4 });
  if (recent.some((p) => p.status === "PENDING")) return true;
  const last = recent.find((p) => p.status === "APPLIED" || p.status === "REJECTED");
  if (last?.decidedAt) {
    if (last.status === "APPLIED" && Date.now() - last.decidedAt.getTime() < APPLIED_QUIET_MS) return true;
    if (last.status === "REJECTED") {
      const rejects = recent.filter((p) => p.status === "REJECTED");
      const two = rejects.length >= 2 && rejects[0].decidedAt && rejects[1].decidedAt;
      if (two && rejects[0].decidedAt && Date.now() - rejects[0].decidedAt.getTime() < REJECT_COOLDOWN_MS) return true;
    }
  }
  return false;
}

async function applyDirectives(cycle: OpsCycle, k: OpsKpis): Promise<void> {
  const clamps = gateClamps();
  const allowed = new Set(Object.keys(clamps));
  let proposals = 0;
  for (const d of cycle.directives) {
    if (d.kind === "PROPOSAL") {
      // calibration freeze: during RAW-CAL capture the gate belongs to the
      // operator mandate — demote to a post-calibration NOTE instead.
      if (k.rawcalArmed) {
        d.kind = "NOTE";
        d.applied = "demoted to NOTE — gate frozen during RAW-CAL calibration capture";
        d.rationale = `[post-calibration agenda] ${d.rationale}`;
        continue;
      }
      if (proposals >= PROPOSALS_PER_CYCLE || !d.knob || !allowed.has(d.knob) || typeof d.proposedValue !== "number") {
        d.applied = "skipped (budget/unknown-knob/value)";
        continue;
      }
      const key = d.knob as keyof GateSettings;
      const [lo, hi] = clamps[key];
      const target = Math.min(hi, Math.max(lo, Math.round(d.proposedValue * 100) / 100));
      const gate = await getGateSettings();
      if (Math.abs(target - gate[key]) < 0.01) {
        d.applied = "skipped (no-op at current value)";
        continue;
      }
      if (await knobBlocked(d.knob)) {
        d.applied = "skipped (pending/cooldown)";
        continue;
      }
      await db.advisorProposal.create({
        data: {
          cycle: -1,
          kind: "KNOB_ADJUST",
          knob: d.knob,
          currentValue: gate[key],
          proposedValue: target,
          direction: target < gate[key] ? "TIGHTEN" : "LOOSEN",
          rationale: `ops-supervisor: ${d.rationale}`.slice(0, 480),
          evidence: JSON.stringify({ source: "ops-supervisor", cycle: cycle.at, wr50: k.wr50, pnl24hUsd: k.pnl24hUsd, estPnlTodayPct: k.estPnlTodayPct }),
        },
      });
      d.applied = `advisor proposal queued ${gate[key]}→${target}`;
      proposals++;
    } else if (d.kind === "ALERT") {
      const lastTg = (await getState()).lastTgAt;
      const gap = Date.now() - (lastTg ?? 0);
      if (gap < (cycle.verdict === "CRITICAL" ? 3600_000 : TG_MIN_GAP_MS)) {
        d.applied = "suppressed (anti-spam gap)";
        continue;
      }
      const tg = await sendDirect(`🛰 <b>OPS-SUPERVISOR [${cycle.verdict}]</b>\n${d.rationale}\n📊 wr50 ${k.wr50}% · 24h ${k.pnl24hUsd}$ · today ${k.estPnlTodayPct}%`).catch(() => ({ ok: false }));
      d.applied = tg.ok ? "operator alerted (Telegram)" : "alert failed (Telegram unreachable)";
      await fireEvent(null, null, "SYSTEM", "warn", `OPS-SUPERVISOR ALERT [${cycle.verdict}]: ${d.rationale}`).catch(() => undefined);
      await putState({ ...(await getState()), lastTgAt: Date.now() });
    }
    // NOTE — journal-only by construction
  }
}

// ── the cron cycle ───────────────────────────────────────────────────────────

export async function runOpsSupervisorCycle(trigger = "cron"): Promise<OpsCycle> {
  const state = await getState();
  const kpis = await gatherOpsKpis();
  const model = await llmCycle(kpis);
  const cycle = model ?? heuristicCycle(kpis);
  await applyDirectives(cycle, kpis);

  const next: OpsSupervisorState = {
    at: Date.now(),
    cycles: state.cycles + 1,
    lastRunAt: cycle.at,
    lastCycleAt: Date.now(),
    lastTgAt: state.lastTgAt,
    journal: [...state.journal, cycle].slice(-JOURNAL_CAP),
  };
  await putState(next);

  const queued = cycle.directives.filter((d) => d.applied?.startsWith("advisor proposal")).length;
  void fireEvent(
    null,
    null,
    "SYSTEM",
    cycle.verdict === "CRITICAL" ? "warn" : "ai",
    `OPS-SUPERVISOR cycle #${next.cycles} (${trigger}, ${cycle.label}) — ${cycle.verdict}: ${cycle.diagnosis.slice(0, 180)}${queued ? ` · ${queued} proposal(s) queued` : ""}`,
  ).catch(() => undefined);
  void recordFourPack(
    "ops-supervisor",
    "cycle",
    `${cycle.verdict} (${cycle.label}) — wr50 ${kpis.wr50}% · 24h ${kpis.pnl24hUsd}$ · today ${kpis.estPnlTodayPct}% — ${cycle.diagnosis.slice(0, 140)}`,
    { verdict: cycle.verdict, label: cycle.label, kpis, directives: cycle.directives },
  ).catch(() => undefined);

  // digest policy: send when it matters (verdict, proposals) or 6h heartbeat
  const dueTg = cycle.verdict !== "HEALTHY" || queued > 0 || next.cycles % 3 === 0;
  if (dueTg && Date.now() - (state.lastTgAt ?? 0) > (cycle.verdict === "CRITICAL" ? 3600_000 : TG_MIN_GAP_MS)) {
    const lines = [
      `🛰 <b>OPS-SUPERVISOR — senior-engineer cycle #${next.cycles}</b> (${cycle.label})`,
      `Verdict: <b>${cycle.verdict}</b>`,
      `🎯 WIN RATE: 30d ${kpis.wr30}% · 50d ${kpis.wr50}% · 100d ${kpis.wr100}% (overall ${kpis.wrOverall}%) — ${cycle.winRateOutlook}`,
      `💰 EST PNL: today ${(kpis.estPnlTodayPct ?? 0) >= 0 ? "+" : ""}${kpis.estPnlTodayPct ?? 0}% over ${kpis.settledToday} settled · 24h ${kpis.pnl24hUsd}$ — ${cycle.estPnlOutlook}`,
      `🧪 RAW-CAL: ${kpis.rawcalBook} · issued ${kpis.rawcalIssuedTotal} lifetime${kpis.banActive ? ` · REST BAN → ${kpis.banResumeAt?.slice(11, 16)}Z` : ""}`,
      cycle.rootCauses.length ? `Root causes: ${cycle.rootCauses.join(" · ")}` : "",
      ...cycle.directives.map((d) => `• [${d.kind}] ${d.rationale}${d.applied ? ` → ${d.applied}` : ""}`),
      queued ? `⚠️ ${queued} advisor proposal(s) await operator approval in AI CORE.` : "",
    ].filter(Boolean);
    const tg = await sendDirect(lines.join("\n")).catch(() => ({ ok: false }));
    if (tg.ok) await putState({ ...(await getState()), lastTgAt: Date.now() });
  }

  return cycle;
}

/** Pulse-riding cron gate — runs a full cycle when the 2h cadence is due. */
export async function maybeRunOpsSupervisor(force = false): Promise<{ ran: boolean; reason?: string; cycle?: OpsCycle }> {
  const now = Date.now();
  if (!force) {
    if (g.opsSupInflight) return { ran: false, reason: "inflight" };
    if (g.opsSupLastProbe && now - g.opsSupLastProbe < PROBE_THROTTLE_MS) return { ran: false, reason: "throttled" };
    g.opsSupLastProbe = now;
  }
  const state = await getState();
  if (!force && state.lastCycleAt && now - state.lastCycleAt < CYCLE_INTERVAL_MS) {
    return { ran: false, reason: "cadence", cycle: state.journal[state.journal.length - 1] };
  }
  g.opsSupInflight = true;
  try {
    const cycle = await runOpsSupervisorCycle(force ? "manual" : "cron");
    return { ran: true, cycle };
  } catch (e) {
    console.error("[ops-supervisor]", e);
    return { ran: false, reason: String(e).slice(0, 120) };
  } finally {
    g.opsSupInflight = false;
  }
}

export async function getOpsSupervisorStatus(): Promise<OpsSupervisorState & { intervalMs: number; nextDueAt: number | null }> {
  const state = await getState();
  return {
    ...state,
    intervalMs: CYCLE_INTERVAL_MS,
    nextDueAt: state.lastCycleAt ? state.lastCycleAt + CYCLE_INTERVAL_MS : null,
  };
}
