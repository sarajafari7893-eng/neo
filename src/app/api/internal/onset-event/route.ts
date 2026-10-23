import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionOf } from "@/lib/volCause";

// ── v12.11 internal ingest — price-ws TICK-ONSET events (:3003 → :3000) ─────
// POST { symbol, side: UP|DOWN, movePct, windowMs, lane, tier: FAST|SLOW|CASCADE,
//        level, price, change24h, at }
// Creates a LEADING VolCauseEvent row so the engine's volCauseBoost, the
// vol-cause board and the daily report see a regime onset within SECONDS —
// the slow |Δ24h| capture recorded IRYS +565% as ONE event 16h in (at the
// tick-top) and the −77.4% collapse as ZERO events; this plane is the fix.
//
// Conventions:
//   · rank 0 = tick-plane origin marker (board rank stays 1-based for the
//     slow capture plane — see volCause.ts CAPTURE_TOP_N).
//   · tier FAST/SLOW → primaryCause VOL-ONSET (eruption onset, tick evidence)
//   · tier CASCADE  → primaryCause LIQ-CASCADE — a ±5%/60s tick cascade is
//     cascade mechanics REGARDLESS of forceOrder-stream visibility (microcap
//     forensics: the liq stream is structurally silent for these listings);
//     the study therefore learns from tick-plane cascades too.
//   · 90s same-symbol+direction dedupe — double-posts and price-ws reload
//     re-fires collapse to one row; the 6h staged ladder lives in price-ws.
//
// External access is gated by the proxy CONTROL_GATE (same doctrine as
// cascade-alert); price-ws posts from loopback.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      symbol?: string; side?: string; movePct?: number; windowMs?: number; lane?: string;
      tier?: string; level?: number | null; price?: number; change24h?: number | null; at?: number;
    };
    const symbol = String(body.symbol ?? "").toUpperCase();
    const side = body.side === "UP" ? "UP" : body.side === "DOWN" ? "DOWN" : null;
    const movePct = Number(body.movePct);
    const price = Number(body.price);
    if (!symbol.endsWith("USDT") || !side || !Number.isFinite(movePct) || !(price > 0)) {
      return NextResponse.json({ ok: false, error: "invalid payload" }, { status: 400 });
    }
    const atMs = Number.isFinite(body.at) && Number(body.at) > 0 ? Number(body.at) : Date.now();
    const detectedAt = new Date(atMs);
    const dupe = await db.volCauseEvent.findFirst({
      where: { symbol, direction: side, detectedAt: { gte: new Date(atMs - 90_000) } },
      select: { id: true },
    });
    if (dupe) return NextResponse.json({ ok: true, deduped: true });
    const tierRaw = String(body.tier ?? "FAST").toUpperCase();
    const tier: "FAST" | "SLOW" | "CASCADE" = tierRaw === "SLOW" ? "SLOW" : tierRaw === "CASCADE" ? "CASCADE" : "FAST";
    const level = Number.isFinite(Number(body.level)) && Number(body.level) > 0 ? Number(body.level) : null;
    const lane = String(body.lane ?? "WS");
    const windowMs = Number.isFinite(body.windowMs) ? Math.max(0, Math.round(Number(body.windowMs))) : 0;
    const change24h = Number.isFinite(Number(body.change24h)) ? Number(body.change24h) : 0;
    const sign = movePct >= 0 ? "+" : "";
    const note =
      tier === "CASCADE"
        ? `TICK-PLANE CASCADE-FREEZE ${sign}${movePct.toFixed(2)}%/${Math.round(windowMs / 1000)}s · lane ${lane}${change24h ? ` · Δ24h ${change24h.toFixed(1)}%` : ""} · tick-plane LIQ-CASCADE evidence (forceOrder stream structurally silent on microcaps)`
        : `TICK-ONSET ${tier} lvl${level ?? "?"} ${sign}${movePct.toFixed(2)}%/${Math.round(windowMs / 1000)}s · lane ${lane}${change24h ? ` · Δ24h ${change24h.toFixed(1)}%` : ""} · leading tick-plane onset (slow capture is 16h-late on this class)`;
    const ev = await db.volCauseEvent.create({
      data: {
        symbol,
        detectedAt,
        rank: 0,
        direction: side,
        change24h,
        price,
        onsetScore: null,
        hourUtc: detectedAt.getUTCHours(),
        session: sessionOf(detectedAt),
        causesJson: JSON.stringify([{ cause: tier === "CASCADE" ? "LIQ-CASCADE" : "VOL-ONSET", weight: 100, note }]),
        primaryCause: tier === "CASCADE" ? "LIQ-CASCADE" : "VOL-ONSET",
      },
    });
    console.log(`[onset-event] ${symbol} ${side} ${tier}${level ? `-lvl${level}` : ""} ${sign}${movePct.toFixed(2)}% — VolCauseEvent ${ev.id} (rank 0, tick-plane, leading)`);
    return NextResponse.json({ ok: true, id: ev.id });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e).slice(0, 200) }, { status: 500 });
  }
}
