/**
 * VOL-ONSET v2 — anchor = FIRST DISPLACEMENT BAR (|15m ret| > 5× trailing median)
 * within last 24h. Measures the pre-eruption state (2h before) and the forward
 * payoff (6h after) to validate it as an EARLY marker of MARKET-MATRIX flare-ups.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

interface Bar { t: number; o: number; h: number; c: number; l: number }

function resample(points: { price: number; createdAt: Date }[], tfMs = 15 * 60_000): Bar[] {
  const bars: Bar[] = [];
  let cur: Bar | null = null;
  for (const p of points) {
    const t = Math.floor(p.createdAt.getTime() / tfMs) * tfMs;
    if (!cur || cur.t !== t) {
      if (cur) bars.push(cur);
      cur = { t, o: p.price, h: p.price, c: p.price, l: p.price };
    } else {
      cur.h = Math.max(cur.h, p.price); cur.l = Math.min(cur.l, p.price); cur.c = p.price;
    }
  }
  if (cur) bars.push(cur);
  return bars;
}

const pct = (v: number, pool: number[]) => pool.length ? (pool.filter((x) => x <= v).length / pool.length) * 100 : 50;

interface Row {
  symbol: string; d24: number; found: boolean;
  eruptRet: number; multX: number; preRangePct: number; preSlope: number;
  fwd6h: number; dir: string; minutesSince: number;
}

async function main() {
  const assets = await db.marketAsset.findMany();
  const pts = await db.pricePoint.findMany({ orderBy: { createdAt: "asc" } });
  const bySymbol = new Map<string, { price: number; createdAt: Date }[]>();
  for (const p of pts) { const a = bySymbol.get(p.symbol) || []; a.push({ price: p.price, createdAt: p.createdAt }); bySymbol.set(p.symbol, a); }

  const ranked = [...assets].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
  const universe = [...ranked.slice(0, 10), ...["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]];

  const rows: Row[] = [];
  for (const a of universe) {
    if (!bySymbol.has(a.symbol)) continue;
    const bars = resample(bySymbol.get(a.symbol)!);
    if (bars.length < 140) continue;
    const win = bars.slice(-96);
    const rets: number[] = [];
    for (let i = 1; i < win.length; i++) rets.push(Math.abs((win[i].c - win[i - 1].c) / win[i - 1].c) * 100);
    const med = [...rets].sort((x, y) => x - y)[Math.floor(rets.length / 2)] || 0.01;

    // first displacement bar (≥5× median) in the last 24h
    let eIdx = -1;
    const off = bars.length - 96;
    for (let i = off + 1; i < bars.length; i++) {
      const r = Math.abs((bars[i].c - bars[i - 1].c) / bars[i - 1].c) * 100;
      if (r >= 5 * med) { eIdx = i; break; }
    }
    const base: Row = { symbol: a.symbol, d24: a.change24h, found: false, eruptRet: 0, multX: 0, preRangePct: 50, preSlope: 0, fwd6h: 0, dir: "—", minutesSince: 0 };
    if (eIdx < 0) { rows.push(base); continue; }

    const eruptRet = ((bars[eIdx].c - bars[eIdx - 1].c) / bars[eIdx - 1].c) * 100;
    // pre-eruption state: 3h rolling range percentile in the 2h before the bar
    const histR: number[] = [];
    for (let i = 12; i < eIdx - 8; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - 11; j <= i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
      histR.push(((hi - lo) / lo) * 100);
    }
    let preHi = -Infinity, preLo = Infinity;
    for (let j = eIdx - 12; j <= eIdx - 1; j++) { if (j < 0) continue; preHi = Math.max(preHi, bars[j].h); preLo = Math.min(preLo, bars[j].l); }
    const preRange = ((preHi - preLo) / preLo) * 100;
    const preSlopeN = 8, preY: number[] = [], preX: number[] = [];
    for (let i = eIdx - preSlopeN; i < eIdx; i++) {
      if (i < 12) continue;
      let hi = -Infinity, lo = Infinity;
      for (let j = i - 11; j <= i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
      preY.push(((hi - lo) / lo) * 100); preX.push(i);
    }
    const mx = preX.reduce((s, v) => s + v, 0) / preX.length, my = preY.reduce((s, v) => s + v, 0) / preY.length;
    let num = 0, den = 0;
    for (let k = 0; k < preX.length; k++) { num += (preX[k] - mx) * (preY[k] - my); den += (preX[k] - mx) ** 2; }
    // forward 6h (24 bars) after eruption bar
    const fwd = bars[Math.min(eIdx + 24, bars.length - 1)];
    const fwd6h = ((fwd.c - bars[eIdx - 1].c) / bars[eIdx - 1].c) * 100;

    rows.push({
      symbol: a.symbol, d24: a.change24h, found: true,
      eruptRet, multX: Math.abs(eruptRet) / med,
      preRangePct: pct(preRange, histR), preSlope: den ? num / den : 0,
      fwd6h, dir: eruptRet >= 0 ? "UP" : "DOWN",
      minutesSince: Math.round((bars[bars.length - 1].t - bars[eIdx].t) / 60000),
    });
  }

  console.log("symbol          Δ24h    eruption     ×med   pre-2h range pct   pre-slope   fwd6h   ago");
  for (const r of rows) {
    if (!r.found) { console.log(`${r.symbol.padEnd(15)} ${(r.d24 >= 0 ? "+" : "") + r.d24.toFixed(1).padStart(5)}%   — no 5× eruption bar in 24h`); continue; }
    console.log(
      `${r.symbol.padEnd(15)} ${(r.d24 >= 0 ? "+" : "") + r.d24.toFixed(1).padStart(5)}%   ` +
      `${r.dir} ${Math.abs(r.eruptRet).toFixed(2).padStart(5)}%  ×${r.multX.toFixed(0).padStart(3)}   ` +
      `${r.preRangePct.toFixed(0).padStart(3)}th pct         ` +
      `${(r.preSlope >= 0 ? "+" : "") + r.preSlope.toFixed(3)}   ` +
      `${(r.fwd6h >= 0 ? "+" : "") + r.fwd6h.toFixed(1).padStart(5)}%  ${r.minutesSince}m`
    );
  }
  const found = rows.filter((r) => r.found);
  const movers = found.filter((r) => Math.abs(r.d24) >= 8);
  const quiet = found.filter((r) => Math.abs(r.d24) < 8);
  const s = (rs: Row[], f: (r: Row) => number) => rs.length ? (rs.reduce((a, r) => a + f(r), 0) / rs.length).toFixed(1) : "—";
  console.log("\n=== VALIDATION ===");
  console.log(`movers  n=${movers.length}  avg eruption ×${s(movers, r => r.multX)}  avg pre-range pct ${s(movers, r => r.preRangePct)}  avg |fwd6h| ${s(movers, r => Math.abs(r.fwd6h))}%  aligned-with-24h-dir: ${movers.filter(r => (r.fwd6h >= 0) === (r.d24 >= 0)).length}/${movers.length}`);
  console.log(`quiet   n=${quiet.length}  avg eruption ×${s(quiet, r => r.multX)}  avg pre-range pct ${s(quiet, r => r.preRangePct)}  avg |fwd6h| ${s(quiet, r => Math.abs(r.fwd6h))}%`);
  await db.$disconnect();
}

main();
