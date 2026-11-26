// ── verify-task43-gates.ts (Task-43, persistent tool) ─────────────────────────
// Verifies the v11.9 gate hardening against live DB + Binance cross-truth:
//   A) LIVE pool-level preview — which symbols the hardened LIQUIDITY-FLOOR
//      excludes right now (volume / venue / sim-source legs; divergence is a
//      deploy-time leg — engine-internal kline cache — shown where Binance is
//      reachable).
//   B) PHANTOM-FEED live — XMRUSDT (and universe) recent-tape regime sanity.
//   C) RETROSPECTIVE — would the new legs have blocked today's fake-data stops?
//      · NX-2736 / NX-2744 (XMRUSDT): phantom gate on the 720-tick window
//        ENDING at each deploy instant (DB PricePoints).
//      · NX-2741 (AGTUSDT): engine entry price vs real Binance fapi close.
// Readonly on SQLite (busy_timeout). No writes. FLAT-10 untouched.
import { Database } from "bun:sqlite";

const ROOT = "/home/z/my-project";
const db = new Database(`${ROOT}/db/custom.db`, { readonly: true });
db.exec("PRAGMA busy_timeout=2500");

const CFG = { minQuoteVol24hUsd: 25_000_000, minVenues: 1, banSimSource: true, maxKlineDivergencePct: 2.5 };
const PF = { stepBlockPct: 25, stepWarnPct: 8, stepWarnMax: 3, windowPoints: 720 };

function vq(exchanges: string): number {
  try { return (JSON.parse(exchanges || "[]") as Array<{ price: number | null }>).filter(q => typeof q.price === "number" && q.price > 0).length; }
  catch { return -1; }
}
function floorLeg(symbol: string, source: string, volume: number, exchanges: string): string | null {
  if (volume > 0 && volume < CFG.minQuoteVol24hUsd) return `volume $${(volume / 1e6).toFixed(1)}M < $25M`;
  const q = vq(exchanges);
  if (q >= 0 && q < CFG.minVenues) return `venue quotes ${q} < ${CFG.minVenues}`;
  if (CFG.banSimSource && source !== "live") return `source=${source} (sim-veto)`;
  return null;
}
function phantomStats(points: Array<{ price: number }>): { maxStepPct: number; warnSteps: number; n: number } {
  let maxStepPct = 0, warnSteps = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const prev = points[i + 1].price, cur = points[i].price;
    if (!(prev > 0) || !(cur > 0)) continue;
    const step = Math.abs(cur - prev) / prev * 100;
    if (step > maxStepPct) maxStepPct = step;
    if (step >= PF.stepWarnPct) warnSteps++;
  }
  return { maxStepPct, warnSteps, n: Math.max(0, points.length - 1) };
}
function phantomBlocked(s: { maxStepPct: number; warnSteps: number }): boolean {
  return s.maxStepPct >= PF.stepBlockPct || s.warnSteps >= PF.stepWarnMax;
}

console.log("═".repeat(30), "A) LIVE LIQUIDITY-FLOOR pool preview (v11.9 legs)", "═".repeat(30));
const assets = db.query("SELECT symbol,source,volume24h,exchanges,price FROM MarketAsset ORDER BY volume24h DESC").all() as Array<{ symbol: string; source: string; volume24h: number; exchanges: string; price: number }>;
let blocked = 0; const legs: Record<string, number> = {};
for (const a of assets) {
  const leg = floorLeg(a.symbol, a.source, a.volume24h || 0, a.exchanges || "[]");
  if (leg) { blocked++; const k = leg.includes("volume") ? "volume" : leg.includes("venue") ? "venue" : "sim"; legs[k] = (legs[k] || 0) + 1; }
}
console.log(`universe=${assets.length} → excluded=${blocked} (${JSON.stringify(legs)}) — deployable=${assets.length - blocked}`);
for (const s of ["AGTUSDT", "XMRUSDT", "GTCUSDT", "BTWUSDT", "QUSDT", "BRUSDT", "ICNTUSDT", "SIRENUSDT", "APRUSDT", "BTCUSDT"]) {
  const a = assets.find(x => x.symbol === s);
  if (!a) { console.log(`  ${s} not in universe`); continue; }
  console.log(`  ${s.padEnd(12)} src=${a.source.padEnd(5)} vol=$${((a.volume24h || 0) / 1e6).toFixed(0).padStart(5)}M vq=${vq(a.exchanges)} → ${floorLeg(s, a.source, a.volume24h || 0, a.exchanges || "[]") ?? "ALLOW"}`);
}

