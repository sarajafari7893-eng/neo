// ── v9.3 RAW-CAL SAMPLE QUALITY LAB — data-health gate for the R6 recalibration ──
// Operator mandate 2026-09-13: «پس از تسویه اولین RAW-CALها (~1-2h) میتوانیم
// کیفیت نمونه‌های خام را هم بررسی کنیم تا کالیبراسیون R6 روی داده سالم بنشیند»
// — after the first RAW-CALs settle, review the quality of the raw samples so
// the R6 calibration rests on HEALTHY data.
//
// WHAT IT MEASURES (every RAW-CAL-tagged ledger row, 100% from the DB):
//  · CAPTURE INTEGRITY (0-30): deploy audit snapshots preserved — factorsJson
//    (confluence votes, 12) / flowJson (order-flow, 9) / mtfJson (multi-TF
//    board, 9). R6 attributes outcomes to factors; a row born without its
//    snapshots can never be attributed, so absence is scored, not forgiven.
//  · PLAN COMPLETENESS (0-20): entry/stop/TP ladder present and
//    direction-consistent, RR > 0, TTL sane — a malformed plan is a malformed
//    sample no matter how it settles.
//  · OUTCOME INFORMATIVENESS (0-30): TP1/TP2/TP3 or SL = fully informative
//    (price proved or disproved the plan — losses are the most instructive
//    rows); EXPIRED with a TP touch = partially informative; EXPIRED with no
//    touch = time-censored (low information); manual CLOSED = censored.
//  · REPRESENTATIVENESS (0-20): spacing ≥ the anti-flood rail (burst-cluster
//    rows are correlated and would inflate calibration confidence), hold time
//    inside the TTL envelope, extension abuse flagged.
// Composite 0-100 → HEALTHY ≥75 · REVIEW 50-74 · CENSORED <50 (PENDING while
// the row is still open).
//
// COHORT HEALTH → R6 GATE: healthy% of the settled raw cohort vs the 85%
// health floor, informative ratio, symbol concentration, side balance,
// snapshot completeness — verdict GREEN / AMBER / RED (WARMING before the
// first settles) with explicit blockers. The gate ADVISES the R6 lift and the
// central intelligence (engine memory + governor context); it NEVER edits the
// calibration math itself (no post-hoc tampering — honest instrumentation).
//
// PERSISTENCE: EngineSetting "rawcal.quality" (compact digest, cross-process)
// + QUALITY rows appended to .data/rawcal-telemetry.jsonl (10min throttle,
// forced the moment the settled-raw count moves — the settle curve of the
// QUALITY of the book, not just its size).

import { promises as fs } from "fs";
import path from "path";
import { db } from "./db";
import { RAWCAL_TELEMETRY_FILE } from "./rawcal-telemetry";

const QUALITY_KEY = "rawcal.quality";
const SETTLED_STATUSES = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];
const OPEN_STATUSES = ["ACTIVE", "TP1", "TP2"];
const HEALTH_FLOOR = 85; // R6 health floor — healthy% of the settled raw cohort
const MAX_JOURNAL_ROWS = 4000;

// ── v10.9 POST-FILTER COHORT (SUPERVISOR proposal 22:55Z, operator-approved
// 2026-09-15 «دستورات سوپروایزر را کامل و مهندسی انجام بده») — before/after
// split around the decisive-excursion filter go-live (first live skip TAOUSDT
// 11:31:27Z, worklog OP-V106-ROOTCAUSE-20260915T1134Z). The blended window is
// dominated by the legacy expired-no-touch stock, so the filter's true effect
// on outcome informativeness is measured on its OWN cohort. Censoring-aware
// pre/post design (gov.uk before-after guidance; Prinja 2010, Turkson 2021).
const FILTER_ERA_START_MS = Date.parse("2026-09-15T11:30:00.000Z");

