// ── P1-c one-off STRATEGY WEIGHTS reallocation (FRESH 2026-10-25 audit) ─────
// Operator mandate (trace 1a16ff36143328fd): re-allocate per-strategy sizing
// from the FRESH 15-day ledger (window 2026-10-10 → 2026-10-25, n=974 CLEAN
// signals, DOCTRINE-PEAK-QA-20261025 audit) — superseding the stale
// 2026-09-15 proposal that was live until now and was INVERTED vs fresh data
// (AI-SWING workhorse ×0.5, broken AI-SCALP ×1.5, best class BREAKOUT ×0.5):
//   · AI-SCALP    n=64  WR 30% (29% even on native tape) net −$11.34 → ×0.25
//                 (clamp floor — documented pause-by-sizing, gates untouched)
//   · MEAN-REVERT n=90  WR 38%  net −$13.98 → ×0.5
//   · BREAKOUT    window +$77.38; native tape n=188 WR 64% +$110.45 (the
//                 surrogate cohort WR 35% −$33.07 is now vetoed by the P0-a
//                 SURROGATE-BREAKOUT gate, so ×1.25 rides the native edge) → ×1.25
//   · AI-SWING    the workhorse, native +$104.07 → ×1.0 (restored from ×0.5)
//   · MOMENTUM    n=6 insufficient sample → ×1.0 (neutral)
// Mirrors POST /api/strategy-weights EXACTLY (putStrategyWeights row shape +
// ENGINE 'ai' SignalEvent audit row, same message template) but records the
// operator-mandate updatedBy instead of "OPERATOR-API". Row shape read by
// src/lib/strategy-weights.ts sanitize(): {enabled, weights, updatedAt,
// updatedBy}; keys uppercased, clamped [0.25, 2.0], rounded to 2dp.
// NOTE: engine reads this via strategyWeightFor() (engine.ts ~3352) on EVERY
// deploy with a 15s in-process cache — a script write is picked up live
// within ≤15s, NO server restart needed.
// Run: bun scripts/apply-strategy-weights-20261025.ts
import { db } from "@/lib/db";

const KEY = "strategy.weights";
const UPDATED_BY = "operator-mandate-1a16ff36143328fd";
const STRATEGY_LIST = ["AI-SCALP", "MEAN-REVERT", "MOMENTUM", "BREAKOUT", "AI-SWING"] as const;
const W_LO = 0.25;
const W_HI = 2.0;

// Mirror of the lib's sanitize() — the row is stored EXACTLY in the shape
// src/lib/strategy-weights.ts reads back.
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
    weights: { "AI-SCALP": 0.25, "MEAN-REVERT": 0.5, MOMENTUM: 1.0, BREAKOUT: 1.25, "AI-SWING": 1.0 },
    updatedAt: new Date().toISOString(),
    updatedBy: UPDATED_BY,
  });

  await db.engineSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });

  // Mirror of the API route's fireEvent(null,null,"ENGINE","ai",msg) — same
  // template, extended with the fresh-audit evidence so the ledger row is
  // self-explanatory to future forensics.
  const transitions = STRATEGY_LIST.map((s) => `${s} ×${cur.weights[s] ?? 1}→×${next.weights[s] ?? 1}`).join(" · ");
  const live = STRATEGY_LIST.map((s) => `${s}:×${next.weights[s] ?? 1}`).join(" ");
  const message =
    `STRATEGY WEIGHTS v10.6: enabled ${cur.enabled ? "true" : "false"} → ${next.enabled ? "true" : "false"} · ${transitions} — ` +
    `per-strategy margin multiplier ${next.enabled ? "ACTIVE on the deploy path" : "neutral (module off)"} · ` +
    `ACTIVE ${live} (updated ${next.updatedAt} by ${next.updatedBy}) — ` +
    `evidence: FRESH 2026-10-25 audit, window 2026-10-10→25, n=974 CLEAN signals (AI-SCALP n=64 WR30% net −$11.34 → pause-by-sizing at clamp floor; ` +
    `MEAN-REVERT n=90 WR38% net −$13.98; BREAKOUT window +$77.38, native tape n=188 WR64% +$110.45, surrogate cohort vetoed by P0-a SURROGATE-BREAKOUT gate; ` +
    `AI-SWING workhorse native +$104.07 restored to ×1.0; MOMENTUM n=6 insufficient → neutral). Operator mandate trace 1a16ff36143328fd.`;

  const ev = await db.signalEvent.create({ data: { signalId: null, symbol: null, type: "ENGINE", level: "ai", message } });

  console.log("=== [P1-c] strategy.weights applied ===");
  console.log("before:", JSON.stringify(cur));
  console.log("after :", JSON.stringify(next));
  console.log("audit SignalEvent:", ev.id, `(type ENGINE, level ai)`);
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("apply-strategy-weights-20261025 FAILED:", e);
  process.exitCode = 1;
  try {
    await db.$disconnect();
  } catch {}
});
