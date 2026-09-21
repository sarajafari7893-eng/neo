import { NextRequest, NextResponse } from "next/server";
import { aiChat } from "@/lib/ai";
import { buildAnalystGrounding } from "@/lib/analyst-context";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/ai/chat { messages: [{role, content}] } */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return NextResponse.json({ error: "messages required" }, { status: 400 });

    // v5.2: every turn gets FRESH live telemetry — the analyst can no longer
    // drift into stale training-data answers. Bundle is server-built, 8s-cached.
    const grounding = await buildAnalystGrounding();
    const reply = await aiChat(messages, grounding);
    return NextResponse.json({ reply });
  } catch (err) {
    console.error("[ai/chat]", err);
    return NextResponse.json({ error: "ai failure" }, { status: 500 });
  }
}
