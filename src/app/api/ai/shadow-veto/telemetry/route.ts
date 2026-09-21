import { NextResponse } from "next/server";
import { captureSvTelemetry, ensureFreshSvTelemetry, getSvTelemetry } from "@/lib/sv-telemetry";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/shadow-veto/telemetry — v10.2 SV-TELEMETRY HUB retrieval.
 *
 * Operator mandate 2026-09-15 («...بصورت جیسون فایل ذخیره و قابل بازیابی و
 * استفاده باشد»): serves the consolidated, versioned shadow-veto telemetry
 * document persisted at .data/shadow-veto-telemetry.json — per-arm feed
 * wiring, pipeline leak counters, wiring checks, arms, promotion evidence,
 * alert ring, 24h history ring.
 *
 * Query:
 *   ?download=1  → Content-Disposition attachment (save the JSON file)
 *   ?history=1   → include the full 144-sample history ring (default: stripped)
 *   ?raw=1       → file exactly as persisted (no freshness top-up)
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const download = url.searchParams.get("download") === "1";
    const withHistory = url.searchParams.get("history") === "1";
    const raw = url.searchParams.get("raw") === "1";

    const snap = raw ? await getSvTelemetry() : await ensureFreshSvTelemetry();
    if (!snap) {
      return NextResponse.json({ error: "telemetry store empty — first capture pending (engine tick or POST {force:true} creates it)" }, { status: 503 });
    }

    const payload = withHistory || download ? snap : { ...snap, history: [] };

    if (download) {
      const d = new Date(snap.capturedAt).toISOString().slice(0, 10);
      return new NextResponse(JSON.stringify(payload, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="shadow-veto-telemetry-${d}.json"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[sv-telemetry] GET error", err);
    return NextResponse.json({ error: "sv-telemetry retrieval failure" }, { status: 500 });
  }
}

/**
 * POST /api/ai/shadow-veto/telemetry — {force?: true} capture a snapshot NOW
 * (bypasses the 10min throttle when force is set). Used by the dashboard
 * "SNAPSHOT NOW" button and by ops scripts.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    const snap = await captureSvTelemetry(body.force === true);
    if (!snap) return NextResponse.json({ ok: false, error: "capture failed — see server log" }, { status: 500 });
    return NextResponse.json({ ok: true, snapshot: snap }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[sv-telemetry] POST error", err);
    return NextResponse.json({ ok: false, error: "sv-telemetry capture failure" }, { status: 500 });
  }
}
