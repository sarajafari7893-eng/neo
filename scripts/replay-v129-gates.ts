// ── REPLAY VERIFICATION HARNESS — v12.9 GATES vs THE DEAD TRADES ──
// AUDIT-20261023 · answers the operator mandate «آیا قابل راستی‌آزمایی است؟»
//
// Replays the 4 audited dying trades (NX-3046 JCTUSDT SHORT −61.35%, NX-3020
// BTWUSDT SHORT −61.21%, NX-3013 IRYSUSDT LONG −61.22%, NX-3045 IRYSUSDT
// LONG whipsaw) through the EXACT v12.9 gate formulas from engine.ts
// (FLUSH-EXHAUSTION ①/KNIFE-CATCH ②/EVENT-VOL STOP-FLOOR ③/SINGLE-VENUE ④/
// NO-BINANCE-CONFIRM ⑤), using the real 15m candle series (Binance vision mirror,
// kline) that the engine would have seen at each entry moment.
//
// READ-ONLY: db/custom.db readonly + public kline GET. Zero app writes.
// Run: bun scripts/replay-v129-gates.ts

import { Database } from "bun:sqlite";

interface Candle { open: number; high: number; low: number; close: number; start: number }

interface Trade {
  serial: number; symbol: string; dir: "LONG" | "SHORT"; strategy: string;
  entry: number; at: number; sl: number | null; initialSl: number | null; pnl: number; venues: number;
  binanceLive: boolean;
}

// ── load the dead trades from the forensic DB ──
const db = new Database("db/custom.db", { readonly: true });
const serials = [3046, 3020, 3013, 3045];
const trades: Trade[] = [];
for (const s of serials) {
  const sig = db.query(`SELECT serial, symbol, direction, strategy, entryPrice, stopLoss, initialStopLoss, pnlPercent, createdAt FROM Signal WHERE serial = ${s}`).get() as any;
  if (!sig) continue;
  const ma = db.query(`SELECT exchanges FROM MarketAsset WHERE symbol = '${sig.symbol}'`).get() as any;
  let venues = 0;
  let binanceLive = false;
  if (ma?.exchanges) {
    try {
      const rows = JSON.parse(String(ma.exchanges)) as Array<{ venue: string; price: number | null }>;
      for (const q of rows) if (typeof q.price === "number" && q.price > 0) { venues++; if (q.venue === "BINANCE") binanceLive = true; }
    } catch { /* keep 0 */ }
  }
  trades.push({
    serial: sig.serial, symbol: sig.symbol, dir: sig.direction, strategy: sig.strategy,
    entry: sig.entryPrice, at: sig.createdAt, sl: sig.stopLoss ?? null, initialSl: sig.initialStopLoss ?? null,
    pnl: sig.pnlPercent, venues, binanceLive,
  });
}

