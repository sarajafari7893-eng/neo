// ops-audit-1110.mjs — FORENSIC LEDGER AUDIT (read-only) for operator order
// «وضعیت سیستم را ممیزی بررسی کن، دلیل افت شدید حساب و عملکرد ردیابی سیستم چیست؟»
// Tehran-day bucketing, clean-ledger doctrine (qualityFlag rows excluded from headline),
// raw seed-$100 net + basis-$1000 re-denomination, per-strategy / per-cohort / direction splits,
// drawdown curve, top losers, rolling windows, engine-version drift, last-24h activity.
import { Database } from "bun:sqlite";

const db = new Database("db/custom.db", { readonly: true });
const TZ = 3.5 * 3600_000; // Tehran UTC+3:30

// date-type detection (Prisma sqlite DateTime storage defense)
const probe = db.prepare("SELECT typeof(createdAt) t, createdAt v FROM Signal LIMIT 1").get();
function toMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (/^\d+$/.test(String(v))) return Number(v);
  const n = Date.parse(String(v).replace(" ", "T").replace(/\+00:00$/, "Z"));
  return Number.isNaN(n) ? null : n;
}
console.log("dateStorage:", probe?.t, "sample:", probe?.v);

const dayOf = (ms) => Math.floor((ms + TZ) / 86_400_000);
const dayStr = (ms) => new Date(dayOf(ms) * 86_400_000 - TZ).toISOString().slice(0, 10);

const rows = db.prepare(`
  SELECT serial, symbol, direction, strategy, status, reachedTp, pnlPercent, marginUsd,
         feeUsd, swapUsd, tags, qualityFlag, engine, createdAt, closedAt
  FROM Signal WHERE closedAt IS NOT NULL AND status NOT IN ('ACTIVE','VOID')
`).all();

const rawNet = (r) => ((r.pnlPercent ?? 0) / 100) * (r.marginUsd ?? 0) - (r.feeUsd ?? 0) - (r.swapUsd ?? 0);
const basisNet = (r) => { const m = r.marginUsd ?? 0; return m >= 0.1 ? rawNet(r) * (20 / m) : rawNet(r); };
const clean = rows.filter((r) => !r.qualityFlag);
const dirty = rows.filter((r) => !!r.qualityFlag);

const f2 = (x) => Number(x ?? 0).toFixed(2);
const wr = (arr) => (arr.length ? ((arr.filter((r) => r.reachedTp >= 1).length / arr.length) * 100).toFixed(1) + "% (" + arr.filter((r) => r.reachedTp >= 1).length + "/" + arr.length + ")" : "—");

console.log("\n== LEDGER OVERVIEW ==");
console.log("settled rows:", rows.length, "| clean:", clean.length, "| dirty(excluded):", dirty.length);
const st = {};
for (const r of rows) st[r.status] = (st[r.status] ?? 0) + 1;
console.log("by status:", JSON.stringify(st));
const qf = {};
for (const r of dirty) qf[r.qualityFlag] = (qf[r.qualityFlag] ?? 0) + 1;
console.log("qualityFlags:", JSON.stringify(qf));
const active = db.prepare("SELECT COUNT(*) n FROM Signal WHERE status='ACTIVE'").get();
console.log("ACTIVE now:", active.n);

// engine version drift (K4)
console.log("\n== ENGINE VERSIONS (settled, last 6 by recency) ==");
const eng = db.prepare(`
  SELECT engine, COUNT(*) n, MIN(createdAt) a, MAX(createdAt) b FROM Signal
  GROUP BY engine ORDER BY b DESC LIMIT 6`).all();
for (const e of eng) console.log(`${e.engine} | n=${e.n} | ${new Date(toMs(e.b)).toISOString().slice(0, 16)}`);

