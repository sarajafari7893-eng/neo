// ── Task 84 FLAT-10 SCOREBOARD (FSB-1.0) — operator mandate 2026-10-06 ──────
// «اگر مارجین را ثابت مثلا 10$ در نظر بگیریم و معیار سوددهی را فقط EST PNL%
// قرار دهیم چه می شود؟ ... معادل 10$ میشود؟» → «کامل و مهندسی اجرا کن»
//
// The OFFICIAL unit of account: FLAT $10 margin per trade, scored ONLY by
// estPnl% — the fee-net levered-% sum of ACTUAL settled engine results
// (margin-invariant by construction — v6.2 official-metric lineage).
// Dollar translation is an EXACT linear rescale: $ = netPct × unit/100 — the
// same linear-in-margin property golden-lane rides (gross, taker fees and
// funding all scale with marginUsd), so +100% est pnl ≡ +$10 — operator math
// confirmed and institutionalized.
//
// Design invariants (the honesty rails):
//  · PRE-REGISTERED — rules written to .data/flat-scoreboard-preregister.json
//    (SHA-256) on first boot, never editable in place; mismatch = TAMPERED.
//  · REALITY-ONLY — the score sums SETTLED results. No forecast, no
//    entry-time estimate, no simulation anywhere in the score.
//  · READ-ONLY — opens nothing, mutates nothing in the trading domain; runs
//    in the pulse path behind a 60s memo; fail-open everywhere.
//  · RAM-DISCIPLINE (Task-83 lesson) — ONE shared DB pass per memo window,
//    NO new client polling loop (the card consumes the shared pulse feed).
//  · BASIS DOCTRINE — unit $10 = 1% of the $1000 rules basis; the physical
//    $100 SEED account stays untouched; live promotion only via operator
//    APPROVE after the paper window confirms.

import { db } from "@/lib/db";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const PREREG_FILE = path.join(DATA_DIR, "flat-scoreboard-preregister.json");
const JOURNAL_FILE = path.join(DATA_DIR, "flat-scoreboard.jsonl");

// ── The pre-registered rules (immutable after first boot) ───────────────────
export interface FlatScoreboardConfig {
  version: "FSB-1.0";
  unitUsd: number; // flat margin per trade — the unit of account
  basisUsd: number; // rules basis (unit must be 1% of basis)
  targetDailyPct: number; // daily target in estPnl%
  dayBoundary: string;
  scoreFormula: string;
  dollarFormula: string;
  dustFilter: string;
  trailingBars: number;
  feeModel: string;
}

export const FSB_CONFIG: FlatScoreboardConfig = {
  version: "FSB-1.0",
  unitUsd: 10,
  basisUsd: 1000,
  targetDailyPct: 100,
  dayBoundary: "Tehran UTC+03:30 (no DST since 2022)",
  scoreFormula: "Σ over settled signals of the Tehran day: pnlPercent − (feeUsd+swapUsd)/marginUsd×100 (fee-NET levered %, margin-invariant)",
  dollarFormula: "netPct × unitUsd / 100 — exact linear rescale (fees scale with margin)",
  dustFilter: "marginUsd ≥ 0.05 (dust rows excluded from % math)",
  trailingBars: 30,
  feeModel: "per-row measured taker + funding, linear in marginUsd",
};

const TZ_MS = 3.5 * 3600_000;

// ── Pre-registration store (golden-lane pattern) ─────────────────────────────
interface Preregister {
  version: 1;
  registeredAt: number;
  configSha256: string;
  config: FlatScoreboardConfig;
}

function configHash(cfg: FlatScoreboardConfig): string {
  return createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
}

function loadOrCreatePreregister(): Preregister {
  try {
    const raw = fs.readFileSync(PREREG_FILE, "utf8");
    const pr = JSON.parse(raw) as Preregister;
    if (pr.configSha256 !== configHash(pr.config)) {
      (pr as Preregister & { tampered?: boolean }).tampered = true;
    }
    return pr;
  } catch {
    const pr: Preregister = {
      version: 1,
      registeredAt: Date.now(),
      configSha256: configHash(FSB_CONFIG),
      config: FSB_CONFIG,
    };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PREREG_FILE, JSON.stringify(pr, null, 1));
    } catch {
      /* read-only fs — scoreboard still evaluates in memory */
    }
    return pr;
  }
}

// ── Tehran day bucketing ─────────────────────────────────────────────────────
function tehranDayIndex(ms: number): number {
  return Math.floor((ms + TZ_MS) / 86_400_000);
}

function dayKeyOf(idx: number): string {
  // Tehran calendar date of day `idx`: Tehran midnight (idx×24h − 3.5h UTC)
  // plus TZ_MS lands on UTC midnight OF the Tehran calendar date.
  return new Date(idx * 86_400_000).toISOString().slice(0, 10);
}

