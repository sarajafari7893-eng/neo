/**
 * VOL-ONSET research scanner (rebuilt 2026-09-07 after sandbox rollback).
 * Detects eruption bars (15m |ret| ≥ 5× trailing-24h median) across the
 * futures universe and prints the onset board with forward drift.
 * Keep constants in sync with src/lib/volOnset.ts.
 * Run: bun scripts/vol-onset-detect.ts [topN=24]
 */
const ERUPTION_MULT = 5;
const TRAILING_BARS = 96;
const MIN_BARS = 110;
const FAPI = "https://fapi.binance.com";

interface Candle { openTime: number; open: number; high: number; low: number; close: number; volume: number }

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function klines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const res = await fetch(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`${symbol} HTTP ${res.status}`);
  const raw = (await res.json()) as (string | number)[][];
  return raw.map((k) => ({ openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
}

function detect(bars: Candle[], now = Date.now()) {
  if (bars.length < MIN_BARS) return null;
  const window = bars.slice(-TRAILING_BARS);
  if (window.length < TRAILING_BARS) return null;
  const absRets = window.map((b, i) => (i === 0 ? 0 : Math.abs((b.close - window[i - 1]!.close) / window[i - 1]!.close) * 100));
  const med = median(absRets.slice(1));
  if (!(med > 0)) return null;
  let idx = -1;
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!, b = window[i]!;
    if (Math.abs(((b.close - prev.close) / prev.close) * 100) >= ERUPTION_MULT * med) { idx = i; break; }
  }
  if (idx < 0) return null;
  const erupt = window[idx]!, prevClose = window[idx - 1]!.close, last = window[window.length - 1]!;
  const eruptRetPct = ((erupt.close - prevClose) / prevClose) * 100;
  const direction = eruptRetPct >= 0 ? 1 : -1;
  const minutesSince = Math.round((now - erupt.openTime) / 60_000);
  const displacementX = Math.abs(eruptRetPct) / med;
  const followThroughPct = (((last.close - erupt.close) / erupt.close) * 100) * direction;
  return { eruptRetPct, direction, minutesSince, displacementX, followThroughPct, med };
}

async function main() {
  const topN = Number(process.argv[2] ?? 24);
  const exc = await fetch(`${FAPI}/fapi/v1/ticker/24hr`).then((r) => r.json()) as Array<{ symbol: string; quoteVolume: string; priceChangePercent: string }>;
  const universe = exc
    .filter((t) => t.symbol.endsWith("USDT") && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, topN);
  console.log(`VOL-ONSET research scan — top ${universe.length} futures by volume · eruption = 15m |ret| ≥ ${ERUPTION_MULT}× trailing-${TRAILING_BARS}b median\n`);
  const rows: Array<{ sym: string; dir: string; age: string; x: string; ft: string; board24h: string }> = [];
  for (const t of universe) {
    try {
      const bars = await klines(t.symbol, "15m", 220);
      const c = detect(bars);
      if (!c) continue;
      const hot = c.minutesSince <= 90 && c.displacementX >= ERUPTION_MULT && (c.followThroughPct >= 0 || Math.abs(c.followThroughPct) < 0.5);
      rows.push({
        sym: t.symbol,
        dir: c.direction === 1 ? "UP" : "DOWN",
        age: c.minutesSince >= 60 ? `${(c.minutesSince / 60).toFixed(1)}h` : `${c.minutesSince}m`,
        x: `×${c.displacementX.toFixed(1)}`,
        ft: `${c.followThroughPct >= 0 ? "+" : ""}${c.followThroughPct.toFixed(1)}%`,
        board24h: `${Number(t.priceChangePercent) >= 0 ? "+" : ""}${Number(t.priceChangePercent).toFixed(1)}%`,
        ...(hot ? {} : {}),
      });
      console.log(`${hot ? "🔥 HOT " : "      "}${t.symbol.padEnd(12)} ${c.direction === 1 ? "▲" : "▼"} ×${c.displacementX.toFixed(1).padStart(5)} ${c.minutesSince >= 60 ? (c.minutesSince / 60).toFixed(1) + "h" : c.minutesSince + "m"} ago · FT ${c.followThroughPct >= 0 ? "+" : ""}${c.followThroughPct.toFixed(1)}% · |Δ24h| ${rows[rows.length - 1]!.board24h}`);
    } catch {
      /* skip symbol */
    }
  }
  if (rows.length === 0) console.log("QUIET TAPE — no eruption bars in the trailing 24h window.");
  process.exit(0);
}

void main();
export {};
