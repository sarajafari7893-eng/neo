// ── DATA-QUALITY AUDIT 2026-10-21 (operator: «کیفیت داده ها پایین است و باید
//    ممیزی بررسی شود چطور افزایش یابد») ─────────────────────────────────────
// Measures every data-quality dimension that feeds engine precision:
//   A. ledger (Signal) integrity + outcome completeness
//   B. event accounting (SignalEvent)
//   C. gate journal coverage (votes/bands/sources)
//   D. price tape freshness + venue consensus completeness
//   E. flow scan completeness (per-TF fields null rates)
//   F. infra noise (OOM markers)
// Output: .data/data-quality-report.json + stdout summary
// ─────────────────────────────────────────────────────────────────────────────
import { Database } from "bun:sqlite";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout=2500");
const q = (s: string, ...a: unknown[]) => db.query(s).all(...a) as any[];
const q1 = (s: string, ...a: unknown[]) => db.query(s).get(...a) as any;
const R: any = { at: new Date().toISOString(), tehran: new Date(Date.now() + 3.5 * 3600e3).toLocaleString("fa-IR") };

// ── A. ledger ────────────────────────────────────────────────────────────────
R.ledger = {
  byStatus: q(`SELECT status, COUNT(*) n FROM Signal GROUP BY status ORDER BY n DESC`),
  byQualityFlag: q(`SELECT COALESCE(qualityFlag,'CLEAN') f, COUNT(*) n FROM Signal GROUP BY f ORDER BY n DESC`),
  byStrategy: q(`SELECT strategy, COUNT(*) n, ROUND(AVG(pnlPercent),2) avgPnl, SUM(CASE WHEN reachedTp>0 THEN 1 ELSE 0 END) tpProven FROM Signal GROUP BY strategy ORDER BY n DESC`),
  outcomeCompleteness: q1(`SELECT COUNT(*) total,
      SUM(CASE WHEN closedAt IS NULL AND status NOT IN ('ACTIVE') THEN 1 ELSE 0 END) closedMissing,
      SUM(CASE WHEN factorsJson IS NULL OR factorsJson='' THEN 1 ELSE 0 END) noFactors,
      SUM(CASE WHEN flowJson IS NULL OR flowJson='' THEN 1 ELSE 0 END) noFlow,
      SUM(CASE WHEN mtfJson IS NULL OR mtfJson='' THEN 1 ELSE 0 END) noMtf FROM Signal`),
  afterlifeState: q(`SELECT COALESCE(afterlife,'N/A') a, COUNT(*) n FROM Signal WHERE status IN ('EXPIRED','SL') GROUP BY a ORDER BY n DESC`),
  recent30d: q1(`SELECT COUNT(*) n, SUM(CASE WHEN reachedTp>0 THEN 1 ELSE 0 END) wins, ROUND(AVG(pnlPercent),2) avgPnl, ROUND(SUM(pnlPercent),2) netPnl FROM Signal WHERE createdAt > datetime('now','-30 days') AND (qualityFlag IS NULL OR qualityFlag='')`),
  perDay30: q(`SELECT date(createdAt) d, COUNT(*) n, SUM(CASE WHEN reachedTp>0 THEN 1 ELSE 0 END) wins FROM Signal WHERE createdAt > datetime('now','-30 days') GROUP BY d ORDER BY d DESC LIMIT 30`),
};

// ── B. events ────────────────────────────────────────────────────────────────
R.events = {
  byType: q(`SELECT type, COUNT(*) n FROM SignalEvent GROUP BY type ORDER BY n DESC LIMIT 12`),
  lastHour: q1(`SELECT COUNT(*) n FROM SignalEvent WHERE createdAt > datetime('now','-1 hour')`),
  lastEventAgeMs: (Date.now() - new Date(q1(`SELECT MAX(createdAt) m FROM SignalEvent`).m).getTime()),
};

