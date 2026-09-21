import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getGateSettings, gateClamps, describeGate } from "@/lib/gate-settings";
import { getGovernorState } from "@/lib/governor";
import { getCalibration } from "@/lib/calibration";
import { getBacktest, learnedGateAllows, getLearnerAutoState } from "@/lib/backtest";
import { getTriggerBusSummary } from "@/lib/triggers";
import { getFlowStatus } from "@/lib/flow";
import { getScanDomain } from "@/lib/engine";
import { getSupervisorStatePersisted } from "@/lib/supervisor";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/agent — the AI agent's MANIFEST (v5.1).
 * Answers "آیا برای AI اسکیل و دستوری تعیین شده؟" with the actual wiring:
 * SKILLS it may execute, the AUTHORITY clamps that bound them, the MEMORY it
 * learns from, and the RECENT ACTIONS it took autonomously.
 */
export async function GET() {
  try {
    const [gate, governor, cal, bt, learned, learnerAuto, bus, flow, scan] = await Promise.all([
      getGateSettings(),
      getGovernorState(),
      getCalibration(),
      getBacktest(),
      learnedGateAllows(),
      getLearnerAutoState(),
      Promise.resolve(getTriggerBusSummary()),
      Promise.resolve(getFlowStatus()),
      getScanDomain(),
    ]);

    const settled = await db.signal.findMany({ where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } }, select: { pnlPercent: true, reachedTp: true }, take: 400 });
    // v6.0: TP-proven win definition — aligned with stats/analytics (reachedTp ≥ 1 counts as a win)
    const realizedWr = settled.length ? (settled.filter((s) => s.pnlPercent > 0 || s.reachedTp >= 1).length / settled.length) * 100 : 0;

    const engineEvents = await db.signalEvent.findMany({ where: { type: "ENGINE", level: { in: "ai warn".split(" ") } }, orderBy: { createdAt: "desc" }, take: 8 });
    const sup = await getSupervisorStatePersisted();

    const skills = [
      {
        id: "MARKET_SCAN",
        name: "Market Scan",
        scope: `rotates ${scan.tracked} flow-ranked USDT-M perps via the 6-layer trigger bus (L1 taker → L4 macro)`,
        autonomous: true,
        state: `${bus.counts ? Object.values(bus.counts).reduce((a, b) => a + b, 0) : 0} triggers measured · flow ${flow.covered} symbols`,
      },
      {
        id: "DEPLOY_GATES",
        name: "Deploy Gates",
        scope: `runs confluence + flow + regime + memory + learned gates before any signal (now ${describeGate(gate)})`,
        autonomous: true,
        state: learned.allowed ? "learned gate: AUTO-DEPLOY ALLOWED" : "learned gate: auto-deploy SUPPRESSED (honest)",
      },
      {
        id: "GOVERN",
        name: "AI Governor",
        scope: `LLM cycles every ${governor.intervalMin}min — PERMANENTLY ENGAGED (manual modes removed v6.0): set_min_score · set_flow_veto · set_flow_shortlist · set_universe · run_backtest · run_autotune`,
        autonomous: true,
        state: `${governor.cycles} cycles · max ${governor.maxActions} actions/cycle · ${governor.lastRunAt ? `last ${governor.lastRunAt.slice(0, 16)}Z` : "first auto cycle pending"}`,
      },
      {
        id: "BACKTEST_LEARN",
        name: "Backtest & Learner",
        scope: `replays history through the real scorer + fees, then a 16-trial sweep ADOPTS better weights — scheduler ALWAYS ON (every ${learnerAuto.intervalHours}h, no manual mode)`,
        autonomous: true,
        state: bt ? `last replay n=${bt.n} · WR ${bt.winRate}% · Wilson-LB ${bt.wilsonLB}%` : "no replay stored yet",
      },
      {
        id: "CALIBRATE",
        name: "Factor Calibration",
        scope: `per-factor win-rate weights (×0.75–1.25) from SETTLED live outcomes`,
        autonomous: true,
        state: `${cal.status} ${cal.settled}/${cal.target} settled`,
      },
      {
        id: "RISK_SENSE",
        name: "Risk Sensing",
        scope: "regime filter (layer-0), counter-cascade veto windows, crowd-cut sizing, OI-notional flow weighting",
        autonomous: true,
        state: `${bus.suppressed.length} suppressed · ${bus.crowdCut.length} crowd-cut windows active`,
      },
      {
        id: "SUPERVISE",
        name: "AI Supervisor",
        scope: "watchdog above the governor: feed health · flow blindness · signal drought/flood · learner staleness · LLM link — safe nudges only, every check audited",
        autonomous: true,
        state: `${sup.checks} checks · ${sup.findings.length} findings · ${sup.nudgesIssued} governor nudges${sup.llmAuthFails ? ` · ${sup.llmAuthFails} LLM auth recoveries` : ""} · last ${sup.lastCheckAt ? sup.lastCheckAt.slice(11, 16) + "Z" : "—"}`,
      },
      {
        id: "VERACITY",
        name: "Veracity Watchdog",
        scope: "ZERO-TOLERANCE anti-hallucination + anti-simulation duty (v6.0): every LLM output grounding-audited number-by-number against its measured bundle; simulation-pattern guard watches for fake pipelines (feed-blind deploys, mislabeled heuristics, mock language)",
        autonomous: true,
        state: `${sup.audits} outputs audited · ${sup.hallucinationFlags} hallucination flags · ${sup.simulationFlags} simulation flags · ${sup.llmRing.filter((r) => r.outcome === "MODEL").length}/${sup.llmRing.length} recent calls MODEL`,
      },
    ];

    return NextResponse.json({
      ts: Date.now(),
      version: "AI-AGENT v6.0",
      mandate:
        "FULL AUTONOMY + VERACITY: learning and deployment run with ZERO manual modes — every process is automatic, intelligent, and controlled by LLM agents. Every number measured, every action clamped, every output grounding-audited against hallucination and simulation. «هیچ توهم و شبیه سازی انجام نشه».",
      skills,
      authority: {
        clamps: Object.fromEntries(Object.entries(gateClamps()).map(([k, v]) => [k, { min: v[0], max: v[1], def: v[2] }])),
        current: gate,
        describe: describeGate(gate),
        note: "The agent tunes the SAME clamped tunables an operator has — hard bounds it can never cross.",
      },
      memory: {
        settledSignals: settled.length,
        realizedWinRate: Number(realizedWr.toFixed(1)),
        calibration: { status: cal.status, settled: cal.settled, target: cal.target, rows: cal.rows.length },
        learnedGate: { allowed: learned.allowed, reason: learned.reason },
        learner: { auto: learnerAuto.enabled, intervalHours: learnerAuto.intervalHours, lastRunAt: learnerAuto.lastRunAt },
        lastBacktest: bt ? { n: bt.n, winRate: bt.winRate, wilsonLB: bt.wilsonLB, avgNetPct: bt.avgNetPct, verdict: bt.verdict } : null,
      },
      autonomy: {
        governorEngaged: true,
        manualModesRemoved: true,
        intervalMin: governor.intervalMin,
        maxActions: governor.maxActions,
        cycles: governor.cycles,
        running: governor.running,
        log: governor.log.slice(0, 5),
      },
      recentActions: engineEvents.map((e) => ({ at: e.createdAt.toISOString(), message: e.message })),
      supervisor: {
        findings: sup.findings,
        checks: sup.checks,
        nudgesIssued: sup.nudgesIssued,
        llmAuthFails: sup.llmAuthFails,
        audits: sup.audits,
        hallucinationFlags: sup.hallucinationFlags,
        simulationFlags: sup.simulationFlags,
        llmRing: sup.llmRing,
      },
      scanDomain: scan,
    });
  } catch (err) {
    console.error("[ai/agent:GET]", err);
    return NextResponse.json({ error: "agent manifest failed" }, { status: 500 });
  }
}