// ── v10.9.2 EXPIRY-CAUSE ATTRIBUTION (SUPERVISOR proposal, operator-approved
// via bridge 2026-09-16T11:18Z «دستورات سوپروایزر را تایید می کنم») — the gate
// verdict is hostage to expired-no-touch censoring (informative 37.7% blended):
// R6 cannot attribute outcomes when a trade never reaches TP1 or SL. Each
// EXPIRED-no-touch row is now split by its MAX FAVORABLE EXCURSION in R units
// (mfeR = (maxPnlPercent/leverage) / stopDistancePct — existing journal fields,
// zero new capture): WRONG-SIDE (mfeR < 0.25 — price never followed the plan;
// entry direction/timing problem, NOT a TTL problem) vs NO-FOLLOW (mfeR ≥ 0.6 —
// meaningful follow that stalled before TP1; barrier/TP geometry too far for
// realized excursion) vs MIXED (in between). The gate can now NAME the dominant
// expiry cause, and the VOL-BARRIER mult/cap knobs get a direct feedback signal
// (no-follow dominance → tighten barrier; wrong-side dominance → entry filter
// problem). Reporting-layer only — scoring, scan and issue logic untouched.
const EXP_WRONG_SIDE_R = 0.25; // below: never followed — wrong side / late entry
const EXP_NO_FOLLOW_R = 0.6; // above: followed then stalled — geometry too far

// ── v10.9.1 EPOCH-WINDOWED GATE VERDICT (SUPERVISOR proposal, operator blanket-
// approve 2026-09-16T09:03Z «تمام اقدامات و پیشنهادات SUPERVISOR را تایید
// می‌کنم — کامل و مهندسی انجام بده») — the gate verdict is computed on the
// POST-FILTER EPOCH WINDOW, not the blended all-time cohort. The blended
// window is dominated by legacy expired-no-touch stock (metric regime-bias:
// 37.7% blended vs 56% post-filter informative at approval time), so the
// all-time ratio can never turn GREEN even when the CURRENT engine regime is
// decisively healthier. GREEN now requires the epoch window to prove itself:
// window informative ≥50% AND window settled n≥20. Structural integrity
// (snapshots) stays whole-cohort — a row born without snapshots is era-
// independent damage. The healthy-floor check rides the window too (AMBER,
// not RED). VERDICT-ONLY change: scoring, cohort measurement, scan/issue
// logic all untouched — the digest still reports the blended ratios for the
// whole book (honest instrumentation), only the VERDICT anchor moved.
const GATE_WINDOW_MIN_N = 20; // settled rows the window needs before GREEN is reachable
const GATE_WINDOW_FORMING = 3; // below this the window is WARMING, not judged
const GATE_WINDOW_INFORMATIVE = 50; // GREEN bar for the window informative ratio
const GATE_WINDOW_WARN_N = 8; // window small-sample guard for the informative blocker

export type QualityClass = "HEALTHY" | "REVIEW" | "CENSORED" | "PENDING";
export type GateVerdict = "WARMING" | "GREEN" | "AMBER" | "RED";

export interface RawcalSampleQuality {
  serial: number;
  symbol: string;
  direction: string;
  strategy: string;
  status: string;
  settled: boolean;
  pnlPercent: number;
  holdMin: number | null;
  score: number; // 0-100 composite (open rows carry no outcome points yet)
  cls: QualityClass;
  flags: string[];
  spacingOk: boolean | null; // issued ≥ rail after the previous raw record
}

export interface ExpiryCauses {
  wrongSide: number; // mfeR < 0.25 — directional miss, never followed
  noFollow: number; // mfeR ≥ 0.6 — followed then stalled before TP1
  mixed: number; // 0.25 ≤ mfeR < 0.6 — ambiguous
}

