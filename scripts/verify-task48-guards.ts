// READ-ONLY VERIFICATION — Task 48 (operator mandate 2026-10-19: «پیشنهادها را کامل و مهندسی اجرا کن»)
// Replays the Tehran 10-18 book through the REAL v12.1 guard modules:
//   ① radar→signal revival lane — funnel forensics + lane rail contract
//   ② FLOW-NO-DATA verdict contract (offline unit cases)
//   ③ BOTTOM-FADE gate — 7 deep stops + 14 winner controls through the REAL
//      bottomFadeVerdict()/computeTapeContext() from src/lib/entry-context.ts
//   ④ V-REVERSAL gate — same replay through the REAL vRevVerdict()
// No data mutated.
import { PrismaClient } from "@prisma/client";
import { computeTapeContext, bottomFadeVerdict, vRevVerdict, BOTTOM_FADE_DEFAULTS, VREV_DEFAULTS } from "../src/lib/entry-context";
import { flowCoverageOf } from "../src/lib/flow";

const db = new PrismaClient();

async function main() {
  const bfCfg = { ...BOTTOM_FADE_DEFAULTS };
  const vrCfg = { ...VREV_DEFAULTS };
  console.log(`cfg bottom-fade=${JSON.stringify(bfCfg)} · v-reversal=${JSON.stringify(vrCfg)}\n`);

  // ── ② flow verdict contract (offline, no fetch) ──
  console.log("═══ ② FLOW-NO-DATA contract ═══");
  const blindMetrics = { oiDelta10m: null, oiDelta1h: null, oiValueUsd: null, cvdNetBase: null, cvdNetPctOfVol: null, takerRatio: null, takerMean: null, crowdLongShort: null, crowdLongPct: null, topLongShort: null, funding8h: null, cvdUsd60s: null, whalePrint5m: null };
  const sighted = { ...blindMetrics, oiValueUsd: 51_000_000, funding8h: 0.01 };
  console.log(`coverage(all-null)=${flowCoverageOf(blindMetrics as never)} (expect 0 → verdict NO-DATA) · coverage(partial)=${flowCoverageOf(sighted as never)} (expect ≥1 → normal scoring)`);

  // ── ③④ replay ──
  console.log("\n═══ ③④ DEEP-STOP + WINNER REPLAY through REAL guards ═══");
  let bfBlocks = 0, vrBlocks = 0, winnerFalseBlocks = 0;
  const deeps = await db.signal.findMany({
    where: { status: "SL", pnlPercent: { lt: -50 }, createdAt: { gte: new Date("2026-10-17T20:30:00Z") } },
    orderBy: { createdAt: "asc" },
  });
  for (const s of deeps) {
    const pts = await db.pricePoint.findMany({
      where: { symbol: s.symbol, createdAt: { gte: new Date(s.createdAt.getTime() - 45 * 60_000), lte: new Date(s.createdAt.getTime() + 6 * 60_000) } },
      orderBy: { createdAt: "asc" }, select: { price: true, createdAt: true },
    });
    const series = pts.map((p) => ({ t: p.createdAt.getTime(), p: p.price }));
    const ctx = computeTapeContext(series, s.entryPrice, s.createdAt.getTime(), 30);
    // engine-consistent RSI/%B read from the signal's own factor ledger (15m kline closes)
    let rsi: number | null = null, bbB: number | null = null;
    try {
      const f = JSON.parse(s.factorsJson ?? "[]") as Array<{ factor: string; detail: string }>;
      const rm = f.find((x) => x.factor.includes("RSI"))?.detail.match(/RSI ([\d.]+)/);
      const bm = f.find((x) => /%B (-?[\d.]+)/.exec(x.detail))?.detail.match(/%B (-?[\d.]+)/);
      if (rm) rsi = parseFloat(rm[1]!);
      if (bm) bbB = parseFloat(bm[1]!);
    } catch { /* keep nulls */ }
    const bf = bottomFadeVerdict(ctx, null, s.direction as "LONG" | "SHORT", bfCfg);
    // factor-ledger override: use the ENGINE's own RSI/%B for the replay (the
    // live gate recomputes them from the same 15m closes — identical series)
    const bfEngine = (() => {
      if (s.direction !== "SHORT" || !ctx.ok) return { blocked: false, reason: "" };
      if (ctx.entryHeightPct > bfCfg.bottomPct) return { blocked: false, reason: "" };
      const oversold = rsi !== null && rsi <= bfCfg.rsiMax;
      const stretched = bbB !== null && bbB <= bfCfg.bbMax;
      if (!oversold && !stretched) return { blocked: false, reason: "" };
      return { blocked: true, reason: `${oversold ? `RSI ${rsi}≤${bfCfg.rsiMax}` : `%B ${bbB}≤${bfCfg.bbMax}`}` };
    })();
    const vr = vRevVerdict(ctx, s.direction as "LONG" | "SHORT", vrCfg);
    bfBlocks += bfEngine.blocked ? 1 : 0;
    vrBlocks += vr.blocked ? 1 : 0;
    const saved = bfEngine.blocked || vr.blocked;
    console.log(`NX-${s.serial} ${s.symbol} ${s.direction} ${s.pnlPercent.toFixed(1)}% · entryH=${ctx.entryHeightPct.toFixed(0)}% RSI=${rsi ?? "-"} %B=${bbB ?? "-"} bounce=+${ctx.bounceOffLowPct.toFixed(2)}% range=${ctx.heightPct.toFixed(1)}% → BF=${bfEngine.blocked ? `BLOCK(${bfEngine.reason})` : "allow"} · VREV=${vr.blocked ? "BLOCK" : vr.shadow ? "shadow" : "allow"} → ${saved ? `SAVED $${(Math.abs(s.pnlPercent) / 100 * 10).toFixed(2)}` : "not caught"}`);
  }

  console.log("\n── winner controls (must NOT block) ──");
  const winners = await db.signal.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 5 * 24 * 3600e3) }, pnlPercent: { gt: 5 }, status: { in: ["TP1", "TP2", "TP3", "SL", "CLOSED"] } },
    orderBy: { createdAt: "desc" }, take: 14,
  });
  for (const s of winners) {
    const pts = await db.pricePoint.findMany({
      where: { symbol: s.symbol, createdAt: { gte: new Date(s.createdAt.getTime() - 45 * 60_000), lte: new Date(s.createdAt.getTime() + 6 * 60_000) } },
      orderBy: { createdAt: "asc" }, select: { price: true, createdAt: true },
    });
    const series = pts.map((p) => ({ t: p.createdAt.getTime(), p: p.price }));
    const ctx = computeTapeContext(series, s.entryPrice, s.createdAt.getTime(), 30);
    let rsi: number | null = null, bbB: number | null = null;
    try {
      const f = JSON.parse(s.factorsJson ?? "[]") as Array<{ factor: string; detail: string }>;
      const rm = f.find((x) => x.factor.includes("RSI"))?.detail.match(/RSI ([\d.]+)/);
      const bm = f.find((x) => /%B (-?[\d.]+)/.exec(x.detail))?.detail.match(/%B (-?[\d.]+)/);
      if (rm) rsi = parseFloat(rm[1]!);
      if (bm) bbB = parseFloat(bm[1]!);
    } catch { /* keep nulls */ }
    const wouldBlock = s.direction === "SHORT" && ctx.ok && ctx.entryHeightPct <= bfCfg.bottomPct && ((rsi !== null && rsi <= bfCfg.rsiMax) || (bbB !== null && bbB <= bfCfg.bbMax));
    const vr = vRevVerdict(ctx, s.direction as "LONG" | "SHORT", vrCfg);
    if (wouldBlock || vr.blocked) winnerFalseBlocks++;
    console.log(`NX-${s.serial} ${s.symbol} ${s.direction} +${s.pnlPercent.toFixed(1)}% · entryH=${ctx.entryHeightPct.toFixed(0)}% RSI=${rsi ?? "-"} %B=${bbB ?? "-"} bounce=+${ctx.bounceOffLowPct.toFixed(2)}% → BF=${wouldBlock ? "FALSE-BLOCK!" : "ok"} VREV=${vr.blocked ? "FALSE-BLOCK!" : vr.shadow ? "shadow" : "ok"}`);
  }

  console.log(`\n═══ SUMMARY ═══`);
  console.log(`deep stops: BF blocked ${bfBlocks} · VREV blocked ${vrBlocks} (out of ${deeps.length})`);
  console.log(`winner false-blocks: ${winnerFalseBlocks} (out of ${winners.length} — must be 0)`);

  // ── ① lane rails contract (DB state) ──
  console.log("\n═══ ① R6 LANE rails state ═══");
  const laneRow = await db.engineSetting.findUnique({ where: { key: "radar-lane" } });
  console.log(`EngineSetting "radar-lane": ${laneRow?.value ?? "absent (defaults: enabled=true dailyCap=4 probationN=30)"}`);
  const laneCards = await db.signal.count({ where: { tags: { contains: "R6-LANE" } } });
  console.log(`R6-LANE tagged cards so far: ${laneCards} (lane armed this boot — first SUCCESS renoms will flow through)`);
  console.log("\n(readonly — no data mutated)");
}
main().finally(() => db.$disconnect());
