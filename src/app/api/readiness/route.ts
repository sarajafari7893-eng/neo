// ── NEXUS//SIGNALS — LIVE-READINESS GATE (machine-readable, v11.0) ──────────
// Spec phase 13: a machine-readable readiness state built from VERIFIED
// EVIDENCE — never a single score, never operator optimism. Every critical
// gate must independently PASS; UNKNOWN/DEGRADED/FAIL ⇒ NOT_ELIGIBLE.
// Evidence sources:
//   · .data/hardening-verify-latest.json  (verification harness run)
//   · .data/disaster-drill-latest.json    (disaster drill run)
//   · live market-feed health (getFeedStatus, same instance as the engine)
//   · kill-switch file state
//   · git commit (deployment_commit) + schema/config versions
// Final state is COMPUTED: any non-PASS gate ⇒ NOT_ELIGIBLE.

import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getFeedStatus } from "@/lib/market-feed";
import { killSwitchStatus } from "@/lib/kill-switch";
import { RISK_LIMITS } from "@/lib/risk-engine";

export const dynamic = "force-dynamic";

type GateValue = "PASS" | "FAIL" | "UNKNOWN" | "DEGRADED" | "OFF" | "ARMED_AND_TESTED" | "NOT_TESTED";

interface Gate { value: GateValue; evidence: string }

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function GET() {
  const harness = readJson<Record<string, { status?: string; note?: string }>>("/home/z/my-project/.data/hardening-verify-latest.json");
  const drill = readJson<Record<string, { status?: string; note?: string }>>("/home/z/my-project/.data/disaster-drill-latest.json");
  const feed = getFeedStatus();
  const ks = killSwitchStatus();

  const g = (key: string, src: Record<string, { status?: string; note?: string }> | null, fallback: GateValue, fallbackEv: string): Gate => {
    const r = src?.[key];
    if (!r) return { value: fallback, evidence: fallbackEv };
    const v = String(r.status ?? "UNKNOWN").toUpperCase();
    return { value: (["PASS", "FAIL", "UNKNOWN", "DEGRADED", "OFF", "ARMED_AND_TESTED", "NOT_TESTED"].includes(v) ? v : "UNKNOWN") as GateValue, evidence: String(r.note ?? "") };
  };

  const feedFresh = feed.consecutiveFailures < 3 && (feed.lastOkAt === null || Date.now() - feed.lastOkAt < 180_000);

  let commit = "unknown";
  try { commit = execSync("git rev-parse --short HEAD", { cwd: "/home/z/my-project" }).toString().trim(); } catch { /* detached/restore */ }

  let configVersion = "unknown";
  try {
    configVersion = createHash("sha1").update(readFileSync("/home/z/my-project/src/config/engine-flags.json", "utf8")).digest("hex").slice(0, 12);
  } catch { /* flag file moved */ }

  const gates: Record<string, Gate> = {
    security: g("security_middleware", harness, "UNKNOWN", "run .zscripts/hardening-verify.ts"),
    database_integrity: g("db_integrity", harness, "UNKNOWN", "run .zscripts/hardening-verify.ts"),
    migration_integrity: g("migration_baseline", harness, "UNKNOWN", "prisma/migrations baseline + harness"),
    execution_reconciliation: g("exec_sm_reconcile_rules", harness, "UNKNOWN", "reconcilePaperOpen checks (harness: exec_sm_reconcile_rules)"),
    real_pnl_ledger: { value: "FAIL", evidence: "REALIZED_PNL class structurally absent — ledger is PAPER (honesty contract); no exchange fills exist" },
    recovery_drill: g("recovery_drill", drill, "UNKNOWN", "run disaster drills (watchdog heal, integrity, restart)"),
    market_feed_health: { value: feedFresh ? "PASS" : "DEGRADED", evidence: `consecutiveFailures=${feed.consecutiveFailures} lastOk=${feed.lastOkAt ?? "never"}` },
    risk_engine: g("risk_engine_hard_limits", harness, "UNKNOWN", "HALT/REJECT/THROTTLE unit checks"),
    oos_validation: { value: "FAIL", evidence: "backtest n=25 (WR 24%, WLB 11.5%, expectancy −0.13R) vs minimum 300 OOS trades — no valid OOS evidence exists" },
    parameter_freeze: { value: "UNKNOWN", evidence: "no frozen-validation window currently in force (auto-tune governance states pending operator adoption)" },
    llm_execution_authority: { value: "OFF", evidence: "LLM/advisor produces PROPOSALS only — adoption is operator-gated (APPLY-GUARD + middleware control plane); no order authority exists anywhere in the codebase" },
    auto_tune_live_mutation: { value: "OFF", evidence: "advisor proposals apply only after explicit operator approval; stale-proposal auto-REJECT in APPLY-GUARD" },
    kill_switch: ks.engaged === false && harness?.kill_switch_roundtrip?.status === "PASS" ? { value: "ARMED_AND_TESTED", evidence: `file-backed, fail-closed; roundtrip test passed; currently ${ks.engaged ? "ENGAGED" : "released"} (${ks.reason})` } : { value: "NOT_TESTED", evidence: harness?.kill_switch_roundtrip ? `state=${ks.engaged}` : "roundtrip test not run" },
  };

  const criticalPass = (v: GateValue) => v === "PASS" || v === "OFF" || v === "ARMED_AND_TESTED";
  const failed = Object.entries(gates).filter(([, x]) => x.value === "FAIL").map(([k]) => k);
  const unknown = Object.entries(gates).filter(([, x]) => x.value === "UNKNOWN" || x.value === "NOT_TESTED").map(([k]) => k);
  const degraded = Object.entries(gates).filter(([, x]) => x.value === "DEGRADED").map(([k]) => k);
  const allCriticalPass = Object.values(gates).every((x) => criticalPass(x.value));

  return NextResponse.json({
    version: "LIVE-READINESS v1.0 (spec NEXUS-LIVE-HARDENING-MASTER-v1.0 phase 13)",
    generatedAt: new Date().toISOString(),
    current_state: allCriticalPass ? "LIMITED_LIVE_ELIGIBLE_CANDIDATE" : "NOT_ELIGIBLE",
    final_statement: allCriticalPass ? "All critical gates PASS." : "If any critical gate is not PASS, state NOT_ELIGIBLE_FOR_LIVE.",
    deployment_commit: commit,
    schema_version: harness?.migration_baseline?.note ?? "unverified",
    configuration_version: configVersion,
    risk_limits: RISK_LIMITS,
    real_orders_enabled: false,
    operator_approval_required: true,
    gates,
    failed_gates: failed,
    unknown_gates: unknown,
    degraded_gates: degraded,
    remaining_blockers: [
      ...failed.map((k) => `${k}: FAIL`),
      ...unknown.map((k) => `${k}: UNVERIFIED`),
      ...degraded.map((k) => `${k}: DEGRADED`),
    ],
    note: "Gates are evidence-derived. UNKNOWN is NOT a pass. This endpoint cannot enable real orders — no real-order executor exists in the system.",
  }, { headers: { "cache-control": "no-store" } });
}
