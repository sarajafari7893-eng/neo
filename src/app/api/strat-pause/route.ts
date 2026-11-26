import { NextResponse } from "next/server";
import { getStrategyPauseState, setStrategyPause, strategyTrailingStats } from "@/lib/strategy-pause";
import { fireEvent } from "@/lib/engine";
import { sendDirect } from "@/lib/notify";

export const dynamic = "force-dynamic";

// ── v11.6 STRATEGY-PAUSE control API (EQ-97) ────────────────────────────────
// GET  /api/strat-pause            → pause state + live trailing evidence for
//                                    every paused strategy (fee-aware net).
// POST /api/strat-pause            → { strategy, enabled, reason, evidence? }
//                                    Mutations gated by the control-plane
//                                    middleware (x-nexus-key / session) → 401
//                                    anonymous. Every change journals an ENGINE
//                                    event + Telegram push (permanent trail).

export async function GET() {
  try {
    const state = await getStrategyPauseState();
    const paused = Object.entries(state.pauses).filter(([, v]) => v.enabled).map(([k]) => k);
    const trailing: Record<string, Awaited<ReturnType<typeof strategyTrailingStats>>> = {};
    for (const s of paused) {
      trailing[s] = await strategyTrailingStats(s, 14).catch(() => null as never);
    }
    return NextResponse.json({ ...state, trailing }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 140) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as {
      strategy?: string; enabled?: boolean; reason?: string; evidence?: string;
    } | null;
    if (!body || typeof body.strategy !== "string" || !body.strategy.trim() || typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "body must carry strategy (string) and enabled (boolean)" }, { status: 400 });
    }
    const strategy = body.strategy.trim().slice(0, 40);
    const reason = (body.reason ?? (body.enabled ? "paused by operator order" : "re-opened by operator order")).slice(0, 300);
    const stats = await strategyTrailingStats(strategy, 14).catch(() => null);
    const evidence = body.evidence ?? (stats ? `14d trailing: n=${stats.n} WR=${stats.winRatePct}% gross=$${stats.grossUsd} fees=$${stats.feesUsd} net=$${stats.netUsd}` : "");
    const state = await setStrategyPause(strategy, { enabled: body.enabled, reason, by: "OPERATOR (EQ-97)", evidence });
    await fireEvent(
      null,
      null,
      "ENGINE",
      body.enabled ? "warn" : "ai",
      `STRATEGY-PAUSE ${body.enabled ? "ENABLED" : "LIFTED"}: ${strategy} — ${reason}${evidence ? ` · evidence: ${evidence}` : ""} · auto deploys of this strategy are now ${body.enabled ? "refused (forced/capture bypass tagged STRAT-PAUSE)" : "allowed again"}`,
    );
    void sendDirect(
      `${body.enabled ? "⏸" : "▶️"} <b>STRATEGY-PAUSE ${body.enabled ? "ON" : "OFF"}</b>: <code>${strategy}</code>\n${reason}${evidence ? `\n📊 ${evidence}` : ""}`,
    ).catch(() => undefined);
    return NextResponse.json({ ok: true, state });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 140) }, { status: 500 });
  }
}
