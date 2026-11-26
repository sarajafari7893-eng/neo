// SENTINEL-20261124-DATA-HISTORY — StableFlowEvent gap backfill (DefiLlama)
// The outage holes (11-12..11-18, 11-20, 11-22) left the stablecoin liquidity
// time-series with missing DAYS. DefiLlama's free chart API holds the full
// history, so the gaps are honestly reconstructable as source=BACKFILL daily
// SNAPSHOT rows — ONLY for (asset, day) pairs that have NO row at all.
// Hourly stream data from the outage windows does NOT exist anywhere —
// fabricating it would be dishonest; daily grid is what the source supports.
import { Database } from "bun:sqlite";

const LLAMA = "https://stablecoins.llama.fi";
const db = new Database("db/custom.db");

const MONTH_START = Date.UTC(2026, 10, 1);   // 2026-11-01
const WINDOW_END  = Date.UTC(2026, 10, 25);  // exclusive — up to 11-24 00:00Z
const WANT = ["USDT", "USDC", "DAI", "USDE", "USDS"];

const j = await (await fetch(`${LLAMA}/stablecoins?includePrices=false`, { signal: AbortSignal.timeout(15000) })).json();
const idByKey = new Map();
for (const a of j.peggedAssets ?? []) {
  const s = String(a.symbol ?? "").toUpperCase();
  if (WANT.includes(s) && !idByKey.has(s)) idByKey.set(s, a.id);
}
console.log("asset ids:", [...idByKey.entries()].map(([k, v]) => `${k}=${v}`).join(" "));

async function chart(id) {
  const url = id === "all" ? `${LLAMA}/stablecoincharts/all` : `${LLAMA}/stablecoincharts/all?stablecoin=${id}`;
  const raw = await (await fetch(url, { signal: AbortSignal.timeout(25000) })).json();
  return (Array.isArray(raw) ? raw : [])
    .map((p) => ({ date: Number(p.date) * 1000, usd: Number(p.totalCirculating?.peggedUSD ?? p.peggedUSD ?? NaN) }))
    .filter((p) => Number.isFinite(p.usd) && p.usd > 0)
    .sort((a, b) => a.date - b.date);
}

// (asset, UTC-day) pairs that already have ANY row in the window
const rows = db.query("SELECT asset, ts FROM StableFlowEvent WHERE ts >= ? AND ts < ?", [MONTH_START, WINDOW_END]).all();
const haveDay = new Set(rows.map((r) => `${r.asset}@${Math.floor(Number(r.ts) / 86400000)}`));

let inserted = 0, skipped = 0, missingDays = [];
function backfillAsset(key, series) {
  const pts = series.filter((p) => p.date >= MONTH_START && p.date < WINDOW_END);
  const byDay = new Map();
  for (const p of pts) { const d = Math.floor(p.date / 86400000); if (!byDay.has(d)) byDay.set(d, p); }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < days.length; i++) {
    const [day, p] = days[i];
    const k = `${key}@${day}`;
    if (haveDay.has(k)) { skipped++; continue; }
    missingDays.push(k);
    const prev = i > 0 ? days[i - 1][1] : null;
    const week = series.find((q) => q.date <= p.date - 7 * 86400000 && p.date - q.date < 8 * 86400000) ?? null;
    const d24 = prev ? p.usd - prev.usd : null;
    const d7 = week ? p.usd - week.usd : null;
    let regime = null;
    if (key === "TOTAL" && d7 !== null && week && week.usd > 0) {
      const pct7 = (d7 / week.usd) * 100;
      regime = pct7 >= 0.5 ? "RISK-ON" : pct7 <= -0.5 ? "RISK-OFF" : "NEUTRAL";
    }
    const id = `bf${p.date.toString(36)}${key.toLowerCase().slice(0, 5)}`;
    db.run(
      `INSERT INTO StableFlowEvent (id, ts, source, kind, asset, mcapUsd, delta1hUsd, delta24hUsd, delta7dUsd, pegDevPct, regime, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, day * 86400000, "BACKFILL", "SNAPSHOT", key, p.usd, null, d24, d7, null, regime,
       "SENTINEL-20261124-DATA-HISTORY: outage-window backfill from DefiLlama daily chart (hourly stream did not exist during downtime — honest daily grid only)"]
    );
    inserted++;
  }
}

const totalSeries = await chart("all");
backfillAsset("TOTAL", totalSeries);
for (const [key, id] of idByKey) {
  try {
    backfillAsset(key, await chart(id));
    await new Promise((r) => setTimeout(r, 1500));
  } catch (e) { console.log(`chart fail ${key}:`, String(e).slice(0, 100)); }
}

console.log("inserted BACKFILL rows:", inserted);
console.log("skipped (day already covered):", skipped);
console.log("filled days per asset:", JSON.stringify(missingDays));

const cnt = db.query("SELECT COUNT(*) c FROM StableFlowEvent WHERE source='BACKFILL' AND ts>=? AND ts<?", [MONTH_START, WINDOW_END]).get();
console.log("BACKFILL rows in window:", cnt.c);
const cov = db.query(
  `SELECT date(ts/1000,'unixepoch') d,
          SUM(CASE WHEN asset='TOTAL' THEN 1 ELSE 0 END) total,
          SUM(CASE WHEN asset='USDT' THEN 1 ELSE 0 END) usdt,
          SUM(CASE WHEN asset='USDC' THEN 1 ELSE 0 END) usdc
   FROM StableFlowEvent WHERE ts >= ? AND ts < ? GROUP BY d ORDER BY d`,
  [MONTH_START, WINDOW_END]).all();
console.log("--- post-backfill daily coverage (TOTAL / USDT / USDC) ---");
for (const r of cov) console.log(`  ${r.d}: TOTAL=${r.total} USDT=${r.usdt} USDC=${r.usdc}`);
db.close();
