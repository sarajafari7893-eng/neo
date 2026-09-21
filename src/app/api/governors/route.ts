import { NextResponse } from "next/server";
import { getRiskGovernorState, runRiskGovernor } from "@/lib/risk-governor";
import { getTimeGovernorState, runTimeGovernor } from "@/lib/time-governor";
import { getCanaryState, runCanary } from "@/lib/ui-canary";
import { getSeniorReviewState } from "@/lib/senior-review";
import { fireEvent } from "@/lib/engine";
import { getMode, putMode, type ModuleMode } from "@/lib/shadow-modules";
import { getFourPackTail, recordFourPack } from "@/lib/fourpack-journal"; // v10.8 journal doctrine

export const dynamic = "force-dynamic";

/** GET /api/governors — v10.0 four-module package snapshot (operator mandate
 * 2026-09-15 «اجرای چهار ماژول را مهندسی شده و کامل انجام بده»):
 * R1 RISK-GOVERNOR · R2 TIME-GOVERNOR · R5 UI-CANARY · R6 SENIOR-REVIEW.
 * v10.8: ?journal=1&limit=N also returns the retrievable FOUR-PACK JSON
 * journal tail (doctrine: every module verdict is auditable, machine-readable,
 * and feedable to the central AI core). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const wantJournal = url.searchParams.get("journal") === "1";
  const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit") ?? "40") || 40));
  const [mode, riskGovernor, timeGovernor, canary, seniorReview, journal] = await Promise.all([
    getMode(),
    getRiskGovernorState(),
    getTimeGovernorState(),
    getCanaryState(),
    getSeniorReviewState(),
    wantJournal ? getFourPackTail(limit) : Promise.resolve(undefined),
  ]);
  return NextResponse.json({ mode, riskGovernor, timeGovernor, canary, seniorReview, ...(journal ? { journal } : {}) });
}

/** POST /api/governors — operator authority actions, all audited ENGINE events
 * AND v10.8 FOUR-PACK journal records.
 *  · { module: "risk-governor", mode: "SHADOW" | "ENGAGED" } → set mode + run one cycle
 *    (SHADOW journals + queues clamped proposals; ENGAGED additionally applies through
 *    the clamped gate-settings channel, ≥6h between applications).
 *  · { module: "ui-canary", mode: "SHADOW" | "ENGAGED" } → set mode + run one probe pass
 *    (ENGAGED pages Telegram only after 3 consecutive RED verdicts).
 *  · { module: "time-governor" } → run one ledger cycle (always honest-shadow:
 *    hour tiers journal + advise; deploy-path wiring is a separate operator decision). */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { module?: string; mode?: string };
    const mode: ModuleMode = body.mode === "ENGAGED" || body.mode === "enforce" ? "ENGAGED" : "SHADOW";

    if (body.module === "risk-governor") {
      await putMode(mode);
      void recordFourPack("mode", "mode", `RISK GOVERNOR mode → ${mode} by operator`, { module: "risk-governor", mode }).catch(() => undefined);
      const st = await runRiskGovernor(mode);
      await fireEvent(null, null, "ENGINE", "ai", `RISK GOVERNOR mode → ${mode} by operator — cycle #${st.cycles} verdict ${st.verdict} (sizeMult ×${st.sizeMult})${mode === "ENGAGED" ? " · applies via clamped gate-settings channel" : " · journals + queues clamped proposals only"}`).catch(() => undefined);
      return NextResponse.json({ ok: true, module: "risk-governor", mode, state: st });
    }
    if (body.module === "ui-canary") {
      await putMode(mode);
      void recordFourPack("mode", "mode", `UI-CANARY mode → ${mode} by operator`, { module: "ui-canary", mode }).catch(() => undefined);
      const st = await runCanary(mode);
      await fireEvent(null, null, "ENGINE", "ai", `UI-CANARY mode → ${mode} by operator — probe pass ${st.verdict} (${st.line})${mode === "ENGAGED" ? " · Telegram paging armed for persistent RED" : ""}`).catch(() => undefined);
      return NextResponse.json({ ok: true, module: "ui-canary", mode, state: st });
    }
    if (body.module === "time-governor") {
      const st = await runTimeGovernor();
      await fireEvent(null, null, "ENGINE", "ai", `TIME GOVERNOR manual cycle #${st.cycles} — ${st.line}`).catch(() => undefined);
      return NextResponse.json({ ok: true, module: "time-governor", state: st });
    }
    return NextResponse.json({ error: "unknown module" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