interface DayBucket {
  n: number;
  grossPct: number;
  feePct: number; // fee mass: Σ (fee+swap)/margin×100 — the drag made visible
  netPct: number; // grossPct − feePct
}

// ── Daily-close journal (audit trail; DB remains the record of truth) ────────
let journaledDays: Set<string> | null = null;

function loadJournal(): Set<string> {
  if (journaledDays) return journaledDays;
  const set = new Set<string>();
  try {
    const raw = fs.readFileSync(JOURNAL_FILE, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { dayKey?: string };
        if (rec.dayKey) set.add(rec.dayKey);
      } catch {
        /* corrupt line — skip */
      }
    }
  } catch {
    /* no journal yet */
  }
  return (journaledDays = set);
}

function journalClosedDays(buckets: Map<number, DayBucket>, todayIdx: number): void {
  try {
    const seen = loadJournal();
    const pending: string[] = [];
    for (const [idx, b] of buckets) {
      if (idx >= todayIdx) continue; // today is partial — journaled at close
      const key = dayKeyOf(idx);
      if (seen.has(key)) continue;
      pending.push(
        JSON.stringify({
          at: Date.now(),
          dayKey: key,
          n: b.n,
          grossPct: Number(b.grossPct.toFixed(1)),
          feePct: Number(b.feePct.toFixed(1)),
          netPct: Number(b.netPct.toFixed(1)),
          flat10Usd: Number((b.netPct * 0.1).toFixed(2)),
          targetHit: b.netPct >= FSB_CONFIG.targetDailyPct,
        })
      );
      seen.add(key);
    }
    if (pending.length) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(JOURNAL_FILE, pending.join("\n") + "\n");
    }
  } catch {
    /* journal is audit-only — fail-open */
  }
}

// ── Computation ──────────────────────────────────────────────────────────────
export interface FlatDayBar {
  dayKey: string;
  n: number;
  netPct: number;
  flat10Usd: number;
  targetHit: boolean;
  partial: boolean;
}

export interface FlatDayStat {
  n: number;
  grossPct: number | null;
  feePct: number | null;
  netPct: number | null;
  flat10Usd: number | null;
  targetProgressPct: number | null; // netPct vs +100% target, capped for display
}

export interface FlatScoreboardBlock {
  version: string;
  registeredAt: number;
  tampered: boolean;
  unitUsd: number;
  basisUsd: number;
  unitPctOfBasis: number;
  targetDailyPct: number;
  targetDailyUsd: number;
  today: FlatDayStat | null;
  yesterday: FlatDayStat | null;
  rolling7d: { n: number; netPct: number; flat10Usd: number; targetDays: number; positiveDays: number; days: number };
  allTime: { n: number; netPct: number; flat10Usd: number; meanDayPct: number | null; meanDayUsd: number | null; bestDayPct: number | null; worstDayPct: number | null; targetDays: number; positiveDays: number; days: number };
  feeMass: { perTradeAvgPct: number; trailing7dPct: number };
  bars: FlatDayBar[];
  updatedAt: number;
}

