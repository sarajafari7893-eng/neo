// ── FlowRadar Neo v8.4 R5 RESEARCH-SHADOW (server-only) ──
// Module-performance audit 2026-09-11: the flow-factor research produced an
// optimum the live gate CONTRADICTS — slAtr 1.2 (live 1.8), rrScale 1.15
// (live 0.75), BE-trail OFF (live ON). Flipping the live book to unproven
// parameters would be reckless; keeping the contradictory ones without an
// experiment would be blind. The engineering compromise is a SHADOW A/B:
//   · every deployment journals a research-aligned ladder next to the live one
//   · at settle time a 1m-candle replay scores BOTH geometries with the SAME
//     runner-only model (first touch of stop vs final target, close at the
//     settling mark if neither touches; fees excluded — symmetric across arms)
//   · verdicts append to db/research-shadow/{deploy,settle}.ndjson
// The ledger answers "would the research params have beaten the live book?"
// with real market paths — the adoption evidence the R6-style gate needs.
// No Prisma schema change (restore post-mortem rule): file-backed journal.

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fetchFuturesKlines } from "@/lib/market-feed";

export const RESEARCH_PARAMS = {
  slAtrMult: 1.2, // research optimum vs live 1.8
  rrScale: 1.15, // research optimum vs live 0.75
  beTrailPct: 0, // research optimum: no mid-ladder BE arm
} as const;

const DIR = join(process.cwd(), "db", "research-shadow");

function jline(file: string, obj: unknown): void {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(join(DIR, file), JSON.stringify(obj) + "\n");
  } catch {
    /* best-effort telemetry */
  }
}

export interface ResearchLadder {
  slDistPct: number; // UNLEVERED % distance to the research stop
  rr: number; // research final target (R multiple)
  stop: number; // absolute research stop price
  tp3: number; // absolute research final target price
}

/** Build the research-aligned ladder from the SAME drivers the live ladder used. */
export function buildResearchLadder(entry: number, isLong: boolean, atrPct: number, slMult: number, volGeoSlMult: number, rawUnscaledRR: number): ResearchLadder {
  const slDistPct = Math.min(5, Math.max(0.7, RESEARCH_PARAMS.slAtrMult * atrPct * slMult * volGeoSlMult)) / 100;
  const rr = Number(Math.min(4.2, Math.max(1.8, rawUnscaledRR * RESEARCH_PARAMS.rrScale)).toFixed(1));
  const risk = entry * slDistPct;
  const stop = isLong ? entry - risk : entry + risk;
  const tp3 = isLong ? entry + risk * rr : entry - risk * rr;
  return { slDistPct: Number((slDistPct * 100).toFixed(3)), rr, stop: Number(stop.toFixed(stop > 100 ? 2 : 6)), tp3: Number(tp3.toFixed(tp3 > 100 ? 2 : 6)) };
}

export interface ShadowDeployRecord {
  serial: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  at: string;
  entry: number;
  live: { slDistPct: number; rr: number; stop: number; tp3: number };
  research: ResearchLadder;
}

export function journalResearchShadowDeploy(rec: ShadowDeployRecord): void {
  jline("deploy.ndjson", rec);
}

/** R× pnl for one arm: stop → −1R · final target → +rr R · neither → mark R. */
function pnlR(exit: "SL" | "TP3" | "MARK", rr: number): number {
  return exit === "SL" ? -1 : exit === "TP3" ? rr : 0; // MARK resolved below as passthrough
}

interface SettleInput {
  serial: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  entry: number;
  createdAt: Date;
  closedAt: Date;
  live: { stop: number; tp3: number; rr: number };
  research: ResearchLadder;
  finalStatus: string;
}

/**
 * Settle the shadow pair: find the deploy record by serial, replay 1m candles
 * between entry and close, first-touch both ladders, append the verdict.
 * Fire-and-forget — never blocks the settle path, never throws.
 */
