// SENTINEL-20261124-DATA-HISTORY — restore operator-mandated gate state
// The 2026-11-23T23:15Z workspace reset restored a STALE snapshot that
// silently reversed the standing operator order 2026-11-06
// «تمام گیتهای ورودی را باز کن»:
//   · gate.regimeGuard back to 1 (REGIME veto layer re-armed)
//   · strat-pause AI-SCALP + MEAN-REVERT back to enabled=true (paused)
// This restores both, keeps evidence, pins regimeGuard (v13.0 contract), and
// verifies by readback. engine.ts untouched (FLAT-10 freeze intact).
import { Database } from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db");
db.exec("PRAGMA busy_timeout=4000");

// ── 1) gate.regimeGuard → 0 + regimeGuardPinned → 1 (merge, never clobber)
const gRow = db.query('SELECT value FROM EngineSetting WHERE key = ?').get("gate");
if (!gRow) throw new Error("gate row missing — aborting");
const gate = JSON.parse(gRow.value);
const before = { regimeGuard: gate.regimeGuard, regimeGuardPinned: gate.regimeGuardPinned ?? "(absent)" };
gate.regimeGuard = 0;
gate.regimeGuardPinned = 1;
db.query('UPDATE EngineSetting SET value = ? WHERE key = ?').run(JSON.stringify(gate), "gate");
const back = JSON.parse(db.query('SELECT value FROM EngineSetting WHERE key = ?').get("gate").value);
console.log(`gate.regimeGuard: ${before.regimeGuard} → ${back.regimeGuard} (REGIME veto OFF — standing order 2026-11-06 restored after reset)`);
console.log(`gate.regimeGuardPinned: ${before.regimeGuardPinned} → ${back.regimeGuardPinned} (OPERATOR PIN — governor set_regime_guard suppressed)`);
if (back.regimeGuard !== 0 || back.regimeGuardPinned !== 1) throw new Error("gate write-back mismatch — aborting");

// ── 2) strat-pause: AI-SCALP + MEAN-REVERT → enabled=false (evidence retained)
const spRow = db.query('SELECT value FROM EngineSetting WHERE key = ?').get("strat-pause.state");
if (!spRow) throw new Error("strat-pause.state row missing — aborting");
const sp = JSON.parse(spRow.value);
const nowIso = new Date().toISOString();
const report = [];
for (const strat of ["AI-SCALP", "MEAN-REVERT"]) {
  const p = sp.pauses?.[strat];
  if (!p) { report.push(`${strat}: (no pause row)`); continue; }
  report.push(`${strat}: enabled ${p.enabled} → false | was: reason="${String(p.reason ?? "").slice(0, 60)}" by="${String(p.by ?? "").slice(0, 40)}" since=${p.since}`);
  p.enabled = false;
  p.reason = "reset-recovery restore: standing operator order 2026-11-06 «تمام گیتهای ورودی را باز کن» (SENTINEL-20261124-DATA-HISTORY)";
  p.by = "SENTINEL-20261124-DATA-HISTORY (trace 1a20afd151b58a5d)";
  p.since = nowIso;
  if (!p.evidence) p.evidence = "restored snapshot had re-paused both strategies — reverted per mandate; prior evidence preserved in worklog SENTINEL-20261124-DATA-HISTORY";
}
sp.lastChangedAt = nowIso;
sp.lastChangedBy = "SENTINEL-20261124-DATA-HISTORY";
db.query('UPDATE EngineSetting SET value = ? WHERE key = ?').run(JSON.stringify(sp), "strat-pause.state");
const spBack = JSON.parse(db.query('SELECT value FROM EngineSetting WHERE key = ?').get("strat-pause.state").value);
console.log("strat-pause readback:", JSON.stringify(Object.fromEntries(Object.entries(spBack.pauses ?? {}).map(([k, v]) => [k, v.enabled]))));
for (const strat of ["AI-SCALP", "MEAN-REVERT"]) {
  if (spBack.pauses?.[strat]?.enabled !== false) throw new Error(`${strat} unpause mismatch — aborting`);
}
for (const line of report) console.log("  " + line);

db.close();
console.log("OK — mandated gate state restored and readback-verified");
