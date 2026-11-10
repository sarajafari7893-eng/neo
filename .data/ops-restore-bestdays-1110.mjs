// SENTINEL-20261110-RESTORE-BESTDAYS — operator order trace 1a1c76eb7b64d83d
// «وضعیت سیستم را ممیزی بررسی کن، دلیل افت شدید حساب و عملکرد ردیابی سیستم چیست؟
//  ایا بهتر نیست تمام هسته موتور و فیلتر ها را به بهترین روزهای عملکرد بازگردانیم؟»
// VERDICT (audit ops-audit-1110): the engine CORE is unchanged since the best
// days (FLAT-10 freeze intact) — what bled the account is CONFIG: the 11-06
// gate-opening (right for the drought, wrong for the tape) re-admitted
// proven-negative cohorts at 5-10x volume. Targeted restoration, no rollback:
//   1. gate.regimeGuard 0 → 1  — REGIME chop veto back ON (best-days config;
//      the 11-06 open removed the #1 protective veto and REGIME-CHOP tags now
//      dominate the top-losers board)
//   2. strat-pause AI-SCALP + MEAN-REVERT re-pause (evidence: AI-SCALP all-time
//      −$66.80 net · WR 13.6% · n=492; MEAN-REVERT −$46.06 · WR 18.9% · n=609;
//      BREAKOUT +$59.94 and AI-SWING ≈breakeven stay OPEN)
// NOT touched: minScore 12 (pinned), decisive/vol/short/chase/dislocation knobs
// (0 = open), MEMORY 48h self-re-arm, anti-sil 10-min cadence, open-cap 8.
import { Database } from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db");
db.exec("PRAGMA busy_timeout=4000");
const now = new Date().toISOString();

// ── 1) gate.regimeGuard → 1 (merge, never clobber other knobs)
const gRow = db.query('SELECT value FROM EngineSetting WHERE key = ?').get("gate");
if (!gRow) throw new Error("gate row missing — aborting");
const gate = JSON.parse(gRow.value);
const beforeRegime = gate.regimeGuard;
gate.regimeGuard = 1;
db.query('UPDATE EngineSetting SET value = ? WHERE key = ?').run(JSON.stringify(gate), "gate");
console.log(`gate.regimeGuard: ${beforeRegime} → 1  (REGIME chop veto RESTORED — best-days config)`);

// ── 2) strat-pause re-pause the proven-negative cohorts
const spRow = db.query('SELECT value FROM EngineSetting WHERE key = ?').get("strat-pause.state");
if (!spRow) throw new Error("strat-pause row missing — aborting");
const sp = JSON.parse(spRow.value);
const PAUSE_NOTE = "PAUSED per performance mandate 2026-11-10 (trace 1a1c76eb7b64d83d «دلیل افت شدید حساب …؟»): ops-audit-1110 all-time settled ledger — AI-SCALP −$66.80 net · WR 13.6% · n=492; MEAN-REVERT −$46.06 · WR 18.9% · n=609. The 11-06 reopen (drought order) re-admitted negative-expectancy cohorts at 5-10x volume. Reversal = setStrategyPause(enabled:false) or one EngineSetting edit.";
for (const strat of ["AI-SCALP", "MEAN-REVERT"]) {
  const cur = sp.pauses?.[strat];
  sp.pauses[strat] = {
    enabled: true,
    reason: PAUSE_NOTE.slice(0, 300),
    by: "SENTINEL (performance mandate 2026-11-10)",
    since: now,
    evidence: `ops-audit-1110: ${strat} netRaw=${strat === "AI-SCALP" ? "-66.80" : "-46.06"} WR=${strat === "AI-SCALP" ? "13.6%" : "18.9%"} n=${strat === "AI-SCALP" ? "492" : "609"} (all-time settled clean); prior 11-06 reopen preserved: ${(cur?.evidence ?? "n/a").slice(0, 160)}`.slice(0, 300),
  };
  console.log(`strat-pause: ${strat} enabled → true (evidence recorded)`);
}
sp.lastChangedAt = now;
sp.lastChangedBy = "SENTINEL (performance mandate 2026-11-10)";
db.query('UPDATE EngineSetting SET value = ? WHERE key = ?').run(JSON.stringify(sp), "strat-pause.state");

// ── verify readback
const g2 = JSON.parse(db.query('SELECT value FROM EngineSetting WHERE key = ?').get("gate").value);
const s2 = JSON.parse(db.query('SELECT value FROM EngineSetting WHERE key = ?').get("strat-pause.state").value);
console.log("VERIFY regimeGuard =", g2.regimeGuard);
console.log("VERIFY pauses:", Object.entries(s2.pauses).map(([k, v]) => `${k}=${v.enabled}`).join(" · "));
db.close();
console.log("DONE " + now);
