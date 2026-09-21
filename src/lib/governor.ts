// ── NEXUS//SIGNALS AI GOVERNOR (server-only, v6.0) ──
// The LLM analyst as an INDEPENDENT decision-maker wired into the system core:
// every cycle it receives a fully GROUNDED telemetry bundle (prices, regimes,
// flow coverage, realized memory, learner verdicts, gate state, open risk) and
// returns strict JSON decisions. The core validates every decision against the
// existing clamps, applies it, and audits it as an ENGINE event + log ring.
// The governor can NEVER break the honesty contract — it only tunes the same
// clamped tunables an operator has, and can trigger the history learner.
//
// ── v6.0 FULL AUTONOMY (operator mandate: «هیچ حالت دستی برای یادگیری و
// استقرار نباید باشه») — the governor is PERMANENTLY ENGAGED: the manual
// toggle/POST endpoints are gone, `enabled` is forced true, and the only
// triggers are the autonomous scheduler + supervisor nudges. Deployment
// control is agent-controlled, clamped, and audited — never hand-driven.

import { db } from "@/lib/db";
// v5.3: TYPE-ONLY import for ai.ts — the runtime bridge is loaded via dynamic
// import inside runGovernorCycle. A syntax/runtime failure in the AI bridge can
// NO LONGER take down the engine data plane (pulse → engine → governor chain).
import type { GovernorDecision } from "./ai";
import { getGateSettings, putGateSettings, describeGate, describeClamps, type GateSettings } from "./gate-settings";
import { getCalibration } from "./calibration";
import { getBacktest, learnedGateAllows, getLearnerAutoState, runBacktest, runAutotune } from "./backtest";
import { getFlowStatus } from "./flow";
import { getTriggerBusSummary } from "./triggers";
import { peekRegime, getRegimeTelemetry } from "./regime";
import { fireEvent } from "./engine";
import { getTtlTelemetry } from "./ttl-gate";

const KEY = "governor";
const KEY_LOG = "governor.log";
const KEY_HYST = "governor.hysteresis";
const LOG_CAP = 24;

// v6.2 GOVERNOR HYSTERESIS (architecture review P2):
// Two autonomous actuators (LLM decisions, drought relief, supervisor quality
// valve) can fight over the same knob cycle-after-cycle — the observed
// pathology was MIN_SCORE being ratcheted up by quality drift then forced
// down by drought relief within a single hour, oscillating the deployment
// pipeline. Every knob now carries a cooldown: once changed, it cannot be
// changed AGAIN (to a different value) for 90 minutes. Safety relief always
// fires (lockout beats thrash), but it records into the same map so the
// quality valve cannot immediately undo it.
// v6.3: the DYNAMIC RISK knobs (SL ATR multiple, RR scale, regime guard) join
// the same hysteresis domain — one flip-flopping risk profile is worse than none.
const KNOB_COOLDOWN_MS = 90 * 60_000;
const HYST_ACTIONS = new Set(["set_min_score", "set_flow_veto", "set_flow_shortlist", "set_universe", "set_ttl_extend_max", "set_ttl_extend_minutes", "set_ttl_near_tp", "set_sl_atr_mult", "set_rr_scale", "set_regime_guard", "set_max_active", "set_risk_per_trade"]);

type HysteresisMap = Record<string, { at: number; from: number | null; to: number }>;

async function getHysteresis(): Promise<HysteresisMap> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY_HYST } });
    if (row) return JSON.parse(row.value) as HysteresisMap;
  } catch {
    /* fresh */
  }
  return {};
}

async function putHysteresis(map: HysteresisMap): Promise<void> {
  // keep only live entries so the row never grows
  const live = Object.fromEntries(Object.entries(map).filter(([, v]) => Date.now() - v.at < 7 * 86_400_000));
  await db.engineSetting.upsert({ where: { key: KEY_HYST }, create: { key: KEY_HYST, value: JSON.stringify(live) }, update: { value: JSON.stringify(live) } });
}

function knobCooling(hyst: HysteresisMap, action: string): { cooling: boolean; minsLeft: number } {
  const rec = hyst[action];
  if (!rec) return { cooling: false, minsLeft: 0 };
  const elapsed = Date.now() - rec.at;
  return elapsed < KNOB_COOLDOWN_MS ? { cooling: true, minsLeft: Math.ceil((KNOB_COOLDOWN_MS - elapsed) / 60_000) } : { cooling: false, minsLeft: 0 };
}

export interface GovernorConfig {
  enabled: boolean;
  intervalMin: number;
  maxActions: number;
  cycles: number;
  lastRunAt: string | null;
}

export interface GovernorLogRow {
  at: string;
  trigger: "auto" | "supervisor";
  label: "MODEL" | "HEURISTIC";
  gatesBefore: string;
  gatesAfter: string;
  applied: number;
  decisions: Array<{ action: string; value?: number; rationale: string; applied: boolean }>;
}

export interface GovernorState extends GovernorConfig {
  running: boolean;
  log: GovernorLogRow[];
}

const DEFAULTS: GovernorConfig = { enabled: true, intervalMin: 45, maxActions: 2, cycles: 0, lastRunAt: null };

