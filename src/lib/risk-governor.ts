// ── FlowRadar Neo v9.6 — RISK GOVERNOR (R1, shadow-first, server-only) ──────
// Operator-approved module #1 (roadmap R1, mandate 2026-09-15: «اجرای چهار
// ماژول را مهندسی شده و کامل انجام بده»). Evidence base (block-2 answer,
// TG msg 2004):
//   · CHOP regime holds nearly all realized loss (−$31 of −$33 tracked),
//   · risk 0.5x → end-equity 90.28 vs 80.56 with DD 9.74 (price replay),
//   · leverage 10-15x worst de-leveraged (−0.475%/x), lev cap 10x ⇒ +3.94,
//   · last-20-settle slope drives the drawdown protocol.
//
// CONTRACT (shadow-first doctrine — approved design):
//   · SHADOW: computes a verdict every cycle, journals it, audits verdict
//     FLIPS as ENGINE events, and queues at most ONE AdvisorProposal per 24h
//     once a recommendation persists 2 consecutive cycles. Nothing is applied.
//   · ENGAGED (explicit operator toggle in AI CORE): applies ONLY through the
//     existing clamped gate-settings channel (riskPerTrade, leveredRiskCap),
//     at most one application per 6h, always audited. The engine deploy path
//     is NEVER touched by this module.
//
// Deterministic math — no LLM call, fail-open everywhere.

import { db } from "@/lib/db";
import { getGateSettings, putGateSettings, gateClamps } from "@/lib/gate-settings";
import { getRiskState } from "@/lib/risk-overlay";
import { peekRegime } from "@/lib/regime";
import { getKlines15m } from "@/lib/vol-forecast";
import { fireEvent } from "@/lib/engine";
import { recordFourPack } from "@/lib/fourpack-journal"; // v10.8 — FOUR-PACK JSON journal doctrine

const KEY = "riskgovernor.state";
const CYCLE_MIN_MS = 60 * 60_000; // hourly shadow cycle
const APPLY_MIN_GAP_MS = 6 * 3600_000; // ENGAGED: ≥6h between applications
const PROPOSAL_MIN_GAP_MS = 24 * 3600_000; // SHADOW: ≤1 proposal/day
const PERSIST_FOR_PROPOSAL = 2; // recommendation must hold 2 consecutive cycles
const JOURNAL_CAP = 14;
const LEV_EVIDENCE_CAP = 15; // leveredRiskCap evidence target (10-15x band)
const LEV_HARD_CAP = 10; // absolute evidence bar for heavy-defensive

export type RiskVerdict = "STANDARD" | "DEFENSIVE" | "HEAVY-DEFENSIVE" | "OFFENSIVE";

export interface RiskGovernorInputs {
  equity: number;
  drawdownPct: number;
  regimeBtc: string | null;
  atrPct: number | null;
  atrTone: "LOW" | "NORMAL" | "HIGH" | "UNKNOWN";
  chop: { n: number; pnlUsd: number; wr: number } | null;
  slope20: { n: number; pnlUsd: number; wins: number } | null;
  gateRiskPerTrade: number;
  gateLeveredRiskCap: number;
}

export interface RiskGovernorState {
  at: number;
  cycles: number;
  lastRunAt: string | null;
  verdict: RiskVerdict;
  sizeMult: number;
  reasons: string[];
  inputs: RiskGovernorInputs;
  streak: number; // consecutive cycles with the same non-STANDARD verdict
  lastProposalAt: string | null;
  lastApplied: { at: string; knob: string; from: number; to: number } | null;
  journal: Array<{ at: string; verdict: RiskVerdict; sizeMult: number; line: string }>;
}

const EMPTY: RiskGovernorState = {
  at: 0,
  cycles: 0,
  lastRunAt: null,
  verdict: "STANDARD",
  sizeMult: 1,
  reasons: [],
  inputs: {
    equity: 0,
    drawdownPct: 0,
    regimeBtc: null,
    atrPct: null,
    atrTone: "UNKNOWN",
    chop: null,
    slope20: null,
    gateRiskPerTrade: 1,
    gateLeveredRiskCap: 25,
  },
  streak: 0,
  lastProposalAt: null,
  lastApplied: null,
  journal: [],
};

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
}

async function getState(): Promise<RiskGovernorState> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    if (row) return { ...EMPTY, ...(JSON.parse(row.value) as Partial<RiskGovernorState>), inputs: { ...EMPTY.inputs, ...((JSON.parse(row.value) as Partial<RiskGovernorState>).inputs ?? {}) } };
  } catch {
    /* fresh */
  }
  return { ...EMPTY };
}

async function putState(next: RiskGovernorState): Promise<void> {
  await db.engineSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
}

