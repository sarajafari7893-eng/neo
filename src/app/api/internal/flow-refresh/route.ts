import { NextResponse } from "next/server";
import { refreshSymbolFlow } from "@/lib/flow-scanner";

// ── v12.12 internal card-refresh — card-sentinel (:3022 → :3000) ─────────────
// GET|POST /api/internal/flow-refresh?symbol=BIRBUSDT
// Forces an immediate single-symbol flow scan AND persists the FlowScan DB
// cards (the dashboard's flow rows) instead of waiting for the two-speed
// rotation to reach the symbol. Consumed by mini-services/card-sentinel from
// loopback; external access is gated by the proxy CONTROL_GATE (same doctrine
// as onset-event / cascade-alert).
//
// Budget guards (RAM-aware — this box runs a 4GB no-swap fleet):
//   · 90s per-symbol rate limit (in-process map, no stampede on retries)
//   · refreshSymbolFlow() is single-flight inside flow-scanner
//   · 45s hard timeout wrapper — a starved kline plane must not hold the lane

export const dynamic = "force-dynamic";

const lastRefreshAt = new Map<string, number>();
const RATE_LIMIT_MS = 90_000;
const HARD_TIMEOUT_MS = 45_000;

async function handle(req: Request): Promise<NextResponse> {
  try {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase().trim();
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
      return NextResponse.json({ ok: false, error: "bad symbol" }, { status: 400 });
    }
    const now = Date.now();
    const last = lastRefreshAt.get(symbol) ?? 0;
    if (now - last < RATE_LIMIT_MS) {
      return NextResponse.json({
        ok: true,
        symbol,
        skipped: "rate-limited",
        retryInSec: Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000),
      });
    }
    lastRefreshAt.set(symbol, now);
    const rollup = await Promise.race([
      refreshSymbolFlow(symbol),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HARD_TIMEOUT_MS).unref?.()),
    ]);
    if (!rollup) {
      return NextResponse.json({ ok: false, symbol, error: "scan failed / in-flight / timeout" }, { status: 503 });
    }
    return NextResponse.json({
      ok: true,
      symbol,
      at: new Date().toISOString(),
      netBias: rollup.netBias,
      netScore: rollup.netScore,
      alignment: rollup.alignment,
      venue: rollup.venue ?? null,
      tfs: rollup.tfs.map((t) => ({ tf: t.tf, score: t.score, bias: t.bias, atrPct: t.atrPct })),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err).slice(0, 200) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