export interface RawcalQualityDigest {
  at: string;
  issuedTotal: number;
  openRaw: number;
  settledRaw: number;
  healthy: number;
  review: number;
  censored: number;
  healthyPct: number | null; // of settled cohort
  informativePct: number | null; // TP/SL (or TP-proven) share of settled — censoring inverse
  expiredNoTouch: number; // time-censored rows in the settled cohort
  expiryCauses: ExpiryCauses; // v10.9.2 — wrongSide/noFollow/mixed split of the no-touch stock
  snapshotPct: number | null; // rows carrying ALL THREE deploy snapshots (whole cohort)
  symbols: number; // distinct symbols in the settled cohort
  topSymbolShare: number | null; // % of the settled cohort in one symbol
  longPct: number | null;
  shortPct: number | null;
  meanAbsPnl: number | null; // mean |pnl%| of settled — realized signal strength
  meanHoldMin: number | null;
  clusterCount: number; // rows issued inside the spacing rail
  warnings: string[]; // max 5, priority-ordered
  gate: {
    verdict: GateVerdict;
    healthFloor: number;
    blockers: string[];
    // v10.9.1 EPOCH-WINDOWED — the verdict anchor (post-filter window), kept
    // alongside the blended ratios above so every consumer can see WHY.
    window: { since: string; settled: number; healthyPct: number | null; informativePct: number | null };
  };
  postFilterCohort: {
    since: string; // filter go-live boundary (ISO)
    n: number; // rows born after the filter (any status)
    settled: number;
    informativePct: number | null; // same informative rule, post cohort
    expiryRatePct: number | null; // expired-no-touch share of settled post cohort
  };
  samples: RawcalSampleQuality[]; // last 12 (settled first, then in-flight) — API/UI only
}

type CompactDigest = Omit<RawcalQualityDigest, "samples">;

// ── memo cache (runs on hot paths) ──
let qualityCache: { at: number; data: RawcalQualityDigest } | null = null;
const QUALITY_TTL_MS = 30_000;
let lastJournalAt = 0;
let lastSeenSettled = -1;

