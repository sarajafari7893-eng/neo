import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tick, getTriggerBusSummary, getScanDomain, getEngineTickInfo } from "@/lib/engine";
import { buildStats, toSignalDTO } from "@/lib/stats";
import { getFeedStatus } from "@/lib/market-feed";
import { getFlowStatus } from "@/lib/flow";
import { getLiquidationStatus } from "@/lib/liquidations";
import { getRegimeSummary } from "@/lib/regime";
import { captureTopVolCauses } from "@/lib/volCause";
import { ensureP0Watchdog } from "@/lib/watchdog-arm";
import { ensureBridgeLoopAlive } from "@/lib/telegram-bridge";
import { getPumpEngineStatus } from "@/lib/pump-dump"; // v9.0 PUMP/DUMP RADAR
import type { PulseSnapshot } from "@/lib/api-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/pulse — engine heartbeat + full snapshot (v4.8)
 * The client polls this; the engine tick is throttled server-side.
 * Also carries feed health (4-exchange consensus, flow coverage, liq stream).
 */
export async function GET() {
  try {
    // resilience (egress-outage lesson 2026-09-07): the heartbeat must keep
    // flowing even when upstream exchanges hang — race the tick against a
    // deadline and let it finish in the background; this pulse answers with
    // last-known state instead of stalling the client.
    const tickP = tick().catch(() => undefined);
    await Promise.race([tickP, new Promise((r) => setTimeout(r, 7000))]);

    // v6.4 VOL-CAUSE capture rides the heartbeat — throttled to one run/3min
    // inside the lib; never blocks or breaks the pulse.
    void captureTopVolCauses();

    // P0 WATCHDOG self-arm (2026-09-09 ops mandate) — keeps the bun
    // p0-watchdog service (:3020) dormant-proof: if its lock pid is dead,
    // the pulse heartbeat re-runs watchdog-up.sh; fail-open + 60s throttle
    // inside the lib, ~1ms when healthy. The v6.2 dormancy lesson, closed.
    ensureP0Watchdog();

    // v8.3 TELEGRAM BRIDGE self-heal — if the getUpdates long-poll loop ever
    // dies silently, every heartbeat (keep-alive cron + dashboard) re-arms it.
    // Fail-open, ~0ms when healthy (global beat read only).
    try {
      ensureBridgeLoopAlive();
    } catch {
      /* never break the pulse */
    }

    const [assets, signals, events, stats, liqStatus] = await Promise.all([
      db.marketAsset.findMany({ orderBy: { volume24h: "desc" } }),
      db.signal.findMany({ orderBy: { createdAt: "desc" }, take: 60 }),
      db.signalEvent.findMany({ orderBy: { createdAt: "desc" }, take: 60 }),
      buildStats(),
      // v10.1 stability pass: secondary calls degrade to null instead of 500-ing
      // the whole heartbeat — the client keeps the last snapshot meanwhile.
      getLiquidationStatus().catch(() => null),
    ]);

    const feedStatus = getFeedStatus();
    const flowStatus = getFlowStatus();
    // auxiliary status calls: never let a radar/domain hiccup kill the pulse
    const scanDomain = await getScanDomain().catch(() => null);

    // derive per-venue health from the latest consensus sweep persisted on assets
    const exchanges = ["BINANCE", "OKX", "BYBIT", "HYPERLIQUID"].map((venue) => {
      if (venue === "BINANCE") return { venue, ok: feedStatus.source === "LIVE" || feedStatus.source === "STALE", latencyMs: feedStatus.latencyMs };
      const withVenue = assets.find((a) => {
        if (!a.exchanges) return false;
        try {
          return (JSON.parse(a.exchanges) as Array<{ venue: string; price: number | null }>).some((q) => q.venue === venue && q.price);
        } catch {
          return false;
        }
      });
      return { venue, ok: !!withVenue, latencyMs: null };
    });

    const snapshot: PulseSnapshot = {
      ts: Date.now(),
      market: assets.map((a) => ({
        ...a,
        sparkline: JSON.parse(a.sparkline) as number[],
        exchanges: a.exchanges ? (JSON.parse(a.exchanges) as Array<{ venue: string; price: number | null; latencyMs: number | null }>) : null,
      })),
      signals: signals.map(toSignalDTO),
      events: events.map((e) => ({
        id: e.id,
        signalId: e.signalId,
        type: e.type,
        symbol: e.symbol,
        message: e.message,
        level: e.level as PulseSnapshot["events"][number]["level"],
        createdAt: e.createdAt.toISOString(),
      })),
      stats,
      feed: {
        source: feedStatus.source,
        lastOkAt: feedStatus.lastOkAt,
        latencyMs: feedStatus.latencyMs,
        consecutiveFailures: feedStatus.consecutiveFailures,
        host: feedStatus.host,
        exchanges,
        flow: flowStatus,
        liq: liqStatus
          ? {
              online: true,
              connected: liqStatus.connected,
              dataStalled: liqStatus.dataStalled,
              buffered: liqStatus.buffered,
              lastEventAt: liqStatus.lastEventAt,
              uptimeSec: liqStatus.uptimeSec,
            }
          : null,
        triggers: { ...getTriggerBusSummary(), ...getEngineTickInfo() },
        regimes: getRegimeSummary(),
        universe: scanDomain,
        pump: await getPumpEngineStatus().catch(() => null), // v9.0 — radar gate + tracks (15s memo inside)
      },
    };

    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[pulse] error", err);
    return NextResponse.json({ error: "engine failure" }, { status: 500 });
  }
}
