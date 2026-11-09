// SENTINEL-20261109-RELAY-REVIVE — operator order trace 1a1c1ecd9694a129
// «وضعیت سیستم و عملکرد را ممیزی بررسی کن ... Shadow veto را به حال veto قرار بده ...
//  کارتهای سیگنال به کانال تلگرام ارسال نمی شود احیا و پایدار کن»
//
// This script restores the OPEN-GATES state (standing operator order 2026-11-06
// «تمام گیتهای ورودی را باز کن») that the AI governor silently reversed:
//   · gate.regimeGuard 0 → was re-hardened to 2 WITHOUT an operator mandate —
//     REGIME then vetoed 496 candidates in 6h; signal issuance stalled 6.2h
//     (last serial NX-3495) and the shadow-veto capture-observe lane starved
//     with it (no deploys → no adjudications → MODEL verdicts 0% / 24h).
//   · gate.regimeGuardPinned = 1 — v13.0 OPERATOR PIN (governor.ts + gate-settings.ts
//     updated in the same change): while pinned, set_regime_guard is SUPPRESSED.
//     Precedent: minScore OPERATOR PIN v8.4.2. Unpin requires an explicit operator mandate.
// NOT touched here: minScore 12 [PINNED], MEMORY probe hysteresis (self-re-arm),
// BOTTOM-FADE protective veto, anti-sil 10-min spacing, maxActive 8 cap, engine.ts
// (FLAT-10 freeze md5 eaf8be0776bdf7597a502a2d77fd8c3e intact).
import { Database } from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db");
db.exec("PRAGMA busy_timeout=4000");

// ── gate.regimeGuard → 0 + regimeGuardPinned → 1 (merge, never clobber other knobs)
const gRow = db.query('SELECT value FROM EngineSetting WHERE key = ?').get("gate");
if (!gRow) throw new Error("gate row missing — aborting");
const gate = JSON.parse(gRow.value);
const before = { regimeGuard: gate.regimeGuard, regimeGuardPinned: gate.regimeGuardPinned ?? "(absent)" };
gate.regimeGuard = 0;
gate.regimeGuardPinned = 1;
db.query('UPDATE EngineSetting SET value = ? WHERE key = ?').run(JSON.stringify(gate), "gate");
const back = JSON.parse(db.query('SELECT value FROM EngineSetting WHERE key = ?').get("gate").value);
console.log(`gate.regimeGuard: ${before.regimeGuard} → ${back.regimeGuard}  (REGIME veto OFF — standing operator order 2026-11-06 restored)`);
console.log(`gate.regimeGuardPinned: ${before.regimeGuardPinned} → ${back.regimeGuardPinned}  (v13.0 OPERATOR PIN — governor set_regime_guard SUPPRESSED)`);
if (back.regimeGuard !== 0 || back.regimeGuardPinned !== 1) throw new Error("write-back mismatch — aborting");
db.close();
console.log("OK — verify via GET /api/settings after boot (clamps now include regimeGuardPinned).");
