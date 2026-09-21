import { NextResponse } from "next/server";
import { appendThought, terminalSnapshot } from "@/lib/terminal";

export const dynamic = "force-dynamic";

/** GET /api/terminal?n=60 — merged ENGINE TERMINAL feed:
 * agent thoughts (THOUGHT) + engine/system events (EVENT), newest first. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const n = Number(url.searchParams.get("n") ?? "60");
    const snap = await terminalSnapshot(Number.isFinite(n) ? n : 60);
    return NextResponse.json(snap, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[terminal] GET error", err);
    return NextResponse.json({ error: "terminal snapshot failed" }, { status: 500 });
  }
}

/** POST /api/terminal — append a resident-agent thought (append-only).
 * Body: { agent, phase?, thought, evidence? } */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      agent?: string;
      phase?: string;
      thought?: string;
      evidence?: unknown;
    };
    if (!body.thought || !String(body.thought).trim()) {
      return NextResponse.json({ ok: false, error: "thought text required" }, { status: 400 });
    }
    const created = await appendThought({
      agent: body.agent ?? "SUPERVISOR",
      phase: body.phase,
      thought: body.thought,
      evidence: body.evidence,
    });
    return NextResponse.json({ ok: true, thought: created });
  } catch (err) {
    console.error("[terminal] POST error", err);
    return NextResponse.json({ ok: false, error: "terminal append failed" }, { status: 500 });
  }
}
