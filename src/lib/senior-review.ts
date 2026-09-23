// ── FlowRadar Neo v9.6 — DAILY SENIOR-REVIEW (R6, nightly agent) ────────────
// Operator-approved module #4 (roadmap R6, mandate 2026-09-15): a 24h
// senior-engineer agent that runs ONCE per Tehran night, after the 00:00
// daily report, and produces a STRUCTURED AUDIT of the whole desk:
//   1. READ: ledger stats (strategies / short book / TTL / last-20), RAW-CAL
//      campaign state, the three sibling shadow modules (risk-governor,
//      time-governor, ui-canary), pump-radar performance digest, advisor
//      queue pressure.
//   2. PROPOSE: at most 3 PENDING AdvisorProposals per run — evidence-backed
//      knob changes through the SAME blocked/proposal channel the advisor
//      uses (pending guard, cooldowns respected) — never applied by itself.
//   3. REPORT: one Telegram digest (no '<' chars) + audited ENGINE event.
// Read-only toward the engine core; clamps enforced via gateClamps().
//
// Deterministic — no LLM call; the "senior engineer" here is the measured
// evidence itself.

import fs from "node:fs/promises";
import path from "node:path";

import { db } from "@/lib/db";
import type { GateSettings } from "@/lib/gate-settings";
import { getGateSettings, gateClamps } from "@/lib/gate-settings";
import { fireEvent } from "@/lib/engine";
import { sendDirect } from "@/lib/notify";
import { gatherLedgerStats } from "@/lib/advisor";
import { recordFourPack } from "@/lib/fourpack-journal"; // v10.8 — FOUR-PACK JSON journal doctrine
import { getRiskGovernorState, type RiskGovernorState } from "@/lib/risk-governor";
import { getTimeGovernorState, type TimeGovernorState } from "@/lib/time-governor";
import { getCanaryState, type CanaryState } from "@/lib/ui-canary";

const KEY = "seniorreview.state";
const MAX_PROPOSALS = 3;
const APPLIED_QUIET_MS = 72 * 3600_000;
const REJECT_COOLDOWN_MS = 7 * 86_400_000;

export interface SeniorReviewSection {
  title: string;
  lines: string[];
}

export interface SeniorReviewReport {
  at: string;
  ledger: { settled: number; last20PnlUsd: number; shortBook: { n: number; pnlUsd: number; expectancyPct: number }; worst: { strategy: string; n: number; expectancyPct: number; pnlUsd: number } | null };
  rawcal: { open: number; settled24h: number; note: string };
  sentinel: { verdict: string; anomalies: number; servicesDown: number } | null; // v10.21.2 — the night audit now LOOKS at the sentinel
  futures: { rows: number; settled: number; bestFilter: string | null; quadrantTop: string | null } | null; // v10.22 — five-family store + edge study
  riskGovernor: { verdict: string; sizeMult: number; streak: number } | null;
  timeGovernor: { toxicHours: number[]; primeHours: number[]; estUpliftUsd: number } | null;
  canary: { verdict: string; line: string } | null;
  proposalsQueued: Array<{ knob: string; from: number; to: number; rationale: string }>;
  skippedKnobs: string[];
}

export interface SeniorReviewState {
  at: number;
  cycles: number;
  lastRunAt: string | null;
  lastDayKey: string | null;
  report: SeniorReviewReport | null;
  tg: { ok: boolean; error: string | null } | null;
}

const EMPTY: SeniorReviewState = { at: 0, cycles: 0, lastRunAt: null, lastDayKey: null, report: null, tg: null };

function tehranNow(): { hour: number; dayKey: string } {
  const t = new Date(Date.now() + 3.5 * 3600_000);
  return {
    hour: t.getUTCHours(),
    dayKey: `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`,
  };
}

async function getState(): Promise<SeniorReviewState> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    if (row) return { ...EMPTY, ...(JSON.parse(row.value) as Partial<SeniorReviewState>) };
  } catch {
    /* fresh */
  }
  return { ...EMPTY };
}

async function putState(next: SeniorReviewState): Promise<void> {
  await db.engineSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
}

// ── proposal channel (advisor-compatible guards, local implementation) ──────

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

function clamped(knob: keyof GateSettings, v: number): number {
  const [lo, hi] = gateClamps()[knob];
  return Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
}

interface Draft {
  knob: keyof GateSettings;
  proposedValue: number;
  rationale: string;
  evidence: Record<string, unknown>;
}

