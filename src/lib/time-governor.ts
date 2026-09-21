// ── FlowRadar Neo v9.6 — TIME GOVERNOR (R2, shadow-first, server-only) ──────
// Operator-approved module #2 (roadmap R2, mandate 2026-09-15). Evidence base
// (block-2 answer, TG msg 2004):
//   · worst Tehran hours 00/03/04/11/12/15 ≈ −$15 combined,
//   · prime hours 01-02 are the book's best window,
//   · prime-hours-only what-if ≈ +$18.15 on the replayed ledger.
//
// CONTRACT (shadow-first doctrine):
//   · Builds a 24-hour (Asia/Tehran, fixed UTC+03:30) realized-performance
//     table from the settled ledger over a 45-day window, tiers each hour
//     TOXIC / PRIME / NEUTRAL / THIN, and attaches a size weight per hour.
//   · SHADOW: compute + journal + audit; the verdict feeds the Daily
//     Senior-Review digest. Hour-of-day filtering has NO existing gate knob,
//     so it can never silently alter the engine — wiring it into the deploy
//     path is explicitly gated on a separate operator decision (documented in
//     the AI CORE card and proposals are NOT queued for it).
//   · ENGAGED: marks the weights ACTIVE in the module verdict + audited event;
//     still no deploy-path mutation (honest shadow doctrine).
//
// Deterministic — no LLM call, fail-open everywhere.

import { db } from "@/lib/db";
import { fireEvent } from "@/lib/engine";
import { recordFourPack } from "@/lib/fourpack-journal"; // v10.8 — FOUR-PACK JSON journal doctrine

const KEY = "timegovernor.state";
const CYCLE_MIN_MS = 6 * 3600_000; // ledger moves slowly — 6h cadence
const TEHRAN_OFFSET_H = 3.5; // Iran = UTC+03:30 fixed (no DST since 2022)
const WINDOW_DAYS = 45;
const MIN_N = 8; // minimum settles before an hour may be tiered
const WEIGHT_CAPS = { toxic: 0.5, prime: 1.1 } as const;

export type HourTier = "TOXIC" | "PRIME" | "NEUTRAL" | "THIN";

export interface HourCell {
  h: number; // 0-23, Tehran local hour
  n: number;
  wins: number;
  pnlUsd: number;
  expectancyPct: number;
  wr: number;
  tier: HourTier;
  weight: number;
}

export interface TimeGovernorState {
  at: number;
  cycles: number;
  lastRunAt: string | null;
  windowDays: number;
  hourly: HourCell[];
  toxicHours: number[];
  primeHours: number[];
  estUpliftUsd: number; // conservative what-if: half of TOXIC bleed avoided
  bookPnlUsd: number;
  line: string;
  journal: Array<{ at: string; line: string }>;
}

const EMPTY: TimeGovernorState = {
  at: 0,
  cycles: 0,
  lastRunAt: null,
  windowDays: WINDOW_DAYS,
  hourly: [],
  toxicHours: [],
  primeHours: [],
  estUpliftUsd: 0,
  bookPnlUsd: 0,
  line: "not run yet",
  journal: [],
};

export function tehranHourOf(d: Date): number {
  return Math.floor((d.getUTCHours() + d.getUTCMinutes() / 60 + TEHRAN_OFFSET_H) % 24);
}

async function getState(): Promise<TimeGovernorState> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    if (row) return { ...EMPTY, ...(JSON.parse(row.value) as Partial<TimeGovernorState>) };
  } catch {
    /* fresh */
  }
  return { ...EMPTY };
}

async function putState(next: TimeGovernorState): Promise<void> {
  await db.engineSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
}