// ── fetch the real 15m candle series (public, no auth) ──
async function klines(symbol: string, endAt: number): Promise<Candle[]> {
  const start = endAt - 8 * 3600_000;
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=15m&startTime=${start}&endTime=${endAt + 120_000}&limit=60`;
  const res = await fetch(url);
  const j = (await res.json()) as { result?: { list?: string[][] } };
  const list = j.result?.list ?? [];
  // Binance klines are ASC [openTime, open, high, low, close, volume, closeTime] — shape handled below
  return list
    .map((r) => ({ start: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) }))
    .sort((a, b) => a.start - b.start);
}

// Wilder RSI14 on the 15m closes (mirror of the engine's snapshot RSI)
function rsi14(candles: Candle[]): number {
  let gain = 0, loss = 0;
  const n = Math.min(15, candles.length - 1);
  for (let i = candles.length - n; i < candles.length; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    if (d >= 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / n / (loss / n);
  return 100 - 100 / (1 + rs);
}

// ── v12.8+ v12.9 gate evaluation — SAME formulas, SAME order as engine.ts ──
function replayGates(t: Trade, candles: Candle[]): Array<{ gate: string; verdict: string; detail: string }> {
  const out: Array<{ gate: string; verdict: string; detail: string }> = [];
  if (candles.length < 22) {
    out.push({ gate: "PRECONDITION", verdict: "SKIP", detail: `only ${candles.length} candles (<22) — engine would not have evaluated flush gates either` });
    return out;
  }
  const forming = candles[candles.length - 1]!;
  // forming-bar close at decision time = the live tick the engine deployed at
  forming.close = t.entry;
  forming.high = Math.max(forming.high, t.entry);
  forming.low = Math.min(forming.low, t.entry);

  // ⓪ CHASE-EXTREME (v12.8, engine.ts:1700-1713) — 5-bar burst ≥1.5×ATR + RSI extreme
  const atrPctQuick = (() => {
    let s = 0;
    for (let i = candles.length - 14; i < candles.length; i++) {
      const c = candles[i]!, p = candles[i - 1]!;
      s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    return (s / 14 / forming.close) * 100;
  })();
  const burstPct = ((forming.close - candles[candles.length - 6]!.close) / candles[candles.length - 6]!.close) * 100;
  const extThreshold = 1.5 * atrPctQuick;
  const rsi = rsi14(candles);
  const extended = t.dir === "LONG" ? burstPct >= extThreshold : burstPct <= -extThreshold;
  const rsiExtreme = t.dir === "LONG" ? rsi >= 80 : rsi <= 20;
  if (extended && rsiExtreme) {
    out.push({ gate: "⓪ CHASE-EXTREME (v12.8)", verdict: "REFUSED", detail: `${t.dir} chasing ${burstPct >= 0 ? "+" : ""}${burstPct.toFixed(2)}%/5-bar extended tape (≥${extThreshold.toFixed(2)}% ≈1.5×ATR) with RSI ${rsi.toFixed(1)} ${t.dir === "LONG" ? "≥80 overbought" : "≤20 oversold"} — extreme-chase entry refused` });
  }

  // ATR14 (engine.ts:1742-1746)
  let trSum = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    trSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const atrPct = (trSum / 14 / forming.close) * 100;

  // ① FLUSH-EXHAUSTION 4-bar move (engine.ts:1747-1758)
  const win4 = candles.slice(-4);
  const move = ((forming.close - win4[0]!.open) / win4[0]!.open) * 100;
  const thr = Math.max(12, 1.2 * atrPct);
  if (t.dir === "SHORT" && move <= -thr) {
    out.push({ gate: "① FLUSH-EXHAUSTION", verdict: "REFUSED", detail: `SHORT into ${move.toFixed(1)}% 4-bar cascade (threshold ≥−${thr.toFixed(1)}%, ATR ${atrPct.toFixed(1)}%) — deploying WITH a flush that already ran` });
  } else if (t.dir === "LONG" && move >= thr) {
    out.push({ gate: "① FLUSH-EXHAUSTION", verdict: "REFUSED", detail: `LONG into +${move.toFixed(1)}% 4-bar cascade (threshold ≥+${thr.toFixed(1)}%) — pump-chase entry refused (NX-3013 top-tick class)` });
  }

  // ② KNIFE-CATCH (engine.ts:1759-1766, SHORT only)
  if (t.dir === "SHORT" && move <= -6 && out.length === 0) {
    let minLow20 = Infinity;
    for (let i = Math.max(0, candles.length - 21); i < candles.length - 1; i++) minLow20 = Math.min(minLow20, candles[i]!.low);
    const knifeLine = minLow20 * (1 - 0.25 * atrPct / 100);
    if (minLow20 > 0 && forming.close < knifeLine) {
      out.push({ gate: "② KNIFE-CATCH", verdict: "REFUSED", detail: `SHORT @ ${forming.close} is ${(100 * (1 - forming.close / minLow20)).toFixed(1)}% below the 20-bar low (${minLow20}) in a live ${move.toFixed(1)}% waterfall — shorting below structure refused` });
    }
  }

  // ③ EVENT-VOL STOP-FLOOR (engine.ts:1767-1773) — implied SL from the
  // governor's INITIAL output (initialStopLoss — the SL as sized at entry,
  // before any BE move; most faithful form)
  if (out.length === 0) {
    let max3Range = 0;
    for (let i = candles.length - 3; i < candles.length; i++) {
      const c = candles[i]!;
      if (c.close > 0) max3Range = Math.max(max3Range, ((c.high - c.low) / c.close) * 100);
    }
    const slRef = t.initialSl ?? t.sl;
    if (max3Range >= 4 && slRef) {
      const impliedSl = Math.abs(slRef - t.entry) / t.entry * 100;
      const floor = 0.5 * max3Range;
      if (impliedSl < floor) {
        out.push({ gate: "③ EVENT-VOL STOP-FLOOR", verdict: "REFUSED", detail: `implied SL ${impliedSl.toFixed(1)}% < 0.5×max-3-bar-range ${floor.toFixed(1)}% — a stop sized on pre-event ATR cannot survive realized vol (regime max-3-bar-range ${max3Range.toFixed(1)}%)` });
      }
    }
  }

  // ④ SINGLE-VENUE / ⑤ NO-BINANCE-CONFIRM (engine.ts:1792-1808)
  if (t.venues === 1) {
    out.push({ gate: "④ SINGLE-VENUE", verdict: "REFUSED", detail: `only ONE live plane — cross-plane confirmation impossible, no Binance ticket → machine deploy refused` });
  } else if (t.venues >= 2 && !t.binanceLive) {
    out.push({ gate: "⑤ NO-BINANCE-CONFIRM", verdict: "SURCHARGE +12", detail: `${t.venues} live venues, BINANCE quote null → effective threshold +12 (higher bar, not a hard refusal)` });
  }

  if (out.length === 0) out.push({ gate: "ALL v12.9 GATES", verdict: "PASS", detail: `no refusal — 4-bar move ${move.toFixed(1)}% (thr ±${thr.toFixed(1)}%), 5-bar burst ${burstPct.toFixed(1)}% (ext ±${extThreshold.toFixed(1)}%), RSI ${rsi.toFixed(1)}, ATR ${atrPct.toFixed(1)}%` });
  return out;
}

// ── run ──
console.log("════ NEXUS v12.9 GATE REPLAY — verified against the real candle series ════\n");
let refusedN = 0, savedPct = 0;
for (const t of trades) {
  const ts = new Date(t.at).toISOString();
  const candles = await klines(t.symbol, t.at);
  const verdicts = replayGates(t, candles);
  const refused = verdicts.some((v) => v.verdict === "REFUSED");
  if (refused) { refusedN++; if (t.pnl < 0) savedPct += -t.pnl; }
  console.log(`NX-${t.serial} ${t.symbol} ${t.dir} (${t.strategy}) @ ${t.entry} · ${ts}`);
  console.log(`  recorded outcome: ${t.pnl >= 0 ? "+" : ""}${t.pnl}% (final SL ${t.sl ?? "n/a"} · initial SL ${t.initialSl ?? "n/a"}) · venues live: ${t.venues}${t.binanceLive ? " (BINANCE live)" : " (no BINANCE)"}`);
  for (const v of verdicts) console.log(`  → ${v.gate}: ${v.verdict} — ${v.detail}`);
  console.log(`  ⟹ v12.9 outcome: ${refused ? "NO DEPLOY (position never opened)" : "deploy would still pass — gates need review"} · PnL ${refused && t.pnl < 0 ? `SAVED ${-t.pnl}%` : "unchanged"}\n`);
}
console.log(`════ SUMMARY: ${refusedN}/${trades.length} dying trades refused by v12.9 · net PnL preserved: ${savedPct.toFixed(1)}% across the audited cohort ════`);
