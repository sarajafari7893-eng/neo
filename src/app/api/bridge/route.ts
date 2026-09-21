import { NextRequest, NextResponse } from "next/server";
import { fileOperatorRequest, readOperatorRequests, readEngineerResponses } from "@/lib/engineer-requests";
import { fireEvent } from "@/lib/engine";

export const dynamic = "force-dynamic";

/** GET /api/bridge — the operator↔engineer round trip (v6.4.1). */
export async function GET() {
  const [requests, responses] = await Promise.all([readOperatorRequests(12), readEngineerResponses(12)]);
  return NextResponse.json({ requests: [...requests].reverse(), responses: [...responses].reverse() });
}

/** POST /api/bridge {message} — the operator files a request into the sandbox inbox.
 * The message is audited as an ENGINE event (terminal feed) and the senior
 * engineer (sandbox coding agent) implements it on its next review cycle,
 * answering through engineer-responses.jsonl → ENGINE events → Telegram. */
export async function POST(req: NextRequest) {
  let message = "";
  try {
    const body = (await req.json()) as { message?: unknown };
    message = typeof body.message === "string" ? body.message : "";
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const filed = await fileOperatorRequest(message);
  if (!filed) return NextResponse.json({ error: "message must be 3–500 characters" }, { status: 400 });
  await fireEvent(null, null, "ENGINE", "ai", `ENGINEER BRIDGE — operator filed ${filed.id}: "${filed.message}" · the senior engineer picks it up on its next sandbox review cycle`);
  return NextResponse.json({ ok: true, id: filed.id, at: filed.at });
}
