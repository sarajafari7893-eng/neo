// ── P1-a — SHADOW MFE-CAPTURE REPLAY (forensics-only, READ-ONLY) ─────────────
// Operator mandate 2026-10-25 (15-day audit follow-up): signals capture only 22%
// (peak era) / 2% (rest) of their max favorable excursion (MFE). This script
// quantifies, as a FIRST-ORDER counterfactual, what a better harvest ladder
// (alternate TP1-fire thresholds + BE-BANK evidence) would have captured.
//
// STRICT READ-ONLY: bun:sqlite { readonly: true }, zero DB writes, zero source
// changes. The only artifact written is .data/shadow-mfe/report-20261025.json.
//
// ── LADDER SEMANTICS (REAL weights extracted from the codebase) ──────────────
// · src/lib/accounting.ts:47  LADDER_TRANCHES = { tp1: 0.5, tp2: 0.3, runner: 0.2 }
//   → W_TP1 = 0.50 banks at the TP1 rung, W_TP2 = 0.30 at TP2, W_TP3(runner) = 0.20
//   rides to TP3 (sums to exactly 1). Consumed by engine.ts resolveSignals
//   (v6.6 tranche-aware settlement: every close after a banked rung is
//   tranche-weighted at its real rung exit).
// · "TP1-R55" (worklog OP-TP-RERANK-1020, v12.6): the TP1 RUNG DISTANCE moved
//   from 1R to 0.55R (gate knob tp1RMult=0.55, cohort tag TP1-R55). It changes
//   WHERE the rung sits, NOT the tranche weights.
// · v11.2 BE-BANK (engine.ts): when the BE arm fires (structural 0.5×SLdist /
//   +1.5% price ceiling) on an UNBANKED signal, beBankFrac = 0.25 of the position
//   banks at the arm mark (recorded UNLEVERED as beBankedMovePct + beBankedFrac).
//   Post-bank, the ladder RESCALES by (1−f_b): TP1 tranche = W_TP1×(1−f_b) of the
//   full book, TP2 = W_TP2×(1−f_b), runner = W_TP3×(1−f_b) — engine.ts
//   resolveSignals tranches block (remain = 1 − f_b multiplier on LADDER_TRANCHES).
// · pnlPercent on each row = realized LEVERED NET % (margin-relative).
//   maxPnlPercent = best levered NET % during life (= MFE, already levered).
//   beBankedMovePct = UNLEVERED move % at the BE arm (× leverage → levered space).
//
// ── SHADOW MODEL (first-order, per row, levered NET % space, fees ignored) ───
// For alternate TP1-fire threshold T (levered NET %):
//   if MFE < T            → the scenario never fires; the signal runs exactly
//                            as it actually did (terminal pnlPercent, full size).
//   if MFE ≥ T            → the T-rung banks the TP1 tranche at T%, and the
//                            remaining book realizes at the row's ACTUAL terminal
//                            pnlPercent scaled proportionally:
//     · row WITHOUT BE-bank (f_b = 0):
//         est = W_TP1×T + (1−W_TP1)×pnl×(1/(1−W_TP1))   ≡ 0.5×T + pnl
//     · row WITH BE-bank (f_b = 0.25 recorded) — beBankedFrac is the FIRST
//       tranche evidence; the T-rung then applies to the post-bank book using
//       the real engine rescale:
//         est = f_b×(beBankedMovePct×lev) + W_TP1×(1−f_b)×T
//               + (1−f_b)×(1−W_TP1)×pnl×(1/(1−W_TP1))
//             = 0.25×mBE_lev + 0.375×T + 0.75×pnl      (at f_b=0.25)
//
// ── HONESTY / LIMITATIONS (stated in the report too) ─────────────────────────
// 1. maxPnlPercent is a SINGLE MAX, not a full price path: we cannot know the
//    drawdown after the T-fire, whether TP2/runner would still be touched, or
//    the order of MFE vs terminal. The remaining book is proxied by the row's
//    actual terminal pnlPercent (path-blind, per the task formula).
// 2. OPTIMISM BIAS: for rows whose actual pnlPercent already embeds banked
//    tranches (reachedTp ≥ 1 or BE-banked), the "remaining book = actual
//    terminal pnl" term re-earns those banked dollars on the remaining
//    fraction — the estimate is an upper-first-order bound, not a prediction.
// 3. FEES ARE IGNORED: the T-bank and the BE-bank are treated as NET fills;
//    more exit fills would in reality add taker fees + funding. Actual
//    pnlPercent is NET, so est is slightly flattered.
// 4. Slippage/fill risk at the T-rung is assumed zero (banked exactly at T).
// 5. BE-bank tranche priced at the RECORDED arm mark (beBankedMovePct×lev) —
//    evidence, not simulation.
// 6. SANITY: at T beyond every row's MFE no scenario fires and est collapses to
//    the actual ledger bit-for-bit (verified at runtime before reporting).

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";