function draftFromEvidence(st: Awaited<ReturnType<typeof gatherLedgerStats>>, risk: RiskGovernorState | null): Draft[] {
  const drafts: Draft[] = [];
  const gate = st.gate;
  const clamps = gateClamps();

  // A — worst strategy bleed (≥12 settles, exp < −2%/trade) → admit higher confluence only
  const worst = st.strategies.find((s) => s.n >= 12 && s.expectancyPct < -2);
  if (worst && gate.minScore < clamps.minScore[1]) {
    drafts.push({
      knob: "minScore",
      proposedValue: clamped("minScore", gate.minScore + 5),
      rationale: `senior-review: worst strategy ${worst.strategy} expectancy ${worst.expectancyPct}%/trade over ${worst.n} settles — MIN_SCORE +5 admits only higher-confluence setups`,
      evidence: { strategy: worst.strategy, n: worst.n, expectancyPct: worst.expectancyPct, pnlUsd: worst.pnlUsd },
    });
  }

  // B — SHORT book bleed (≥20 settles in 30d) → shave size further
  if (st.shortBook.n >= 20 && st.shortBook.pnlUsd < 0 && st.shortBook.expectancyPct < -1.5 && gate.shortSizeMult > clamps.shortSizeMult[0]) {
    drafts.push({
      knob: "shortSizeMult",
      proposedValue: clamped("shortSizeMult", gate.shortSizeMult - 0.1),
      rationale: `senior-review: SHORT book 30d ${st.shortBook.n} settles, ${st.shortBook.expectancyPct}%/trade, net $${st.shortBook.pnlUsd} — size ×${gate.shortSizeMult.toFixed(2)}→×${clamped("shortSizeMult", gate.shortSizeMult - 0.1).toFixed(2)}`,
      evidence: st.shortBook,
    });
  }

  // C — drawdown protocol on the last-20 slope
  if (st.last20PnlUsd <= -10 && gate.riskPerTrade > clamps.riskPerTrade[0]) {
    drafts.push({
      knob: "riskPerTrade",
      proposedValue: clamped("riskPerTrade", gate.riskPerTrade - 0.15),
      rationale: `senior-review: last 20 settles ${st.last20PnlUsd <= 0 ? "" : "+"}$${st.last20PnlUsd} — drawdown protocol shrinks sizing ×${gate.riskPerTrade.toFixed(2)}→×${clamped("riskPerTrade", gate.riskPerTrade - 0.15).toFixed(2)}`,
      evidence: { last20PnlUsd: st.last20PnlUsd, riskPerTrade: gate.riskPerTrade },
    });
  }

  // D — risk-governor heavy-defensive persistent → levered risk cap to the evidence band
  if (risk && risk.verdict === "HEAVY-DEFENSIVE" && risk.streak >= 2 && gate.leveredRiskCap > 15) {
    drafts.push({
      knob: "leveredRiskCap",
      proposedValue: 15,
      rationale: `senior-review: risk-governor HEAVY-DEFENSIVE ×${risk.streak} cycles (DD ${risk.inputs.drawdownPct}%, slope ${risk.inputs.slope20?.pnlUsd ?? "?"}$) — trim levered risk cap ${gate.leveredRiskCap} → 15 (10-15x evidence band)`,
      evidence: { verdict: risk.verdict, streak: risk.streak, drawdownPct: risk.inputs.drawdownPct, atrPct: risk.inputs.atrPct },
    });
  }

  return drafts;
}

// ── the nightly audit ───────────────────────────────────────────────────────

