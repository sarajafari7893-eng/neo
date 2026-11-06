// SENTINEL-20261106-OPEN-GATES — operator order trace 1a1a66a9881d011
// «بازهم سیگنالی ردیابی و صادر نمی شود ف تمام گیتهای ورودی را باز کن»
// Reiterated trace 1a1b2af7bcc328fd «چرا هیچ ردیابی و سیگنالی تولید نمی شود؟»
// EngineSetting writes (config lane — same lane the dashboard knobs use):
//   1. gate.regimeGuard 1 → 0  (REGIME chop veto OFF — soft penalties only;
//      measured 6,873 REGIME blocks in the last 24h = the #1 deploy-plane killer)
//   2. strat-pause reopen AI-SCALP + MEAN-REVERT (140 STRAT-PAUSE blocks/24h;
//      prior operator pauses preserved in evidence fields, reversible)
// NOT touched (honesty rails / self-healing, disclosed in report):
//   minScore 12 pinned, decisiveFilter 0, decisiveErMin 0, volBarrier 0,
//   shortGuard 0, chaseThrAdj 0, dislocationGate 0 (all already OPEN),
//   MEMORY probe-block (48h cooldown self-re-arms; capture lane bypasses),
//   BOTTOM-FADE (50/24h, protective), anti-sil spacing 10min, open-cap 8.
import { Database } from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db");
db.exec("PRAGMA busy_timeout=4000");
const now = new Date().toISOString();

// ── 1) gate.regimeGuard → 0 (merge, never clobber other knobs)
const gRow = db.query('SELECT value FROM EngineSetting WHERE key = ?').get("gate");
if (!gRow) throw new Error("gate row missing — aborting");
const gate = JSON.parse(gRow.value);
const beforeRegime = gate.regimeGuard;
gate.regimeGuard = 0;
db.query('UPDATE EngineSetting SET value = ? WHERE key = ?').run(JSON.stringify(gate), "gate");
console.log(`gate.regimeGuard: ${beforeRegime} → 0  (REGIME chop veto OFF)`);

// ── 2) strat-pause reopen (keep full evidence trail of the prior pauses)
const spRow = db.query('SELECT value FROM EngineSetting WHERE key = ?').get("strat-pause.state");
if (!spRow) throw new Error("strat-pause row missing — aborting");
const sp = JSON.parse(spRow.value);
const REOPEN_NOTE = "REOPENED per operator order 2026-11-06 «تمام گیتهای ورودی را باز کن» (traces 1a1a66a9881d011 + 1a1b2af7bcc328fd) — newest order supersedes the pause; reversal = setStrategyPause(enabled:true) or one EngineSetting edit";
for (const strat of ["AI-SCALP", "MEAN-REVERT"]) {
  const cur = sp.pauses?.[strat];
  if (cur?.enabled) {
    sp.pauses[strat] = {
      enabled: false,
      reason: REOPEN_NOTE.slice(0, 300),
      by: "SENTINEL (operator order 2026-11-06)",
      since: cur.since, // pause-time preserved
      evidence: `[was-paused ${cur.since} by ${cur.by}] ${(cur.evidence ?? "").slice(0, 200)}`.slice(0, 300),
    };
    console.log(`strat-pause: ${strat} enabled → false (evidence preserved)`);
  } else {
    console.log(`strat-pause: ${strat} was NOT enabled (no-op)`);
  }
}
sp.lastChangedAt = now;
sp.lastChangedBy = "SENTINEL (operator order 2026-11-06)";
db.query('UPDATE EngineSetting SET value = ? WHERE key = ?').run(JSON.stringify(sp), "strat-pause.state");

// ── verify readback
const g2 = JSON.parse(db.query('SELECT value FROM EngineSetting WHERE key = ?').get("gate").value);
const s2 = JSON.parse(db.query('SELECT value FROM EngineSetting WHERE key = ?').get("strat-pause.state").value);
console.log("VERIFY regimeGuard =", g2.regimeGuard);
console.log("VERIFY pauses:", Object.entries(s2.pauses).map(([k, v]) => `${k}=${v.enabled}`).join(" · "));
db.close();
console.log("DONE " + now);