export async function getGovernorState(): Promise<GovernorState> {
  let cfg: GovernorConfig = { ...DEFAULTS };
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    if (row) cfg = { ...cfg, ...(JSON.parse(row.value) as Partial<GovernorConfig>) };
  } catch {
    /* defaults */
  }
  // v6.0: the governor is PERMANENTLY ENGAGED — a stale persisted `enabled:
  // false` (pre-autonomy era) can never put it back on manual standby.
  cfg.enabled = true;
  let log: GovernorLogRow[] = [];
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY_LOG } });
    if (row) log = JSON.parse(row.value) as GovernorLogRow[];
  } catch {
    /* empty */
  }
  return { ...cfg, running: cycleInFlight, log };
}

export async function setGovernorConfig(patch: Partial<Pick<GovernorConfig, "intervalMin" | "maxActions">>): Promise<GovernorState> {
  const cur = await getGovernorState();
  const next: GovernorConfig = {
    ...cur,
    enabled: true, // v6.0: permanently engaged — no manual override exists
    intervalMin: patch.intervalMin ? Math.min(240, Math.max(10, patch.intervalMin)) : cur.intervalMin,
    maxActions: patch.maxActions ? Math.min(3, Math.max(1, patch.maxActions)) : cur.maxActions,
  };
  await db.engineSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
  return { ...next, running: cycleInFlight, log: cur.log };
}

