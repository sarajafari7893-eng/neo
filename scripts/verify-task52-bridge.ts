// ── TASK-52 FLOW BRIDGE verification (readonly, persistent) ──
// Operator mandate (trace 1a15557783520919) «کامل و مهندسی اجرا کن».
// Proves every rung of the Task-52 flow bridge LIVE without forcing any fapi
// ban (the Task-50 law — never poke a banned pool): each rung is called
// DIRECTLY, and the ladders are called to show the healthy-path selection.
// No writes anywhere — pure measurement.
//
// Run: bun scripts/verify-task52-bridge.ts

import {
  bridgeKlines,
  bridgeTape,
  bridgeOiHist,
  bybitKlines,
  bybitTape,
  bybitOiHist,
  bybitTickerMap,
  spotMirrorKlines,
  spotMirrorTape,
} from "../src/lib/flow-bridge";

const SYMBOLS = ["BTCUSDT", "1000PEPEUSDT"]; // second: a 1000X perp with NO spot pair
const bps = (a: number, b: number): number => (b > 0 ? Math.round((Math.abs(a - b) / b) * 10_000) : -1);

async function main(): Promise<void> {
  const out: string[] = [];
  let fail = 0;
  const check = (name: string, ok: boolean, detail: string): void => {
    if (!ok) fail++;
    out.push(`${ok ? "PASS" : "FAIL"} · ${name} · ${detail}`);
  };

  console.log(`== TASK-52 FLOW BRIDGE verify @ ${new Date().toISOString()} ==\n`);

  // ── 1. klines: full ladder + each rung ──
  for (const s of SYMBOLS) {
    const ladder = await bridgeKlines(s, "1h", 96);
    check(`klines ladder ${s}`, !!ladder && ladder.rows.length >= 90, ladder ? `${ladder.rows.length} rows, source=${ladder.source}, lastClose=${ladder.rows[ladder.rows.length - 1]?.close}` : "null");
    const spot = await spotMirrorKlines(s, "1h", 96);
    check(`klines SPOT rung ${s}`, s === "1000PEPEUSDT" ? spot === null : !!spot && spot.length >= 90, spot ? `${spot.length} rows, taker9=${spot[spot.length - 1]?.takerBuyBase}` : "null (expected for 1000X — no spot pair)");
    const byb = await bybitKlines(s, "1h", 96);
    check(`klines BYBIT rung ${s}`, !!byb && byb.length >= 90, byb ? `${byb.length} rows (ASC), taker9=${String(byb[byb.length - 1]?.takerBuyBase)} (expected null), lastClose=${byb[byb.length - 1]?.close}` : "null");
    if (ladder && byb) {
      const d = bps(ladder.rows[ladder.rows.length - 1]!.close, byb[byb.length - 1]!.close);
      check(`klines cross-venue coherence ${s}`, d >= 0 && d < 100, `${d}bps ${ladder.source} vs bybit last close`);
    }
  }

  // ── 2. tape: full ladder + each rung ──
  for (const s of SYMBOLS) {
    const ladder = await bridgeTape(s);
    check(`tape ladder ${s}`, !!ladder && ladder.trades.length > 0, ladder ? `${ladder.trades.length} trades, source=${ladder.source}, window=${((Date.now() - ladder.trades[0]!.time) / 1000).toFixed(0)}s` : "null");
    const byb = await bybitTape(s);
    check(`tape BYBIT rung ${s}`, !!byb && byb.length > 0, byb ? `${byb.length} trades, sideSemantics sample: ${byb[0]!.isBuyerMaker ? "makerBuy(aggrSell)" : "aggrBuy"}` : "null");
    const spot = await spotMirrorTape(s);
    check(`tape SPOT rung ${s}`, spot === null || spot.length > 0, spot ? `${spot.length} trades (last resort rung alive)` : "null");
  }

  // ── 3. OI history: full ladder + bybit rung ──
  for (const s of SYMBOLS) {
    const ladder = await bridgeOiHist(s, "15m", 17);
    check(`OI ladder ${s}`, !!ladder && ladder.rows.length >= 10, ladder ? `${ladder.rows.length} rows, source=${ladder.source}, lastOI=${ladder.rows[ladder.rows.length - 1]?.sumOpenInterest}, notional=${String(ladder.rows[ladder.rows.length - 1]?.sumOpenInterestValue)}` : "null");
    const byb = await bybitOiHist(s, "15m", 17);
    check(`OI BYBIT rung ${s}`, !!byb && byb.length >= 10, byb ? `${byb.length} rows (ASC), notional=${String(byb[byb.length - 1]?.sumOpenInterestValue)} (expected null — base-denominated)` : "null");
  }

  // ── 4. batched tickers (funding + mark + OI notional domain-wide) ──
  const tick = await bybitTickerMap();
  const btc = tick.get("BTCUSDT");
  check("bybit tickers batch", tick.size > 100, `${tick.size} linear symbols`);
  check("bybit tickers BTC row", !!btc, btc ? `last=${btc.lastPrice} mark=${String(btc.markPrice)} funding=${String(btc.fundingRate)} oiVal=${String(btc.openInterestValue)}` : "null");

  console.log(out.join("\n"));
  console.log(`\n${fail === 0 ? "ALL RUNGS GREEN" : `${fail} CHECK(S) FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
