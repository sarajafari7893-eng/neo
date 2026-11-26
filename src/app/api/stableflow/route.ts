import { NextResponse } from "next/server";
import { getStableBoard, readRecentStableEvents, isBoardFresh, depegMuted, DEPEG_MUTE_PCT, DEPEG_WARN_PCT, REGIME_ON_PCT, REGIME_OFF_PCT } from "@/lib/stableflow";

// ── v11.0 STABLECOIN FLOW API (operator mandate 2026-09-30) ─────────────────
// Public read: the family-E board (DefiLlama-backed) + recent journal events.
// Honest nulls everywhere — when stable-feed hasn't published a board yet the
// UI gets { board: null } and renders its empty state, never a guess.

export const dynamic = "force-dynamic";

export async function GET() {
  const board = await getStableBoard().catch(() => null);
  const events = readRecentStableEvents(50);
  return NextResponse.json(
    {
      ok: true,
      at: new Date().toISOString(),
      board,
      fresh: isBoardFresh(board),
      gates: board
        ? {
            depegMute: { armed: depegMuted(board).muted, thresholdPct: DEPEG_MUTE_PCT },
            warnPct: DEPEG_WARN_PCT,
            regimeOnPct: REGIME_ON_PCT,
            regimeOffPct: REGIME_OFF_PCT,
            regimeGateMode: "SHADOW", // enforcement is an operator decision — see stableflow.ts doctrine
          }
        : null,
      events,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