export async function runTimeGovernor(): Promise<TimeGovernorState> {
  const prev = await getState();
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const settled = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, closedAt: { gte: since } },
    select: { closedAt: true, pnlPercent: true, marginUsd: true, reachedTp: true },
  });

  const buckets = new Map<number, { n: number; wins: number; pnl: number; pct: number }>();
  let bookPnl = 0;
  for (const s of settled) {
    if (!s.closedAt) continue;
    const usd = (s.marginUsd * s.pnlPercent) / 100;
    bookPnl += usd;
    const h = tehranHourOf(s.closedAt);
    const b = buckets.get(h) ?? { n: 0, wins: 0, pnl: 0, pct: 0 };
    b.n++;
    if (s.reachedTp >= 1) b.wins++;
    b.pnl += usd;
    b.pct += s.pnlPercent;
    buckets.set(h, b);
  }

  const hourly: HourCell[] = [];
  for (let h = 0; h < 24; h++) {
    const b = buckets.get(h);
    if (!b || b.n === 0) {
      hourly.push({ h, n: 0, wins: 0, pnlUsd: 0, expectancyPct: 0, wr: 0, tier: "THIN", weight: 1 });
      continue;
    }
    const exp = b.pct / b.n;
    const wr = (b.wins / b.n) * 100;
    let tier: HourTier = "NEUTRAL";
    let weight = 1;
    if (b.n < MIN_N) tier = "THIN";
    else if (b.pnl < 0 && exp <= -1) {
      tier = "TOXIC";
      weight = WEIGHT_CAPS.toxic;
    } else if (b.pnl > 0 && exp >= 1) {
      tier = "PRIME";
      weight = WEIGHT_CAPS.prime;
    }
    hourly.push({ h, n: b.n, wins: b.wins, pnlUsd: Number(b.pnl.toFixed(2)), expectancyPct: Number(exp.toFixed(2)), wr: Number(wr.toFixed(1)), tier, weight });
  }
  hourly.sort((a, b) => a.h - b.h);

  const toxicHours = hourly.filter((c) => c.tier === "TOXIC").map((c) => c.h);
  const primeHours = hourly.filter((c) => c.tier === "PRIME").map((c) => c.h);
  const toxicBleed = hourly.filter((c) => c.tier === "TOXIC").reduce((a, c) => a + c.pnlUsd, 0);
  // v10.8 sign fix — est. uplift = the bleed AVOIDED by throttling toxic hours to
  // ×0.5: toxicBleed is negative, so the avoided half is positive (+$X.XX).
  const estUplift = Number((-toxicBleed * (1 - WEIGHT_CAPS.toxic)).toFixed(2));

  const line =
    toxicHours.length || primeHours.length
      ? `TOXIC Tehran hours [${toxicHours.map((h) => String(h).padStart(2, "0")).join(",")}] bleed $${toxicBleed.toFixed(2)} · PRIME [${primeHours.map((h) => String(h).padStart(2, "0")).join(",")}] · weight cap ×${WEIGHT_CAPS.toxic}—×${WEIGHT_CAPS.prime} · est. uplift +$${estUplift}`
      : `no tiered hour yet (n ≥ ${MIN_N} per hour required) — book ${settled.length} settles in window`;

  const state: TimeGovernorState = {
    at: Date.now(),
    cycles: prev.cycles + 1,
    lastRunAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    hourly,
    toxicHours,
    primeHours,
    estUpliftUsd: estUplift,
    bookPnlUsd: Number(bookPnl.toFixed(2)),
    line,
    journal: [{ at: new Date().toISOString(), line }, ...prev.journal].slice(0, 8),
  };

  // audit on tier-flip only (both modes)
  const prevKey = `${prev.toxicHours.join(",")}|${prev.primeHours.join(",")}`;
  const nextKey = `${toxicHours.join(",")}|${primeHours.join(",")}`;
  if (prev.cycles > 0 && prevKey !== nextKey) {
    void fireEvent(null, null, "ENGINE", "ai", `TIME GOVERNOR tiers changed — ${line}`).catch(() => undefined);
  }
  // v10.8 journal doctrine — every cycle + tier-flip lands in the JSON journal
  void recordFourPack("r2-time-governor", prev.cycles > 0 && prevKey !== nextKey ? "flip" : "cycle", line, { toxicHours, primeHours, estUpliftUsd: estUplift, bookPnlUsd: Number(bookPnl.toFixed(2)), settles: settled.length }).catch(() => undefined);

  await putState(state);
  return state;
}

export async function getTimeGovernorState(): Promise<TimeGovernorState> {
  return getState();
}

let lastRun = 0;
export async function maybeRunTimeGovernor(): Promise<void> {
  if (Date.now() - lastRun < CYCLE_MIN_MS) return;
  lastRun = Date.now();
  await runTimeGovernor().catch(() => undefined);
}
