import { NextResponse } from "next/server";
import { getCloseAllState, setCloseAllState } from "@/lib/close-all";

export const dynamic = "force-dynamic";

// ── v11.5 GLOBAL OPEN-PNL CLOSE-ALL BREAKER — control API ──────────────────
// GET  /api/closeall → breaker state (enabled, targetUsd, trigger ledger).
// POST /api/closeall → { enabled?: boolean, targetUsd?: number } — operator
//                       tuning of the book-level profit-lock (default ON at
//                       $20). Mutations are gated by the control-plane
//                       middleware (x-nexus-key / operator session) → 401 for
//                       anonymous clients. The breaker itself runs inside the
//                       engine's settlement tick (resolveSignals) — see
//                       src/lib/close-all.ts for the design contract.

export async function GET() {
  try {
    return NextResponse.json(await getCloseAllState(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 140) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { enabled?: boolean; targetUsd?: number } | null;
    if (!body || (body.enabled === undefined && body.targetUsd === undefined)) {
      return NextResponse.json({ error: "body must carry enabled and/or targetUsd" }, { status: 400 });
    }
    if (body.targetUsd !== undefined && (!Number.isFinite(body.targetUsd) || body.targetUsd <= 0 || body.targetUsd > 500)) {
      return NextResponse.json({ error: "targetUsd must be a positive number ≤ 500" }, { status: 400 });
    }
    const next = await setCloseAllState({ enabled: body.enabled, targetUsd: body.targetUsd });
    return NextResponse.json({ ok: true, state: next });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 140) }, { status: 500 });
  }
}
