import { NextResponse } from "next/server";
import { getShadowModulesSnapshot, runModuleNow, putMode, MODULES, type ModuleId, type ModuleMode } from "@/lib/shadow-modules";

export const dynamic = "force-dynamic";

/** GET /api/modules — full shadow-modules snapshot: registry, per-module modes,
 * and the live state of R1 risk-governor / R2 time-governor / R5 ui-canary /
 * R6 senior-review. */
export async function GET() {
  try {
    const snapshot = await getShadowModulesSnapshot();
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[modules] GET error", err);
    return NextResponse.json({ error: "shadow modules snapshot failed" }, { status: 500 });
  }
}

/** POST /api/modules — operator actions:
 *  { module: id, action: "run" }                      → force a module cycle now
 *  { module: id, action: "mode", mode: "SHADOW"|"ENGAGED" } → toggle the doctrine mode
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { module?: string; action?: string; mode?: string };
    const id = body.module as ModuleId | undefined;
    if (!id || !MODULES.some((m) => m.id === id)) {
      return NextResponse.json({ ok: false, error: `unknown module — valid ids: ${MODULES.map((m) => m.id).join(", ")}` }, { status: 400 });
    }
    if (body.action === "run") {
      const r = await runModuleNow(id);
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 500 });
      const snapshot = await getShadowModulesSnapshot();
      return NextResponse.json({ ok: true, snapshot });
    }
    if (body.action === "mode") {
      const mode = body.mode as ModuleMode | undefined;
      if (mode !== "SHADOW" && mode !== "ENGAGED") {
        return NextResponse.json({ ok: false, error: "mode must be SHADOW or ENGAGED" }, { status: 400 });
      }
      await putMode(mode as ModuleMode);
      const snapshot = await getShadowModulesSnapshot();
      return NextResponse.json({ ok: true, snapshot });
    }
    return NextResponse.json({ ok: false, error: "unknown action — use {module, action:'run'} or {module, action:'mode', mode}" }, { status: 400 });
  } catch (err) {
    console.error("[modules] POST error", err);
    return NextResponse.json({ ok: false, error: "modules action failed" }, { status: 500 });
  }
}