// ── C. gate journal ─────────────────────────────────────────────────────────
function readJsonl(p: string, maxBytes = 40_000_000): any[] {
  try {
    if (!existsSync(p)) return [];
    const txt = readFileSync(p, "utf8");
    return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const gj = readJsonl("/home/z/my-project/.data/gate-journal.jsonl");
const samples = gj.filter((r) => r.k === "s");
const blocks = gj.filter((r) => r.k === "b");
const days: Record<string, number> = {};
for (const s of samples) { const d = new Date(s.v?.at || s.at || Date.now()).toISOString().slice(0, 10); days[d] = (days[d] || 0) + 1; }
R.gateJournal = {
  samplesTotal: samples.length, blocksTotal: blocks.length,
  perDay: Object.entries(days).sort().slice(-10).map(([d, n]) => ({ d, n })),
  bandDist: samples.reduce((m, s) => { const b = s.v?.band || "?"; m[b] = (m[b] || 0) + 1; return m; }, {} as any),
  sourceDist: samples.reduce((m, s) => { const b = s.v?.source || "engine"; m[b] = (m[b] || 0) + 1; return m; }, {} as any),
  voteCoverage: (() => {
    let confirms = 0, opposes = 0;
    for (const s of samples) { confirms += (s.v?.confirms || []).length; opposes += (s.v?.opposes || []).length; }
    return { avgConfirms: samples.length ? +(confirms / samples.length).toFixed(2) : 0, avgOpposes: samples.length ? +(opposes / samples.length).toFixed(2) : 0 };
  })(),
  factorFrequency: (() => {
    const f: Record<string, number> = {};
    for (const s of samples) for (const c of s.v?.confirms || []) f[c.factor] = (f[c.factor] || 0) + 1;
    for (const s of samples) for (const c of s.v?.opposes || []) f[c.factor] = (f[c.factor] || 0) + 1;
    return Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([factor, n]) => ({ factor, n }));
  })(),
};

// ── D. price tape + venue consensus ─────────────────────────────────────────
R.priceTape = {
  total: q1(`SELECT COUNT(*) n FROM PricePoint`).n,
  perSymbolTop: q(`SELECT symbol, COUNT(*) n, MAX(createdAt) last FROM PricePoint GROUP BY symbol ORDER BY n DESC LIMIT 5`),
  perSymbolBottom: q(`SELECT symbol, COUNT(*) n, MAX(createdAt) last FROM PricePoint GROUP BY symbol ORDER BY n ASC LIMIT 5`),
  staleAssets: q(`SELECT symbol, MAX(createdAt) last FROM PricePoint GROUP BY symbol HAVING MAX(createdAt) < datetime('now','-10 minutes') LIMIT 10`),
  lastPointAgeMs: (Date.now() - new Date(q1(`SELECT MAX(createdAt) m FROM PricePoint`).m).getTime()),
};
R.venueConsensus = (() => {
  const rows = q(`SELECT symbol, exchanges, maxDevBps, price, prevPrice FROM MarketAsset`);
  let noExchanges = 0, venueCounts: Record<number, number> = {}, devHigh = 0, zeroMove = 0;
  for (const r of rows) {
    let ex: any[] = [];
    try { ex = r.exchanges ? JSON.parse(r.exchanges) : []; } catch {}
    venueCounts[ex.length] = (venueCounts[ex.length] || 0) + 1;
    if (!ex.length) noExchanges++;
    if (r.maxDevBps > 150) devHigh++;
    if (r.price === r.prevPrice) zeroMove++;
  }
  return { assets: rows.length, noExchanges, venueCounts, devHighBps150: devHigh, frozenPrice: zeroMove };
})();

// ── E. flow scan completeness ────────────────────────────────────────────────
R.flowScan = {
  byTf: q(`SELECT tf, COUNT(*) n, SUM(CASE WHEN cvdPct IS NULL THEN 1 ELSE 0 END) cvdNull, SUM(CASE WHEN volZ IS NULL THEN 1 ELSE 0 END) volzNull, MAX(updatedAt) last FROM FlowScan GROUP BY tf`),
  symbols: q1(`SELECT COUNT(DISTINCT symbol) n FROM FlowScan`).n,
};

// ── F. infra noise ───────────────────────────────────────────────────────────
try {
  const log = readFileSync("/home/z/my-project/dev.log", "utf8").slice(-400_000);
  R.infra = { oomMarkers: (log.match(/Out of memory|OOM|oom-kill/gi) || []).length, errorLines: (log.match(/^.*error.*$/gim) || []).length };
} catch { R.infra = { err: "dev.log unreadable" }; }

writeFileSync("/home/z/my-project/.data/data-quality-report.json", JSON.stringify(R, null, 2));

// stdout summary
const J = R.gateJournal, L = R.ledger, V = R.venueConsensus;
console.log("═".repeat(72));
console.log(`DATA-QUALITY AUDIT ${R.tehran}`);
console.log("═".repeat(72));
console.log(`A. LEDGER: ${JSON.stringify(L.byStatus)}\n   flags: ${JSON.stringify(L.byQualityFlag)}`);
console.log(`   outcome completeness: ${JSON.stringify(L.outcomeCompleteness)}`);
console.log(`   30d(clean): ${JSON.stringify(L.recent30d)}`);
console.log(`B. EVENTS: lastHour=${R.events.lastHour.n} age=${Math.round(R.events.lastEventAgeMs)}ms`);
console.log(`C. GATE-JOURNAL: samples=${J.samplesTotal} blocks=${J.blocksTotal} bands=${JSON.stringify(J.bandDist)} sources=${JSON.stringify(J.sourceDist)}`);
console.log(`   votes: ${JSON.stringify(J.voteCoverage)} | perDay: ${JSON.stringify(J.perDay)}`);
console.log(`D. TAPE: total=${R.priceTape.total} lastAge=${Math.round(R.priceTape.lastPointAgeMs / 1000)}s stale=${R.priceTape.staleAssets.length}`);
console.log(`   venues: ${JSON.stringify(V)} `);
console.log(`E. FLOW: ${JSON.stringify(R.flowScan.byTf)} symbols=${R.flowScan.symbols}`);
console.log(`F. INFRA: ${JSON.stringify(R.infra)}`);
