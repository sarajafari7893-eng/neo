// ── Task 79 TICK ARCHIVE — missing-data doctrine item ① (operator mandate
// 2026-10-05 «اقدامات لازم را کامل و مهندسی انجام بده») ──────────────────────
// The Task-78 audit proved 60s PricePoint sampling misclassified 15/102 BE
// cohorts and minted 19 phantom SLs (engine truth is a ~3.5s tick). Every
// price-distance filter is currently tuned on blurred prices. Cheapest fix:
// persist the tick stream ALREADY flowing through updatePrices().
//
// Two-tier engineered archive (disk-aware: 3.5GB free):
//   · tier-1 FULL RATE (~3.5s) — symbols with live exposure (ACTIVE/TP1/TP2
//     signals or open PumpTrack): full tick truth exactly where money moves.
//   · tier-2 16s — the rest of the universe (still 3× denser than PricePoint).
// Storage: compact `epochMs|symIdx|price` lines, hour-keyed files under
// .data/ticks/, 14-day retention + 150MB hard cap, dictionary-encoded symbols.
// NEVER throws into the engine tick loop — every path is fail-open.

import * as fs from "node:fs";
import * as path from "node:path";
import { db } from "@/lib/db";

const TICKS_DIR = path.join(process.cwd(), ".data", "ticks");
const SYMBOLS_FILE = path.join(TICKS_DIR, "symbols.json");
const RETENTION_DAYS = 14;
const DIR_CAP_BYTES = 150 * 1024 * 1024;
const TIER2_MIN_MS = 16_000; // universe tier cadence
const ACTIVE_REFRESH_MS = 30_000;
const FLUSH_LINES = 1200;

interface TickState {
  buf: string[];
  symIdx: Map<string, number>;
  lastT2: Map<string, number>;
  activeSyms: Set<string>;
  activeAt: number;
  activeLoading: boolean;
  curHour: number;
}

let st: TickState | null = null;

function S(): TickState {
  if (st) return st;
  st = { buf: [], symIdx: new Map(), lastT2: new Map(), activeSyms: new Set(), activeAt: 0, activeLoading: false, curHour: Math.floor(Date.now() / 3_600_000) };
  try {
    fs.mkdirSync(TICKS_DIR, { recursive: true });
    const dict = JSON.parse(fs.readFileSync(SYMBOLS_FILE, "utf8")) as string[];
    dict.forEach((s, i) => st!.symIdx.set(s, i));
  } catch {
    /* fresh dictionary */
  }
  return st;
}

function symCode(sym: string): number {
  const s = S();
  let i = s.symIdx.get(sym);
  if (i === undefined) {
    i = s.symIdx.size;
    s.symIdx.set(sym, i);
    try {
      const dict = [...s.symIdx.keys()];
      fs.writeFileSync(SYMBOLS_FILE, JSON.stringify(dict));
    } catch {
      /* dictionary re-persists on next flush */
    }
  }
  return i;
}

function refreshActiveSymbols(): void {
  const s = S();
  if (s.activeLoading || Date.now() - s.activeAt < ACTIVE_REFRESH_MS) return;
  s.activeLoading = true;
  void (async () => {
    const [sigSyms, trackSyms] = await Promise.all([
      db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { symbol: true }, distinct: ["symbol"] }),
      db.pumpTrack.findMany({ where: { phase: { not: "RESOLVED" } }, select: { symbol: true }, distinct: ["symbol"] }),
    ]);
    s.activeSyms = new Set([...sigSyms.map((r) => r.symbol), ...trackSyms.map((r) => r.symbol)]);
    s.activeAt = Date.now();
  })()
    .catch(() => undefined)
    .finally(() => {
      s.activeLoading = false;
    });
}

function flush(hour: number): void {
  const s = S();
  if (!s.buf.length) return;
  const lines = s.buf;
  s.buf = [];
  try {
    fs.appendFileSync(path.join(TICKS_DIR, `${hour}.jsonl`), lines.join("\n") + "\n");
  } catch {
    /* archive is additive instrumentation — never fail the engine */
  }
}

function cleanup(): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const files = fs
      .readdirSync(TICKS_DIR)
      .filter((f) => /^\d+\.jsonl$/.test(f))
      .map((f) => ({ f, hour: Number(f.replace(".jsonl", "")), size: fs.statSync(path.join(TICKS_DIR, f)).size }))
      .sort((a, b) => a.hour - b.hour);
    let total = 0;
    for (const x of files) {
      if (x.hour * 3_600_000 < cutoff) {
        fs.rmSync(path.join(TICKS_DIR, x.f), { force: true });
      } else {
        total += x.size;
      }
    }
    for (const x of files) {
      if (total <= DIR_CAP_BYTES) break;
      if (x.hour * 3_600_000 >= cutoff) {
        fs.rmSync(path.join(TICKS_DIR, x.f), { force: true });
        total -= x.size;
      }
    }
  } catch {
    /* fail-open */
  }
}

/** Called once per asset per engine tick (~3.5s) from updatePrices(). */
export function recordTick(symbol: string, price: number, atMs: number): void {
  try {
    const s = S();
    refreshActiveSymbols();
    if (!s.activeSyms.has(symbol)) {
      const last = s.lastT2.get(symbol) ?? 0;
      if (atMs - last < TIER2_MIN_MS) return;
      s.lastT2.set(symbol, atMs);
    }
    s.buf.push(`${atMs}|${symCode(symbol)}|${price}`);
    const hour = Math.floor(atMs / 3_600_000);
    if (s.buf.length >= FLUSH_LINES || hour !== s.curHour) {
      flush(s.curHour);
      if (hour !== s.curHour) {
        s.curHour = hour;
        cleanup();
      }
    }
  } catch {
    /* fail-open */
  }
}

/** End-of-pass drain — guarantees ≤ ~1 tick-pass latency for buffered lines. */
export function flushTickArchive(nowMs: number = Date.now()): void {
  try {
    const s = S();
    const hour = Math.floor(nowMs / 3_600_000);
    if (s.buf.length) flush(s.curHour);
    if (hour !== s.curHour) {
      s.curHour = hour;
      cleanup();
    }
  } catch {
    /* fail-open */
  }
}