// daily curve — Tehran days, last 21 days with data + all-time peak/trough
console.log("\n== DAILY CURVE (Tehran days, settled clean; deploy n by createdAt) ==");
const byDay = new Map();
for (const r of clean) {
  const d = dayStr(toMs(r.closedAt));
  if (!byDay.has(d)) byDay.set(d, { n: 0, netR: 0, netB: 0, wins: 0 });
  const o = byDay.get(d); o.n++; o.netR += rawNet(r); o.netB += basisNet(r); if (r.reachedTp >= 1) o.wins++;
}
const days = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
let cum = 0, peak = 100, peakDay = null, trough = 100, troughDay = null;
for (const [d, o] of days) {
  cum += o.netR;
  const eq = 100 + cum;
  if (eq > peak) { peak = eq; peakDay = d; }
  if (eq < trough) { trough = eq; troughDay = d; }
}
console.log("ALL-TIME  equity now:", f2(100 + cum), "| PEAK:", f2(peak), "@" + peakDay, "| TROUGH:", f2(trough), "@" + troughDay, "| drawdown from peak:", f2(100 + cum - peak));
for (const [d, o] of days.slice(-21)) console.log(`${d}  settled=${String(o.n).padStart(3)}  netRaw=${f2(o.netR).padStart(8)}  netBasis=${f2(o.netB).padStart(9)}  WR=${o.n ? ((o.wins / o.n) * 100).toFixed(0) + "%" : "—"}  cumEquity=${f2(100 + days.slice(0, days.findIndex(x => x[0] === d) + 1).reduce((a, [, y]) => a + y.netR, 0))}`);

// week split (Tehran Sat-start)
console.log("\n== WEEK SPLIT (Tehran Sat-start, last 6 weeks) ==");
const wk = new Map();
for (const r of clean) {
  const wi = Math.floor((dayOf(toMs(r.closedAt)) + 2) / 7);
  if (!wk.has(wi)) wk.set(wi, { n: 0, netR: 0, wins: 0 });
  const o = wk.get(wi); o.n++; o.netR += rawNet(r); if (r.reachedTp >= 1) o.wins++;
}
for (const [wi, o] of [...wk.entries()].sort((a, b) => a[0] - b[0]).slice(-6)) {
  const start = new Date((wi * 7 - 2) * 86_400_000 - TZ).toISOString().slice(0, 10);
  console.log(`week ${start}  settled=${String(o.n).padStart(3)}  netRaw=${f2(o.netR).padStart(8)}  WR=${o.n ? ((o.wins / o.n) * 100).toFixed(0) + "%" : "—"}`);
}

