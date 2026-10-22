/**
 * backtest-invalidate-v2.ts — ONE-OFF invalidation of pre-parity backtest state
 * Task 5-b / FIX 2 · audit W3 (v10.16: backtest ≠ live settlement rules)
 * Run: bunx tsx scripts/backtest-invalidate-v2.ts
 *
 * WHY: src/lib/backtest.ts shipped a v10.16 W3 parity rewrite — the exit sim
 * now replays the LIVE settlement rules (v6.6 tranche ladder, TP3 priced at the
 * deploy-time rung, v5.4/R2 BE-trail, R2/R7 early time-exit, engine open-symbol
 * dedup, shared accounting helpers). Every PERSISTED backtest artifact was
 * produced by the pre-parity sim that priced TP3 at 2.6R on FULL margin
 * (~+67% overstatement at rr=2.6) and ignored TP1/TP2 touches — the learned
 * gate must not trust those numbers for another cycle.
 *
 * WHAT THE READERS TREAT AS STALE (investigation, read-only):
 *   · "backtest"           — the BacktestResult consumed by learnedGateAllows()
 *     (src/lib/backtest.ts, imported by engine.ts). The reader has NO age
 *     check: `getBacktest() → null` is the only state it treats as stale
 *     ("insufficient evidence — 0/20 backtest trades"). ⇒ DELETE the row.
 *     Result consumers: /api/backtest, /api/ai/agent (display-only).
 *   · "backtest.autotune"  — pre-parity sweep ADOPTION: getEffectiveWeights()
 *     (src/lib/calibration.ts) multiplies adoptedWeights into live scoring. An
 *     adoption decided on inflated TP3 math must not steer the book. Deleting
 *     it also clears lastRunAt → the always-on learner recomputes
 *     baseline+autotune on the NEXT engine tick instead of waiting out the 6h
 *     cadence (getLearnerAutoState reads autotune.lastRunAt).
 *   · "backtest.runs"      — the runs history ring; all rows are pre-parity and
 *     would mislead the operator's trend view. Deleted (rebuilt per run).
 *   · "learner.baseline"   — the frozen-mode baseline replay clock
 *     (KEY_BASELINE in backtest.ts); deleting it forces an immediate baseline
 *     refresh should the R6 freeze be ON. belt-and-braces.
 * NOT touched: "learner.auto" (learner config), gate settings, calibration
 * state, signals, market data.
 *
 * IDEMPOTENT: safe to re-run (absent keys are skipped). After this, the next
 * maybeAutoLearner cycle persists a fresh result carrying
 * engineVersion="v10.16-parity" / parity=true — that marker is the durable
 * proof a row was NOT produced by the pre-parity sim.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const KEYS = ["backtest", "backtest.autotune", "backtest.runs", "learner.baseline"] as const;

function summarize(key: string, value: string): string {
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    if (key === "backtest") {
      return `ranAt=${String(v.ranAt)} label=${String(v.label)} n=${String(v.n)} WR=${String(v.winRate)}% LB=${String(v.wilsonLB)}% net=${String(v.avgNetPct)}%/trade · parity=${String(v.parity)} engineVersion=${String(v.engineVersion ?? "(none — pre-parity)")}`;
    }
    if (key === "backtest.autotune") {
      const w = v.adoptedWeights as Record<string, unknown> | null;
      return `adopted=${String(v.adopted)} adoptedWeights=${w ? `${Object.keys(w).length} factors (${Object.entries(w).slice(0, 2).map(([k, x]) => `${k}×${String(x)}`).join(", ")}…)` : "null"} lastRunAt=${String(v.lastRunAt)}`;
    }
    if (key === "backtest.runs") {
      const runs = Array.isArray(v) ? (v as Array<{ ranAt?: string }>) : [];
      return `${runs.length} runs · newest ${runs[0]?.ranAt ?? "-"}`;
    }
    return value.slice(0, 160);
  } catch {
    return value.slice(0, 160);
  }
}

async function main(): Promise<void> {
  console.log(`[backtest-invalidate-v2] run at ${new Date().toISOString()} — invalidating pre-parity backtest state (audit W3, v10.16)`);
  let deleted = 0;
  for (const key of KEYS) {
    const row = await db.engineSetting.findUnique({ where: { key } });
    if (!row) {
      console.log(`  ${key}: absent — nothing to invalidate`);
      continue;
    }
    console.log(`  DELETED ${key}\n    was: ${summarize(key, row.value)}`);
    await db.engineSetting.delete({ where: { key } });
    deleted++;
  }

  // context for the audit trail — what the gate will see next
  const frozen = await db.engineSetting.findUnique({ where: { key: "calibration.frozen" } });
  const quality = await db.engineSetting.findUnique({ where: { key: "rawcal.quality" } });
  console.log(`  context: calibration.frozen=${frozen ? (JSON.parse(frozen.value) as { frozen: boolean }).frozen : "absent"} · rawcal.quality=${quality ? (() => { const q = JSON.parse(quality.value) as { gate?: { verdict?: string }; informativePct?: number | null }; return `${q.gate?.verdict ?? "?"}/informative ${q.informativePct ?? "?"}%`; })() : "absent"}`);

  const remaining = await db.engineSetting.findMany({ where: { key: { in: [...KEYS] } } });
  console.log(`  post-check: ${deleted} row(s) deleted, ${remaining.length} remaining (expect 0)`);
  console.log(`[backtest-invalidate-v2] done — learnedGateAllows() now sees NO backtest result (null → "insufficient evidence"); the next maybeAutoLearner tick recomputes baseline+autotune with v10.16-parity settlement math and re-persists rows carrying engineVersion="v10.16-parity" parity=true.`);
}

main()
  .catch((e) => {
    console.error("[backtest-invalidate-v2] FAILED", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
