// REARM-BRAKE replay audit — readonly (SENTINEL-20261020, operator mandate
// «تمام توصیه‌های P1/P2 و مأموریت بعدی پیشنهادی را قابل راستی‌آزمایی کامل و
// مهندسی شده اجرا کن»).
// Acceptance criterion (approved): صفر ورود تکراری هم‌جهت پس از استاپ.
// This script replays the ledger and measures:
//   1. the historical relay leak: same symbol+direction deploys that were
//      created <360m after a net-negative SL close on that symbol+direction,
//      split by (a) would-have-been-auto-blocked (lockout window) vs
//      (b) capture/forced bypass cohort (RAW-CAL tag);
//   2. the $ the brake would have saved (settled PnL of those relay entries);
//   3. post-deploy acceptance: relay deploys created AFTER the brake went live
//      (gate-journal REARM-BRAKE blocks + zero new relay rows).
import {Database} from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db", {readonly: true});
db.exec("PRAGMA busy_timeout=2500");
const NOW = Math.floor(Date.now()/1000);
const WINDOW_MS = 360 * 60_000; // 6h — approved stopCooldownMin

type Row = { id: string; symbol: string; direction: string; createdAt: number; closedAt: number | null; status: string; pnlPercent: number; marginUsd: number; tags: string | null };

const relays: Array<{gapMin: number; sym: string; dir: string; id: string; bypass: boolean; usd: number | null; status: string}> = [];
let checked = 0;

const sigs = db.query(
  `SELECT id, symbol, direction, createdAt, closedAt, status, pnlPercent, marginUsd, tags
   FROM Signal WHERE createdAt > (${NOW} - 86400*14)*1000
   AND direction IN ('LONG','SHORT') ORDER BY createdAt`).all() as unknown as Row[];

// index settled same-direction stops per symbol+dir
const stops = new Map<string, number[]>(); // key sym|dir → sorted closedAt[] (net-negative SL)
for (const s of sigs) {
  if (s.status === "SL" && s.pnlPercent < 0 && s.closedAt) {
    const k = `${s.symbol}|${s.direction}`;
    const arr = stops.get(k) ?? [];
    arr.push(s.closedAt);
    stops.set(k, arr);
  }
}
for (const s of sigs) {
  const k = `${s.symbol}|${s.direction}`;
  const arr = stops.get(k);
  if (!arr) continue;
  checked++;
  // find most recent stop strictly before this deploy's createdAt
  let last: number | null = null;
  for (const c of arr) { if (c < s.createdAt) last = c; else break; }
  if (last === null) continue;
  const gapMin = (s.createdAt - last) / 60_000;
  if (gapMin < WINDOW_MS / 60_000) {
    const bypass = !!(s.tags && s.tags.includes("RAW-CAL"));
    const settled = s.closedAt !== null;
    relays.push({ gapMin, sym: s.symbol, dir: s.direction, id: s.id.slice(-6), bypass, status: s.status, usd: settled ? +(s.pnlPercent * s.marginUsd / 100).toFixed(2) : null });
  }
}

console.log(`=== REARM-BRAKE REPLAY (14d ledger, ${checked} deploys checked, cooldown ${WINDOW_MS/60000}m same-direction) ===`);
console.log(`relay deploys found: ${relays.length}`);
const bypassed = relays.filter(r => r.bypass);
const autoWouldBlock = relays.filter(r => !r.bypass);
const sum = (xs: typeof relays) => xs.reduce((a, r) => a + (r.usd ?? 0), 0).toFixed(2);
console.log(`  via bypass (RAW-CAL capture / forced): ${bypassed.length} deploys, settled $ = ${sum(bypassed)}`);
console.log(`  race-gap (auto-path, stop visible late): ${autoWouldBlock.length} deploys, settled $ = ${sum(autoWouldBlock)}`);
console.log(`  TOTAL brake-savable $ = ${sum(relays)} (of which still-open: ${relays.filter(r=>r.usd===null).length})`);
console.log(`\n=== relay detail (worst 14 by gap) ===`);
for (const r of [...relays].sort((a,b)=>a.gapMin-b.gapMin).slice(0,14))
  console.log(`  ${r.sym} ${r.dir} gap=${r.gapMin.toFixed(1)}m ${r.bypass ? "BYPASS(RAW-CAL)" : "race-gap   "} ${r.status} ${r.usd ?? "open"}$ [${r.id}]`);

// post-deploy acceptance check: brake went live at worklog commit time — flag any relay AFTER it
const BRAKE_LIVE_AT = Number(process.env.BRAKE_LIVE_AT_MS ?? 0);
if (BRAKE_LIVE_AT > 0) {
  const post = relays.filter(r => { const row = sigs.find(s => s.id.slice(-6) === r.id); return row && row.createdAt > BRAKE_LIVE_AT; });
  console.log(`\n=== POST-BRAKE acceptance: relay deploys created after brake went live: ${post.length} (target 0) ===`);
  for (const r of post) console.log(`  VIOLATION: ${r.sym} ${r.dir} gap=${r.gapMin.toFixed(1)}m [${r.id}]`);
}
const blocks = db.query(`SELECT COUNT(*) n FROM SignalEvent WHERE type='ENGINE' AND message LIKE '%REARM-BRAKE BLOCK%'`).get() as {n: number};
console.log(`REARM-BRAKE block events journaled so far: ${blocks.n}`);
db.close();
