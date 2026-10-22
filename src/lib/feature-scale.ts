// ── NEXUS//SIGNALS — feature-scale gate (server-only) ───────────────────────
// OPERATOR MANDATE 2026-10-21: «هدف حفظ سرمایه نیست، ردیابی جریانات است با
// دقت و سرعت بالا… بجای وتوی کامل، ویژگی‌های منفی را حذف کن و ویژگی‌های مثبت
// را بیشتر تحت نظر داشته باش.»
//
// The old policy BLANKET-VETOED whole strategies/directions on cohort-level
// evidence (BREAKOUT 14.3% WR → veto ALL; SHORT 11.1% WR → veto ALL). That
// throws away every flow signal inside a mixed cohort. The ledger CAN answer
// at feature granularity: every Signal row stores the FactorVote[] at deploy
// (factorsJson, 100% coverage per the 2026-10-21 data audit), and every row
// has a realized outcome (reachedTp / status).
//
// Per (strategy × direction × factor) this module measures:
//   wrBase  — cohort win-rate (win = reachedTp>0; loss = SL with reachedTp=0;
//             EXPIRED-without-TP excluded — no invented outcome)
//   wrConf  — win-rate when the factor CONFIRMED the direction
//   wrOpp   — win-rate when the factor OPPOSED the direction
// and prunes a factor's vote ONLY on measured anti-signal evidence (n≥12):
//   CONFIRM-ANTI  wrConf ≤ wrBase − 6  → its confirming vote predicted LOSSES
//                                        → prune confirm-side vote
//   OPPOSE-NOISE  wrOpp ≥ wrBase − 3  → its opposing vote never predicted
//                                        losses (pure drag) → prune oppose-side
// A candidate dropped ONLY by the score band or a blanket guard gets one
// rescale attempt: pruned votes removed, score recomputed, and it must STILL
// clear the same effective threshold. Everything is journaled via the note
// field — the operator sees exactly which features were removed and why.
// Hard data-integrity gates (feed-fresh, sim-ban, settlement, dislocation,
// kill-switch) are NEVER rescaled — they protect truth, not expectancy.
// Knob: EngineSetting "featureScale" = "1"(on, default) | "0"(off).
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "@/lib/db";

export interface FeatureCohortStat {
  nConf: number;
  wrConf: number | null;
  nOpp: number;
  wrOpp: number | null;
  wrBase: number | null;
}
export type FeatureStats = Map<string, FeatureCohortStat>; // key = strategy|direction|factor

export interface RescaleResult {
  rescore: number;
  pruned: string[];
  watched: string[];
}

const STATS_TTL_MS = 10 * 60_000;
const MIN_N = 12;
const CONFIRM_ANTI_PTS = 6;
const OPPOSE_NOISE_PTS = 3;
const MAX_PRUNED = 2; // bounded surgery — never silently rewrite a whole setup

let statsCache: { at: number; stats: FeatureStats } | null = null;
let statsLoading: Promise<FeatureStats> | null = null;
let statsLoaded = false;

const health = {
  statsLoaded: false,
  lastStatsAt: 0,
  cohortRows: 0,
  pruneRules: 0,
  rescaleAttempts: 0,
  rescues: 0,
  rescaleFails: 0,
  lastRescaleNote: null as string | null,
};
export function featureScaleHealth() {
  return { ...health, stats: statsCache?.at ?? 0 };
}

/** Rescue-outcome telemetry from the engine gate — keeps the audit trail. */
export function noteRescale(kind: "rescue" | "fail", note: string | null): void {
  if (kind === "rescue") {
    health.rescues++;
    health.lastRescaleNote = note;
  } else {
    health.rescaleFails++;
  }
}

