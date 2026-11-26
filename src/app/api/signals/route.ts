import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toSignalDTO } from "@/lib/stats";
import { ENGINE_VERSION } from "@/lib/engine";

export const dynamic = "force-dynamic";

// ── v11.5 PUBLIC SIGNALS FEED (operator question 2026-10-12: «آیا میشود از
// سیگنالهای صادر شده API گرفت تا در داشبورد دیگر استفاده شود؟») ────────────
// READ-ONLY feed of every emitted signal, CORS-open so ANY external dashboard
// can consume it directly from the browser (no key needed for reads — writes
// stay gated by the control-plane middleware). POST remains 423 (total
// autonomy doctrine: deployment is 100% engine-autonomous).
//
//   GET /api/signals
//     ?status=ACTIVE|OPEN|TP1|TP2|TP3|SL|EXPIRED|CLOSED|ALL   (default ALL)
//     ?direction=LONG|SHORT|ALL                                (default ALL)
//     ?symbol=BTCUSDT                                          (exact match)
//     ?since=2026-10-12T00:00:00Z | 1791760000000              (createdAt ≥)
//     ?limit=40                                                (1..500, default 40)
//     ?format=full|compact                                     (default full)
//
//   compact → one flat row per signal for cheap external widgets:
//     { serial, symbol, direction, strategy, status, confidence,
//       entryPrice, stopLoss, tp1, tp2, tp3, leverage, marginUsd,
//       pnlPercent, reachedTp, createdAt, closedAt, tags }
//
// Response envelope: { meta: { engine, generatedAt, count, limit }, signals: [...] }
// CORS: Access-Control-Allow-Origin: * on GET/OPTIONS.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