export async function runSeniorReview(): Promise<SeniorReviewState> {
  const prev = await getState();
  const sections: SeniorReviewSection[] = [];
  const proposalsQueued: SeniorReviewReport["proposalsQueued"] = [];
  const skippedKnobs: string[] = [];

  // 1 — ledger
  const st = await gatherLedgerStats();
  const worst = st.strategies.find((s) => s.n >= 12 && s.expectancyPct < -2) ?? null;
  sections.push({
    title: "LEDGER",
    lines: [
      `settled ${st.settled} · last-20 ${st.last20PnlUsd >= 0 ? "+" : ""}$${st.last20PnlUsd} · SHORT 30d ${st.shortBook.n} / ${st.shortBook.pnlUsd >= 0 ? "+" : ""}$${st.shortBook.pnlUsd} (${st.shortBook.expectancyPct}%/trade)`,
      worst ? `worst strategy ${worst.strategy}: ${worst.expectancyPct}%/trade over ${worst.n} = $${worst.pnlUsd}` : "no strategy bucket below −2%/trade",
    ],
  });

  // 2 — RAW-CAL
  const dayAgo = new Date(Date.now() - 86_400_000);
  const [open, settled24] = await Promise.all([
    db.signal.count({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] }, tags: { contains: "RAW-CAL" } } }),
    db.signal.count({ where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, tags: { contains: "RAW-CAL" }, closedAt: { gte: dayAgo } } }),
  ]);
  const rawcalNote = `RAW-CAL: ${open} open · ${settled24} settled in 24h`;
  sections.push({ title: "RAW-CAL", lines: [rawcalNote] });

  // 3 — sibling modules
  const [risk, time, canary] = await Promise.all([getRiskGovernorState(), getTimeGovernorState(), getCanaryState()]);
  if (risk.cycles > 0) {
    sections.push({ title: "RISK GOVERNOR", lines: [`verdict ${risk.verdict} ×${risk.sizeMult} (streak ${risk.streak}) — ${risk.reasons[0] ?? "baseline"}`] });
  }
  if (time.cycles > 0) {
    sections.push({ title: "TIME GOVERNOR", lines: [time.line] });
  }
  if (canary.cycles > 0) {
    sections.push({ title: "UI-CANARY", lines: [`${canary.verdict} — ${canary.line}`] });
  }

  // 3.5 — sentinel (v10.21.2): operator finding «چرا به گزارش خطای System Sentinel
  // توجه نمیشه؟» — the sentinel's steady-state verdicts were consumed by NOBODY
  // (files only; pages fire only on the verdict flip; the night audit never read
  // it). Now the nightly audit reads .data/sentinel/latest.json best-effort.
  let sentinel: SeniorReviewReport["sentinel"] = null;
  try {
    const raw = await fs.readFile(path.join(process.cwd(), ".data", "sentinel", "latest.json"), "utf8");
    const j = JSON.parse(raw) as { verdict?: string; anomalies?: Array<{ sev?: string; msg?: string }>; services?: Array<{ up?: boolean; label?: string }> };
    if (j.verdict) {
      const down = (j.services ?? []).filter((s) => !s.up).map((s) => s.label ?? "?");
      const anomalies = (j.anomalies ?? []).slice(0, 3).map((a) => `${a.sev ?? "?"}: ${a.msg ?? "?"}`);
      sections.push({
        title: "SENTINEL",
        lines: [
          `verdict ${j.verdict}${anomalies.length ? ` — ${anomalies.join(" · ")}` : " — no anomalies"}`,
          down.length ? `services DOWN: ${down.join(", ")}` : `all ${j.services?.length ?? 0} services up`,
        ],
      });
      sentinel = { verdict: j.verdict, anomalies: (j.anomalies ?? []).length, servicesDown: down.length };
    }
  } catch {
    /* sentinel never ran — fail-open, the audit must not break */
  }

  // 3.6 — FUTURES TAXONOMY (v10.22, operator mandate «جمع‌آوری داده → ذخیره →
  // یادگیری → بهترین فیلتر»): the night audit now reads the five-family store
  // + edge study, so the operator sees collection maturity and the current
  // best-filter candidate in every nightly Telegram report. Best-effort,
  // fail-open — a cold store must never break the audit.
  let futures: SeniorReviewReport["futures"] = null;
  try {
    const m = await import("@/lib/futures-taxonomy");
    const edge = await m.buildFuturesEdge();
    const qLine = edge.quadrantStudy
      .map((q) => `${q.quadrant.replace(/^Q(\d)_.*/, "Q$1")} ${q.verdict} ${q.meanFwd1h >= 0 ? "+" : ""}${q.meanFwd1h}% (n=${q.n})`)
      .join(" · ");
    const lines = [
      `store ${edge.rowsScanned} rows · settled fwd1h ${edge.settledRows}/${edge.maturity.target} (${edge.maturity.progressPct}%)`,
      qLine || "quadrant study: no settled rows yet",
      edge.bestFilter
        ? `best filter [${edge.bestFilter.source}] ${edge.bestFilter.filter} — edge ${edge.bestFilter.edge} (n=${edge.bestFilter.n}, ${edge.bestFilter.confidence})`
        : `best filter: COLLECTING (${edge.maturity.settled}/${edge.maturity.target} settled)`,
      edge.attribution.joined > 0 ? `signal attribution: ${edge.attribution.joined} settled signals joined to quadrant context` : "signal attribution: waiting for settled signals",
    ];
    sections.push({ title: "FUTURES TAXONOMY", lines });
    futures = {
      rows: edge.rowsScanned,
      settled: edge.settledRows,
      bestFilter: edge.bestFilter ? `${edge.bestFilter.filter} (${edge.bestFilter.edge})` : null,
      quadrantTop: edge.quadrantStudy.length ? edge.quadrantStudy.map((q) => `${q.quadrant}:${q.meanFwd1h}`).join(",") : null,
    };
  } catch {
    /* futures module never ran — fail-open */
  }

  // 4 — proposals (≤3, advisor-compatible guards)
  const drafts = draftFromEvidence(st, risk.cycles > 0 ? risk : null);
  for (const d of drafts) {
    if (proposalsQueued.length >= MAX_PROPOSALS) break;
    if (await knobBlocked(d.knob)) {
      skippedKnobs.push(d.knob);
      continue;
    }
    const target = clamped(d.knob, d.proposedValue);
    if (Math.abs(target - st.gate[d.knob]) < 0.01) continue;
    await db.advisorProposal.create({
      data: {
        cycle: -1,
        kind: "KNOB_ADJUST",
        knob: d.knob,
        currentValue: st.gate[d.knob],
        proposedValue: target,
        direction: target < st.gate[d.knob] ? "TIGHTEN" : "LOOSEN",
        rationale: d.rationale,
        evidence: JSON.stringify({ source: "senior-review", ...d.evidence }),
      },
    });
    proposalsQueued.push({ knob: d.knob, from: st.gate[d.knob], to: target, rationale: d.rationale });
  }
  const pendingCount = await db.advisorProposal.count({ where: { status: "PENDING" } });
  sections.push({
    title: "PROPOSALS",
    lines: [
      proposalsQueued.length ? `${proposalsQueued.length} queued: ${proposalsQueued.map((p) => `${p.knob} ${p.from}→${p.to}`).join(" · ")}` : "no new proposal (guards/cooldowns)",
      skippedKnobs.length ? `skipped (pending/cooldown): ${skippedKnobs.join(", ")}` : `advisor queue: ${pendingCount} PENDING`,
    ],
  });

  const report: SeniorReviewReport = {
    at: new Date().toISOString(),
    ledger: { settled: st.settled, last20PnlUsd: st.last20PnlUsd, shortBook: st.shortBook, worst: worst ? { strategy: worst.strategy, n: worst.n, expectancyPct: worst.expectancyPct, pnlUsd: worst.pnlUsd } : null },
    rawcal: { open, settled24h: settled24, note: rawcalNote },
    sentinel,
    futures,
    riskGovernor: risk.cycles > 0 ? { verdict: risk.verdict, sizeMult: risk.sizeMult, streak: risk.streak } : null,
    timeGovernor: time.cycles > 0 ? { toxicHours: time.toxicHours, primeHours: time.primeHours, estUpliftUsd: time.estUpliftUsd } : null,
    canary: canary.cycles > 0 ? { verdict: canary.verdict, line: canary.line } : null,
    proposalsQueued,
    skippedKnobs,
  };

  const state: SeniorReviewState = {
    at: Date.now(),
    cycles: prev.cycles + 1,
    lastRunAt: new Date().toISOString(),
    lastDayKey: tehranNow().dayKey,
    report,
    tg: null,
  };

  // 5 — audit + Telegram digest
  void fireEvent(null, null, "SYSTEM", "ai", `SENIOR-REVIEW night audit complete — ${sections.map((s) => s.title).join(" / ")}${proposalsQueued.length ? ` · ${proposalsQueued.length} proposal(s) queued` : ""}`).catch(() => undefined);
  // v10.8 journal doctrine — the nightly audit is a first-class journal event
  void recordFourPack("r6-senior-review", "audit", `night audit — ${sections.map((s) => s.title).join(" / ")}${proposalsQueued.length ? ` · ${proposalsQueued.length} proposal(s) queued: ${proposalsQueued.map((p) => `${p.knob} ${p.from}→${p.to}`).join(", ")}` : " · no new proposal"}`, { settled: st.settled, last20PnlUsd: st.last20PnlUsd, proposalsQueued, skippedKnobs, riskGovernor: risk.cycles > 0 ? risk.verdict : null, canary: canary.cycles > 0 ? canary.verdict : null }).catch(() => undefined);

  const tgLines: string[] = ["FlowRadar Neo — SENIOR REVIEW (nightly audit)", ""];
  for (const s of sections) tgLines.push(`${s.title}:`, ...s.lines.map((l) => `· ${l}`), "");
  tgLines.push("Approve/reject in AI CORE advisor panel or via Telegram.");
  const tg = await sendDirect(tgLines.join("\n")).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : "tg failed" }));
  state.tg = { ok: tg.ok, error: tg.ok ? null : (tg as { error?: string }).error ?? "failed" };

  await putState(state);
  return state;
}

export async function getSeniorReviewState(): Promise<SeniorReviewState> {
  return getState();
}

/** Nightly window check — runs once per Tehran day, after the 00:00 report. */
let checking = false;
export async function maybeRunSeniorReview(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const { hour, dayKey } = tehranNow();
    // window: 00:00–05:59 Tehran, once per day key
    if (hour >= 6) return;
    const state = await getState();
    if (state.lastDayKey === dayKey) return;
    await runSeniorReview();
  } catch {
    /* fail-open — the nightly audit must never break the tick */
  } finally {
    checking = false;
  }
}
