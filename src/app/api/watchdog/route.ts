import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// P0 WATCHDOG status mirror (OP-P0-WD-0909) — read-only passthrough of the
// guardian's persisted state (.data/p0-watchdog/state.json). The guardian
// itself lives in mini-services/p0-watchdog on :3020; this endpoint lets the
// keep-alive cron and the operator verify protection status from the app port.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE = path.join(process.cwd(), ".data", "p0-watchdog", "state.json");

export async function GET() {
  try {
    if (!existsSync(STATE)) {
      return NextResponse.json(
        { ok: false, guarded: false, reason: "watchdog-state-missing (guardian not booted yet?)" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    const raw = JSON.parse(readFileSync(STATE, "utf8")) as Record<string, unknown>;
    const services = (raw.services ?? {}) as Record<string, { mode?: string }>;
    const modes = Object.values(services).map((s) => s?.mode ?? "unknown");
    const guarded = modes.length > 0 && modes.every((m) => m === "ok" || m === "init");
    return NextResponse.json(
      {
        ok: true,
        guarded,
        services: Object.fromEntries(Object.entries(services).map(([k, s]) => [k, s?.mode ?? "unknown"])),
        ver: raw.ver ?? null,
        uptimeSec: raw.uptimeSec ?? null,
        tehran: raw.tehran ?? null,
        mem: raw.mem ?? null,
        paused: raw.pausedUntil ?? null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, guarded: false, reason: `state-read-failed: ${String(e).slice(0, 80)}` },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