// ── evidence gathering (read-only) ──────────────────────────────────────────

async function atrPctile(): Promise<{ atrPct: number | null; tone: RiskGovernorInputs["atrTone"] }> {
  try {
    const candles = await getKlines15m("BTCUSDT");
    if (!candles || candles.length < 40) return { atrPct: null, tone: "UNKNOWN" };
    const closed = candles.slice(0, -1);
    const trs: number[] = [];
    for (let i = 1; i < closed.length; i++) {
      const c = closed[i]!;
      const p = closed[i - 1]!;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      if (p.close > 0) trs.push(tr / p.close);
    }
    const win = trs.slice(-14);
    if (!win.length) return { atrPct: null, tone: "UNKNOWN" };
    const atr = (win.reduce((a, b) => a + b, 0) / win.length) * 100;
    const tone: RiskGovernorInputs["atrTone"] = atr > 2.5 ? "HIGH" : atr < 1.2 ? "LOW" : "NORMAL";
    return { atrPct: Number(atr.toFixed(2)), tone };
  } catch {
    return { atrPct: null, tone: "UNKNOWN" };
  }
}

async function gatherInputs(): Promise<{ inputs: RiskGovernorInputs; regimeIsChop: boolean }> {
  const [risk, gate, chopTele, atr] = await Promise.all([
    getRiskState(),
    getGateSettings(),
    db.engineSetting.findUnique({ where: { key: "regime.telemetry" } }).catch(() => null),
    atrPctile(),
  ]);
  let chop: RiskGovernorInputs["chop"] = null;
  try {
    const tel = JSON.parse(chopTele?.value ?? "{}") as Record<string, { n: number; wins: number; pnlUsd: number }>;
    const c = tel["CHOP"];
    if (c && c.n > 0) chop = { n: c.n, pnlUsd: c.pnlUsd, wr: Number(((c.wins / c.n) * 100).toFixed(1)) };
  } catch {
    /* fresh */
  }

  const since = new Date(Date.now() - 30 * 86_400_000);
  const last20 = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, closedAt: { gte: since } },
    select: { pnlPercent: true, marginUsd: true, reachedTp: true },
    orderBy: { closedAt: "desc" },
    take: 20,
  });
  let pnl = 0;
  let wins = 0;
  for (const s of last20) {
    pnl += (s.marginUsd * s.pnlPercent) / 100;
    if (s.reachedTp >= 1) wins++;
  }

  const btc = peekRegime("BTCUSDT");
  return {
    inputs: {
      equity: risk.state.equity,
      drawdownPct: risk.state.drawdownPct,
      regimeBtc: btc?.regime ?? null,
      atrPct: atr.atrPct,
      atrTone: atr.tone,
      chop,
      slope20: last20.length ? { n: last20.length, pnlUsd: Number(pnl.toFixed(2)), wins } : null,
      gateRiskPerTrade: gate.riskPerTrade,
      gateLeveredRiskCap: gate.leveredRiskCap,
    },
    regimeIsChop: btc?.regime === "CHOP",
  };
}

// ── verdict math (deterministic) ────────────────────────────────────────────

function decide(inputs: RiskGovernorInputs, regimeIsChop: boolean): { verdict: RiskVerdict; sizeMult: number; reasons: string[] } {
  const reasons: string[] = [];
  let defensive = 0;
  let heavy = 0;

  if (inputs.drawdownPct >= 7) {
    heavy++;
    reasons.push(`drawdown ${inputs.drawdownPct}% ≥ 7% — heavy throttle band (risk-overlay)`);
  } else if (inputs.drawdownPct >= 3) {
    defensive++;
    reasons.push(`drawdown ${inputs.drawdownPct}% ≥ 3% — throttle band (risk-overlay)`);
  }

  if (inputs.slope20 && inputs.slope20.n >= 10) {
    if (inputs.slope20.pnlUsd <= -10) {
      heavy++;
      reasons.push(`last ${inputs.slope20.n} settles sum ${inputs.slope20.pnlUsd <= 0 ? "" : "+"}$${inputs.slope20.pnlUsd} ≤ −$10 — drawdown protocol`);
    } else if (inputs.slope20.pnlUsd <= -4) {
      defensive++;
      reasons.push(`last ${inputs.slope20.n} settles sum ${inputs.slope20.pnlUsd <= 0 ? "" : "+"}$${inputs.slope20.pnlUsd} — soft bleed`);
    }
  }

  if (inputs.chop && inputs.chop.n >= 10 && inputs.chop.pnlUsd < 0 && (regimeIsChop || inputs.regimeBtc === null)) {
    defensive++;
    reasons.push(`CHOP book: ${inputs.chop.n} settles, ${inputs.chop.wr}% win, net $${inputs.chop.pnlUsd}${regimeIsChop ? " — BTC regime is CHOP right now" : ""}`);
  }
  if (regimeIsChop) {
    defensive++;
    reasons.push("BTC regime CHOP — the regime that holds nearly all realized loss");
  }

  if (inputs.atrTone === "HIGH") {
    defensive++;
    reasons.push(`BTC 15m ATR ${inputs.atrPct}% — high-vol tone (stop inflation risk)`);
  }

  if (defensive === 0 && heavy === 0) {
    // offense requires a clean bill: positive slope + shallow DD + trend regime
    const slopeOk = inputs.slope20 && inputs.slope20.n >= 10 && inputs.slope20.pnlUsd >= 4;
    const trendOk = inputs.regimeBtc === "TREND_UP" || inputs.regimeBtc === "TREND_DOWN";
    if (slopeOk && trendOk && inputs.drawdownPct < 1) {
      return {
        verdict: "OFFENSIVE",
        sizeMult: 1.15,
        reasons: [`last ${inputs.slope20!.n} settles +$${inputs.slope20!.pnlUsd} with ${inputs.regimeBtc} regime and DD ${inputs.drawdownPct}% — measured offense (×1.15, inside clamps)`],
      };
    }
    return { verdict: "STANDARD", sizeMult: 1, reasons: ["book clean — no defensive trigger; baseline sizing"] };
  }

  if (heavy > 0) return { verdict: "HEAVY-DEFENSIVE", sizeMult: 0.5, reasons };
  return { verdict: "DEFENSIVE", sizeMult: 0.75, reasons };
}