const ROOT = import.meta.dir.replace(/\/scripts$/, "");
const DB_PATH = `${ROOT}/db/custom.db`;
const OUT_PATH = `${ROOT}/.data/shadow-mfe/report-20261025.json`;

// Window: createdAt >= 2026-10-09T20:30:00Z (stored as epoch ms INTEGER in SQLite).
const T0_MS = Date.parse("2026-10-09T20:30:00Z");

// Real ladder weights (src/lib/accounting.ts LADDER_TRANCHES — fractions sum to 1).
const W_TP1 = 0.5;
const W_TP2 = 0.3;
const W_TP3_RUNNER = 0.2;
const BE_BANK_FRAC_DEFAULT = 0.25; // gate-settings.ts beBankFrac default (v11.2)

const SCENARIOS = [20, 30, 40, 50, 60]; // alternate TP1-fire thresholds, levered NET %
const T_SANITY = 1e9; // beyond every MFE → must collapse to the actual ledger

const PEAK_ENGINES = new Set(["NEXUS-LIVE v11.6", "NEXUS-LIVE v11.7", "NEXUS-LIVE v11.8"]);

interface SigRow {
  id: string;
  symbol: string;
  engine: string;
  era: "PEAK" | "REST";
  status: string;
  reachedTp: number;
  marginUsd: number;
  leverage: number;
  pnlPercent: number;
  maxPnlPercent: number;
  beBankedFrac: number | null;
  beBankedMovePct: number | null;
}

