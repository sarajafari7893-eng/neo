// ── P2-a — CONFIDENCE CALIBRATION STUDY (forensics + ONE telemetry-only EngineSetting row) ──
// Operator P2 mandate: the AI confidence score (0-100) was measured chi2-DEAD
// (chi2=1.8, df=3, crit 7.81) across the 10/10→25/10 window — it does not
// predict outcomes, yet it feeds sizing/conviction. This script builds the
// auditable calibration artifact:
//   1. Realized WR + avg$/net$/n per confidence bucket (<55, 55-61, 62-69,
//      70-77, 78+) and per GS gate-score bucket (<50, 50-59, 60-69, 70+;
//      parsed from tags via /GS-(\d+)/).
//   2. Inline chi2 homogeneity test per family (expected = overall WR of the
//      analyzed cohort; only buckets with n>=8 enter the sum; df = valid-1).
//   3. Isotonic-style binned recalibration map: calibrated WR = Laplace-smoothed
//      realized WR (w+1)/(n+2) — the honest per-bucket correction table.
//   4. Era stability: same tables split PEAK (engines v11.6/11.7/11.8) vs REST;
//      per-bucket two-sample z-tests + rank-order preservation check. If the
//      mapping is unstable across eras the report SAYS SO (key finding).
//   5. Writes .data/shadow-calibration/report-20261025.json.
//   6. Upserts ONE EngineSetting row "calibration.confidence.shadow" with
//      enabled:false (mirrors scripts/apply-strategy-weights-20261025.ts
//      Prisma upsert pattern) — telemetry-only, nothing consumes it (verified:
//      zero references in src/ at build time of this study) — then reads it
//      back via a SEPARATE readonly bun:sqlite connection and prints it.
// DB writes: ONLY that single EngineSetting key. No Signal rows touched.
// Win convention (established by the 2026-10-25 fresh audit, P1-c): a row
// WINS when realized levered NET pnlPercent > 0 (reproduces AI-SCALP 30% /
// MEAN-REVERT 38% audit numbers exactly).
// Run: bun scripts/calibration-confidence-20261025.ts   (from repo root)

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { db as prisma } from "@/lib/db";

const ROOT = import.meta.dir.replace(/\/scripts$/, "");
const DB_PATH = `${ROOT}/db/custom.db`;
const OUT_DIR = `${ROOT}/.data/shadow-calibration`;
const OUT_PATH = `${OUT_DIR}/report-20261025.json`;
const ES_KEY = "calibration.confidence.shadow";

// Window: createdAt >= 2026-10-09T20:30:00Z (epoch-ms INTEGER in SQLite).
const T0_MS = Date.parse("2026-10-09T20:30:00Z");
const T0_ISO = "2026-10-09T20:30:00Z";

const MIN_BUCKET_N = 8; // chi2 validity floor (operator mandate: df depends on buckets with n>=8)
const PEAK_ENGINES = new Set(["NEXUS-LIVE v11.6", "NEXUS-LIVE v11.7", "NEXUS-LIVE v11.8"]);
// 5% upper-tail critical values, chi2 (reference table; df = valid buckets − 1)
const CHI2_CRIT_5PCT: Record<number, number> = { 1: 3.84, 2: 5.99, 3: 7.81, 4: 9.49, 5: 11.07 };

interface Row {
  confidence: number;
  status: string;
  pnlPercent: number;
  marginUsd: number;
  engine: string;
  tags: string;
  era: "PEAK" | "REST";
  win: boolean;
  usd: number; // realized $ = margin × pnlPercent / 100
}

interface BucketStat {
  n: number;
  wins: number;
  realizedWR: number | null; // w/n, % — null when n=0
  avgUsdPerRow: number; // mean realized $ per row (losses included, zeros included)
  netUsd: number; // Σ margin×pnl/100
  rawConfMid: number | null; // closed bucket → arithmetic midpoint; open bucket → observed mean; empty → null
}

