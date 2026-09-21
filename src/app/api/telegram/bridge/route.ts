import { NextResponse } from "next/server";
import {
  bridgeStatus,
  bridgeRecent,
  bridgeSend,
  bridgePollOnceFast,
  setAutoReply,
  ensureBridgeLoopAlive,
} from "@/lib/telegram-bridge";

export const dynamic = "force-dynamic";

/** Optional shared-secret guard: if BRIDGE_TOKEN is set, callers must send
 * header X-Bridge-Token. Unset → open (localhost posture, same as /api/notify). */
function authorized(req: Request): boolean {
  const expected = process.env.BRIDGE_TOKEN;
  if (!expected) return true;
  return req.headers.get("x-bridge-token") === expected;
}

/** GET /api/telegram/bridge?limit=80 — bridge health + recent conversation. */
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    ensureBridgeLoopAlive();
  } catch {
    /* self-heal is best-effort */
  }
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "80");
  const status = bridgeStatus();
  const recent = bridgeRecent(Number.isFinite(limit) ? limit : 80);
  return NextResponse.json(
    {
      ok: true,
      status: {
        autoReply: status.autoReply,
        startedAt: status.startedAt,
        lastPollAt: status.lastPollAt,
        lastIngestAt: status.lastIngestAt,
        lastReplyAt: status.lastReplyAt,
        polls: status.polls,
        ingested: status.ingested,
        replies: status.replies,
        errors: status.errors,
        lastError: status.lastError,
        files: status.files,
      },
      inbox: recent.inbox,
      outbox: recent.outbox,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** POST /api/telegram/bridge — {action:"send",text} | {action:"sync"} |
 * {action:"autoreply",on:boolean} | {action:"status"} */
export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; text?: string; on?: boolean };
    const action = body.action ?? "send";
    if (action === "send") {
      const text = (body.text ?? "").trim();
      if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
      const r = await bridgeSend(text, "api");
      return NextResponse.json({ ok: r.ok, error: r.error }, { status: r.ok ? 200 : 502 });
    }
    if (action === "sync") {
      const ingested = await bridgePollOnceFast();
      return NextResponse.json({ ok: true, ingested, status: bridgeStatus() });
    }
    if (action === "autoreply") {
      const s = setAutoReply(Boolean(body.on));
      return NextResponse.json({ ok: true, autoReply: s.autoReply });
    }
    if (action === "status") {
      return NextResponse.json({ ok: true, status: bridgeStatus() });
    }
    return NextResponse.json({ error: `unknown action ${action}` }, { status: 400 });
  } catch (err) {
    console.error("[telegram/bridge] POST error", err);
    return NextResponse.json({ error: "bridge action failed" }, { status: 500 });
  }
}
