// ── FlowRadar//AI ANALYST — live grounding bundle (server-only, v5.2) ──
// Root-cause fix for "analyst answers are vague and based on stale data":
// every chat request now receives a FRESH measured telemetry bundle built
// from the same sources the engine itself reads — prices, flow matrix,
// open risk, realized memory, gates, liquidation feed, trigger bus.
// No static snapshots. No training-data guesses. Every number is live.

import { db } from "@/lib/db";
import { ensureFlow, fetchFlowMetrics, getFlowStatus } from "./flow";
import { getTriggerBusSummary, LAYER_LABEL } from "./triggers";
import { peekRegime } from "./regime";
import { getLiquidationStatus, liquidationPressure } from "./liquidations";
import { getGateSettings, describeGate } from "./gate-settings";
import { getGovernorState } from "./governor";
import { getBacktest } from "./backtest";
import { buildStats } from "./stats";
import { buildTp3Lab, getDeepLearnState } from "./tp3-lab";
import { getVerdictCoreState } from "./verdict";
import { getOnsetBoard, onsetTagStats } from "./volOnset";

const CACHE_TTL = 8_000;
let cache: { at: number; bundle: string } | null = null;

export async function buildAnalystGrounding(): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.bundle;
  const bundle = await buildFresh();
  cache = { at: Date.now(), bundle };
  return bundle;
}