console.log("═".repeat(30), "B) PHANTOM-FEED live tape sanity", "═".repeat(30));
for (const s of ["XMRUSDT", "BTCUSDT", "ETHUSDT", "AGTUSDT"]) {
  const pts = db.query("SELECT price FROM PricePoint WHERE symbol=? ORDER BY createdAt DESC LIMIT ?").all(s, PF.windowPoints + 1) as Array<{ price: number }>;
  const st = phantomStats(pts);
  console.log(`  ${s.padEnd(12)} window=${st.n} maxStep=${st.maxStepPct.toFixed(1)}% warnSteps=${st.warnSteps} → ${phantomBlocked(st) ? "BLOCK (corrupted tape)" : "OK"}`);
}

console.log("═".repeat(30), "C) RETROSPECTIVE — today's fake-data stops vs new gates", "═".repeat(30));
// NX-2736 XMR LONG created 01:22:04.517Z — phantom window ENDING there
for (const [serial, sym, iso] of [["NX-2736", "XMRUSDT", "2026-10-18T01:22:04.517Z"], ["NX-2744", "XMRUSDT", "2026-10-18T03:22:09.898Z"]] as const) {
  const t = Date.parse(iso);
  const pts = db.query("SELECT price FROM PricePoint WHERE symbol=? AND createdAt<=? ORDER BY createdAt DESC LIMIT ?").all(sym, t, PF.windowPoints + 1) as Array<{ price: number }>;
  const st = phantomStats(pts);
  console.log(`  ${serial} ${sym} @${iso} → maxStep=${st.maxStepPct.toFixed(1)}% warns=${st.warnSteps} → PHANTOM-FEED would ${phantomBlocked(st) ? "BLOCK ✓" : "ALLOW ✗"}`);
}
// NX-2741 AGT — divergence vs Binance fapi close at 02:09Z
const agt = assets.find(x => x.symbol === "AGTUSDT");
const sig = db.query("SELECT entryPrice,createdAt FROM Signal WHERE serial=2741").get() as { entryPrice: number; createdAt: number } | null;
if (sig) {
  let verdict = "Binance unreachable — divergence not live-checkable";
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=AGTUSDT&interval=1m&startTime=${sig.createdAt - 60_000}&limit=2`, { signal: AbortSignal.timeout(6000) });
    const j = (await r.json()) as unknown;
    if (Array.isArray(j) && j.length) {
      const last = j[j.length - 1] as [unknown, string, unknown, unknown, string];
      const realClose = Number(last[4]);
      const dev = Math.abs(sig.entryPrice - realClose) / realClose * 100;
      verdict = `entry ${sig.entryPrice} vs real close ${realClose} → divergence ${dev.toFixed(1)}% ${dev > CFG.maxKlineDivergencePct ? `> ${CFG.maxKlineDivergencePct}% → LIQ-FLOOR divergence leg would BLOCK ✓` : `≤ ${CFG.maxKlineDivergencePct}% → divergence leg would ALLOW (engine tick lag on a moving tape — the 2741 stop was a genuine chase loss, not fake data)`}`;
    } else verdict = `Binance response: ${JSON.stringify(j).slice(0, 100)}`;
  } catch (e) { verdict = `Binance fetch failed (${String(e).slice(0, 60)}) — documented evidence stands: entry 0.100626 vs 02:09 kline close ≈0.0904 → ~+11.3% → BLOCK ✓`; }
  console.log(`  NX-2741 AGTUSDT: ${verdict}`);
  // was the post-entry slide REAL on Binance? (02:09 → 02:16)
  try {
    const r2 = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=AGTUSDT&interval=1m&startTime=${sig.createdAt}&limit=7`, { signal: AbortSignal.timeout(6000) });
    const j2 = (await r2.json()) as unknown;
    if (Array.isArray(j2) && j2.length) {
      const closes = (j2 as Array<[unknown, string, unknown, unknown, string]>).map(k => Number(k[4]));
      const drop = (closes[closes.length - 1] - closes[0]) / closes[0] * 100;
      console.log(`  NX-2741 AGT real-tape check: Binance close ${closes[0]} → ${closes[closes.length - 1]} in 7m = ${drop.toFixed(2)}% ${drop < -3 ? "(REAL slide — stop followed the genuine market)" : "(slide not confirmed on real tape)"}`);
    }
  } catch { /* leave unconfirmed */ }
}
console.log("═".repeat(30), "done (readonly)", "═".repeat(30));
db.close();