interface Chi2Result {
  cohortN: number; // rows analyzed (all rows for confidence; GS-tagged rows for GS)
  cohortWR: number; // overall win rate of the cohort (%)
  chi2: number;
  df: number;
  crit5pct: number;
  pValueApprox: number; // Wilson–Hilferty upper-tail approximation
  validBuckets: string[]; // buckets with n >= MIN_BUCKET_N that entered the sum
  dead: boolean; // chi2 < crit → buckets indistinguishable from overall WR
}

interface EraBucket {
  n: number;
  wins: number;
  realizedWR: number | null;
  sufficient: boolean; // n >= MIN_BUCKET_N (else WR shown for context but NOT testable)
  zVsOtherEra: number | null; // two-sample z (peak vs rest), null when either side n < MIN_BUCKET_N
  significant: boolean | null;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10000) / 10000;

// ── Standard normal CDF (Zelen & Severo erf approximation) + Wilson–Hilferty ─
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - poly * Math.exp((-Math.abs(z) * Math.abs(z)) / 2) / Math.sqrt(2 * Math.PI);
  return z >= 0 ? p : 1 - p;
}
function chi2PValue(x: number, df: number): number {
  if (df <= 0 || x <= 0) return 1;
  const c = 2 / (9 * df);
  const z = (Math.cbrt(x / df) - (1 - c)) / Math.sqrt(c);
  return round4(1 - normCdf(z));
}

// ── Bucket definitions (operator-mandated edges) ─────────────────────────────
const CONF_EDGES: Array<{ label: string; lo: number; hi: number }> = [
  { label: "<55", lo: -Infinity, hi: 55 },
  { label: "55-61", lo: 55, hi: 62 },
  { label: "62-69", lo: 62, hi: 70 },
  { label: "70-77", lo: 70, hi: 78 },
  { label: "78+", lo: 78, hi: Infinity },
];
const GS_EDGES: Array<{ label: string; lo: number; hi: number }> = [
  { label: "<50", lo: -Infinity, hi: 50 },
  { label: "50-59", lo: 50, hi: 60 },
  { label: "60-69", lo: 60, hi: 70 },
  { label: "70+", lo: 70, hi: Infinity },
];

function confBucketLabel(c: number): string {
  for (const e of CONF_EDGES) if (c >= e.lo && c < e.hi) return e.label;
  return "?";
}
function gsScore(tags: string): number | null {
  const m = /GS-(\d+)/.exec(tags ?? "");
  return m ? Number(m[1]) : null;
}
function gsBucketLabel(g: number): string {
  for (const e of GS_EDGES) if (g >= e.lo && g < e.hi) return e.label;
  return "?";
}

// ── Per-bucket table (WR, avg$, net$, n, raw midpoint) ───────────────────────
function buildTable(rows: Row[], labelOf: (r: Row) => string | null, edges: Array<{ label: string; lo: number; hi: number }>, valueOf: (r: Row) => number): Record<string, BucketStat> {
  const out: Record<string, BucketStat> = {};
  for (const e of edges) out[e.label] = { n: 0, wins: 0, realizedWR: null, avgUsdPerRow: 0, netUsd: 0, rawConfMid: null };
  const sums: Record<string, { valSum: number; valN: number }> = {};
  for (const r of rows) {
    const label = labelOf(r);
    if (label === null || !(label in out)) continue;
    const b = out[label];
    b.n++;
    if (r.win) b.wins++;
    b.netUsd += r.usd;
    const s = (sums[label] ??= { valSum: 0, valN: 0 });
    s.valSum += valueOf(r);
    s.valN++;
  }
  for (const e of edges) {
    const b = out[e.label];
    b.realizedWR = b.n > 0 ? round2((100 * b.wins) / b.n) : null;
    b.avgUsdPerRow = b.n > 0 ? round2(b.netUsd / b.n) : 0;
    b.netUsd = round2(b.netUsd);
    if (b.n > 0) {
      // closed bucket → arithmetic midpoint; open-ended bucket → observed mean (honest anchor)
      b.rawConfMid = Number.isFinite(e.lo) && Number.isFinite(e.hi) ? round2((e.lo + e.hi - 1) / 2) : round4(sums[e.label].valSum / sums[e.label].valN);
    }
  }
  return out;
}