// ── deploy-rate probe — the anti-lockup sensor ──
// v5.2: the governor ratcheting MIN_SCORE to the clamp ceiling produced a
// 12h signal drought (0 deploys). Every cycle now MEASURES deployment flow and
// (a) reports it to the LLM, (b) blocks raises on tiny samples, (c) forces a
// step-down when the engine has been silent too long. Signals must flow.
async function deployRate(): Promise<{ deploys6h: number; hoursSinceLast: number | null }> {
  const since = new Date(Date.now() - 6 * 3600_000);
  const [recent, last] = await Promise.all([
    db.signal.count({ where: { createdAt: { gte: since } } }),
    db.signal.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  return { deploys6h: recent, hoursSinceLast: last ? (Date.now() - new Date(last.createdAt).getTime()) / 3600_000 : null };
}

const MIN_SCORE_RELIEF_FLOOR = 42; // engine never locks itself above this
const EVIDENCE_MIN_SETTLED = 8; // raises need at least this many settled outcomes
const MIN_SCORE_QUALITY_CEILING = 45; // supervisor never tightens above this
const SUPERVISOR_TRAILING_N = 15; // trailing settled window for WR drift
const SUPERVISOR_WR_FLOOR = 15; // below this → quality drift

// ── grounded telemetry bundle — every line is a MEASURED number ──
async function buildGovernorContext(): Promise<string> {
  const [gate, cal, bt, learned, learnerAuto, flow, bus, regimeTel] = await Promise.all([getGateSettings(), getCalibration(), getBacktest(), learnedGateAllows(), getLearnerAutoState(), Promise.resolve(getFlowStatus()), Promise.resolve(getTriggerBusSummary()), getRegimeTelemetry()]);

  const settled = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
    select: { status: true, strategy: true, pnlPercent: true, reachedTp: true, marginUsd: true, tags: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  // v5.4 TP-proven WR — TP1/TP2/TP3 touches are wins (matches analytics)
  const realizedWr = settled.length ? (settled.filter((s) => s.pnlPercent > 0 || s.reachedTp >= 1).length / settled.length) * 100 : 0;
  // v6.3 RISK LEDGER inputs — stop-rate + bucket USD so the LLM tunes SL/RR from evidence
  const slSigs = settled.filter((s) => s.status === "SL");
  const tpSigs = settled.filter((s) => s.status === "TP3");
  const stopRate = settled.length ? (slSigs.length / settled.length) * 100 : null;
  const slNetUsd = slSigs.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const tp3NetUsd = tpSigs.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  // v6.3 STRATEGY LEDGER — net expectancy per strategy (profit-first telemetry)
  const stratAcc = new Map<string, { n: number; pct: number; usd: number }>();
  for (const s of settled) {
    const c = stratAcc.get(s.strategy ?? "?") ?? { n: 0, pct: 0, usd: 0 };
    c.n++;
    c.pct += s.pnlPercent;
    c.usd += (s.marginUsd * s.pnlPercent) / 100;
    stratAcc.set(s.strategy ?? "?", c);
  }
  const strategyLedger = [...stratAcc.entries()].map(([strategy, c]) => ({ strategy, n: c.n, expectancy: Number((c.pct / c.n).toFixed(2)), netUsd: Number(c.usd.toFixed(2)) })).sort((a, b) => b.netUsd - a.netUsd);

  const open = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { symbol: true, direction: true, confidence: true, pnlPercent: true, serial: true }, take: 8 });
  const assets = await db.marketAsset.findMany({ orderBy: { volume24h: "desc" }, take: 10 });

  const rate = await deployRate();
  const ttlTel = await getTtlTelemetry();
  const expiredPost = await db.signal.groupBy({ by: ["afterlife"], _count: true, where: { status: "EXPIRED" } });
  const expPost = Object.fromEntries(expiredPost.map((r) => [r.afterlife ?? "none", r._count]));
  const expTotal = Object.values(expPost).reduce((a, b) => a + b, 0);
  const expWon = (expPost["TP1_HIT"] ?? 0) + (expPost["TP2_HIT"] ?? 0) + (expPost["TP3_HIT"] ?? 0);
  const lines: string[] = [
    "TELEMETRY BUNDLE (all numbers measured — none invented):",
    // v6.3: the clamp table grounds every knob request — requesting outside a
    // legal range wastes an action (the MIN_SCORE-constancy root cause)
    `0. CLAMPS (hard ranges the core enforces — request values INSIDE these): ${describeClamps()}`,
    `1. GATES: ${describeGate(gate)}`,
    `2. REALIZED MEMORY: ${settled.length} settled live signals, realized WR ${realizedWr.toFixed(1)}%, NET expectancy ${(settled.reduce((a, s) => a + s.pnlPercent, 0) / Math.max(1, settled.length)).toFixed(2)}%/trade`,
    `3. LEARNED GATE: ${learned.allowed ? "AUTO-DEPLOY ALLOWED" : "AUTO-DEPLOY SUPPRESSED"} — ${learned.reason}`,
    bt
      ? `4. BACKTEST LEARNER (last replay ${bt.ranAt.slice(0, 16)}Z): n=${bt.n}, WR ${bt.winRate}%, Wilson-LB ${bt.wilsonLB}%, expectancy ${bt.avgNetPct}%/trade NET, equity $${bt.equityEnd} — verdict: ${bt.verdict}`
      : "4. BACKTEST LEARNER: no replay stored yet",
    `5. LEARNER SCHEDULER: ${learnerAuto.enabled ? `auto every ${learnerAuto.intervalHours}h` : "auto disabled"}, last run ${learnerAuto.lastRunAt ?? "never"}, running=${learnerAuto.running}`,
    `6. CALIBRATION: ${cal.status} (${cal.settled}/${cal.target} settled), rows=${cal.rows.length} — v6.3 weights derive from NET-PNL expectancy (avg %/trade per factor), not raw win rate`,
    `7. FLOW COVERAGE: ${flow.covered} symbols live (CVD/OI/funding/crowd measured per symbol)`,
    `8. TRIGGER BUS: ${JSON.stringify(bus.counts)} — L1 sweeps act as event-driven candidate spawns`,
    `8b. DEPLOY RATE / CAPACITY: ${rate.deploys6h} signals deployed in last 6h${rate.hoursSinceLast !== null ? `, last deploy ${rate.hoursSinceLast.toFixed(1)}h ago` : ", none ever"} — open ${open.length}/${gate.maxActive} capacity slots (set_max_active owns the cap). 0 deploys WITH free slots means the engine is LOCKED, loosen gates rather than raise them; 0 deploys AT capacity is normal, not a lockup`,
    `8c. TTL-GATE (dynamic expiry): policy +${gate.ttlExtendMinutes}m ×≤${gate.ttlExtendMax} near-TP band ${gate.ttlNearTpPct}% — granted ${ttlTel.extended} extensions → TP ${ttlTel.tpAfter} / SL ${ttlTel.slAfter} / re-expired ${ttlTel.reExpired}, $${ttlTel.capturedUsd} captured · DENIED ${ttlTel.denied} expiries (${ttlTel.deniedNearTp} with next TP inside 2× band — if this stays high while post-mortem wins, widen the band via set_ttl_near_tp) · EXPIRED post-mortem: ${expWon}/${expTotal} would have hit TP within 48h after TTL (${expTotal ? Math.round((expWon / Math.max(1, expTotal)) * 100) : 0}%) — tune set_ttl_extend_max/minutes/set_ttl_near_tp from this evidence`,
    // v6.3 REGIME LEDGER — realized per-regime outcomes so the guard level is evidence-tuned
    `8d. REGIME LEDGER (realized outcomes per regime, guard L${gate.regimeGuard}): ${Object.entries(regimeTel).length ? Object.entries(regimeTel).map(([r, c]) => `${r} n=${c.n} WR=${c.n ? Math.round((c.wins / c.n) * 100) : 0}% $${c.pnlUsd >= 0 ? "+" : ""}${c.pnlUsd.toFixed(2)}`).join(" · ") : "warming up (no closes yet)"} — if CHOP/VOLATILE bleeds USD while TREND wins, harden via set_regime_guard (L2 adds BTC-spillover + vol MR veto); if the guard is vetoing profitable regimes, soften to L0`,
    // v6.3 RISK LEDGER — stop-rate + bucket USD so SL distance / RR scale are evidence-tuned
    `8e. RISK LEDGER: stop-rate ${stopRate !== null ? `${stopRate.toFixed(0)}% (${slSigs.length}/${settled.length} settled died at SL)` : "no settles yet"}, SL bucket $${slNetUsd.toFixed(2)} vs full-TP bucket $${tp3NetUsd.toFixed(2)} — stops now ${gate.slAtrMult}×ATR, ladder scale ×${gate.rrScale.toFixed(2)}. High stop-rate + heavy SL bleed → widen via set_sl_atr_mult; trades dying of TIME with rare stops → tighten. TP3 conversion ${tpSigs.length}/${settled.length} — greedy targets (rare TP3, SL-dominant) → trim via set_rr_scale`,
    // v6.3 PROFIT-FIRST STRATEGY LEDGER — expectancy per strategy (win rate lies:
    // a 28% WR strategy bleeding −13%/trade and a 54% WR one printing +8%/trade
    // can share the same "WR" narrative; net PNL cannot)
    `8f. STRATEGY LEDGER (net expectancy per strategy — profit is the criterion, not win count): ${strategyLedger.length ? strategyLedger.map((r) => `${r.strategy} n=${r.n} exp ${r.expectancy >= 0 ? "+" : ""}${r.expectancy}%/trade $${r.netUsd >= 0 ? "+" : ""}${r.netUsd.toFixed(0)}`).join(" · ") : "no settles yet"} — negative-expectancy strategies should be suppressed/tightened (the memory gate auto-suppresses below −2%/trade over n≥12)`,
    open.length
      ? `9. OPEN RISK: ${open.map((o) => `NX-${String(o.serial).padStart(4, "0")} ${o.symbol} ${o.direction} ${o.pnlPercent >= 0 ? "+" : ""}${o.pnlPercent.toFixed(1)}%`).join(" · ")}`
      : "9. OPEN RISK: no open signals",
    `10. UNIVERSE: ${assets.map((a) => `${a.symbol} ${a.change24h >= 0 ? "+" : ""}${a.change24h.toFixed(1)}%${peekRegime(a.symbol) ? `[${peekRegime(a.symbol)!.regime}]` : ""}`).join(", ")}`,
  ];
  // v8.4.3 VERDICT-CORE WIRING (operator: «چرا از نتایج Verdict core استفاده
  // نمیشه؟») — the deep-learn findings now ground the governor's tuning context:
  // each cycle reads the latest lessons from the gate-journal research desk so
  // knob decisions can weigh the core's own pattern findings. Dynamic import —
  // verdict.ts dynamically imports engine.ts which imports this module.
  try {
    const { getVerdictCoreState } = await import("./verdict");
    const vc = await getVerdictCoreState();
    if (vc.lastRunAt) {
      const top = vc.lessons.slice(0, 3).map((l) => `${l.pattern} → ${l.action} (conf ${l.confidence}%, ${l.label})`).join(" · ");
      lines.push(`11. VERDICT-CORE LESSONS (deep-learn over the gate journal, cycle #${vc.runs} @ ${vc.lastRunAt.slice(0, 16)}Z): ${top || "no lessons stored yet"} — these are the core's own recurring confirm/reject patterns; weigh them in your tuning rationale alongside the ledgers above`);
    }
  } catch { /* verdict-core unavailable → context simply omits line 11 */ }
  // v9.1 CENTRAL-INTELLIGENCE EXTENSIONS (operator mandate 2026-09-13) — the
  // governor must KNOW about the two new authority layers before it tunes:
  // radar direct-authority deploys and the RAW-CAL capture cohort (both ride
  // OUTSIDE the generic quality gates, so the governor must not read their
  // settles as evidence about the gate threshold itself).
  try {
    const { readPersistedPumpPerformance } = await import("./pump-performance");
    const { rawCalStatus } = await import("./raw-cal");
    const [pp, rc] = await Promise.all([readPersistedPumpPerformance(), rawCalStatus()]);
    if (pp) {
      const k = pp.perKind.map((r) => `${r.kind} ${r.success}/${r.resolved} (${r.successRatePct}%)`).join(" · ");
      lines.push(`12. PUMP/DUMP RADAR JOURNAL: ${pp.headline} per-kind: ${k}; 24h declared ${pp.window24h.declared}; radar-spawned signals ${pp.totals.spawnedSignals} — radar deploys carry DIRECT AUTHORITY (evidence conviction ≥78, engine quality gates bypassed); judge the radar cohort by its own ledger, not the MIN_SCORE gate`);
    }
    const raw13 = `13. RAW-CAL CAPTURE: ${rc.armed ? `ARMED — unfiltered RAW-CAL records issue every ≥${rc.spacingMin}min (open ${rc.openRaw}/${rc.maxOpen}, lifetime ${rc.issuedTotal}, settled ${rc.settledRaw}${rc.rawWinRatePct !== null ? `, WR ${rc.rawWinRatePct}%` : ""})` : "OFF"} — the EPOCH-2 book is ${rc.settledN}/${rc.target} settled; while ARMED, EXCLUDE RAW-CAL-tagged settles from gate-quality reasoning (they sample rejected flows by design) and expect the R6 calibration lift at n≥${rc.target}`;
    // v9.3 sample-quality gate — the governor also knows whether the raw cohort
    // is HEALTHY enough for the R6 recalibration to rest on (advisory only)
    try {
      const { computeRawcalQuality } = await import("./rawcal-quality");
      const q = await computeRawcalQuality();
      lines.push(`${raw13} · SAMPLE QUALITY ${q.gate.verdict}: healthy ${q.healthyPct ?? "—"}% (floor ${q.gate.healthFloor}), informative ${q.informativePct ?? "—"}%, snapshots ${q.snapshotPct ?? "—"}%${q.warnings.length ? `, watch: ${q.warnings[0]}` : ", no issues"}`);
    } catch {
      lines.push(raw13);
    }
  } catch { /* extensions unavailable → context simply omits lines 12-13 */ }
  return lines.join("\n");
}

/** Rule-based fallback when the neural link is down — still grounded, still clamped. */
function heuristicDecisions(bt: Awaited<ReturnType<typeof getBacktest>>, realizedWr: number, settledCount: number, gateMinScore: number, gate: GateSettings, stopRate: number | null, slNetUsd: number): GovernorDecision[] {
  // v6.3: stop-bleed heuristic — when nearly half of settles die at the stop
  // AND the SL bucket is the dominant USD bleed, widen the ATR multiple one notch.
  if (stopRate !== null && stopRate >= 45 && slNetUsd <= -20 && gate.slAtrMult < 2.1) {
    return [{ action: "set_sl_atr_mult", value: Number(Math.min(2.5, gate.slAtrMult + 0.25).toFixed(2)), rationale: `HEURISTIC: stop-rate ${stopRate.toFixed(0)}% with SL bucket $${slNetUsd.toFixed(2)} — noise is taking trades out, widening stops ${gate.slAtrMult}→${Math.min(2.5, gate.slAtrMult + 0.25).toFixed(2)}×ATR` }];
  }
  if (bt && bt.n >= 20 && bt.wilsonLB < 30 && gateMinScore > 25) {
    return [{ action: "set_min_score", value: Math.max(25, gateMinScore - 3), rationale: `HEURISTIC: backtest Wilson-LB ${bt.wilsonLB}% <30 with n=${bt.n} — tighten threshold is wrong direction, loosen minScore to admit higher-quality grid only if flow confirms` }];
  }
  if (settledCount >= 10 && realizedWr < 25 && gateMinScore < 55) {
    return [{ action: "set_min_score", value: Math.min(60, gateMinScore + 5), rationale: `HEURISTIC: realized WR ${realizedWr.toFixed(0)}% over ${settledCount} settled <25% — raise MIN_SCORE to filter marginal confluence` }];
  }
  if (!bt || Date.now() - new Date(bt.ranAt).getTime() > 12 * 3600_000) {
    return [{ action: "run_backtest", rationale: "HEURISTIC: learner evidence stale (>12h) — refresh the replayed-history mean" }];
  }
  return [{ action: "no_op", rationale: `HEURISTIC: no dominant signal to act on — WR ${realizedWr.toFixed(0)}%, gates ${describeGate(gate)}` }];
}

let cycleInFlight = false;

// v8.4.1 N2 (operator mandate «هوش غیرفعال شده رو فعال و پایدار کن»): the
// supervisor fires a governor cycle every ~2min and each one attempted an LLM
// call — ~30 calls/h of background pressure against a provider that is
// throttling (429). Doctrine: the operator tier comes first. The governor now
// attempts the MODEL at most once per 15min; between attempts the designed
// rule-based heuristic speaks (still grounded, still clamped, honestly
// labeled). Decision capability is unchanged — only the LLM burn is spaced.
const GOVERNOR_LLM_MIN_SPACING_MS = 15 * 60_000;
let lastGovernorLlmAt = 0;

export async function runGovernorCycle(trigger: "auto" | "supervisor" = "auto"): Promise<{ ok: boolean; summary: string }> {
  if (cycleInFlight) return { ok: false, summary: "governor cycle already running" };
  cycleInFlight = true;
  try {
    const [gateBefore, bt] = await Promise.all([getGateSettings(), getBacktest()]);
    const context = await buildGovernorContext();

    const settled = await db.signal.findMany({ where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } }, orderBy: { createdAt: "desc" }, select: { status: true, pnlPercent: true, reachedTp: true, marginUsd: true, tags: true }, take: 200 });
    const realizedWr = settled.length ? (settled.filter((s) => s.pnlPercent > 0 || s.reachedTp >= 1).length / settled.length) * 100 : 0;
    // v6.3 RISK LEDGER inputs for the heuristic fallback (stop-bleed rule)
    const slSigs = settled.filter((s) => s.status === "SL");
    const stopRate = settled.length ? (slSigs.length / settled.length) * 100 : null;
    const slNetUsd = slSigs.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);

    // v5.3: dynamic import — if the AI bridge is broken, the governor still runs
    // on its rule-based heuristic instead of crashing the whole engine chain.
    let rawDecisions: GovernorDecision[];
    let label: "MODEL" | "HEURISTIC";
    if (Date.now() - lastGovernorLlmAt < GOVERNOR_LLM_MIN_SPACING_MS) {
      rawDecisions = heuristicDecisions(bt, realizedWr, settled.length, gateBefore.minScore, gateBefore, stopRate, slNetUsd);
      label = "HEURISTIC";
    } else {
      lastGovernorLlmAt = Date.now(); // the attempt itself consumes budget — failures count too
      try {
        const { aiGovernorDecisions } = await import("./ai");
        const r = await aiGovernorDecisions(context, heuristicDecisions(bt, realizedWr, settled.length, gateBefore.minScore, gateBefore, stopRate, slNetUsd));
        rawDecisions = r.decisions;
        label = r.label;
      } catch (bridgeErr) {
        console.error("[governor] AI bridge unavailable — heuristic fallback", bridgeErr);
        rawDecisions = heuristicDecisions(bt, realizedWr, settled.length, gateBefore.minScore, gateBefore, stopRate, slNetUsd);
        label = "HEURISTIC";
      }
    }

    // ── evidence gate (v5.2): raising MIN_SCORE on a tiny settled sample is
    // overfitting to noise — it was exactly this loop that locked the engine
    // at MIN_SCORE 60 for 12h on n=2. Raises need ≥8 settled outcomes.
    // ── v6.7 BO-EXP TRIAL FREEZE (operator directive 2026-09-08): while the
    // BREAKOUT conditional trial runs (breakoutGuard=1, <20 BO-EXP settles),
    // set_min_score and set_flow_veto are LOCKED against governor writes. The
    // operator approved MIN_SCORE 50 and the governor re-loosened it to 38
    // within the hour — entry-quality knobs stay operator-owned until the
    // trial verdict so the A/B cohort stays uncontaminated. AUTO-RELIEF and
    // the SUPERVISOR valve below respect the same freeze.
    const boExpSettled = settled.filter((s) => s.tags.split(",").includes("BO-EXP")).length;
    const trialFreeze = gateBefore.breakoutGuard === 1 && boExpSettled < 20;
    if (trialFreeze) console.log(`[GOVERNOR] BO-EXP trial freeze ACTIVE — minScore/flowVeto locked (BO-EXP settles: ${boExpSettled}/20)`);
    const rate = await deployRate();
    const decisions = rawDecisions.map((d) =>
      d.action === "set_min_score" && typeof d.value === "number" && d.value > gateBefore.minScore && settled.length < EVIDENCE_MIN_SETTLED
        ? { ...d, action: "no_op" as const, value: undefined, rationale: `BLOCKED (evidence gate): raise to ${d.value} rejected — only ${settled.length}/8 settled outcomes; sample too small to justify tightening` }
        : trialFreeze && (d.action === "set_min_score" || d.action === "set_flow_veto")
          ? { ...d, action: "no_op" as const, value: undefined, rationale: `BLOCKED (BO-EXP trial freeze): ${d.action} locked while the BREAKOUT conditional trial runs (${boExpSettled}/20 settled) — operator owns entry-quality knobs until the verdict` }
          : d
    );

    // validate + apply with EXISTING clamps + v6.2 hysteresis (flip-flop protection)
    const applied: GovernorLogRow["decisions"] = [];
    let appliedCount = 0;
    const cfg = await getGovernorState();
    const hyst = await getHysteresis();
    // v6.2.1 operator request: HYSTERESIS state must be visible in the log at
    // every cycle — which knobs are cooling and for how long.
    const coolingNow = Object.entries(hyst).filter(([, v]) => Date.now() - v.at < KNOB_COOLDOWN_MS);
    console.log(`[GOVERNOR-HYSTERESIS] cycle #${cfg.cycles + 1} (${new Date().toISOString().slice(11, 19)}Z) — ${coolingNow.length === 0 ? "no knobs in cooldown" : coolingNow.map(([k, v]) => `${k} ${Math.ceil((KNOB_COOLDOWN_MS - (Date.now() - v.at)) / 60_000)}m left`).join(", ")}`);
    for (const d of decisions.slice(0, cfg.maxActions)) {
      let ok = false;
      let appliedVal: number | undefined;
      try {
        if (HYST_ACTIONS.has(d.action) && typeof d.value === "number") {
          const { cooling, minsLeft } = knobCooling(hyst, d.action);
          if (cooling) {
            console.log(`[GOVERNOR-HYSTERESIS] BLOCKED ${d.action} → ${d.value} — ${minsLeft}m left of 90min cooldown (flip-flop protection)`);
            applied.push({ action: d.action, value: d.value, rationale: `BLOCKED (hysteresis): ${d.action} changed <${minsLeft}m ago — flip-flop protection holds the knob for the rest of its 90min cooldown · ${d.rationale}`, applied: false });
            continue;
          }
        }
        if (d.action === "set_min_score" && typeof d.value === "number") {
          // v8.4.2 OPERATOR PIN — «ثابت نگه دار»: while minScorePinned=1 the
          // governor may NOT retune the entry threshold in either direction.
          const pinnedNow = (await getGateSettings()).minScorePinned === 1;
          if (pinnedNow) {
            const live = (await getGateSettings()).minScore;
            console.log(`[GOVERNOR] set_min_score → ${d.value} SUPPRESSED — OPERATOR PIN active (minScore fixed at ${live} by bridge mandate 2026-09-12)`);
            applied.push({ action: d.action, value: d.value, rationale: `BLOCKED (OPERATOR PIN): minScore is operator-owned and fixed at ${live} — bridge mandate 2026-09-12 «آستانه ورود ... و ثابت نگه دار». Only an explicit operator mandate may move it.`, applied: false });
            continue;
          }
          const next = await putGateSettings({ minScore: d.value });
          appliedVal = next.minScore;
          ok = true;
        } else if (d.action === "set_flow_veto" && typeof d.value === "number") {
          const next = await putGateSettings({ flowVetoScore: d.value });
          appliedVal = next.flowVetoScore;
          ok = true;
        } else if (d.action === "set_flow_shortlist" && typeof d.value === "number") {
          const next = await putGateSettings({ flowShortlist: d.value });
          appliedVal = next.flowShortlist;
          ok = true;
        } else if (d.action === "set_universe" && typeof d.value === "number") {
          const next = await putGateSettings({ universeSize: d.value });
          appliedVal = next.universeSize;
          ok = true;
        } else if (d.action === "set_ttl_extend_max" && typeof d.value === "number") {
          const next = await putGateSettings({ ttlExtendMax: d.value });
          appliedVal = next.ttlExtendMax;
          ok = true;
        } else if (d.action === "set_ttl_extend_minutes" && typeof d.value === "number") {
          const next = await putGateSettings({ ttlExtendMinutes: d.value });
          appliedVal = next.ttlExtendMinutes;
          ok = true;
        } else if (d.action === "set_ttl_near_tp" && typeof d.value === "number") {
          const next = await putGateSettings({ ttlNearTpPct: d.value });
          appliedVal = next.ttlNearTpPct;
          ok = true;
        } else if (d.action === "set_sl_atr_mult" && typeof d.value === "number") {
          // v6.3 DYNAMIC RISK — stop distance in ATR multiples (governor-owned)
          const next = await putGateSettings({ slAtrMult: d.value });
          appliedVal = next.slAtrMult;
          ok = true;
        } else if (d.action === "set_rr_scale" && typeof d.value === "number") {
          // v6.3 DYNAMIC RISK — scales every computed R:R ladder
          const next = await putGateSettings({ rrScale: d.value });
          appliedVal = next.rrScale;
          ok = true;
        } else if (d.action === "set_regime_guard" && typeof d.value === "number") {
          // v6.3 REGIME FILTER HARDENING level (0 soft · 1 chop veto · 2 full guard)
          const next = await putGateSettings({ regimeGuard: d.value });
          appliedVal = next.regimeGuard;
          ok = true;
        } else if (d.action === "set_max_active" && typeof d.value === "number") {
          // v6.3 DYNAMIC RISK — position capacity (max concurrent open signals)
          const next = await putGateSettings({ maxActive: d.value });
          appliedVal = next.maxActive;
          ok = true;
        } else if (d.action === "set_risk_per_trade" && typeof d.value === "number") {
          // v6.3 DYNAMIC RISK — margin sizing scale on confidence-sized margin
          const next = await putGateSettings({ riskPerTrade: d.value });
          appliedVal = next.riskPerTrade;
          ok = true;
        } else if (d.action === "run_backtest") {
          void runBacktest({ label: "GOVERNOR REQUEST" }).then((r) => fireEvent(null, null, "ENGINE", "ai", `AI GOVERNOR requested replay done — ${r.n} trades, Wilson-LB ${r.wilsonLB}%`)).catch(() => undefined);
          ok = true;
        } else if (d.action === "run_autotune") {
          void runAutotune().then((r) => fireEvent(null, null, "ENGINE", "ai", `AI GOVERNOR requested auto-tune done — ${r.adopted ? "weights ADOPTED" : "baseline kept"} (Δ${r.delta >= 0 ? "+" : ""}${r.delta})`)).catch(() => undefined);
          ok = true;
        }
      } catch {
        ok = false;
      }
      if (ok && HYST_ACTIONS.has(d.action) && typeof appliedVal === "number") {
        hyst[d.action] = { at: Date.now(), from: null, to: appliedVal };
        console.log(`[GOVERNOR-HYSTERESIS] APPLIED ${d.action} → ${appliedVal} — cooldown armed for 90min`);
      }
      if (ok) appliedCount++;
      applied.push({ action: d.action, value: d.value, rationale: d.rationale, applied: ok });
    }
    await putHysteresis(hyst);

    const gatesAfterApplied = await getGateSettings();

    // ── anti-lockup relief valve (v5.2): if the engine deployed NOTHING in
    // the last 6h and MIN_SCORE sits above the relief floor, force a step-down
    // and audit it. The governor may never seal the deployment pipeline shut.
    if (!trialFreeze && !gatesAfterApplied.minScorePinned && rate.deploys6h === 0 && gatesAfterApplied.minScore > MIN_SCORE_RELIEF_FLOOR) {
      const relieved = Math.max(MIN_SCORE_RELIEF_FLOOR, gatesAfterApplied.minScore - 6);
      await putGateSettings({ minScore: relieved });
      const hyst = await getHysteresis();
      hyst.set_min_score = { at: Date.now(), from: gatesAfterApplied.minScore, to: relieved };
      await putHysteresis(hyst);
      console.log(`[GOVERNOR-HYSTERESIS] AUTO-RELIEF bypass on set_min_score ${gatesAfterApplied.minScore}→${relieved} — cooldown re-armed (lockout beats thrash)`);
      applied.push({ action: "set_min_score", value: relieved, rationale: `AUTO-RELIEF: 0 deploys in 6h with MIN_SCORE ${gatesAfterApplied.minScore} — engine locked, stepping down to ${relieved} so candidates reach the gates again (safety valve bypasses hysteresis but records the change)`, applied: true });
      appliedCount++;
      fireEvent(null, null, "ENGINE", "ai", `AI GOVERNOR AUTO-RELIEF: signal drought detected — MIN_SCORE ${gatesAfterApplied.minScore}→${relieved}`).catch(() => undefined);
    }

    // ── SUPERVISOR quality valve (v5.3): the MIRROR of auto-relief. A drought
    // is not the only failure mode — over-trading low-quality signals is the
    // other (realized case: 28 deploys at WR 9% while MIN_SCORE sat at the 20
    // floor). When the trailing settled window shows WR < 15% over ≥12 settles
    // and MIN_SCORE is below the quality ceiling, step it UP and audit it.
    // v6.7: respects the BO-EXP trial freeze (minScore is operator-owned during
    // the trial — the advisor carries the quality decision instead).
    const trail = settled.slice(0, SUPERVISOR_TRAILING_N);
    const trailWr = trail.length >= 12 ? (trail.filter((s) => s.pnlPercent > 0).length / trail.length) * 100 : null;
    if (trialFreeze && trailWr !== null && trailWr < SUPERVISOR_WR_FLOOR) {
      applied.push({ action: "set_min_score", value: gatesAfterApplied.minScore, rationale: `SUPERVISOR raise suppressed by BO-EXP trial freeze (trailing WR ${trailWr.toFixed(0)}% < 15%) — quality decision deferred to the operator/advisor until the trial verdict`, applied: false });
    }
    if (!trialFreeze && trailWr !== null && trailWr < SUPERVISOR_WR_FLOOR && gatesAfterApplied.minScore < MIN_SCORE_QUALITY_CEILING) {
      // v8.4.2 OPERATOR PIN — the quality-raise valve must never fight the pin.
      if (gatesAfterApplied.minScorePinned) {
        applied.push({ action: "set_min_score", value: gatesAfterApplied.minScore, rationale: `SUPERVISOR raise SUPPRESSED — OPERATOR PIN active (minScore fixed at ${gatesAfterApplied.minScore} by bridge mandate 2026-09-12); trailing WR ${trailWr.toFixed(0)}% recorded for the operator to judge`, applied: false });
      } else {
      const hyst = await getHysteresis();
      const { cooling, minsLeft } = knobCooling(hyst, "set_min_score");
      if (cooling) {
        console.log(`[GOVERNOR-HYSTERESIS] SUPERVISOR raise BLOCKED — set_min_score cooling, ${minsLeft}m left (trailing WR ${trailWr.toFixed(0)}% < 15%)`);
        applied.push({ action: "set_min_score", value: gatesAfterApplied.minScore + 5, rationale: `SUPERVISOR: trailing WR ${trailWr.toFixed(0)}% < 15% — raise REQUIRED but blocked by hysteresis for another ${minsLeft}m (flip-flop protection)`, applied: false });
      } else {
        const raised = Math.min(MIN_SCORE_QUALITY_CEILING, gatesAfterApplied.minScore + 5);
        await putGateSettings({ minScore: raised });
        hyst.set_min_score = { at: Date.now(), from: gatesAfterApplied.minScore, to: raised };
        await putHysteresis(hyst);
        console.log(`[GOVERNOR-HYSTERESIS] SUPERVISOR quality-raise APPLIED set_min_score ${gatesAfterApplied.minScore}→${raised} — cooldown re-armed`);
        applied.push({ action: "set_min_score", value: raised, rationale: `SUPERVISOR: trailing WR ${trailWr.toFixed(0)}% over ${trail.length} settled < 15% — quality drift, stepping MIN_SCORE ${gatesAfterApplied.minScore}→${raised}`, applied: true });
        appliedCount++;
        fireEvent(null, null, "ENGINE", "ai", `AI GOVERNOR SUPERVISOR: quality drift detected (trailing WR ${trailWr.toFixed(0)}%) — MIN_SCORE ${gatesAfterApplied.minScore}→${raised}`).catch(() => undefined);
      }
      }
    }

    const gatesAfter = await getGateSettings();
    const row: GovernorLogRow = {
      at: new Date().toISOString(),
      trigger,
      label,
      gatesBefore: describeGate(gateBefore),
      gatesAfter: describeGate(gatesAfter),
      applied: appliedCount,
      decisions: applied,
    };

    const state = await getGovernorState();
    const log = [row, ...state.log].slice(0, LOG_CAP);
    const nextCfg: GovernorConfig = { ...state, cycles: state.cycles + 1, lastRunAt: row.at };
    await db.engineSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(nextCfg) }, update: { value: JSON.stringify(nextCfg) } });
    await db.engineSetting.upsert({ where: { key: KEY_LOG }, create: { key: KEY_LOG, value: JSON.stringify(log) }, update: { value: JSON.stringify(log) } });

    for (const d of applied) {
      await fireEvent(null, null, "ENGINE", "ai", `AI GOVERNOR (${trigger}, ${label}): ${d.action}${d.value !== undefined ? ` → ${d.value}` : ""} ${d.applied ? "APPLIED" : "rejected"} — ${d.rationale}`);
    }

    return { ok: true, summary: `${label} cycle: ${appliedCount}/${applied.length} decisions applied · ${gatesAfter.minScore !== gateBefore.minScore ? `MIN_SCORE ${gateBefore.minScore}→${gatesAfter.minScore}` : "gates unchanged"}` };
  } finally {
    cycleInFlight = false;
  }
}

// ── auto scheduler hook (called by engine tick) — v6.0: UNCONDITIONAL, the
// governor can no longer be disengaged; only the interval is configurable ──
let autoLastCheck = 0;
export async function maybeAutoGovernor(): Promise<void> {
  if (cycleInFlight) return;
  if (Date.now() - autoLastCheck < 60_000) return;
  autoLastCheck = Date.now();
  const cfg = await getGovernorState();
  if (cfg.lastRunAt && Date.now() - new Date(cfg.lastRunAt).getTime() < cfg.intervalMin * 60_000) return;
  void runGovernorCycle("auto").catch((err) => console.error("[governor:auto]", err));
}