export async function settleResearchShadow(input: Omit<SettleInput, "live" | "research"> & { live: { stop: number; tp3: number; rr: number } }): Promise<void> {
  try {
    const deployFile = join(DIR, "deploy.ndjson");
    if (!existsSync(deployFile)) return;
    const lines = readFileSync(deployFile, "utf8").trim().split("\n");
    let rec: ShadowDeployRecord | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]!) as ShadowDeployRecord;
        if (r.serial === input.serial) {
          rec = r;
          break;
        }
      } catch {
        /* skip torn line */
      }
    }
    if (!rec) return; // deployed before R5 went live — nothing to settle

    const spanMin = Math.ceil((input.closedAt.getTime() - input.createdAt.getTime()) / 60_000) + 2;
    const candles = await fetchFuturesKlines(input.symbol, "1m", Math.min(1000, Math.max(60, spanMin + 5))).catch(() => []);
    if (!candles || candles.length === 0) return;
    const inWindow = candles.filter((c) => c.openTime >= input.createdAt.getTime() - 60_000 && c.openTime <= input.closedAt.getTime() + 60_000);
    if (inWindow.length === 0) return;
    const isLong = input.direction === "LONG";

    // first-touch walk (1m granularity): SL and TP3 checked on the same candle —
    // a candle spanning both resolves CONSERVATIVELY to SL (pessimistic for both arms)
    const firstTouch = (stop: number, tp3: number, rr: number): { exit: "SL" | "TP3" | "MARK"; pnlR: number } => {
      for (const c of inWindow) {
        const hitSl = isLong ? c.low <= stop : c.high >= stop;
        const hitTp = isLong ? c.high >= tp3 : c.low <= tp3;
        if (hitSl) return { exit: "SL", pnlR: -1 };
        if (hitTp) return { exit: "TP3", pnlR: rr };
      }
      const last = inWindow[inWindow.length - 1]!;
      const move = ((last.close - input.entry) / input.entry) * (isLong ? 1 : -1);
      const riskDist = Math.abs(input.entry - stop) / input.entry || 0.0001; // fractional 1R distance
      return { exit: "MARK", pnlR: Number((move / riskDist).toFixed(2)) };
    };

    const liveT = firstTouch(input.live.stop, input.live.tp3, input.live.rr);
    const resT = firstTouch(rec.research.stop, rec.research.tp3, rec.research.rr);
    const verdict = {
      serial: input.serial,
      symbol: input.symbol,
      direction: input.direction,
      finalStatus: input.finalStatus,
      settledAt: new Date().toISOString(),
      candles: inWindow.length,
      live: { exit: liveT.exit, pnlR: liveT.exit === "MARK" ? liveT.pnlR : pnlR(liveT.exit, input.live.rr) },
      research: { exit: resT.exit, pnlR: resT.exit === "MARK" ? resT.pnlR : pnlR(resT.exit, rec.research.rr) },
      deltaR: Number(((resT.exit === "MARK" ? resT.pnlR : pnlR(resT.exit, rec.research.rr)) - (liveT.exit === "MARK" ? liveT.pnlR : pnlR(liveT.exit, input.live.rr))).toFixed(2)),
      model: "runner-only · 1m first-touch · SL-pessimistic · fees-excluded",
    };
    jline("settle.ndjson", verdict);
  } catch {
    /* telemetry must never break settlement */
  }
}

export interface ResearchShadowSummary {
  settled: number;
  researchWins: number;
  liveWins: number;
  ties: number;
  sumDeltaR: number;
  avgDeltaR: number | null;
  byExit: Record<string, number>;
}

/** Compact A/B readout for reports/audits. */
export function researchShadowSummary(): ResearchShadowSummary {
  const file = join(DIR, "settle.ndjson");
  const empty: ResearchShadowSummary = { settled: 0, researchWins: 0, liveWins: 0, ties: 0, sumDeltaR: 0, avgDeltaR: null, byExit: {} };
  if (!existsSync(file)) return empty;
  try {
    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { deltaR: number; research: { exit: string }; live: { exit: string } });
    const byExit: Record<string, number> = {};
    let sum = 0;
    let rw = 0;
    let lw = 0;
    let ties = 0;
    for (const r of rows) {
      sum += r.deltaR;
      if (r.deltaR > 0.05) rw++;
      else if (r.deltaR < -0.05) lw++;
      else ties++;
      const k = `${r.live.exit}→${r.research.exit}`;
      byExit[k] = (byExit[k] ?? 0) + 1;
    }
    return { settled: rows.length, researchWins: rw, liveWins: lw, ties, sumDeltaR: Number(sum.toFixed(2)), avgDeltaR: rows.length ? Number((sum / rows.length).toFixed(3)) : null, byExit };
  } catch {
    return empty;
  }
}
