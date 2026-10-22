import { NextResponse } from "next/server";
import { entryLeversState, setEntryLeverMode, ENTRY_LEVER_IDS, type EntryLeverId, type EntryLeverMode } from "@/lib/entry-levers";

export const dynamic = "force-dynamic";

// ── v11.3 ENTRY-LEVERS API — the late-entry shield desk ──
// GET  /api/entry-levers → full state: modes, params, per-lever ledger stats
//                           (flagged vs unflagged cohorts on the rolling
//                           window), promotion-gate status, journal tail and
//                           the auto-mode ladder notes. Reading also RUNS the
//                           promotion/demotion ladder — the card always shows
//                           the live authority state.
// POST /api/entry-levers → operator override { lever, mode } where mode is
//                          "shadow" | "enforce" | "off". "off" is the
//                          kill-switch; 45s cooldown against mode flapping.

const MODE_COOLDOWN_MS = 45_000;
let lastModeChangeAt = 0;

export async function GET() {
  try {
    return NextResponse.json(await entryLeversState());
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 140) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { lever?: string; mode?: string; pin?: boolean } | null;
    const lever = body?.lever;
    const mode = body?.mode;
    const pin = body?.pin !== false; // default: operator override pins the lever against the auto ladder
    if (!lever || !ENTRY_LEVER_IDS.includes(lever as EntryLeverId)) {
      return NextResponse.json({ error: `unknown lever — expected one of ${ENTRY_LEVER_IDS.join(", ")}` }, { status: 400 });
    }
    if (mode !== "shadow" && mode !== "enforce" && mode !== "off") {
      return NextResponse.json({ error: "mode must be shadow | enforce | off" }, { status: 400 });
    }
    if (Date.now() - lastModeChangeAt < MODE_COOLDOWN_MS) {
      return NextResponse.json({ error: "mode change cooldown (45s)" }, { status: 429 });
    }
    lastModeChangeAt = Date.now();
    const cfg = await setEntryLeverMode(lever as EntryLeverId, mode as EntryLeverMode, pin ? "operator-pin" : "operator-auto", pin);
    return NextResponse.json({ ok: true, lever, mode, pin, modes: cfg.modes });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 140) }, { status: 500 });
  }
}
