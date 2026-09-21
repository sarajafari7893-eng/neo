// ── CALIBRATION EPOCH V7 — operator-approved reform package (2026-09-08) ──
// Applies the 4 approved changes that live in DATA (not code):
//   ① breakoutGuard 2→1 — BREAKOUT re-enters CONDITIONALLY: chop still vetoed
//     (regimeGuard L1), non-chop BREAKOUT deploys at HALF size, tagged BO-EXP.
//     Trial window: ≥20 settled with PF>1.2 keeps it; PF≤1.2 → advisor proposes
//     reverting to veto.
//   ⑥ epoch marker — new signals carry EPOCH-V7 (code-side tag); this stores
//     the boundary timestamp so before/after performance slices cleanly WITHOUT
//     wiping the forensic ledger (operator's reset-vs-continue answer: CONTINUE).
// Code-side changes shipped in the same release: v6.6 tranche accounting
// (both ledger bugs), smart TTL, advisor loop + panel + Telegram section.
// Idempotent: re-running only refreshes the marker, never double-flips.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const now = new Date();

  // ① gate: breakoutGuard 2→1
  const row = await db.engineSetting.findUnique({ where: { key: "gate" } });
  const gate = row ? (JSON.parse(row.value) as Record<string, number>) : {};
  const before = gate.breakoutGuard ?? "default(0)";
  if (gate.breakoutGuard !== 1) {
    gate.breakoutGuard = 1;
    await db.engineSetting.upsert({
      where: { key: "gate" },
      create: { key: "gate", value: JSON.stringify(gate) },
      update: { value: JSON.stringify(gate) },
    });
    console.log(`[gate] breakoutGuard ${before} → 1 (CONDITIONAL: chop veto stays, half-size BO-EXP trial armed)`);
  } else {
    console.log("[gate] breakoutGuard already 1 — no change (idempotent)");
  }

  // ⑥ epoch marker
  await db.engineSetting.upsert({
    where: { key: "epoch.v7" },
    create: {
      key: "epoch.v7",
      value: JSON.stringify({
        at: now.toISOString(),
        changes: [
          "breakoutGuard 2→1 (conditional regime trial, BO-EXP cohort, PF>1.2 @ ≥20 settles)",
          "v6.6 tranche accounting: TP3 priced on ORIGINAL risk (Bug A) + TP1/TP2 banked tranches weighted at real exits (Bug B)",
          "smart TTL: AI-SWING near-TP band 8-10%, MFE<0 never extends, re-arm grant (cap 2)",
          "AI advisor loop: 6h evidence cycles → PENDING proposals → operator APPROVE applies",
        ],
        resetDecision: "CONTINUE with existing ledger — epoch tag EPOCH-V7 separates before/after performance",
      }),
    },
    update: { value: JSON.stringify({ at: now.toISOString(), note: "marker refreshed (idempotent re-run)" }) },
  });
  console.log("[epoch] V7 marker stored at", now.toISOString());

  // audit trail (skip if this script already ran — message fingerprint)
  const dup = await db.signalEvent.findFirst({ where: { type: "SYSTEM", message: { contains: "CALIBRATION EPOCH V7 opened" } } });
  if (!dup) {
    await db.signalEvent.create({
      data: {
        type: "SYSTEM",
        level: "ai",
        message:
          "CALIBRATION EPOCH V7 opened — operator approved all 4 reforms: ① BREAKOUT conditional regime (guard 2→1, half-size BO-EXP trial, PF>1.2 @≥20 or revert) ② v6.6 tranche-aware accounting (TP3 on original risk + TP1/TP2 banked tranches) ③ smart TTL (AI-SWING band 8-10%, MFE<0 never extends, re-arm ≤2) ④ AI advisor loop (6h evidence cycles → operator APPROVE). Ledger CONTINUES — new signals tagged EPOCH-V7 for clean before/after forensics.",
      },
    });
    console.log("[audit] EPOCH V7 event written");
  } else {
    console.log("[audit] EPOCH V7 event already present — skipped");
  }

  const check = await db.engineSetting.findUnique({ where: { key: "gate" } });
  console.log("[verify] gate now:", check?.value);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