// ── v13.3 LIVE-INTENT ENRICHMENT (operator forensics trace 1a193604acd890f9) ──
// The ledger's marginUsd is the FLAT-10 sizing ANCHOR (engine deploy math);
// the bridge's execution truth is the operator's FIXED-MARGIN mandate
// (cfg.marginUsdt=2) — NX-3217 LSK showed both on different layers and the
// operator saw two numbers. This merge attaches the bridge intent per serial
// so every card can display the EXECUTION truth next to the ledger anchor.
// Fail-soft: bridge down / slow → no liveIntent field, feed still serves.
let bridgeIntentCache: { at: number; map: Map<number, import("@/lib/api-types").LiveIntentDTO> } | null = null;
async function fetchBridgeIntentMap(): Promise<Map<number, import("@/lib/api-types").LiveIntentDTO>> {
  if (bridgeIntentCache && Date.now() - bridgeIntentCache.at < 5000) return bridgeIntentCache.map;
  const map = new Map<number, import("@/lib/api-types").LiveIntentDTO>();
  try {
    const res = await fetch("http://127.0.0.1:3021/status", { signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (res.ok) {
      const j = (await res.json()) as { openIntents?: Record<string, unknown>[]; recent?: Record<string, unknown>[]; cfg?: { marginUsdt?: number } };
      const cfgMargin = typeof j.cfg?.marginUsdt === "number" ? j.cfg.marginUsdt : null;
      const seen = new Set<Record<string, unknown>>();
      for (const i of [...(j.openIntents ?? []), ...(j.recent ?? [])]) {
        if (seen.has(i)) continue; // openIntents ⊂ recent overlap
        seen.add(i);
        const serial = typeof i.serial === "number" ? i.serial : null;
        if (serial === null || map.has(serial)) continue;
        const margin = typeof i.marginUsdt === "number" ? i.marginUsdt : cfgMargin;
        if (margin === null) continue;
        map.set(serial, {
          serial,
          mode: i.mode === "PAPER" ? "PAPER" : "LIVE",
          bridgeStatus: typeof i.status === "string" ? i.status : "UNKNOWN",
          marginUsdt: margin,
          leverage: typeof i.leverage === "number" ? i.leverage : 0,
          levSrc: typeof i.levSrc === "string" ? i.levSrc : "n/a",
          notionalUsdt: typeof i.notionalUsdt === "number" ? i.notionalUsdt : margin * (typeof i.leverage === "number" ? i.leverage : 0),
          fillPrice: typeof i.fillPrice === "number" ? i.fillPrice : null,
          qtyOrig: typeof i.qtyOrig === "number" ? i.qtyOrig : null,
          orderId: typeof i.orderId === "string" ? i.orderId : null,
          slipBps: typeof i.slipBps === "number" ? i.slipBps : null,
        });
      }
    }
  } catch {
    // bridge down — honest absence (no liveIntent), never block the feed
  }
  bridgeIntentCache = { at: Date.now(), map };
  return map;
}

/** GET /api/signals?status=ACTIVE&direction=LONG&symbol=BTCUSDT&limit=40 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const direction = sp.get("direction");
  const symbol = sp.get("symbol");
  const sinceRaw = sp.get("since");
  const format = sp.get("format") === "compact" ? "compact" : "full";
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit") ?? 40) || 40));

  const where: Record<string, unknown> = {};
  if (status && status !== "ALL") where.status = status === "OPEN" ? { in: ["ACTIVE", "TP1", "TP2"] } : status;
  if (direction && direction !== "ALL") where.direction = direction;
  if (symbol && symbol !== "ALL") where.symbol = symbol.toUpperCase();
  if (sinceRaw) {
    const ms = /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw);
    if (Number.isFinite(ms)) where.createdAt = { gte: new Date(ms) };
  }

  const signals = await db.signal.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const body =
    format === "compact"
      ? signals.map((s) => ({
          serial: s.serial,
          symbol: s.symbol,
          direction: s.direction,
          strategy: s.strategy,
          status: s.status,
          confidence: s.confidence,
          entryPrice: s.entryPrice,
          stopLoss: s.stopLoss,
          tp1: s.tp1,
          tp2: s.tp2,
          tp3: s.tp3,
          leverage: s.leverage,
          marginUsd: s.marginUsd,
          pnlPercent: s.pnlPercent,
          reachedTp: s.reachedTp,
          createdAt: s.createdAt.toISOString(),
          closedAt: s.closedAt?.toISOString() ?? null,
          tags: s.tags ? s.tags.split(",").filter(Boolean) : [],
        }))
      : signals.map(toSignalDTO);

  // v13.3 — attach bridge execution truth per serial (full format only;
  // compact stays a flat cheap widget row). Fail-soft: no field when down.
  if (format !== "compact") {
    const intentMap = await fetchBridgeIntentMap();
    if (intentMap.size > 0) {
      for (const dto of body) {
        const li = intentMap.get((dto as { serial: number }).serial);
        if (li) (dto as { liveIntent?: unknown }).liveIntent = li;
      }
    }
  }

  return NextResponse.json(
    {
      meta: {
        engine: ENGINE_VERSION,
        generatedAt: new Date().toISOString(),
        count: body.length,
        limit,
        format,
        note: "read-only public feed — GET is keyless + CORS-open; deployment is engine-autonomous (POST 423)",
      },
      signals: body,
    },
    { headers: CORS },
  );
}

/**
 * POST /api/signals — DISABLED (v6.0 TOTAL AUTONOMY).
 * The operator-forced deployment path (which bypassed the gates) is removed:
 * deployment is 100% autonomous — the trigger bus → confluence/flow/regime/
 * memory gates → AI GOVERNOR supervision is the ONLY deploy path. Manual
 * deployment is exactly the un-audited flow the AI SUPERVISOR's no-manual,
 * no-simulation mandate exists to prevent.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "manual deployment disabled — signals deploy only via the autonomous trigger-bus → governor-gated engine",
      autonomy: "total",
      note: "no manual mode for deployment or learning; the AI SUPERVISOR enforces zero hallucination / zero simulation",
    },
    { status: 423 },
  );
}
