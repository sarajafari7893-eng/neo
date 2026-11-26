// ── Task 65 SIZING-MODES — operator control plane for margin sizing ──────
// GET  → live config + consecutive-SL run + next-base preview
// POST → switch mode / tune parameters (audited via SignalEvent SIZING_MODE)
//
// Auth: middleware already requires the control key or operator session for
// POST/PUT/PATCH/DELETE; the POST body is re-checked here (defense in depth,
// kill-switch/armor-boot pattern). GET is read-only.
//
// Backtest verdict stamped 2026-10-02 (1031 closed signals, no-lookahead):
//   CONFIDENCE −$10.65 · FLAT$2 −$3.02 · ANTI_MARTINGALE(base2×0.5) +$2.99.

import { NextResponse } from "next/server";
import { liveEnv } from "@/lib/live-env";
import { db } from "@/lib/db";
import { getSizingConfig, setSizingConfig, getConsecutiveSlCount, computeMarginBase, SIZING_MODES, MIN_NOTIONAL_DEFAULT_USD, MIN_NOTIONAL_OVERRIDES, tradeableFloorMargin, type SizingConfig } from "@/lib/sizing";
import { fireEvent } from "@/lib/engine";
import { ACCOUNT_START_USD } from "@/lib/accounting";

export const dynamic = "force-dynamic";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function preview(cfg: SizingConfig) {
  const consecSl = cfg.mode === "ANTI_MARTINGALE" ? await getConsecutiveSlCount(cfg) : 0;
  // preview base at CURRENT account equity (same math as the deploy path)
  const [settled, open] = await Promise.all([
    db.signal.findMany({ where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } }, select: { marginUsd: true, pnlPercent: true } }),
    db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { marginUsd: true, pnlPercent: true } }),
  ]);
  const realized = settled.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const unrealized = open.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const equity = ACCOUNT_START_USD + realized + unrealized;
  const exposure = open.reduce((a, s) => a + s.marginUsd, 0);
  const base = await computeMarginBase(cfg, 75, equity, Math.max(0, equity - exposure));
  return {
    consecSl,
    equity: Number(equity.toFixed(2)),
    nextBasePreview: base.margin,
    previewMode: base.mode,
  };
}

export async function GET() {
  const cfg = await getSizingConfig();
  const p = await preview(cfg);
  return NextResponse.json(
    {
      ok: true,
      config: cfg,
      ...p,
      allowedModes: SIZING_MODES,
      // Task 66: exchange tradeability floor — dust margins cannot exist in reality
      minNotional: {
        defaultUsd: MIN_NOTIONAL_DEFAULT_USD,
        overrides: MIN_NOTIONAL_OVERRIDES,
        floorMarginAt5x: Number(tradeableFloorMargin("ANY", 5).toFixed(2)),
        floorMarginAt10x: Number(tradeableFloorMargin("ANY", 10).toFixed(2)),
        floorMarginAt20x: Number(tradeableFloorMargin("ANY", 20).toFixed(2)),
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  // defense-in-depth re-check (mirrors /api/nexus/kill-switch)
  const expected = liveEnv("NEXUS_CONTROL_KEY");
  const provided = req.headers.get("x-nexus-key") ?? "";
  const keyOk = expected.length > 0 && provided.length > 0 && constantTimeEqual(provided, expected);
  if (!keyOk) {
    try {
      const { getToken } = await import("next-auth/jwt");
      const token = await getToken({ req: req as never, secret: liveEnv("NEXTAUTH_SECRET") || process.env.NEXTAUTH_SECRET || "" });
      if (!token) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    } catch {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  let body: Partial<SizingConfig> & { reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (body.mode && !(SIZING_MODES as readonly string[]).includes(body.mode)) {
    return NextResponse.json({ ok: false, error: `mode must be one of ${SIZING_MODES.join(" | ")}` }, { status: 400 });
  }

  const before = await getSizingConfig();
  const cfg = await setSizingConfig(body);
  const p = await preview(cfg);

  const changed: string[] = [];
  if (before.mode !== cfg.mode) changed.push(`mode ${before.mode}→${cfg.mode}`);
  for (const k of ["flatBase", "antiBase", "decay", "floor", "consecCap"] as const) {
    if (before[k] !== cfg[k]) changed.push(`${k} ${before[k]}→${cfg[k]}`);
  }
  await fireEvent(null, null, "SIZING_MODE", "info", `MARGIN SIZING ${changed.length ? `CHANGED — ${changed.join(" · ")}` : "RE-SET (no change)"} · next base ≈ $${p.nextBasePreview} (k=${p.consecSl})${body.reason ? ` · ${body.reason}` : ""} — backtest: CONFIDENCE −$10.65 / FLAT$2 −$3.02 / ANTI-MART +$2.99`).catch(() => undefined);

  return NextResponse.json({ ok: true, config: cfg, ...p, changed });
}