async function computeBlock(): Promise<FlatScoreboardBlock> {
  const pr = loadOrCreatePreregister();
  const cfg = FSB_CONFIG;
  const rows = await db.signal.findMany({
    where: {
      status: { notIn: ["ACTIVE", "TP1", "TP2"] },
      closedAt: { not: null },
      marginUsd: { gte: 0.05 },
    },
    select: { closedAt: true, pnlPercent: true, feeUsd: true, swapUsd: true, marginUsd: true },
  });

  const buckets = new Map<number, DayBucket>();
  for (const r of rows) {
    if (!r.closedAt) continue;
    const margin = r.marginUsd;
    const idx = tehranDayIndex(r.closedAt.getTime());
    const b = buckets.get(idx) ?? { n: 0, grossPct: 0, feePct: 0, netPct: 0 };
    b.n += 1;
    b.grossPct += r.pnlPercent;
    const feePct = ((r.feeUsd + r.swapUsd) / margin) * 100;
    b.feePct += feePct;
    b.netPct += r.pnlPercent - feePct;
    buckets.set(idx, b);
  }

  const todayIdx = tehranDayIndex(Date.now());
  journalClosedDays(buckets, todayIdx);

  const statOf = (idx: number): FlatDayStat | null => {
    const b = buckets.get(idx);
    if (!b) return null;
    return {
      n: b.n,
      grossPct: Number(b.grossPct.toFixed(1)),
      feePct: Number(b.feePct.toFixed(1)),
      netPct: Number(b.netPct.toFixed(1)),
      flat10Usd: Number((b.netPct * cfg.unitUsd / 100).toFixed(2)),
      targetProgressPct: Number(Math.max(0, Math.min(100, (b.netPct / cfg.targetDailyPct) * 100)).toFixed(1)),
    };
  };

  // rolling 7 complete days (today excluded — shown separately, partial)
  const last7 = [...Array(7)].map((_, i) => buckets.get(todayIdx - 1 - i)).filter((b): b is DayBucket => Boolean(b));
  const r7n = last7.reduce((a, b) => a + b.n, 0);
  const r7net = last7.reduce((a, b) => a + b.netPct, 0);
  const r7fee = last7.reduce((a, b) => a + b.feePct, 0);
  const r7feeN = last7.reduce((a, b) => a + b.n, 0);

  // all-time (complete days only)
  const complete = [...buckets.entries()].filter(([idx]) => idx < todayIdx).sort((a, b) => a[0] - b[0]);
  const aN = complete.reduce((a, [, b]) => a + b.n, 0);
  const aNet = complete.reduce((a, [, b]) => a + b.netPct, 0);
  const dayNets = complete.map(([, b]) => b.netPct);

  // bars: last N complete days + today (partial)
  const bars: FlatDayBar[] = complete.slice(-cfg.trailingBars).map(([idx, b]) => ({
    dayKey: dayKeyOf(idx),
    n: b.n,
    netPct: Number(b.netPct.toFixed(1)),
    flat10Usd: Number((b.netPct * cfg.unitUsd / 100).toFixed(2)),
    targetHit: b.netPct >= cfg.targetDailyPct,
    partial: false,
  }));
  const todayB = buckets.get(todayIdx);
  if (todayB) {
    bars.push({
      dayKey: dayKeyOf(todayIdx),
      n: todayB.n,
      netPct: Number(todayB.netPct.toFixed(1)),
      flat10Usd: Number((todayB.netPct * cfg.unitUsd / 100).toFixed(2)),
      targetHit: todayB.netPct >= cfg.targetDailyPct,
      partial: true,
    });
  }

  return {
    version: cfg.version,
    registeredAt: pr.registeredAt,
    tampered: Boolean((pr as Preregister & { tampered?: boolean }).tampered),
    unitUsd: cfg.unitUsd,
    basisUsd: cfg.basisUsd,
    unitPctOfBasis: Number(((cfg.unitUsd / cfg.basisUsd) * 100).toFixed(2)),
    targetDailyPct: cfg.targetDailyPct,
    targetDailyUsd: (cfg.targetDailyPct * cfg.unitUsd) / 100,
    today: statOf(todayIdx),
    yesterday: statOf(todayIdx - 1),
    rolling7d: {
      n: r7n,
      netPct: Number(r7net.toFixed(1)),
      flat10Usd: Number((r7net * cfg.unitUsd / 100).toFixed(2)),
      targetDays: last7.filter((b) => b.netPct >= cfg.targetDailyPct).length,
      positiveDays: last7.filter((b) => b.netPct > 0).length,
      days: 7,
    },
    allTime: {
      n: aN,
      netPct: Number(aNet.toFixed(1)),
      flat10Usd: Number((aNet * cfg.unitUsd / 100).toFixed(2)),
      meanDayPct: complete.length ? Number((aNet / complete.length).toFixed(1)) : null,
      meanDayUsd: complete.length ? Number(((aNet / complete.length) * cfg.unitUsd / 100).toFixed(2)) : null,
      bestDayPct: dayNets.length ? Number(Math.max(...dayNets).toFixed(1)) : null,
      worstDayPct: dayNets.length ? Number(Math.min(...dayNets).toFixed(1)) : null,
      targetDays: dayNets.filter((v) => v >= cfg.targetDailyPct).length,
      positiveDays: dayNets.filter((v) => v > 0).length,
      days: complete.length,
    },
    feeMass: {
      perTradeAvgPct: r7n ? Number((r7fee / r7n).toFixed(2)) : 0,
      trailing7dPct: Number(r7fee.toFixed(1)),
    },
    bars,
    updatedAt: Date.now(),
  };
}

// ── Pulse-facing status (60s memo — ONE DB pass/min, fail-soft) ──────────────
const MEMO_MS = 60_000;
let memo: { at: number; block: FlatScoreboardBlock } | null = null;
let computeInFlight: Promise<FlatScoreboardBlock> | null = null;

export async function getFlatScoreboardStatus(): Promise<FlatScoreboardBlock | null> {
  try {
    if (memo && Date.now() - memo.at < MEMO_MS) return memo.block;
    if (!computeInFlight) {
      computeInFlight = computeBlock()
        .then((block) => {
          memo = { at: Date.now(), block };
          return block;
        })
        .finally(() => {
          computeInFlight = null;
        });
    }
    return await computeInFlight;
  } catch {
    return null; // fail-open — scoreboard can never disturb the pulse
  }
}