interface EraResult {
  era: "PEAK" | "REST" | "COMBINED";
  T: number | null; // null = ACTUAL baseline (no scenario)
  scenario: string;
  n: number; // rows in era
  fired: number; // rows with MFE >= T (scenario fired)
  estNet: number; // estimated net $ (shadow)
  actNet: number; // actual net $ (ledger)
  delta: number; // estNet − actNet
  keptPct: number; // estNet / mfeNet × 100 (kept-MFE%)
  actKeptPct: number; // actNet / mfeNet × 100 (reference)
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round1 = (x: number) => Math.round(x * 10) / 10;
const fmtUsd = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;

// ── Load CLEAN window signals (READ-ONLY connection) ─────────────────────────
const db = new Database(DB_PATH, { readonly: true });
const rowsRaw = db
  .prepare(
    `SELECT id, symbol, engine, status, reachedTp, marginUsd, leverage,
            pnlPercent, maxPnlPercent, beBankedFrac, beBankedMovePct
       FROM Signal
      WHERE createdAt >= ? AND qualityFlag IS NULL
      ORDER BY createdAt ASC`,
  )
  .all(T0_MS as never) as Array<Record<string, unknown>>;
db.close();

const rows: SigRow[] = rowsRaw.map((r) => ({
  id: String(r.id),
  symbol: String(r.symbol),
  engine: String(r.engine),
  era: PEAK_ENGINES.has(String(r.engine)) ? "PEAK" : "REST",
  status: String(r.status),
  reachedTp: Number(r.reachedTp ?? 0),
  marginUsd: Number(r.marginUsd ?? 0),
  leverage: Number(r.leverage ?? 1),
  pnlPercent: Number(r.pnlPercent ?? 0),
  maxPnlPercent: Number(r.maxPnlPercent ?? 0),
  beBankedFrac: r.beBankedFrac === null || r.beBankedFrac === undefined ? null : Number(r.beBankedFrac),
  beBankedMovePct: r.beBankedMovePct === null || r.beBankedMovePct === undefined ? null : Number(r.beBankedMovePct),
}));

// ── Shadow model (single row, single threshold) ──────────────────────────────
function shadowPnlPct(r: SigRow, T: number): number {
  const pnl = r.pnlPercent;
  const mfe = r.maxPnlPercent;
  if (mfe < T) return pnl; // scenario does not fire — run as today
  const fb = r.beBankedFrac ?? 0;
  if (fb > 0 && r.beBankedMovePct !== null) {
    // BE-BANKED row: first tranche = recorded BE-bank evidence; T-rung banks the
    // rescaled TP1 tranche; the rest proxies the row's actual terminal book.
    const mBeLev = r.beBankedMovePct * r.leverage; // UNLEVERED arm mark → levered (fees ignored)
    const wRun = W_TP1 * (1 - fb); // engine rescale: TP1 tranche × (1−f_b)
    const remain = (1 - fb) * (1 - W_TP1); // TP2 + runner share after the T-rung
    return fb * mBeLev + wRun * T + remain * pnl * (1 / (1 - W_TP1));
  }
  // Plain row: TP1 tranche banks at T; remaining book ≡ actual terminal pnl.
  return W_TP1 * T + (1 - W_TP1) * pnl * (1 / (1 - W_TP1));
}

// ── Era aggregation ──────────────────────────────────────────────────────────
function evalEra(subset: SigRow[], era: EraResult["era"], T: number | null): EraResult {
  const n = subset.length;
  const actNet = subset.reduce((a, r) => a + (r.marginUsd * r.pnlPercent) / 100, 0);
  const mfeNet = subset.reduce((a, r) => a + (r.marginUsd * r.maxPnlPercent) / 100, 0);
  const estNet = T === null ? actNet : subset.reduce((a, r) => a + (r.marginUsd * shadowPnlPct(r, T)) / 100, 0);
  const fired = T === null ? 0 : subset.filter((r) => r.maxPnlPercent >= T).length;
  return {
    era,
    T,
    scenario: T === null ? "ACTUAL (baseline ledger)" : `TP1 fires at ${T}% NET`,
    n,
    fired,
    estNet: round2(estNet),
    actNet: round2(actNet),
    delta: round2(estNet - actNet),
    keptPct: mfeNet > 0 ? round1((estNet / mfeNet) * 100) : 0,
    actKeptPct: mfeNet > 0 ? round1((actNet / mfeNet) * 100) : 0,
  };
}

const peak = rows.filter((r) => r.era === "PEAK");
const rest = rows.filter((r) => r.era === "REST");
const groups: Array<[EraResult["era"], SigRow[]]> = [
  ["PEAK", peak],
  ["REST", rest],
  ["COMBINED", rows],
];

// ── SANITY GATE (before reporting): T beyond all MFEs must equal the ledger ──
let sanityPass = true;
for (const [era, subset] of groups) {
  const s = evalEra(subset, era, T_SANITY);
  const ok = Math.abs(s.estNet - s.actNet) < 1e-6 && Math.abs(s.delta) < 1e-6;
  if (!ok) sanityPass = false;
  console.log(
    `SANITY ${era} @T=${T_SANITY}: est=${s.estNet} act=${s.actNet} delta=${s.delta} → ${ok ? "PASS" : "FAIL"}`,
  );
  const firedAny = subset.filter((r) => r.maxPnlPercent >= T_SANITY).length;
  if (firedAny !== 0) sanityPass = false;
}
if (!sanityPass) {
  console.error("SANITY FAILED — report NOT written.");
  process.exit(1);
}

// ── Build results ────────────────────────────────────────────────────────────
const results: EraResult[] = [];
for (const [era, subset] of groups) {
  results.push(evalEra(subset, era, null)); // baseline
  for (const T of SCENARIOS) results.push(evalEra(subset, era, T));
}

const mfeNetByEra: Record<string, number> = {};
for (const [era, subset] of groups) {
  mfeNetByEra[era] = round2(subset.reduce((a, r) => a + (r.marginUsd * r.maxPnlPercent) / 100, 0));
}

// ── Console report ───────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════════════════════════");
console.log("P1-a — SHADOW MFE-CAPTURE REPLAY (first-order, fees ignored, path-blind)");
console.log("══════════════════════════════════════════════════════════════════════");
console.log(
  `Window: createdAt ≥ 2026-10-09T20:30:00Z · qualityFlag IS NULL · CLEAN rows = ${rows.length}` +
    ` (PEAK ${peak.length} · REST ${rest.length})`,
);
console.log(
  `Ladder weights (real, src/lib/accounting.ts LADDER_TRANCHES): W_TP1=${W_TP1} W_TP2=${W_TP2} W_TP3=${W_TP3_RUNNER}` +
    ` · BE-BANK v11.2 f_b=${BE_BANK_FRAC_DEFAULT} (ladder rescales ×(1−f_b)) · TP1-R55 = rung distance 0.55R (weights unchanged)`,
);
console.log(`Total MFE on the table (mfeNet = Σ margin×MFE/100): ${JSON.stringify(mfeNetByEra)}`);
console.log("");
for (const era of ["PEAK", "REST", "COMBINED"] as const) {
  const rs = results.filter((r) => r.era === era);
  const base = rs.find((r) => r.T === null)!;
  console.log(`── ${era} (n=${base.n}, actual net ${fmtUsd(base.actNet)}, actual kept-MFE ${base.actKeptPct}%) ──`);
  console.log("T(fire)  fired   estNet      actNet     delta      keptMFE%");
  for (const r of rs) {
    if (r.T === null) continue;
    console.log(
      `${String(r.T).padEnd(8)} ${String(r.fired).padEnd(7)} ${fmtUsd(r.estNet).padEnd(11)} ${fmtUsd(r.actNet).padEnd(10)} ${fmtUsd(r.delta).padEnd(10)} ${r.keptPct}%`,
    );
  }
  console.log("");
}
console.log(
  "HONESTY: maxPnlPercent is a single max (not a price path) — first-order model only; remaining book proxied by the actual terminal pnlPercent (optimistic where banked tranches already sit inside pnl); fees ignored.",
);

// ── JSON report artifact ─────────────────────────────────────────────────────
const report = {
  task: "P1-a",
  title: "Shadow MFE-capture replay — TP1/BE-BANK harvest headroom (first-order)",
  generatedAtUTC: new Date().toISOString(),
  readonly: true,
  window: {
    fromISO: "2026-10-09T20:30:00Z",
    filter: "createdAt >= T0 (epoch-ms) AND qualityFlag IS NULL",
    cleanRows: rows.length,
    eraSplit: { PEAK: peak.length, REST: rest.length },
    statuses: rows.reduce<Record<string, number>>((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {}),
    beBankedRows: rows.filter((r) => r.beBankedFrac !== null).length,
  },
  ladder: {
    source:
      "src/lib/accounting.ts LADDER_TRANCHES (imported and applied by engine.ts resolveSignals v6.6 tranche settlement)",
    weights: { W_tp1: W_TP1, W_tp2: W_TP2, W_tp3_runner: W_TP3_RUNNER, note: "fractions sum to 1.0" },
    tp1R55:
      "v12.6 (worklog OP-TP-RERANK-1020): TP1 rung DISTANCE moved 1R→0.55R (gate tp1RMult=0.55, cohort tag TP1-R55) — rung placement only; tranche weights unchanged",
    beBank: {
      beBankFrac: BE_BANK_FRAC_DEFAULT,
      semantics:
        "v11.2 BE-BANK (engine.ts): on unbanked signals 25% of the position banks at the BE-arm mark (beBankedMovePct, UNLEVERED); post-bank the ladder rescales by (1−f_b): TP1 = 0.5×0.75 = 0.375 of full book",
    },
  },
  model: {
    space: "levered NET % (pnlPercent/maxPnlPercent native; beBankedMovePct × leverage)",
    fired_row_no_be: "est = W_TP1×T + (1−W_TP1)×pnl×(1/(1−W_TP1))  ≡ 0.5×T + pnl",
    fired_row_with_be:
      "est = f_b×(beBankedMovePct×lev) + W_TP1×(1−f_b)×T + (1−f_b)×(1−W_TP1)×pnl×(1/(1−W_TP1))  (f_b=0.25 → 0.25×mBE_lev + 0.375×T + 0.75×pnl)",
    not_fired_row: "est = pnlPercent (runs exactly as it actually did)",
    keptPct: "estNet / mfeNet × 100 where mfeNet = Σ marginUsd×maxPnlPercent/100",
  },
  assumptions: [
    "STORED MFE IS A SINGLE MAX, NOT A PRICE PATH — first-order model only: drawdown after the T-fire, TP2/runner touch order and path shape are unknowable from the ledger.",
    "Remaining book after the T-rung proxies the row's ACTUAL terminal pnlPercent (task formula) — path-blind.",
    "OPTIMISM BIAS: rows whose actual pnlPercent already embeds banked tranches (reachedTp≥1 / BE-banked) re-earn those banked dollars on the remaining fraction — treat deltas as an upper-first-order bound, not a prediction.",
    "FEES IGNORED: T-bank/BE-bank treated as NET fills; real extra exit fills would add taker fees + funding (actual pnlPercent is NET) — est is slightly flattered.",
    "Zero slippage assumed at the T-rung (banked exactly at T).",
    "BE-bank tranche priced at the RECORDED arm mark (beBankedMovePct×leverage) — evidence, not simulation.",
    "One ACTIVE row included at its current pnlPercent; sanity verified: T=1e9 collapses est to the actual ledger exactly before this report was written.",
  ],
  sanity: {
    threshold: T_SANITY,
    pass: sanityPass,
    note: "No row fires at T beyond max MFE → est collapses to the actual ledger (verified per era before writing).",
  },
  mfeNetByEra,
  results,
};

mkdirSync(`${ROOT}/.data/shadow-mfe`, { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Report written → ${OUT_PATH}`);
