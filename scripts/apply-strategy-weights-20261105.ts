// ── STRATEGY WEIGHTS reallocation 2026-11-05 (operator mandate trace 1a1a8ea4186c6571) ──
// Executes chapter-7 item ④ of the engineering report NX3247+LIVE (download/
// گزارش-مهندسی-NX3247-و-LIVE.docx): «تنزل سایه‌ای AI-SCALP و MOMENTUM تا رسیدن
// به نمونهٔ آماری ۳۰۰تایی — هر دو امید ریاضی منفی و نرخ انقضای بالا دارند».
//
//   · MOMENTUM ×1.0 → ×0.25 (clamp floor — shadow downweight).
//     Evidence: chapter-7 item ④ + FRESH 2026-11-03 audit — MOMENTUM 30d
//     n=21 net −$5.13, TPwr 14.3%, OOS base 15/300 at pace 0.3/day. The
//     downweight is SIZING-ONLY: issuance and OOS capture continue untouched
//     (unlike strat-pause), the cohort keeps accruing toward the 300 floor.
//   · AI-SCALP ×0.25 UNCHANGED — already at the clamp floor since 2026-10-25
//     ("pause-by-sizing"); nothing further is possible through this mechanism.
//     (Chapter-7 names both strategies; AI-SCALP's leg of the item is already
//     satisfied by the live 0.25 floor.)
//   · MEAN-REVERT ×0.25, BREAKOUT ×1.25, AI-SWING ×1.0 UNCHANGED (2026-11-03
//     mandate row preserved verbatim).
//
// Mirrors POST /api/strategy-weights EXACTLY (same row shape src/lib/
// strategy-weights.ts reads, same ENGINE SignalEvent audit template).
// Engine picks the row up live via strategyWeightFor() (15s cache) — NO
// restart needed. FLAT-10 untouched: margin stays exactly $10.
// Run: bun scripts/apply-strategy-weights-20261105.ts
import { db } from "@/lib/db";

const KEY = "strategy.weights";
const UPDATED_BY = "operator-mandate-1a1a8ea4186c6571";
const STRATEGY_LIST = ["AI-SCALP", "MEAN-REVERT", "MOMENTUM", "BREAKOUT", "AI-SWING"] as const;
const W_LO = 0.25;
const W_HI = 2.0;

function sanitize(raw: { enabled?: boolean; weights?: Record<string, unknown>; updatedAt?: unknown; updatedBy?: unknown }) {
  const weights: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.weights ?? {})) {
    const num = Number(v);
    if (Number.isFinite(num)) weights[String(k).toUpperCase().slice(0, 24)] = Math.min(W_HI, Math.max(W_LO, Math.round(num * 100) / 100));
  }
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
    weights,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === "string" ? (raw.updatedBy as string).slice(0, 80) : null,
  };
}

async function main(): Promise<void> {
  const curRow = await db.engineSetting.findUnique({ where: { key: KEY } });
  const cur = curRow ? sanitize(JSON.parse(curRow.value)) : { enabled: false, weights: {} as Record<string, number>, updatedAt: null, updatedBy: null };
  const next = sanitize({
    enabled: true,
    weights: { "AI-SCALP": 0.25, "MEAN-REVERT": 0.25, MOMENTUM: 0.25, BREAKOUT: 1.25, "AI-SWING": 1.0 },
    updatedAt: new Date().toISOString(),
    updatedBy: UPDATED_BY,
  });

  await db.engineSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });

  const transitions = STRATEGY_LIST.map((s) => `${s} ×${cur.weights[s] ?? 1}→×${next.weights[s] ?? 1}`).join(" · ");
  const live = STRATEGY_LIST.map((s) => `${s}:×${next.weights[s] ?? 1}`).join(" ");
  const message =
    `STRATEGY WEIGHTS v10.6 (chapter-7 item ④): ${transitions} — ` +
    `shadow downweight (SIZING-ONLY; issuance + OOS capture continue, margin stays exactly $10) · ` +
    `ACTIVE ${live} (updated ${next.updatedAt} by ${next.updatedBy}) — ` +
    `evidence: engineering report NX3247+LIVE ch.7 item ④ «تنزل سایه‌ای AI-SCALP و MOMENTUM تا نمونهٔ ۳۰۰تایی — امید ریاضی منفی و نرخ انقضای بالا»; ` +
    `MOMENTUM 30d n=21 net −$5.13 TPwr 14.3% OOS 15/300 pace 0.3/day → clamp floor ×0.25; ` +
    `AI-SCALP already ×0.25 floor since 2026-10-25 (item leg pre-satisfied); ` +
    `MEAN-REVERT ×0.25 + paused (probation), BREAKOUT ×1.25 (positive pattern kept), AI-SWING ×1.0 workhorse — 2026-11-03 row preserved. ` +
    `Operator mandate trace 1a1a8ea4186c6571 («پیشنهادات باقی مانده مهندسی را کامل اجرا کن»).`;

  const ev = await db.signalEvent.create({ data: { signalId: null, symbol: null, type: "ENGINE", level: "ai", message } });

  console.log("=== strategy.weights applied (2026-11-05 mandate, ch.7 item ④) ===");
  console.log("before:", JSON.stringify(cur));
  console.log("after :", JSON.stringify(next));
  console.log("audit SignalEvent:", ev.id, "(type ENGINE, level ai)");
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("apply-strategy-weights-20261105 FAILED:", e);
  process.exitCode = 1;
  try {
    await db.$disconnect();
  } catch {}
});
