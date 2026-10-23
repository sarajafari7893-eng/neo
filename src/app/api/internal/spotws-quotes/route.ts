import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// ── v12.11 internal ingest — price-ws spot-print push (:3003 → :3000) ───────
// POST { at, rows: [{ s: "BTCUSDT", p: 81340.7, t: <exchange ms> }] } every 3s.
// Persists .data/spotws-quotes.json (atomic tmp+rename) — the app's venue
// consensus reads it as BINANCE rung 0. WHY a FILE and not an in-memory
// store: dev-mode Turbopack compiles per-route bundles → module-level state
// is not reliably shared across bundles; the file is cross-bundle truth,
// survives route recompiles, and ages out honestly (mtime + per-row ts).
// WHY push from price-ws: it already holds the ONE Binance plane that
// sustains from this egress (spot !miniTicker@arr WS — hours-proven) while
// the app must stay WS-free (compile-ramp OOM budget + instance churn).
// Loopback only — external gating by the proxy CONTROL_GATE (cascade doctrine).

export const dynamic = "force-dynamic";

const OUT_FILE = path.resolve(".data/spotws-quotes.json");
const MAX_ROWS = 5000;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { at?: number; rows?: Array<{ s?: string; p?: number; t?: number }> };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0 || rows.length > MAX_ROWS) {
      return NextResponse.json({ ok: false, error: "invalid row count" }, { status: 400 });
    }
    const clean: Array<{ s: string; p: number; t: number }> = [];
    for (const r of rows) {
      const sym = String(r.s ?? "").toUpperCase();
      const p = Number(r.p);
      const t = Number(r.t);
      if (!sym.endsWith("USDT") || !(p > 0) || !(t > 0)) continue;
      clean.push({ s: sym, p, t });
    }
    if (clean.length === 0) {
      return NextResponse.json({ ok: false, error: "no valid rows" }, { status: 400 });
    }
    const payload = JSON.stringify({ at: Date.now(), rows: clean });
    const tmp = `${OUT_FILE}.tmp`;
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, OUT_FILE);
    return NextResponse.json({ ok: true, rows: clean.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e).slice(0, 200) }, { status: 500 });
  }
}