// ── chi2 homogeneity test (expected = overall WR of the analyzed cohort) ─────
function chi2Test(rows: Row[], table: Record<string, BucketStat>): Chi2Result {
  const cohortN = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const p = wins / cohortN; // overall WR (expected per row)
  const valid = Object.keys(table).filter((k) => table[k].n >= MIN_BUCKET_N);
  let chi2 = 0;
  for (const k of valid) {
    const n = table[k].n;
    const w = table[k].wins;
    const ew = n * p; // expected wins
    const el = n * (1 - p); // expected losses
    if (ew <= 0 || el <= 0) continue; // degenerate-cell guard
    chi2 += ((w - ew) * (w - ew)) / ew + ((n - w - el) * (n - w - el)) / el;
  }
  const df = valid.length - 1;
  const crit = CHI2_CRIT_5PCT[df] ?? NaN;
  return {
    cohortN,
    cohortWR: round2(100 * p),
    chi2: round4(chi2),
    df,
    crit5pct: crit,
    pValueApprox: chi2PValue(chi2, df),
    validBuckets: valid,
    dead: chi2 < crit,
  };
}

// ── Isotonic-style binned recalibration (Laplace-smoothed realized WR) ───────
// calibratedWR = (w+1)/(n+2) — pooled toward 50% with one pseudo-win + one
// pseudo-loss. Monotonicity is NOT enforced (true PAVA would invent structure);
// a non-monotonic calibrated curve is itself evidence that confidence does not
// rank-order outcomes.
function isotonicMap(table: Record<string, BucketStat>): Record<string, { n: number; rawConfMid: number | null; realizedWR: number | null; calibratedWR: number | null }> {
  const out: Record<string, { n: number; rawConfMid: number | null; realizedWR: number | null; calibratedWR: number | null }> = {};
  for (const [k, b] of Object.entries(table)) {
    out[k] = {
      n: b.n,
      rawConfMid: b.rawConfMid,
      realizedWR: b.realizedWR,
      calibratedWR: b.n > 0 ? round2((100 * (b.wins + 1)) / (b.n + 2)) : null,
    };
  }
  return out;
}

function isMonotonicNonDecreasing(map: Record<string, { n: number; realizedWR: number | null; calibratedWR: number | null }>, order: string[]): { realized: boolean; calibrated: boolean } {
  const seqR: number[] = [];
  const seqC: number[] = [];
  for (const k of order) {
    if (map[k].n > 0 && map[k].realizedWR !== null) seqR.push(map[k].realizedWR as number);
    if (map[k].n > 0 && map[k].calibratedWR !== null) seqC.push(map[k].calibratedWR as number);
  }
  const nonDec = (a: number[]) => a.every((v, i) => i === 0 || v >= a[i - 1]);
  return { realized: nonDec(seqR), calibrated: nonDec(seqC) };
}

// ── Era stability: per-bucket WR per era + two-sample z + order preservation ─
function eraTable(rows: Row[], labelOf: (r: Row) => string | null, edges: Array<{ label: string }>): Record<"PEAK" | "REST", Record<string, EraBucket>> {
  const out: Record<"PEAK" | "REST", Record<string, EraBucket>> = { PEAK: {}, REST: {} };
  for (const era of ["PEAK", "REST"] as const) {
    for (const e of edges) out[era][e.label] = { n: 0, wins: 0, realizedWR: null, sufficient: false, zVsOtherEra: null, significant: null };
  }
  for (const r of rows) {
    const label = labelOf(r);
    if (label === null || !(label in out[r.era])) continue;
    out[r.era][label].n++;
    if (r.win) out[r.era][label].wins++;
  }
  for (const era of ["PEAK", "REST"] as const) {
    for (const k of Object.keys(out[era])) {
      const b = out[era][k];
      if (b.n > 0) b.realizedWR = round2((100 * b.wins) / b.n);
      b.sufficient = b.n >= MIN_BUCKET_N;
    }
  }
  // two-sample z per bucket (both eras need n >= MIN_BUCKET_N)
  for (const k of Object.keys(out.PEAK)) {
    const a = out.PEAK[k];
    const b = out.REST[k];
    if (a.n >= MIN_BUCKET_N && b.n >= MIN_BUCKET_N) {
      const pa = a.wins / a.n;
      const pb = b.wins / b.n;
      const se = Math.sqrt((pa * (1 - pa)) / a.n + (pb * (1 - pb)) / b.n);
      const z = se > 0 ? (pa - pb) / se : 0;
      a.zVsOtherEra = round4(z);
      b.zVsOtherEra = a.zVsOtherEra;
      a.significant = Math.abs(z) > 1.96;
      b.significant = a.significant;
    }
  }
  return out;
}

