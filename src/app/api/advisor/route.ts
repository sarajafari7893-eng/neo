import { NextResponse } from "next/server";
import { advisorSnapshot, forceRunAdvisor, decideProposal } from "@/lib/advisor";

export const dynamic = "force-dynamic";

/** GET /api/advisor — advisor state, proposal queue, BREAKOUT trial tracker,
 * plus the ledger stats the current evidence is built on. */
export async function GET() {
  try {
    const snapshot = await advisorSnapshot();
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[advisor] GET error", err);
    return NextResponse.json({ error: "advisor snapshot failed" }, { status: 500 });
  }
}

/** POST /api/advisor — operator actions:
 *  { action: "run" }                    → force an evidence cycle now
 *  { action: "approve" | "reject", id } → decide a PENDING proposal
 * APPROVE is the only path that mutates gate settings from the advisor —
 * exactly the operator-approval contract (Q3 mandate). */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string };
    if (body.action === "run") {
      const r = await forceRunAdvisor();
      return NextResponse.json({ ok: true, ...r });
    }
    if ((body.action === "approve" || body.action === "reject") && body.id) {
      const r = await decideProposal(body.id, body.action === "approve");
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
      return NextResponse.json({ ok: true, proposal: r.proposal });
    }
    return NextResponse.json({ ok: false, error: "unknown action — use {action:'run'} or {action:'approve'|'reject', id}" }, { status: 400 });
  } catch (err) {
    console.error("[advisor] POST error", err);
    return NextResponse.json({ ok: false, error: "advisor action failed" }, { status: 500 });
  }
}