function safeParse(json: string | null | undefined): boolean {
  if (!json || !json.trim()) return false;
  try {
    const v = JSON.parse(json);
    return v !== null && (typeof v !== "object" || Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
  } catch {
    return false;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function pct(part: number, whole: number): number | null {
  return whole > 0 ? round1((part / whole) * 100) : null;
}

/** Score ONE raw ledger row against the four quality dimensions. */
function scoreSample(
  row: {
    serial: number; symbol: string; direction: string; strategy: string; status: string;
    reachedTp: number; pnlPercent: number; ttlMinutes: number; ttlExtensions: number;
    entryPrice: number; tp1: number; tp2: number; tp3: number; stopLoss: number; riskReward: number;
    leverage: number; maxPnlPercent: number;
    expiresAt: Date; createdAt: Date; closedAt: Date | null;
    factorsJson: string | null; flowJson: string | null; mtfJson: string | null;
  },
  prevCreatedAt: Date | null,
  spacingMin: number,
): RawcalSampleQuality {
  const flags: string[] = [];
  const settled = SETTLED_STATUSES.includes(row.status);
  const open = OPEN_STATUSES.includes(row.status);

  // ── A) capture integrity — the deploy audit snapshots R6 will attribute to (0-30)
  let integrity = 0;
  if (safeParse(row.factorsJson)) integrity += 12; else flags.push("no-factors");
  if (safeParse(row.flowJson)) integrity += 9; else flags.push("no-flow");
  if (safeParse(row.mtfJson)) integrity += 9; else flags.push("no-mtf");

  // ── B) plan completeness — entry/stop/ladder coherent (0-20)
  let plan = 0;
  if (row.entryPrice > 0) plan += 2;
  if (row.stopLoss > 0) plan += 3; else flags.push("no-stop");
  if (row.tp1 > 0 && row.tp2 > 0 && row.tp3 > 0) plan += 3; else flags.push("ladder-short");
  const long = row.direction === "LONG";
  const ladderOk = long
    ? row.tp1 > row.entryPrice && row.stopLoss < row.entryPrice
    : row.direction === "SHORT"
      ? row.tp1 < row.entryPrice && row.stopLoss > row.entryPrice
      : false;
  if (ladderOk) plan += 6; else flags.push("ladder-inconsistent");
  if (row.riskReward > 0) plan += 2;
  if (row.ttlMinutes > 0 && row.expiresAt.getTime() > row.createdAt.getTime()) plan += 4; else flags.push("ttl-bad");

  // ── C) outcome informativeness — what did the settle actually teach (0-30)
  let outcome = 0;
  if (settled) {
    if (["TP1", "TP2", "TP3"].includes(row.status)) outcome = 30;
    else if (row.status === "SL") outcome = 30;
    else if (row.status === "EXPIRED") {
      if (row.reachedTp >= 1) outcome = 20;
      else {
        outcome = 8;
        flags.push("expired-no-touch"); // time-censored — weakest calibration row
        // v10.9.2 expiry-cause attribution — MFE in R units names WHY it censored
        const slPct = row.entryPrice > 0 ? (Math.abs(row.stopLoss - row.entryPrice) / row.entryPrice) * 100 : 0;
        if (slPct > 0 && row.leverage > 0) {
          const mfeR = row.maxPnlPercent / row.leverage / slPct;
          if (mfeR < EXP_WRONG_SIDE_R) flags.push("expired-wrong-side");
          else if (mfeR >= EXP_NO_FOLLOW_R) flags.push("expired-no-follow");
        } // slPct/leverage degenerate → cause unknown, censoring flag alone stands
      }
    } else if (row.status === "CLOSED") {
      outcome = 10;
      flags.push("manual-close");
    }
  } else if (!open) {
    flags.push("status-odd");
  }

  // ── D) representativeness — spacing rail + TTL envelope (0-20)
  let timing = 0;
  let spacingOk: boolean | null = null;
  if (prevCreatedAt) {
    const gapMin = (row.createdAt.getTime() - prevCreatedAt.getTime()) / 60_000;
    spacingOk = gapMin >= spacingMin * 0.98;
    if (spacingOk) timing += 10;
    else {
      timing += 4;
      flags.push("cluster-spawn");
    }
  } else {
    timing += 10; // first record of the cohort — no spacing to violate
  }
  if (settled && row.closedAt) {
    const envelope = row.ttlMinutes * (1 + 0.25 * row.ttlExtensions) + 5;
    const holdMin = (row.closedAt.getTime() - row.createdAt.getTime()) / 60_000;
    if (holdMin <= envelope) timing += 10;
    else flags.push("hold-overrun");
    if (row.ttlExtensions >= 3) flags.push(`ttl-ext×${row.ttlExtensions}`);
  } else if (!settled) {
    timing += 10; // hold envelope not yet measurable — neutral until settle
  }

  const score = Math.round(integrity + plan + outcome + timing);
  const cls: QualityClass = open ? "PENDING" : score >= 75 ? "HEALTHY" : score >= 50 ? "REVIEW" : "CENSORED";
  return {
    serial: row.serial,
    symbol: row.symbol,
    direction: row.direction,
    strategy: row.strategy,
    status: row.status,
    settled,
    pnlPercent: round1(row.pnlPercent),
    holdMin: row.closedAt ? Math.round((row.closedAt.getTime() - row.createdAt.getTime()) / 60_000) : null,
    score,
    cls,
    flags,
    spacingOk,
  };
}

/** Cohort quality + R6 data-health gate (30s memo). */
export async function computeRawcalQuality(): Promise<RawcalQualityDigest> {
  if (qualityCache && Date.now() - qualityCache.at < QUALITY_TTL_MS) return qualityCache.data;

  let spacingMin = 12;
  try {
    const { getRawCalState } = await import("./raw-cal");
    spacingMin = (await getRawCalState()).spacingMin;
  } catch {
    /* default rail */
  }

  const rows = await db.signal.findMany({
    where: { tags: { contains: "RAW-CAL" } },
    select: {
      serial: true, symbol: true, direction: true, strategy: true, status: true, reachedTp: true,
      pnlPercent: true, ttlMinutes: true, ttlExtensions: true, entryPrice: true, tp1: true, tp2: true,
      tp3: true, stopLoss: true, riskReward: true, leverage: true, maxPnlPercent: true,
      expiresAt: true, createdAt: true, closedAt: true,
      factorsJson: true, flowJson: true, mtfJson: true,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const asc = [...rows].reverse(); // asc for spacing diffs

  const scored = asc.map((r, i) => scoreSample(r, i > 0 ? asc[i - 1].createdAt : null, spacingMin));
  const settledSamples = scored.filter((s) => s.settled);
  const settledRaw = settledSamples.length;
  const openRaw = scored.filter((s) => !s.settled).length;

  const healthy = settledSamples.filter((s) => s.cls === "HEALTHY").length;
  const review = settledSamples.filter((s) => s.cls === "REVIEW").length;
  const censored = settledSamples.filter((s) => s.cls === "CENSORED").length;
  const healthyPct = pct(healthy, settledRaw);

  // informative = fully readable outcome: TP/SL proved the plan, or EXPIRED
  // after a TP touch (partially readable). EXPIRED-no-touch / CLOSED excluded.
  const informativePct = pct(
    settledSamples.filter((s) => ["TP1", "TP2", "TP3", "SL"].includes(s.status) || (s.status === "EXPIRED" && !s.flags.includes("expired-no-touch"))).length,
    settledRaw,
  );
  const expiredNoTouch = settledSamples.filter((s) => s.flags.includes("expired-no-touch")).length;
  const expiryCauses: ExpiryCauses = {
    wrongSide: expiredNoTouch ? settledSamples.filter((s) => s.flags.includes("expired-wrong-side")).length : 0,
    noFollow: expiredNoTouch ? settledSamples.filter((s) => s.flags.includes("expired-no-follow")).length : 0,
    mixed: 0,
  };
  expiryCauses.mixed = Math.max(0, expiredNoTouch - expiryCauses.wrongSide - expiryCauses.noFollow);

  // ── post-filter cohort — reuses the cohort-consistent scores (spacing vs true
  // predecessor) by index alignment with `asc`, not a re-scored sub-list.
  const postScored = asc
    .map((r, i) => (r.createdAt.getTime() >= FILTER_ERA_START_MS ? scored[i] : null))
    .filter((s): s is RawcalSampleQuality => s !== null);
  const postSettled = postScored.filter((s) => s.settled);
  const postInformativePct = pct(
    postSettled.filter((s) => ["TP1", "TP2", "TP3", "SL"].includes(s.status) || (s.status === "EXPIRED" && !s.flags.includes("expired-no-touch"))).length,
    postSettled.length,
  );
  const postExpiryRatePct = pct(postSettled.filter((s) => s.flags.includes("expired-no-touch")).length, postSettled.length);
  const postFilterCohort = {
    since: new Date(FILTER_ERA_START_MS).toISOString(),
    n: postScored.length,
    settled: postSettled.length,
    informativePct: postInformativePct,
    expiryRatePct: postExpiryRatePct,
  };

  const snapshotOk = scored.filter((s) => !s.flags.includes("no-factors") && !s.flags.includes("no-flow") && !s.flags.includes("no-mtf")).length;
  const snapshotPct = pct(snapshotOk, scored.length);

  const symAcc = new Map<string, number>();
  let longs = 0;
  for (const s of settledSamples) {
    symAcc.set(s.symbol, (symAcc.get(s.symbol) ?? 0) + 1);
    if (s.direction === "LONG") longs++;
  }
  const symbols = symAcc.size;
  const topSymbolShare = symbols ? Math.max(...symAcc.values()) / settledRaw * 100 : null;
  const longPct = pct(longs, settledRaw);
  const shortPct = longPct !== null ? round1(100 - longPct) : null;

  const holds = settledSamples.map((s) => s.holdMin).filter((h): h is number => h !== null);
  const meanAbsPnl = settledRaw ? round1(settledSamples.reduce((a, s) => a + Math.abs(s.pnlPercent), 0) / settledRaw) : null;
  const meanHoldMin = holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : null;
  const clusterCount = scored.filter((s) => s.flags.includes("cluster-spawn")).length;

  // ── warnings (priority-ordered, sample-size-guarded — no noise at n=1) ──
  const warnings: string[] = [];
  if (settledRaw >= 3 && informativePct !== null && informativePct < 70)
    warnings.push(`informative ratio ${informativePct}% < 70% — EXPIRED censoring weakens R6 factor attribution`);
  if (settledRaw >= 5 && topSymbolShare !== null && topSymbolShare > 40)
    warnings.push(`symbol concentration ${round1(topSymbolShare)}% in one market — R6 may overfit`);
  if (settledRaw >= 5 && (longPct === null || shortPct === null || Math.max(longPct, shortPct ?? 0) > 75))
    warnings.push(`side imbalance ${longPct ?? "—"}L/${shortPct ?? "—"}S — thin counter-direction evidence`);
  if (scored.length >= 2 && snapshotPct !== null && snapshotPct < 80)
    warnings.push(`deploy snapshots complete on ${snapshotPct}% of the cohort — factor attribution degraded`);
  if (clusterCount >= 2) warnings.push(`${clusterCount} records issued inside the ${spacingMin}min rail — burst cluster, correlated samples`);
  if (settledRaw >= 3 && healthyPct !== null && healthyPct < HEALTH_FLOOR)
    warnings.push(`healthy ${healthyPct}% below the ${HEALTH_FLOOR}% R6 floor`);

  // ── R6 gate verdict — v10.9.1 EPOCH-WINDOWED ──
  // Blocker 1 (structural, whole-cohort): snapshot integrity — era-independent.
  // Blocker 2 (regime, epoch window): window informative ratio below the GREEN
  // bar, only judged once the window carries enough settled rows (≥20) to be
  // statistically meaningful; below the warn-n the window is guarded, not
  // punished (small-sample informative dips are noise, not censoring).
  const blockers: string[] = [];
  const winSettled = postSettled.length;
  const winHealthyPct = pct(postSettled.filter((s) => s.cls === "HEALTHY").length, winSettled);
  if (scored.length >= 2 && snapshotPct !== null && snapshotPct < 50) blockers.push(`snapshots complete on only ${snapshotPct}%`);
  if (winSettled >= GATE_WINDOW_WARN_N && postInformativePct !== null && postInformativePct < GATE_WINDOW_INFORMATIVE)
    blockers.push(`epoch-window informative ${postInformativePct}% < 50% (n=${winSettled}) — censoring regime`);

  const verdict: GateVerdict =
    settledRaw === 0 || winSettled < GATE_WINDOW_FORMING
      ? "WARMING" // honest: the window has nothing meaningful to grade yet
      : blockers.length > 0
        ? "RED"
        : winSettled < GATE_WINDOW_MIN_N || (winHealthyPct !== null && winHealthyPct < HEALTH_FLOOR)
          ? "AMBER" // window formed but short of the GREEN bar or the health floor
          : "GREEN";

  // UI samples view: settled cohort first (newest first), then in-flight
  const desc = [...scored].reverse();
  const samples = [...desc.filter((s) => s.settled), ...desc.filter((s) => !s.settled)].slice(0, 12);

  const digest: RawcalQualityDigest = {
    at: new Date().toISOString(),
    issuedTotal: scored.length,
    openRaw,
    settledRaw,
    healthy,
    review,
    censored,
    healthyPct,
    informativePct,
    expiredNoTouch,
    expiryCauses,
    snapshotPct,
    symbols,
    topSymbolShare: topSymbolShare !== null ? round1(topSymbolShare) : null,
    longPct,
    shortPct,
    meanAbsPnl,
    meanHoldMin,
    clusterCount,
    warnings: warnings.slice(0, 5),
    gate: {
      verdict,
      healthFloor: HEALTH_FLOOR,
      blockers,
      window: { since: postFilterCohort.since, settled: winSettled, healthyPct: winHealthyPct, informativePct: postInformativePct },
    },
    postFilterCohort,
    samples,
  };
  qualityCache = { at: Date.now(), data: digest };
  return digest;
}

/** One-line data-health read for the central intelligence (ai-memory / governor). */
export function r6GateLine(d: RawcalQualityDigest): string {
  const w = d.gate.window;
  const base =
    `R6 DATA HEALTH (v10.9.1 epoch-windowed gate — verdict anchors the post-filter window, blended ratios reported for the whole book): raw cohort ${d.settledRaw} settled/${d.issuedTotal} issued · blended healthy ${d.healthyPct ?? "—"}% (floor ${d.gate.healthFloor}) · blended informative ${d.informativePct ?? "—"}% · snapshots ${d.snapshotPct ?? "—"}% · GATE ${d.gate.verdict}` +
    (w ? ` — window n=${w.settled} informative ${w.informativePct ?? "—"}% healthy ${w.healthyPct ?? "—"}%` : "") +
    (d.gate.verdict === "WARMING" ? " (window still forming — grading starts at the first window settles)" : "") +
    (d.gate.blockers.length ? ` · blockers: ${d.gate.blockers.join("; ")}` : "");
  const causes =
    d.expiryCauses && d.expiryCauses.wrongSide + d.expiryCauses.noFollow + d.expiryCauses.mixed > 0
      ? ` · expiry causes: wrong-side ${d.expiryCauses.wrongSide} / no-follow ${d.expiryCauses.noFollow} / mixed ${d.expiryCauses.mixed} (of ${d.expiredNoTouch} no-touch)`
      : "";
  const post =
    d.postFilterCohort && d.postFilterCohort.n > 0
      ? ` · post-filter cohort n=${d.postFilterCohort.n} (settled ${d.postFilterCohort.settled}) informative ${d.postFilterCohort.informativePct ?? "—"}% expiry ${d.postFilterCohort.expiryRatePct ?? "—"}%`
      : "";
  return base + causes + post + (d.warnings.length ? ` — watch: ${d.warnings[0]}` : " — no issues");
}

/** Compact digest for EngineSetting persistence (no samples array). */
function compact(d: RawcalQualityDigest): CompactDigest {
  const { samples: _samples, ...rest } = d;
  void _samples;
  return rest;
}

/**
 * Tick hook — engine.ts calls this every 20 ticks (fire-and-forget).
 * 10min journal cadence, FORCED the moment the settled-raw count moves so the
 * quality curve reacts to every settle. Persists the compact digest to
 * EngineSetting "rawcal.quality" + a QUALITY row in the telemetry JSONL.
 */
export async function recordRawcalQuality(): Promise<RawcalQualityDigest | null> {
  try {
    const digest = await computeRawcalQuality();
    const changed = digest.settledRaw !== lastSeenSettled;
    if (!changed && Date.now() - lastJournalAt < 10 * 60_000) return null;
    lastJournalAt = Date.now();
    lastSeenSettled = digest.settledRaw;

    const c = compact(digest);
    await db.engineSetting
      .upsert({ where: { key: QUALITY_KEY }, create: { key: QUALITY_KEY, value: JSON.stringify(c) }, update: { value: JSON.stringify(c) } })
      .catch(() => undefined);

    try {
      await fs.mkdir(path.dirname(RAWCAL_TELEMETRY_FILE), { recursive: true });
      const row = {
        kind: "QUALITY",
        t: digest.at,
        issued: digest.issuedTotal,
        settled: digest.settledRaw,
        healthyPct: digest.healthyPct,
        informativePct: digest.informativePct,
        snapshotPct: digest.snapshotPct,
        gate: digest.gate.verdict,
        warns: digest.warnings.length,
      };
      await fs.appendFile(RAWCAL_TELEMETRY_FILE, JSON.stringify(row) + "\n", "utf8");
      // opportunistic trim (same policy as the pace journal)
      const st = await fs.stat(RAWCAL_TELEMETRY_FILE).catch(() => null);
      if (st && st.size > MAX_JOURNAL_ROWS * 180) {
        const txt = await fs.readFile(RAWCAL_TELEMETRY_FILE, "utf8").catch(() => "");
        const lines = txt.split("\n").filter(Boolean).slice(-MAX_JOURNAL_ROWS);
        await fs.writeFile(RAWCAL_TELEMETRY_FILE, lines.join("\n") + "\n", "utf8").catch(() => undefined);
      }
    } catch {
      /* journal best-effort */
    }
    return digest;
  } catch (e) {
    console.error("[rawcal-quality] record failed", e);
    return null;
  }
}

/** Read the persisted compact digest (cross-process consumers, e.g. governor). */
export async function readPersistedQuality(): Promise<CompactDigest | null> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: QUALITY_KEY } });
    if (!row) return null;
    return JSON.parse(row.value) as CompactDigest;
  } catch {
    return null;
  }
}
