// ── FlowRadar Neo v6.3 TELEGRAM relay control + health ────────────────
// GET  /api/notify                      → relay health (armed/bot/chat counters/errors)
// POST /api/notify {action:"test"}      → operator-initiated delivery proof (plain line)
// POST /api/notify {action:"sample"}    → v6.3.2 card-format proof (all 7 banner photos)
// POST /api/notify {action:"discover"}  → learn the operator chat from getUpdates
import { NextResponse } from "next/server";
import { relayHealth, sendDirect, discoverChat, sendSampleCards, primeRelayState } from "@/lib/notify";
import { APP_NAME } from "@/lib/brand";

export const dynamic = "force-dynamic";

export async function GET() {
  await primeRelayState(); // cold-route-bundle fix — load bot identity + persisted chat before reporting
  return NextResponse.json(relayHealth());
}

export async function POST(req: Request) {
  let body: { action?: string; text?: string } = {};
  try {
    body = (await req.json()) as { action?: string; text?: string };
  } catch {
    /* empty body */
  }
  if (body.action === "discover") return NextResponse.json(await discoverChat());
  if (body.action === "sample") return NextResponse.json(await sendSampleCards());
  if (body.action === "test") {
    const r = await sendDirect(
      body.text?.slice(0, 500) ??
        `${APP_NAME} relay TEST — ${new Date().toISOString()}\nIf you can read this, the TELEGRAM relay is fully armed: CREATED / TP1-3 / SL / TTL_EXPIRED / TTL_EXTENDED / AFTERLIFE events will mirror here as structured v6.3 cards (WIN/STOP/EXPIRED photos included).`
    );
    return NextResponse.json(r);
  }
  return NextResponse.json({ ok: false, error: "unknown action — use {action:'test'|'sample'|'discover'}" }, { status: 400 });
}
