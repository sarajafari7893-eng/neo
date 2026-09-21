import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getResearchSettings,
  setResearchSettings,
  loadPersistedStacks,
  RESEARCH_IDS,
  RESEARCH_DEFAULTS,
} from "@/lib/research-factors";
import { getTapeHealth } from "@/lib/trade-flow";

export const dynamic = "force-dynamic";

/**
 * GET /api/flow/research — the v4.7 research factor stack state:
 * operator settings, per-symbol last measured stacks (votes with live
 * values), real-tape service health and the macro bias sources.
 * Every value is measured; stacks only exist after the engine has
 * flow-assessed a candidate (they appear as scans happen).
 */
export async function GET() {
  try {
    const [settings, tape, stacks] = await Promise.all([getResearchSettings(), getTapeHealth(), loadPersistedStacks()]);
    return NextResponse.json(
      {
        settings,
        ids: RESEARCH_IDS,
        defaults: RESEARCH_DEFAULTS.enabled,
        tape,
        stacks,
        generatedAt: Date.now(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { settings: null, stacks: [], tape: null, error: err instanceof Error ? err.message : "research unavailable" },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}

/**
 * PUT /api/flow/research — operator tunables: impact scale (0–1.5) and
 * per-factor switches. Clamped server-side, persisted in EngineSetting,
 * every change audited to the terminal event log.
 */
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as { impactScale?: number; enabled?: Record<string, boolean> };
    const next = await setResearchSettings({
      impactScale: typeof body.impactScale === "number" ? body.impactScale : undefined,
      enabled: body.enabled,
    });
    await db.signalEvent.create({
      data: {
        signalId: null,
        symbol: null,
        type: "TERMINAL",
        level: "info",
        message: `RESEARCH STACK tunables updated — impact ×${next.impactScale.toFixed(2)} · ${
          Object.entries(next.enabled)
            .filter(([, v]) => !v)
            .map(([k]) => k)
            .join(", ") || "all 13 factors enabled"
        }`,
      },
    });
    return NextResponse.json({ settings: next }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "update failed" }, { status: 400 });
  }
}