async function buildFresh(): Promise<string> {
  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  try {
    const [assets, gate, governor, bt, liqStatus, bus, stats, tp3Lab, deepLearn, onsetBoard, onsetTs, verdictCore] = await Promise.all([
      db.marketAsset.findMany({ orderBy: { volume24h: "desc" }, take: 8 }),
      getGateSettings(),
      getGovernorState(),
      getBacktest(),
      getLiquidationStatus(),
      Promise.resolve(getTriggerBusSummary()),
      buildStats(),
      buildTp3Lab(14).catch(() => null),
      getDeepLearnState(),
      // VOL-ONSET grounding — deadline-guarded so a cold board rebuild never
      // stalls the chat (the board itself answers stale after its own 12s cap)
      Promise.race([getOnsetBoard(), new Promise<null>((res) => setTimeout(() => res(null), 9_000))]).catch(() => null),
      onsetTagStats().catch(() => null),
      getVerdictCoreState().catch(() => null),
    ]);
    const acct = stats.account;

    // flow metrics for the top-8 liquid symbols (same path the gate reads)
    await ensureFlow(assets.map((a) => a.symbol));
    const flowRows = await Promise.all(
      assets.map(async (a) => ({ sym: a.symbol, m: await fetchFlowMetrics(a.symbol) }))
    );
    const flowStatus = getFlowStatus();

    // open + settled risk
    const [open, settled] = await Promise.all([
      db.signal.findMany({
        where: { status: { in: ["ACTIVE", "TP1", "TP2"] } },
        select: { serial: true, symbol: true, direction: true, confidence: true, pnlPercent: true, entryPrice: true },
        orderBy: { createdAt: "desc" },
        take: 6,
      }),
      db.signal.findMany({
        where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
        select: { serial: true, symbol: true, direction: true, status: true, pnlPercent: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);

    // operator journal → analyst (closes the operator→AI feedback loop:
    // notes written on signal cards were previously write-only for the AI)
    const journal = await db.signal
      .findMany({
        where: { operatorNotes: { not: "" } },
        select: { serial: true, symbol: true, operatorNotes: true, notesUpdatedAt: true },
        orderBy: { notesUpdatedAt: "desc" },
        take: 5,
      })
      .catch(() => []);

    const lines: string[] = [
      `═══ LIVE TELEMETRY — ${now} (grounding: every number below is MEASURED right now; cite ONLY these numbers, never invent or rely on training data) ═══`,
      `MARKET: ${assets.map((a) => `${a.symbol} $${a.price >= 1000 ? a.price.toFixed(0) : a.price.toPrecision(5)} ${a.change24h >= 0 ? "+" : ""}${a.change24h.toFixed(2)}%${peekRegime(a.symbol) ? ` [${peekRegime(a.symbol)!.regime}]` : ""}`).join(" · ")}`,
      flowRows.length
        ? `ORDER FLOW (CVD net % of vol / taker buy-ratio / OI Δ1h / funding 8h / crowd L/S): ${flowRows
            .filter((r): r is typeof r & { m: NonNullable<typeof r.m> } => r.m !== null)
            .map((r) => {
              // FlowMetrics fields are all number|null — coerce honestly to 0 for display
              const cvd = r.m.cvdNetPctOfVol ?? 0;
              const tk = r.m.takerRatio ?? 0;
              const oi = r.m.oiDelta1h ?? 0;
              const fund = (r.m.funding8h ?? 0) * 100;
              const crowd = r.m.crowdLongShort ?? 0;
              return `${r.sym} cvd ${cvd >= 0 ? "+" : ""}${cvd.toFixed(1)}% · tk ${tk.toFixed(2)} · oiΔ1h ${oi >= 0 ? "+" : ""}${oi.toFixed(1)}% · fund ${fund.toFixed(3)}% · crowd ${crowd.toFixed(2)}`;
            })
            .join(" | ")}`
        : "ORDER FLOW: measuring…",
      `FLOW COVERAGE: ${flowStatus.covered} symbols measured live`,
      liqStatus
        ? `LIQUIDATION FEED: ${liqStatus.online ? "online" : "offline"}${liqStatus.dataStalled ? " (stream stalled — no live cascade data)" : ""}`
        : "LIQUIDATION FEED: offline (sandbox stream blocked — say so if asked about cascades)",
      open.length
        ? `OPEN SIGNALS: ${open.map((o) => `NX-${String(o.serial).padStart(4, "0")} ${o.symbol} ${o.direction} entry ${o.entryPrice} now ${o.pnlPercent >= 0 ? "+" : ""}${o.pnlPercent.toFixed(2)}% (conf ${o.confidence})`).join(" · ")}`
        : "OPEN SIGNALS: none — engine deployed nothing yet (gates open since last relief)",
      settled.length
        ? `LAST SETTLED: ${settled.map((s) => `NX-${String(s.serial).padStart(4, "0")} ${s.symbol} ${s.direction} → ${s.status} ${s.pnlPercent >= 0 ? "+" : ""}${s.pnlPercent.toFixed(2)}%`).join(" · ")}`
        : "LAST SETTLED: no history yet",
      `ENGINE GATES: ${describeGate(gate)}`,
      `ACCOUNT (SIM): balance $${acct.balance.toFixed(2)} · equity $${acct.equity.toFixed(2)} · open ${acct.openPositions} · exposure $${acct.exposureUsd.toFixed(2)} · fees paid $${acct.feesPaid.toFixed(2)}`,
      bt ? `BACKTEST MEMORY: n=${bt.n} WR ${bt.winRate}% Wilson-LB ${bt.wilsonLB}% expectancy ${bt.avgNetPct}%/trade — ${bt.verdict}` : "BACKTEST MEMORY: no replay yet",
      tp3Lab
        ? `TP3 DEEP-LAB (14d): full-TP ${tp3Lab.fullTp.count}/${tp3Lab.fullTp.count + tp3Lab.stopped.count} (${tp3Lab.fullTp.ratePct}%) avgConf ${tp3Lab.fullTp.avgConfidence} avgRR ${tp3Lab.fullTp.avgRr} vs stop-outs avgConf ${tp3Lab.stopped.avgConfidence} — ${tp3Lab.contrast.note}`
        : "TP3 DEEP-LAB: measuring…",
      deepLearn.lessons.length
        ? `DEEP-LEARN LESSONS (apply these, newest first): ${deepLearn.lessons.slice(0, 3).map((l) => `[${l.scope}] ${l.pattern} → ${l.action}`).join(" | ")}`
        : "DEEP-LEARN LESSONS: none yet — research desk cycles after TP3/SL outcomes settle",
      governor.log[0]
        ? `GOVERNOR LAST CYCLE: ${governor.log[0].at.slice(0, 16)}Z ${governor.log[0].gatesAfter}`
        : "GOVERNOR: no cycle yet",
      verdictCore?.lastAnswer
        ? `VERDICT-CORE (gate-journal deep-learn, ${verdictCore.runs} cycles, ${verdictCore.lastRunAt ? verdictCore.lastRunAt.slice(0, 16) + "Z" : "n/a"}): ${verdictCore.lastAnswer.slice(0, 420)}${verdictCore.lessons[0] ? ` · TOP LESSON: ${verdictCore.lessons[0].pattern} → ${verdictCore.lessons[0].action}` : ""}`
        : "VERDICT-CORE: no learning cycle yet — the gate journal (confirm/reject reasons at the decision border) accrues automatically",
      `GATE JOURNAL: the deploy gate journals every confirm/reject verdict with its full reason payload (v8.2) — cite it when asked WHY signals pass or fail`,
      onsetBoard
        ? `VOL-ONSET RADAR (15m eruption bars ≥5× trailing median — LEADING view, recency-decay ranked): ${onsetBoard.rows.filter((r) => r.hot).length} hot · ${onsetBoard.rows.length ? onsetBoard.rows.slice(0, 3).map((r) => `${r.symbol} ${r.direction} score ${r.score} erupted ${r.minutesSince}m ago ×${r.displacementX.toFixed(1)} ft ${r.followThroughPct >= 0 ? "+" : ""}${r.followThroughPct.toFixed(1)}%${r.hot ? " HOT" : ""}`).join(" | ") : "no eruption bars in trailing 24h (quiet tape)"}${onsetTs ? ` — LEARNING: settled ${onsetTs.settledTotal}, tagged ${onsetTs.tagged.n} (WR ${onsetTs.tagged.winRatePct ?? "—"}%, avg net ${onsetTs.tagged.avgNetPct ?? "—"}%) vs rest ${onsetTs.rest.n} (WR ${onsetTs.rest.winRatePct ?? "—"}%, avg net ${onsetTs.rest.avgNetPct ?? "—"}%)` : ""}`
        : "VOL-ONSET RADAR: measuring (board rebuilding — do not invent numbers)",
      `TRIGGER BUS: ${JSON.stringify(bus.counts)} events measured`,
      journal.length
        ? `OPERATOR JOURNAL (operator's own notes — acknowledge and respect them when relevant): ${journal
            .map((j) => `NX-${String(j.serial).padStart(4, "0")} ${j.symbol}: “${(j.operatorNotes ?? "").slice(0, 90)}”`)
            .join(" · ")}`
        : "OPERATOR JOURNAL: no notes yet",
    ];

    const recentEvents = (bus.last ?? []).slice(0, 4);
    if (recentEvents.length) {
      lines.push(`LATEST TRIGGERS: ${recentEvents.map((e) => `[${LAYER_LABEL[e.layer] ?? e.layer}] ${e.symbol}`).join(" · ")}`);
    }

    return lines.join("\n");
  } catch (err) {
    console.error("[analyst-context]", err);
    return `═══ LIVE TELEMETRY — ${now} ═══\n(grounding partially unavailable: telemetry builder errored — answer generally and SAY the live feed is degraded rather than inventing numbers)`;
  }
}