// per strategy
console.log("\n== PER STRATEGY (settled clean, ALL TIME) ==");
const strat = new Map();
for (const r of clean) {
  if (!strat.has(r.strategy)) strat.set(r.strategy, []);
  strat.get(r.strategy).push(r);
}
for (const [s, arr] of [...strat.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${s.padEnd(12)} n=${String(arr.length).padStart(4)}  WR(tp-proven)=${wr(arr)}  netRaw=${f2(arr.reduce((a, r) => a + rawNet(r), 0))}`);
}

// tag cohorts — RAW-CAL, FAPI-DEG, radar lineage, neither
console.log("\n== TAG COHORTS (settled clean) ==");
const has = (r, t) => (r.tags ?? "").includes(t);
const cohorts = { "RAW-CAL": [], "FAPI-DEG": [], "PUMP": [], "plain(auto-only)": [] };
for (const r of clean) {
  if (has(r, "FAPI-DEG")) cohorts["FAPI-DEG"].push(r);
  else if (has(r, "RAW-CAL")) cohorts["RAW-CAL"].push(r);
  else if (has(r, "PUMP")) cohorts["PUMP"].push(r);
  else cohorts["plain(auto-only)"].push(r);
}
for (const [c, arr] of Object.entries(cohorts)) {
  if (!arr.length) { console.log(`${c.padEnd(18)} n=0`); continue; }
  console.log(`${c.padEnd(18)} n=${String(arr.length).padStart(4)}  WR=${wr(arr)}  netRaw=${f2(arr.reduce((a, r) => a + rawNet(r), 0))}  avg=${f2(arr.reduce((a, r) => a + rawNet(r), 0) / arr.length)}`);
}

// direction split last 14d
const cut14 = Date.now() - 14 * 86_400_000;
console.log("\n== DIRECTION SPLIT (settled clean, last 14d) ==");
for (const dir of ["LONG", "SHORT"]) {
  const arr = clean.filter((r) => r.direction === dir && toMs(r.closedAt) >= cut14);
  console.log(`${dir.padEnd(6)} n=${String(arr.length).padStart(3)}  WR=${wr(arr)}  netRaw=${f2(arr.reduce((a, r) => a + rawNet(r), 0))}`);
}

// top losers last 10d
console.log("\n== TOP 12 LOSERS (settled clean, last 10d, by netRaw) ==");
const losers = clean.filter((r) => toMs(r.closedAt) >= Date.now() - 10 * 86_400_000)
  .map((r) => ({ ...r, net: rawNet(r) })).sort((a, b) => a.net - b.net).slice(0, 12);
for (const r of losers) console.log(`NX-${String(r.serial).padStart(4, "0")} ${r.symbol.padEnd(12)} ${r.direction.padEnd(5)} ${r.strategy.padEnd(12)} pnl%=${f2(r.pnlPercent).padStart(8)} margin=$${f2(r.marginUsd)} net=$${f2(r.net).padStart(7)} tags=${(r.tags ?? "").slice(0, 48)} closed=${new Date(toMs(r.closedAt)).toISOString().slice(0, 16)}`);

// rolling windows
const sorted = [...clean].sort((a, b) => toMs(a.closedAt) - toMs(b.closedAt));
const lastN = (n) => sorted.slice(-n);
const r20 = lastN(20).reduce((a, r) => a + rawNet(r), 0);
const r50wr = lastN(50).length ? ((lastN(50).filter((r) => r.reachedTp >= 1).length / lastN(50).length) * 100).toFixed(1) : "—";
const r50net = lastN(50).reduce((a, r) => a + rawNet(r), 0);
const basis20 = lastN(20).reduce((a, r) => a + basisNet(r), 0);
console.log("\n== ROLLING WINDOWS (clean) ==");
console.log(`rolling-20: netRaw=${f2(r20)} netBasis=${f2(basis20)} (K1 pause rail = -60 basis)`);
console.log(`rolling-50: netRaw=${f2(r50net)} WR=${r50wr}`);

// fees burden last 14d
const fee14 = clean.filter((r) => toMs(r.closedAt) >= cut14).reduce((a, r) => a + (r.feeUsd ?? 0) + (r.swapUsd ?? 0), 0);
const net14 = clean.filter((r) => toMs(r.closedAt) >= cut14).reduce((a, r) => a + rawNet(r), 0);
console.log(`last-14d: fees+swap=${f2(fee14)}  netRaw=${f2(net14)}`);

// last 24h activity
console.log("\n== LAST 24H ==");
const cut24 = Date.now() - 86_400_000;
const dep24 = db.prepare("SELECT serial, symbol, direction, strategy, status, tags, createdAt FROM Signal WHERE createdAt >= ? ORDER BY serial").all(cut24);
console.log("deployed:", dep24.length);
for (const r of dep24.slice(-15)) console.log(`  NX-${String(r.serial).padStart(4, "0")} ${r.symbol} ${r.direction} ${r.strategy} status=${r.status} tags=${(r.tags ?? "").slice(0, 44)}`);
const set24 = clean.filter((r) => toMs(r.closedAt) >= cut24);
console.log(`settled(24h): n=${set24.length}  netRaw=${f2(set24.reduce((a, r) => a + rawNet(r), 0))}  WR=${wr(set24)}`);

// best days (evidence for the operator's "best days" rollback question)
console.log("\n== BEST 5 DAYS (netRaw) ==");
for (const [d, o] of [...days].sort((a, b) => b[1].netR - a[1].netR).slice(0, 5)) console.log(`${d}  netRaw=${f2(o.netR)}  n=${o.n}`);
console.log("\n== WORST 5 DAYS (netRaw) ==");
for (const [d, o] of [...days].sort((a, b) => a[1].netR - b[1].netR).slice(0, 5)) console.log(`${d}  netRaw=${f2(o.netR)}  n=${o.n}`);

db.close();
console.log("\nAUDIT-1110 DONE");