export async function loadFeatureStats(force = false): Promise<FeatureStats> {
  if (!force && statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.stats;
  if (statsLoading) return statsLoading;
  statsLoading = (async () => {
    const rows = await db.signal.findMany({
      where: { qualityFlag: null, factorsJson: { not: null } },
      select: { strategy: true, direction: true, status: true, reachedTp: true, factorsJson: true },
    });
    // cohort baseline: strategy|direction → {settled, wins}
    const base = new Map<string, { settled: number; wins: number }>();
    // factor cohorts: strategy|direction|factor → confirm/oppose outcome tallies
    const agg = new Map<string, { cS: number; cW: number; oS: number; oW: number }>();
    for (const r of rows) {
      const win = r.reachedTp > 0;
      const loss = r.status === "SL" && r.reachedTp === 0;
      if (!win && !loss) continue; // ACTIVE / EXPIRED-no-TP — outcome not measured
      const bk = `${r.strategy}|${r.direction}`;
      const b = base.get(bk) ?? { settled: 0, wins: 0 };
      b.settled++;
      if (win) b.wins++;
      base.set(bk, b);
      let votes: Array<{ factor: string; vote: number }> = [];
      try {
        votes = JSON.parse(r.factorsJson ?? "[]") as Array<{ factor: string; vote: number }>;
      } catch {
        continue;
      }
      const dirSign = r.direction === "LONG" ? 1 : -1;
      for (const v of votes) {
        if (!v?.factor || typeof v.vote !== "number" || v.vote === 0) continue;
        const key = `${bk}|${v.factor}`;
        const a = agg.get(key) ?? { cS: 0, cW: 0, oS: 0, oW: 0 };
        if (v.vote * dirSign > 0) {
          a.cS++;
          if (win) a.cW++;
        } else {
          a.oS++;
          if (win) a.oW++;
        }
        agg.set(key, a);
      }
    }
    const stats: FeatureStats = new Map();
    let rules = 0;
    for (const [key, a] of agg) {
      const [strategy, direction, factor] = key.split("|");
      const b = base.get(`${strategy}|${direction}`);
      if (!b || b.settled < MIN_N) continue;
      const wrBase = b.wins / b.settled;
      const entry: FeatureCohortStat = {
        nConf: a.cS,
        wrConf: a.cS >= MIN_N ? a.cW / a.cS : null,
        nOpp: a.oS,
        wrOpp: a.oS >= MIN_N ? a.oW / a.oS : null,
        wrBase,
      };
      stats.set(key, entry);
      void factor;
      if ((entry.wrConf !== null && wrBase - entry.wrConf >= CONFIRM_ANTI_PTS / 100) || (entry.wrOpp !== null && entry.wrOpp - wrBase >= OPPOSE_NOISE_PTS / 100)) rules++;
    }
    statsCache = { at: Date.now(), stats };
    health.statsLoaded = true;
    health.lastStatsAt = Date.now();
    health.cohortRows = rows.length;
    health.pruneRules = rules;
    return stats;
  })();
  try {
    return await statsLoading;
  } finally {
    statsLoading = null;
  }
}

export async function featureScaleOn(): Promise<boolean> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: "featureScale" } });
    return (row?.value ?? "1") !== "0";
  } catch {
    return true; // fail-open to the operator mandate default
  }
}

/**
 * Re-score a candidate with measured anti-signal features pruned.
 * `votes` = the candidate's FactorVote[] at score time; direction + strategy
 * select the cohort. Returns the pruned rescore — caller re-checks threshold.
 */
export function rescaleCandidate(votes: Array<{ factor: string; vote: number }>, strategy: string, direction: string, stats: FeatureStats): RescaleResult {
  const dirSign = direction === "LONG" ? 1 : -1;
  const pruned: string[] = [];
  const watched: string[] = [];
  let kept = 0;
  let pruneBudget = MAX_PRUNED;
  for (const v of votes) {
    const st = stats.get(`${strategy}|${direction}|${v.factor}`);
    const confirms = v.vote * dirSign > 0;
    if (st && pruneBudget > 0) {
      const confirmAnti = st.wrConf !== null && st.wrBase !== null && st.wrBase - st.wrConf >= CONFIRM_ANTI_PTS / 100;
      const opposeNoise = st.wrOpp !== null && st.wrBase !== null && st.wrOpp - st.wrBase >= OPPOSE_NOISE_PTS / 100;
      if ((confirms && confirmAnti) || (!confirms && opposeNoise)) {
        const wrHit = confirms ? st.wrConf! : st.wrOpp!;
        pruned.push(`${v.factor}(${confirms ? "confirm-anti" : "oppose-noise"}, wrBase ${(st.wrBase! * 100).toFixed(0)}% vs ${(wrHit * 100).toFixed(0)}%)`);
        pruneBudget--;
        continue; // vote removed from the pool — measured, journaled, reversible
      }
      if (st.wrConf !== null && st.wrBase !== null && st.wrConf - st.wrBase >= CONFIRM_ANTI_PTS / 100) {
        watched.push(v.factor); // genuinely positive — under closer monitoring
      }
    }
    kept += v.vote;
  }
  return { rescore: Math.max(-100, Math.min(100, kept)), pruned, watched };
}
