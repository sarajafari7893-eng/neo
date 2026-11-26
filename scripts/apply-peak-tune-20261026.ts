// ── PEAK-TUNE one-off: gate.tp1RMult 0.55 → 1.0 (legacy = 14-18 peak geometry) ──
// Operator order (trace 1a175136420be5b5): «سیستم رو به اوج ۱۴-۱۸ تنظیم کن»
//
// LEDGER PROOF (readonly bun:sqlite, scripts run 2026-10-26):
//   · PEAK era (v11.6-11.8, 10/14→10/18): 60/60 sampled AI-SWING rows carry
//     "targets 1R/…" — legacy TP1 at 1R. tp1RMult did not exist before v12.6.
//   · v12.6 deployed 2026-10-20/21 ("operator mandate 2026-10-20" per
//     gate-settings.ts) — AFTER the peak ended — moving TP1 to 0.55R.
//   · v12.7 era (10/21-22): 34/34 rows "targets 0.55R"; v13.1 era (10/25-26):
//     17/17 rows "targets 0.55R".
//   · avgWin collapsed 17.7% (peak) → 7.2% (v13.1) while avgLoss stayed
//     ≈−17..−19% — the first tranche (50% of book per LADDER_TRANCHES) banks at
//     0.55R instead of 1R; MFE-harvest fell 22% (peak) → 2% (P1-a shadow study:
//     a HIGHER first rung ≈ +$159 on the 15-day window, ×2.0).
//   · ALL other exit layers are IDENTICAL peak vs now (verified from ledger
//     analysis text): BE-BANK 25% @ 0.5×SLdist/+1.5%px, early-exit R7
//     50%TTL@0.45R, gov-scale ×0.85, slAtrMult 2×ATR (governor already
//     restored 2 on 10/25 21:11). tp1RMult is the ONLY drifted geometry knob.
// Applied via putGateSettings (clamped [0.3..1], partial-merge, cache-refresh
// ≤15s) — NO code-path change, NO restart, FLAT-10 untouched (this knob lives
// on the TP/SL distance layer, never inside the margin formula).
// Expected cost (honest): TP1-hit rate drops vs 0.55R — that is the peak
// configuration the operator ordered; evaluate after ≥50 settled signals.
// Run: bun scripts/apply-peak-tune-20261026.ts
import { db } from "@/lib/db";
import { putGateSettings, getGateSettings } from "@/lib/gate-settings";

async function main(): Promise<void> {
  const before = await getGateSettings();
  console.log("before: tp1RMult =", before.tp1RMult, "| slAtrMult =", before.slAtrMult, "| beArmRMult =", before.beArmRMult, "| beBankFrac =", before.beBankFrac);

  const next = await putGateSettings({ tp1RMult: 1 });
  console.log("after : tp1RMult =", next.tp1RMult, "(clamp range [0.3..1], 1.0 = legacy peak geometry)");

  const message =
    `PEAK-TUNE v13.2: gate.tp1RMult 0.55 → 1.0 (legacy 1R first rung restored — operator order «سیستم رو به اوج ۱۴-۱۸ تنظیم کن» trace 1a175136420be5b5) — ` +
    `ledger proof: peak 14-18 (v11.6-11.8) ran targets 1R 60/60 sampled rows; TP1-R55 was introduced v12.6 on 2026-10-20 AFTER the peak; ` +
    `v12.7 era 34/34 and v13.1 era 17/17 rows ran 0.55R while avgWin collapsed 17.7%→7.2% and MFE-harvest 22%→2% (P1-a: higher first rung ≈ +$159/window); ` +
    `all other exit layers verified identical to peak (BE-BANK 25%@0.5×SL/+1.5%px, early-exit R7 50%TTL@0.45R, gov-scale ×0.85, SL 2×ATR). ` +
    `DB-knob change via putGateSettings — FLAT-10 untouched, no restart. Evaluate after ≥50 settled signals.`;

  const ev = await db.signalEvent.create({ data: { signalId: null, symbol: null, type: "ENGINE", level: "ai", message } });
  console.log("audit SignalEvent:", ev.id, "(type ENGINE, level ai)");
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("apply-peak-tune-20261026 FAILED:", e);
  process.exitCode = 1;
  try {
    await db.$disconnect();
  } catch {}
});
