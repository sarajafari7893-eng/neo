// ── v14.0 FLOW BRIDGE verification (readonly, persistent) ──
// Operator mandates (trace 1a15557783520919 «کامل و مهندسی اجرا کن» + trace
// 1a185042c872b4f9 «ردپای OKX/Bybit در کجا وجود دارد و با بایننس جایگزین شود»).
// Proves every rung of the v14.0 BINANCE-ONLY flow bridge LIVE without forcing
// any fapi ban (the Task-50 law — never poke a banned pool): each rung is
// called DIRECTLY, and the ladders are called to show the healthy-path
// selection. No writes anywhere — pure measurement.
//
// Run: bun scripts/verify-task52-bridge.ts

import {
  bridgeKlines,
  bridgeTape,
  bridgeOiHist,
  futTickerMap,
  futTickerRow,
  spotMirrorKlines,
  spotMirrorTape,
  spot5mMove,
  fapi5mMove,
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

  console.log(`== v14.0 FLOW BRIDGE (BINANCE-ONLY) verify @ ${new Date().toISOString()} ==\n`);

  // ── 1. klines: full ladder + SPOT-MIRROR rung ──
  for (const s of SYMBOLS) {
    const ladder = await bridgeKlines(s, "1h", 96).catch(() => null);
    check(`klines ladder ${s}`, !!ladder && ladder.rows.length >= 90, ladder ? `${ladder.rows.length} rows, source=${ladder.source}, lastClose=${ladder.rows[ladder.rows.length - 1]?.close}` : "null");
    const spot = await spotMirrorKlines(s, "1h", 96).catch(() => null);
    check(`klines SPOT-MIRROR rung ${s}`, s === "1000PEPEUSDT" ? spot === null : !!spot && spot.length >= 90, spot ? `${spot.length} rows, taker9=${spot[spot.length - 1]?.takerBuyBase}` : "null (expected for 1000X — no spot pair)");
    if (ladder && spot && spot.length > 0) {
      const d = bps(ladder.rows[ladder.rows.length - 1]!.close, spot[spot.length - 1]!.close);
      check(`klines cross-plane coherence ${s}`, d >= 0 && d < 100, `${d}bps ${ladder.source} vs SPOT-MIRROR last close`);
    }
  }

  // ── 2. tape: full ladder + SPOT-MIRROR rung ──
  for (const s of SYMBOLS) {
    const ladder = await bridgeTape(s).catch(() => null);
    check(`tape ladder ${s}`, !!ladder && ladder.trades.length > 0, ladder ? `${ladder.trades.length} trades, source=${ladder.source}, window=${((Date.now() - ladder.trades[0]!.time) / 1000).toFixed(0)}s` : "null");
    const spot = await spotMirrorTape(s).catch(() => null);
    check(`tape SPOT-MIRROR rung ${s}`, s === "1000PEPEUSDT" ? spot === null : !!spot && spot.length > 0, spot ? `${spot.length} trades (spot-plane rung alive)` : "null (expected for 1000X)");
  }

  // ── 3. OI history: fapi-only ladder (perp-native) ──
  for (const s of SYMBOLS) {
    const ladder = await bridgeOiHist(s, "15m", 17).catch(() => null);
    check(`OI ladder (fapi-only) ${s}`, !!ladder && ladder.rows.length >= 10, ladder ? `${ladder.rows.length} rows, source=${ladder.source}, lastOI=${ladder.rows[ladder.rows.length - 1]?.sumOpenInterest}, notional=${String(ladder.rows[ladder.rows.length - 1]?.sumOpenInterestValue)}` : "null (honest — perp-native, no spot equivalent)");
  }

  // ── 4. composite ticker board + per-symbol row ──
  const tick = await futTickerMap().catch(() => null);
  check("composite ticker board (fapi merged)", !!tick && tick.size > 100, `${tick?.size ?? 0} symbols, plane=${[...((tick ?? new Map()).values())[0] ? [(tick ?? new Map()).values()][0][0]?.source : "?"]}`);
  for (const s of SYMBOLS) {
    const row = await futTickerRow(s).catch(() => null);
    check(`ticker row ${s}`, !!row && row.lastPrice > 0, row ? `last=${row.lastPrice} mark=${row.markPrice} funding=${row.fundingRate} oi=${row.openInterest} source=${row.source}` : "null");
  }

  // ── 5. second-plane direction cross-checks ──
  for (const s of ["BTCUSDT"]) {
    const sMove = await spot5mMove(s).catch(() => null);
    const fMove = await fapi5mMove(s).catch(() => null);
    check(`spot5mMove ${s}`, sMove !== null, `${sMove?.toFixed(3) ?? "null"}% (SPOT-MIRROR plane)`);
    check(`fapi5mMove ${s}`, fMove !== null, `${fMove?.toFixed(3) ?? "null"}% (gated fapi plane)`);
    if (sMove !== null && fMove !== null) {
      const agree = Math.sign(sMove) === Math.sign(fMove);
      check(`cross-plane direction agreement ${s}`, agree, `spot=${sMove.toFixed(3)}% fapi=${fMove.toFixed(3)}% → ${agree ? "AGREE" : "DIVERGE (clamps conviction)"}`);
    }
  }

  console.log(out.join("\n"));
  console.log(`\n== ${fail === 0 ? "ALL PASS" : `${fail} FAILURES`} ==`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
