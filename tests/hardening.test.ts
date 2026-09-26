/**
 * LIVE-HARDENING Phase 12 — kill-switch, risk engine, accounting, entry-quality,
 * param-governance unit tests. Run: bun test tests/hardening.test.ts
 */
import { describe, expect, test } from "bun:test";
import { engageKillSwitch, readKillSwitch, releaseKillSwitch } from "../src/lib/execution/kill-switch";
import { assessRisk, clampLimits, DEFAULT_LIMITS } from "../src/lib/execution/risk-engine";
import { computeClassMetrics, makeLedgerEntry } from "../src/lib/execution/accounting";
import { assessEntryQuality, GRAY_ZONE_BECOMES_LIVE_ELIGIBLE } from "../src/lib/execution/entry-quality";
import { transitionParam } from "../src/lib/execution/param-governance";
import type { LedgerEntry } from "../src/lib/execution/accounting";
import type { ParamVersion } from "../src/lib/execution/param-governance";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── kill switch ──────────────────────────────────────────────────────────────
describe("kill-switch — independent + fail-closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-ks-"));
  const path = join(dir, "kill.json");

  test("missing file = clean", () => {
    expect(readKillSwitch(path).engaged).toBe(false);
  });

  test("engage → engaged; release → clean", () => {
    engageKillSwitch("operator-test", "drill", path);
    expect(readKillSwitch(path).engaged).toBe(true);
    releaseKillSwitch("operator-test", path);
    expect(readKillSwitch(path).engaged).toBe(false);
    expect(readKillSwitch(path).reason).toBe("released");
  });

  test("corrupt file FAILS CLOSED (treated as engaged)", () => {
    writeFileSync(path, "{not json");
    const st = readKillSwitch(path);
    expect(st.engaged).toBe(true);
    expect(st.degraded).toBe(true);
  });

  test("missing engaged flag FAILS CLOSED", () => {
    writeFileSync(path, JSON.stringify({ at: "x" }));
    expect(readKillSwitch(path).engaged).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── risk engine ──────────────────────────────────────────────────────────────
describe("risk engine — sizing from invalidation + breakers + caps", () => {
  const base = {
    equityUsd: 1000,
    realizedTodayPct: 0,
    realizedWeekPct: 0,
    open: [] as { symbol: string; riskPct: number; group: string }[],
    candidate: { symbol: "BTCUSDT", entry: 50000, stop: 49500, group: "majors" }, // 1% invalidation
  };

  test("size derives from invalidation: 0.2% of 1000 = $2 risk / 1% → $200 notional", () => {
    const r = assessRisk(base);
    expect(r.approved).toBe(true);
    if (r.approved) {
      expect(r.riskUsd).toBe(2);
      expect(r.sizeUsd).toBe(200);
      expect(r.invalidationPct).toBe(1);
    }
  });

  test("daily loss stop halts trading", () => {
    const r = assessRisk({ ...base, realizedTodayPct: -1.0 });
    expect(r.approved).toBe(false);
    if (!r.approved) expect(r.reasonCode).toBe("DAILY_LOSS_STOP");
  });

  test("weekly emergency stop halts trading", () => {
    const r = assessRisk({ ...base, realizedWeekPct: -2.5 });
    expect(r.approved).toBe(false);
    if (!r.approved) expect(r.reasonCode).toBe("WEEKLY_LOSS_STOP");
  });

  test("symbol concentration cap", () => {
    const r = assessRisk({ ...base, open: [{ symbol: "BTCUSDT", riskPct: 0.4, group: "majors" }] });
    expect(r.approved).toBe(false);
    if (!r.approved) expect(r.reasonCode).toBe("SYMBOL_CONCENTRATION");
  });

  test("correlated group cap", () => {
    const r = assessRisk({ ...base, open: [{ symbol: "ETHUSDT", riskPct: 0.3, group: "majors" }, { symbol: "SOLUSDT", riskPct: 0.3, group: "majors" }] });
    expect(r.approved).toBe(false);
    if (!r.approved) expect(r.reasonCode).toBe("GROUP_CONCENTRATION");
  });

  test("aggregate cap shrinks budget instead of approving beyond it", () => {
    const r = assessRisk({ ...base, open: [{ symbol: "ETHUSDT", riskPct: 0.65, group: "alts" }] });
    expect(r.approved).toBe(true);
    if (r.approved) expect(r.riskUsd).toBeLessThanOrEqual((1000 * (0.75 - 0.65)) / 100 + 0.001);
  });

  test("invalidation unknown fails closed", () => {
    expect(assessRisk({ ...base, candidate: { ...base.candidate, entry: 0 } }).approved).toBe(false);
    expect(assessRisk({ ...base, equityUsd: NaN }).approved).toBe(false);
  });

  test("limits are clamp-locked inside pilot ranges", () => {
    const l = clampLimits({ riskPerTradePct: 5, dailyLossStopPct: 10, weeklyLossStopPct: 99 });
    expect(l.riskPerTradePct).toBe(0.25);
    expect(l.dailyLossStopPct).toBe(1.5);
    expect(l.weeklyLossStopPct).toBe(3.0);
    expect(DEFAULT_LIMITS.riskPerTradePct).toBeLessThanOrEqual(0.25);
  });
});

// ── accounting ───────────────────────────────────────────────────────────────
describe("accounting — MODELED/PAPER/REALIZED never mix", () => {
  const fill = { price: 50_000, qtyUnits: 0.004, feeUsd: 0.03, at: new Date().toISOString() };

  const modeled = makeLedgerEntry({ class: "MODELED_PNL", signalId: "s1", symbol: "BTCUSDT", side: "LONG", grossPnlUsd: 5, feesUsd: 0, fundingUsd: 0, slippageUsd: 0, fills: [], executionLatencyMs: null, modeledPnlUsd: null });
  const realized = makeLedgerEntry({ class: "REALIZED_PNL", signalId: "s2", symbol: "BTCUSDT", side: "LONG", grossPnlUsd: 4.5, feesUsd: 0.06, fundingUsd: 0.02, slippageUsd: 0.1, fills: [fill, { ...fill, price: 50_100 }], executionLatencyMs: 210, modeledPnlUsd: 5 });

  test("REALIZED requires actual fills", () => {
    expect(() => makeLedgerEntry({ ...{ class: "REALIZED_PNL", signalId: "s3", symbol: "X", side: "LONG", grossPnlUsd: 1, feesUsd: 0, fundingUsd: 0, slippageUsd: 0, fills: [], executionLatencyMs: null, modeledPnlUsd: null } })).toThrow(/fill/i);
  });

  test("mixing classes THROWS (modeled can never be presented as realized)", () => {
    const mixed: LedgerEntry[] = [modeled, realized];
    expect(() => computeClassMetrics(mixed)).toThrow(/mixed/i);
  });

  test("REALIZED metrics emit all 8 task-required fields + partial VWAP", () => {
    const m = computeClassMetrics([realized]);
    expect(m.n).toBe(1);
    for (const k of ["gross_pnl", "fees", "funding", "slippage", "realized_pnl", "realized_R", "execution_latency_ms", "model_vs_realized_error"]) {
      expect(k in m).toBe(true);
    }
    expect(m.realized_pnl).toBeCloseTo(4.5 - 0.06 - 0.02 - 0.1, 6);
    expect(realized.partialFillVwapUsd).toBeCloseTo((50_000 * 0.004 + 50_100 * 0.004) / 0.008, 4);
  });

  test("realized_R computed when per-trade risk provided", () => {
    const m = computeClassMetrics([realized], new Map([["s2", 2]]));
    expect(m.realized_R).toBeCloseTo((4.32) / 2, 2);
  });
});

// ── entry quality ────────────────────────────────────────────────────────────
describe("entry-quality — STRONG_PASS / GRAY_ZONE / STRONG_REJECT", () => {
  const clean = { chasePct: 0.1, entryZoneHalfPct: 0.3, impulsePct1m: 0.2, spreadBps: 4, oneShotFlowSpike: false, persistentFlowConfirmation: true, ageSeconds: 30 };

  test("clean entry passes", () => {
    expect(assessEntryQuality(clean).decision).toBe("STRONG_PASS");
  });

  test("late/overextended entry is rejected", () => {
    const r = assessEntryQuality({ ...clean, chasePct: 1.2 });
    expect(r.decision).toBe("STRONG_REJECT");
  });

  test("one-snapshot flow spike is NEVER a pass", () => {
    const r = assessEntryQuality({ ...clean, oneShotFlowSpike: true, persistentFlowConfirmation: false });
    expect(r.decision).not.toBe("STRONG_PASS");
  });

  test("one-shot spike + impulse exhaustion → REJECT", () => {
    const r = assessEntryQuality({ ...clean, impulsePct1m: 1.0, oneShotFlowSpike: true, persistentFlowConfirmation: false });
    expect(r.decision).toBe("STRONG_REJECT");
    if (r.decision === "STRONG_REJECT") expect(r.code).toBe("ENTRY_QUALITY_REJECT");
  });

  test("GRAY_ZONE is a dead-end for live eligibility (constant, structurally)", () => {
    const r = assessEntryQuality({ ...clean, ageSeconds: 1000 });
    expect(r.decision).toBe("GRAY_ZONE");
    expect(GRAY_ZONE_BECOMES_LIVE_ELIGIBLE).toBe(false);
  });
});

// ── param governance ─────────────────────────────────────────────────────────
describe("param governance — proposal ≠ adoption, LLM can never promote", () => {
  function version(): ParamVersion {
    return {
      id: "p1",
      state: "PROPOSED",
      createdAt: new Date().toISOString(),
      paramsHash: "deadbeef",
      params: { minScore: 70 },
      dataWindow: { from: "2026-09-01", to: "2026-09-20" },
      objective: "net_expectancy_R",
      sampleSize: { train: 500, oos: 320, perStrategy: { "AI-SCALP": 65, BREAKOUT: 70 } },
      evaluator: "human-operator",
      evidenceRefs: [".data/validation/run-1.json"],
      history: [],
    };
  }

  test("happy lifecycle to CANARY_ELIGIBLE requires frozen production + samples", () => {
    let v = version();
    for (const to of ["BACKTESTED", "OOS_VALIDATED"] as const) {
      const r = transitionParam(v, to, "ci-pipeline", "ok");
      expect(r.ok).toBe(true);
      v = (r as { ok: true; version: ParamVersion }).version;
    }
    const r = transitionParam(v, "CANARY_ELIGIBLE", "human-operator", "gates green", { productionFrozen: true });
    expect(r.ok).toBe(true);
  });

  test("small OOS sample blocks promotion", () => {
    let v = version();
    v.sampleSize.oos = 120;
    v.state = "OOS_VALIDATED";
    const r = transitionParam(v, "CANARY_ELIGIBLE", "human-operator", "try", { productionFrozen: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("OOS_SAMPLE_TOO_SMALL");
  });

  test("unfrozen production blocks promotion", () => {
    let v = version();
    v.state = "OOS_VALIDATED";
    const r = transitionParam(v, "CANARY_ELIGIBLE", "human-operator", "try", { productionFrozen: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PRODUCTION_NOT_FROZEN");
  });

  test("LLM evaluators are structurally forbidden", () => {
    let v = version();
    v.state = "OOS_VALIDATED";
    const r = transitionParam(v, "CANARY_ELIGIBLE", "llm-agent", "ai proposes adoption", { productionFrozen: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("LLM_ADOPTION_FORBIDDEN");
  });

  test("illegal jumps rejected", () => {
    expect(transitionParam(version(), "PROMOTED", "human-operator", "skip everything").ok).toBe(false);
  });
});