// ── proposal / application helpers ──────────────────────────────────────────

async function knobHasPending(knob: string): Promise<boolean> {
  const recent = await db.advisorProposal.findMany({ where: { knob }, orderBy: { createdAt: "desc" }, take: 3 });
  return recent.some((p) => p.status === "PENDING");
}

async function queueProposal(knob: "riskPerTrade" | "leveredRiskCap" | "regimeGuard", proposedValue: number, rationale: string, evidence: Record<string, unknown>): Promise<boolean> {
  if (await knobHasPending(knob)) return false;
  const gate = await getGateSettings();
  const [lo, hi] = gateClamps()[knob];
  const target = clampNum(proposedValue, lo, hi);
  if (Math.abs(target - gate[knob]) < 0.01) return false;
  await db.advisorProposal.create({
    data: {
      cycle: -1,
      kind: "KNOB_ADJUST",
      knob,
      currentValue: gate[knob],
      proposedValue: target,
      direction: target < gate[knob] ? "TIGHTEN" : "LOOSEN",
      rationale,
      evidence: JSON.stringify({ source: "risk-governor", ...evidence }),
    },
  });
  return true;
}

// ── cycle ───────────────────────────────────────────────────────────────────

export async function runRiskGovernor(mode: "SHADOW" | "ENGAGED"): Promise<RiskGovernorState> {
  const prev = await getState();
  const { inputs, regimeIsChop } = await gatherInputs();
  const { verdict, sizeMult, reasons } = decide(inputs, regimeIsChop);

  const state: RiskGovernorState = {
    at: Date.now(),
    cycles: prev.cycles + 1,
    lastRunAt: new Date().toISOString(),
    verdict,
    sizeMult,
    reasons,
    inputs,
    streak: verdict === prev.verdict && verdict !== "STANDARD" ? prev.streak + 1 : verdict !== "STANDARD" ? 1 : 0,
    lastProposalAt: prev.lastProposalAt,
    lastApplied: prev.lastApplied,
    journal: [{ at: new Date().toISOString(), verdict, sizeMult, line: reasons[0] ?? "baseline" }, ...prev.journal].slice(0, JOURNAL_CAP),
  };

  // verdict-flip audit (both modes — evidence honesty)
  const flipped = verdict !== prev.verdict && prev.cycles > 0;
  if (flipped) {
    void fireEvent(null, null, "ENGINE", "ai", `RISK GOVERNOR verdict ${prev.verdict} → ${verdict} (sizeMult ×${sizeMult}) — ${reasons[0] ?? ""}`).catch(() => undefined);
  }
  // v10.8 journal doctrine — every cycle lands in the retrievable JSON journal
  void recordFourPack("r1-risk-governor", flipped ? "flip" : "cycle", reasons[0] ?? "baseline sizing", { cycles: state.cycles, streak: state.streak, drawdownPct: inputs.drawdownPct, slope20PnlUsd: inputs.slope20?.pnlUsd ?? null, regimeBtc: inputs.regimeBtc, mode }, verdict).catch(() => undefined);

  if (mode === "SHADOW") {
    const canPropose = !state.lastProposalAt || Date.now() - new Date(state.lastProposalAt).getTime() >= PROPOSAL_MIN_GAP_MS;
    if (canPropose && state.streak >= PERSIST_FOR_PROPOSAL) {
      let queued = false;
      if (verdict === "HEAVY-DEFENSIVE" && inputs.gateLeveredRiskCap > LEV_EVIDENCE_CAP) {
        queued = await queueProposal("leveredRiskCap", LEV_EVIDENCE_CAP, `RISK GOVERNOR ${verdict} persistent (${state.streak} cycles): DD ${inputs.drawdownPct}%, slope ${inputs.slope20?.pnlUsd ?? "?"}$ — trim levered risk cap to the 10-15x evidence band (de-leverage −0.475%/x)`, { verdict, streak: state.streak, drawdownPct: inputs.drawdownPct, slope20: inputs.slope20, atrPct: inputs.atrPct });
      } else if (verdict === "HEAVY-DEFENSIVE" || verdict === "DEFENSIVE") {
        const target = clampNum(1 * sizeMult, 0.5, 1.5);
        if (target < inputs.gateRiskPerTrade) {
          queued = await queueProposal("riskPerTrade", target, `RISK GOVERNOR ${verdict} persistent (${state.streak} cycles): ${reasons.slice(0, 2).join("; ")} — size ×${inputs.gateRiskPerTrade.toFixed(2)}→×${target.toFixed(2)} (0.5x replay: end 90.28, DD 9.74)`, { verdict, streak: state.streak, sizeMult, drawdownPct: inputs.drawdownPct, slope20: inputs.slope20 });
        }
      }
      if (queued) {
        state.lastProposalAt = new Date().toISOString();
        void recordFourPack("r1-risk-governor", "proposal", `${verdict} persistent (${state.streak}) — clamped proposal queued`, { streak: state.streak, verdict }, verdict).catch(() => undefined);
      }
    }
  } else {
    // ENGAGED — apply through the clamped channel, ≥6h gap, audited
    const gapOk = !state.lastApplied || Date.now() - new Date(state.lastApplied.at).getTime() >= APPLY_MIN_GAP_MS;
    if (gapOk && verdict !== "STANDARD") {
      const gate = await getGateSettings();
      const targetRisk = clampNum(1 * sizeMult, gateClamps().riskPerTrade[0], gateClamps().riskPerTrade[1]);
      if (Math.abs(gate.riskPerTrade - targetRisk) >= 0.05) {
        await putGateSettings({ riskPerTrade: targetRisk });
        state.lastApplied = { at: new Date().toISOString(), knob: "riskPerTrade", from: gate.riskPerTrade, to: targetRisk };
        void fireEvent(null, null, "ENGINE", "ai", `RISK GOVERNOR ENGAGED: riskPerTrade ×${gate.riskPerTrade.toFixed(2)}→×${targetRisk.toFixed(2)} (verdict ${verdict}) — audited, clamped`).catch(() => undefined);
        void recordFourPack("r1-risk-governor", "apply", `ENGAGED applied riskPerTrade ×${gate.riskPerTrade.toFixed(2)}→×${targetRisk.toFixed(2)} (verdict ${verdict})`, { knob: "riskPerTrade", from: gate.riskPerTrade, to: targetRisk }, verdict).catch(() => undefined);
      } else if (verdict === "HEAVY-DEFENSIVE" && gate.leveredRiskCap > LEV_EVIDENCE_CAP) {
        const capTarget = Math.min(gate.leveredRiskCap, LEV_HARD_CAP);
        await putGateSettings({ leveredRiskCap: capTarget });
        state.lastApplied = { at: new Date().toISOString(), knob: "leveredRiskCap", from: gate.leveredRiskCap, to: capTarget };
        void fireEvent(null, null, "ENGINE", "ai", `RISK GOVERNOR ENGAGED: leveredRiskCap ${gate.leveredRiskCap}→${capTarget} — evidence band enforcement, audited`).catch(() => undefined);
        void recordFourPack("r1-risk-governor", "apply", `ENGAGED applied leveredRiskCap ${gate.leveredRiskCap}→${capTarget} (evidence band)`, { knob: "leveredRiskCap", from: gate.leveredRiskCap, to: capTarget }, verdict).catch(() => undefined);
      }
    }
  }

  await putState(state);
  return state;
}

export async function getRiskGovernorState(): Promise<RiskGovernorState> {
  return getState();
}

let lastRun = 0;
export async function maybeRunRiskGovernor(mode: "SHADOW" | "ENGAGED"): Promise<void> {
  if (Date.now() - lastRun < CYCLE_MIN_MS) return;
  lastRun = Date.now();
  await runRiskGovernor(mode).catch(() => undefined);
}