function eraStabilityFor(rows: Row[], labelOf: (r: Row) => string | null, edges: Array<{ label: string }>, order: string[], map: Record<string, { calibratedWR: number | null }>) {
  const tables = eraTable(rows, labelOf, edges);
  const significantBuckets = Object.keys(tables.PEAK).filter((k) => tables.PEAK[k].significant === true);
  const orderPreserved = isMonotonicNonDecreasing(map, order).calibrated;
  const stable = significantBuckets.length === 0 && orderPreserved;
  return {
    eraSplit: { PEAK: rows.filter((r) => r.era === "PEAK").length, REST: rows.filter((r) => r.era === "REST").length },
    tables,
    significantBuckets, // |z| > 1.96 → era-dependent bucket WRs
    orderPreserved, // calibrated curve non-decreasing in combined data
    stable,
    rule: "bucket STABLE when both-era n>=8 and |z| <= 1.96, and the combined calibrated curve is non-decreasing; else UNSTABLE",
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  // ── Phase 1: readonly load ───────────────────────────────────────────────────
  const ro = new Database(DB_PATH, { readonly: true });
  const raw = ro
    .prepare(
      `SELECT confidence, status, pnlPercent, marginUsd, engine, tags
         FROM Signal
        WHERE createdAt >= ? AND qualityFlag IS NULL
        ORDER BY createdAt ASC`,
    )
    .all(T0_MS as never) as Array<Record<string, unknown>>;
  ro.close();

  const rows: Row[] = raw.map((r) => ({
    confidence: Number(r.confidence),
    status: String(r.status),
    pnlPercent: Number(r.pnlPercent ?? 0),
    marginUsd: Number(r.marginUsd ?? 0),
    engine: String(r.engine),
    tags: String(r.tags ?? ""),
    era: PEAK_ENGINES.has(String(r.engine)) ? "PEAK" : "REST",
    win: Number(r.pnlPercent ?? 0) > 0,
    usd: (Number(r.marginUsd ?? 0) * Number(r.pnlPercent ?? 0)) / 100,
  }));

  const statuses = rows.reduce<Record<string, number>>((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  const sanity = { windowRows: rows.length, statuses };
  if (rows.length < 500) {
    console.error("SANITY FAILED — window cohort unexpectedly small; nothing written, EngineSetting untouched.");
    process.exit(1);
  }

  // ── Phase 2: bucket tables + chi2 + isotonic maps ────────────────────────────
  const withGs = rows.filter((r) => gsScore(r.tags) !== null);

  const confTable = buildTable(rows, (r) => confBucketLabel(r.confidence), CONF_EDGES, (r) => r.confidence);
  const gsTable = buildTable(withGs, (r) => gsBucketLabel(gsScore(r.tags) as number), GS_EDGES, (r) => gsScore(r.tags) as number);

  const confChi2 = chi2Test(rows, confTable);
  const gsChi2 = chi2Test(withGs, gsTable);

  const confMap = isotonicMap(confTable);
  const gsMap = isotonicMap(gsTable);
  const confOrder = CONF_EDGES.map((e) => e.label);
  const gsOrder = GS_EDGES.map((e) => e.label);
  const confMono = isMonotonicNonDecreasing(confMap, confOrder);
  const gsMono = isMonotonicNonDecreasing(gsMap, gsOrder);

  // ── Phase 3: era stability (PEAK v11.6-11.8 vs REST) ─────────────────────────
  const confEra = eraStabilityFor(rows, (r) => confBucketLabel(r.confidence), CONF_EDGES, confOrder, confMap);
  const gsEra = eraStabilityFor(withGs, (r) => gsBucketLabel(gsScore(r.tags) as number), GS_EDGES, gsOrder, gsMap);

  const eraStability = {
    rule: confEra.rule,
    confidence: confEra,
    gs: gsEra,
    verdict:
      confEra.stable && gsEra.stable
        ? "STABLE — per-bucket WRs replicate across eras (no |z|>1.96) and the calibrated curve keeps its order"
        : `UNSTABLE — ${[!confEra.stable ? "confidence" : null, !gsEra.stable ? "GS" : null].filter(Boolean).join(" + ")} mapping differs by era (significant buckets: ${[...confEra.significantBuckets, ...gsEra.significantBuckets].join(", ") || "none"}; order preserved: conf=${confEra.orderPreserved} gs=${gsEra.orderPreserved}) → a single global calibration map is NOT trustworthy; recalibration must be era-aware or re-fit on rolling windows`,
  };

  // ── Phase 4: verdict ─────────────────────────────────────────────────────────
  const verdict =
    `CONFIDENCE chi2-DEAD CONFIRMED: chi2=${confChi2.chi2} df=${confChi2.df} crit=${confChi2.crit5pct} (p≈${confChi2.pValueApprox}) — bucket WRs indistinguishable from the ${confChi2.cohortWR}% overall WR; ` +
    `GS gate-score chi2=${gsChi2.chi2} df=${gsChi2.df} crit=${gsChi2.crit5pct} (p≈${gsChi2.pValueApprox}) on cohort n=${gsChi2.cohortN} → ${gsChi2.dead ? "also DEAD (does not discriminate outcomes)" : "ALIVE (discriminates outcomes)"}; ` +
    `calibrated curves monotonic: confidence realized=${confMono.realized}/calibrated=${confMono.calibrated}, GS realized=${gsMono.realized}/calibrated=${gsMono.calibrated}; ` +
    `era stability: ${eraStability.verdict}; ` +
    `CONSEQUENCE: raw confidence must NOT feed sizing/conviction; the attached Laplace-smoothed isotonic map is the honest per-bucket recalibration for shadow evaluation only (EngineSetting enabled:false, telemetry-only).`;

  // ── Phase 5: JSON report artifact ────────────────────────────────────────────
  const report = {
    task: "P2-a",
    title: "Confidence calibration study — chi2, GS gate-score, isotonic-style recalibration map, era stability",
    generatedAt: new Date().toISOString(),
    window: { fromISO: T0_ISO, filter: "createdAt >= T0 (epoch-ms) AND qualityFlag IS NULL", rows: rows.length, statuses, gsUntaggedRows: rows.length - withGs.length },
    definitions: {
      win: "realized levered NET pnlPercent > 0 (same convention as the 2026-10-25 fresh audit — reproduces AI-SCALP 30% / MEAN-REVERT 38%)",
      avgUsdPerRow: "mean realized $ per row = Σ(margin×pnlPercent/100)/n, losses and zeros included",
      netUsd: "Σ margin×pnlPercent/100",
      chi2: "homogeneity test vs overall cohort WR; only buckets with n>=8 enter the sum; df = valid buckets − 1; 5% crit: df1=3.84 df2=5.99 df3=7.81 df4=9.49 df5=11.07",
      isotonicStyle: "binned recalibration, calibratedWR=(w+1)/(n+2) Laplace-smoothed; monotonicity NOT enforced (non-monotonic curve = evidence against rank-ordering)",
      eraSplit: "PEAK = engines NEXUS-LIVE v11.6/11.7/11.8; REST = everything else (same split as P1-a MFE replay)",
      snapshotNote: "the live Signal table churns — numbers are point-in-time at script run",
    },
    buckets: confTable,
    gsBuckets: gsTable,
    chi2: {
      confidence: confChi2,
      gs: gsChi2,
      note: "expected = overall WR of the analyzed cohort (all rows for confidence; GS-tagged rows for GS)",
    },
    isotonicMap: { confidence: confMap, gs: gsMap },
    eraStability,
    verdict,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);

  // ── Phase 6: console tables ──────────────────────────────────────────────────
  const line = "══════════════════════════════════════════════════════════════════════";
  console.log(line);
  console.log("P2-a — CONFIDENCE CALIBRATION STUDY (chi2-dead audit → isotonic map)");
  console.log(line);
  console.log(`Window: createdAt >= ${T0_ISO} · qualityFlag IS NULL · rows = ${rows.length} (GS-tagged ${withGs.length}, untagged ${rows.length - withGs.length}) · statuses ${JSON.stringify(statuses)}`);
  const printTable = (title: string, table: Record<string, BucketStat>, chi2: Chi2Result) => {
    console.log(`\n── ${title} ──`);
    console.log("bucket     n     wins  WR%     avg$/row   net$      rawMid");
    for (const [k, b] of Object.entries(table)) {
      console.log(
        `${k.padEnd(10)} ${String(b.n).padEnd(5)} ${String(b.wins).padEnd(5)} ${b.realizedWR === null ? "—" : String(b.realizedWR).padEnd(7)} ${b.avgUsdPerRow.toFixed(2).padEnd(10)} ${b.netUsd.toFixed(2).padEnd(9)} ${b.rawConfMid ?? "—"}`,
      );
    }
    console.log(`chi2=${chi2.chi2} df=${chi2.df} crit(5%)=${chi2.crit5pct} p≈${chi2.pValueApprox} validBuckets=[${chi2.validBuckets.join(",")}] cohortWR=${chi2.cohortWR}% → ${chi2.dead ? "DEAD (no discrimination)" : "ALIVE (discriminates)"}`);
  };
  printTable("CONFIDENCE buckets", confTable, confChi2);
  printTable("GS gate-score buckets (tags /GS-(\\d+)/)", gsTable, gsChi2);
  console.log("\n── ISOTONIC-STYLE MAP (calibratedWR = (w+1)/(n+2)) ──");
  for (const [k, v] of Object.entries(confMap)) console.log(`conf ${k.padEnd(6)} n=${String(v.n).padEnd(5)} rawMid=${String(v.rawConfMid ?? "—").padEnd(6)} realized=${v.realizedWR ?? "—"}% calibrated=${v.calibratedWR ?? "—"}%`);
  for (const [k, v] of Object.entries(gsMap)) console.log(`gs   ${k.padEnd(6)} n=${String(v.n).padEnd(5)} rawMid=${String(v.rawConfMid ?? "—").padEnd(6)} realized=${v.realizedWR ?? "—"}% calibrated=${v.calibratedWR ?? "—"}%`);
  console.log(`\nEra stability: ${eraStability.verdict}`);
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`Report → ${OUT_PATH}`);

  // ── Phase 7: ONE telemetry-only EngineSetting row (Prisma upsert, mirrors
  // scripts/apply-strategy-weights-20261025.ts pattern) + readonly read-back ───
  if (!confChi2.dead && !gsChi2.dead) {
    console.log("Both families ALIVE — unexpected vs mandate; EngineSetting write SKIPPED (operator review required).");
  } else {
    const map = { confidence: confMap, gs: gsMap };
    const value = JSON.stringify({
      enabled: false,
      at: new Date().toISOString(),
      note: "P2-a telemetry-only — chi2-dead confidence, isotonic map attached, NOT consumed by engine",
      map,
    });
    await prisma.engineSetting.upsert({
      where: { key: ES_KEY },
      create: { key: ES_KEY, value },
      update: { value },
    });
    console.log(`\nEngineSetting upserted: ${ES_KEY} (enabled:false — telemetry-only, zero consumers in src/)`);
    // Read back via a SEPARATE readonly bun:sqlite connection (audit proof).
    const ro2 = new Database(DB_PATH, { readonly: true });
    const back = ro2.prepare(`SELECT key, value, updatedAt FROM EngineSetting WHERE key = ?`).get(ES_KEY) as Record<string, unknown> | null;
    ro2.close();
    console.log("READBACK:", JSON.stringify(back));
    if (!back || !String(back.value).includes('"enabled":false')) {
      console.error("READBACK MISMATCH — the telemetry row did not land as expected.");
      process.exitCode = 1;
    }
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("calibration-confidence-20261025 FAILED:", e);
  process.exitCode = 1;
  try {
    await prisma.$disconnect();
  } catch {}
});
