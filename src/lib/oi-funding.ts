// ── FlowRadar Neo v8.1 OI / FUNDING BOARD (P1 liq-deepening, server-only) ──
// Operator mandate 2026-09-08: «طبق نظر مهندسی P1 و P2 رو کامل اجرا کن».
//
// What P1 adds on top of the existing reactive L3 cascade layer:
//   · a PERSISTENT derivatives board covering the tracked domain with OI deltas
//     across three horizons (15m / 1h / 4h) + funding carry + OI notional —
//     flow.ts only computes a 1h delta on demand with no board.
//   · the raw material the predictive L3-PRE layer needs: "positions still
//     piling in near a liquidation cluster" is a cascade BEFORE it happens.
//
// Cadence & budget (mirrors flow-scanner doctrine): rotating batch of 6
// symbols per call, ≥60s between calls → ~12 REST calls/min worst case on top
// of the flow scanner's ~24. Board persisted as ONE EngineSetting row
// (race-free by construction), in-memory map bounded at 64 symbols.

import { db } from "@/lib/db";
import { gateFetch } from "./fapi-gate";
import { bridgeOiHist, bybitTickerMap, bybitTickerRow } from "./flow-bridge";

const BOARD_KEY = "oifund.board";
const BATCH = 6;
const MIN_INTERVAL_MS = 60_000;
const BOARD_CAP = 64;

export interface OiFundRow {
  symbol: string;
  at: number;
  markPrice: number | null;
  funding8h: number | null; // % per 8h (signed — positive: longs pay)
  nextFundingAt: number | null;
  oiBase: number | null; // contracts (sumOpenInterest)
  oiUsd: number | null; // notional open interest
  oiDelta15m: number | null; // %
  oiDelta1h: number | null; // %
  oiDelta4h: number | null; // %
  oiZ1h: number | null; // z-score of the last 1h OI change vs its own 4h distribution
  /** v12.2 TASK-52 — venue that fed the OI ladder (BINANCE | BYBIT) when fapi starved. */
  src?: string;
}

// ── bounded cache + in-flight dedupe (flow-scanner pattern) ──
const board = new Map<string, OiFundRow>();
let boardLoaded = false;
let scanCursor = 0;
let lastScanAt = 0;
let scanInFlight = false;

async function loadBoard(): Promise<void> {
  if (boardLoaded) return;
  boardLoaded = true;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: BOARD_KEY } });
    if (row) {
      const parsed = JSON.parse(row.value) as { rows: OiFundRow[] };
      for (const r of parsed.rows ?? []) board.set(r.symbol, r);
    }
  } catch {
    /* cold start — the scanner repopulates within ~10min */
  }
}

async function persistBoard(): Promise<void> {
  const rows = [...board.values()].sort((a, b) => (b.oiUsd ?? 0) - (a.oiUsd ?? 0)).slice(0, BOARD_CAP);
  const value = JSON.stringify({ at: Date.now(), rows });
  await db.engineSetting.upsert({ where: { key: BOARD_KEY }, create: { key: BOARD_KEY, value }, update: { value } });
}

// v10.24 Task 34-a: fapi REST goes through the central fapi-gate (telemetry
// lane — a shedded rotation returns nulls and the board keeps its previous
// rows; the op-audit-20260908 carry-over semantics still apply downstream).
async function fapi<T>(path: string, timeoutMs = 6000): Promise<T | null> {
  return gateFetch<T>(path, { priority: "telemetry", timeoutMs });
}

interface PremRow { lastFundingRate: string; markPrice: string; nextFundingTime: number }

async function scanSymbol(symbol: string, prem: PremRow | null, prev: OiFundRow | null): Promise<OiFundRow | null> {
  // v12.2 TASK-52 — OI LADDER: fapi openInterestHist → BYBIT open-interest
  // history (perp-native; no spot equivalent exists). On the BYBIT rung the
  // rows are base-denominated, so the notional comes from the batched tickers
  // call (measured, not invented).
  const histB = await bridgeOiHist(symbol, "15m", 17).catch(() => null);
  if (!histB || histB.rows.length < 4) return null; // honest — no invented rows
  const hist = histB.rows.map((r) => ({ sumOpenInterest: String(r.sumOpenInterest), sumOpenInterestValue: String(r.sumOpenInterestValue ?? 0), timestamp: r.timestamp }));

  const oi = hist.map((h) => Number(h.sumOpenInterest));
  const cur = oi[oi.length - 1]!;
  const pct = (barsBack: number): number | null => {
    const ref = oi[oi.length - 1 - barsBack];
    return ref !== undefined && ref > 0 ? Number((((cur - ref) / ref) * 100).toFixed(2)) : null;
  };

  // z-score of the last 1h change vs its own distribution across the window
  let oiZ1h: number | null = null;
  const d1h = pct(4);
  if (d1h !== null && oi.length >= 10) {
    const deltas: number[] = [];
    for (let i = 4; i < oi.length; i++) {
      const ref = oi[i - 4]!;
      if (ref > 0) deltas.push(((oi[i]! - ref) / ref) * 100);
    }
    if (deltas.length >= 5) {
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const std = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) * (b - mean), 0) / deltas.length);
      if (std > 0) oiZ1h = Number(((d1h - mean) / std).toFixed(2));
    }
  }

  const oiUsdRow = Number(hist[hist.length - 1]?.sumOpenInterestValue ?? 0) || null;
  let oiUsd = oiUsdRow;
  if (!oiUsd && histB.source === "BYBIT") {
    // bybit history is base-only → notional from the batched tickers (openInterestValue)
    oiUsd = (await bybitTickerRow(symbol).catch(() => null))?.openInterestValue ?? null;
  }
  // op-audit-20260908: when the batch premiumIndex call missed (transient fapi
  // weight pressure), CARRY OVER the previous funding fields instead of
  // overwriting good data with nulls — funding changes every 8h, staleness of
  // one rotation is harmless, data loss was not.
  return {
    symbol,
    at: Date.now(),
    markPrice: prem ? Number(prem.markPrice) || null : (prev?.markPrice ?? null),
    funding8h: prem ? Number((Number(prem.lastFundingRate) * 100).toFixed(4)) : (prev?.funding8h ?? null),
    nextFundingAt: prem ? Number(prem.nextFundingTime) || null : (prev?.nextFundingAt ?? null),
    oiBase: cur,
    oiUsd: oiUsd ? Number((oiUsd / 1e6).toFixed(2)) : null, // reported in $M
    oiDelta15m: pct(1),
    oiDelta1h: d1h,
    oiDelta4h: pct(16),
    oiZ1h,
    src: histB.source,
  };
}

/** Rotating scanner — call from the engine tick. Refreshes BATCH symbols per call. */
export async function maybeOiFundScan(symbols: string[]): Promise<void> {
  await loadBoard();
  if (scanInFlight || symbols.length === 0) return;
  if (Date.now() - lastScanAt < MIN_INTERVAL_MS) return;
  scanInFlight = true;
  lastScanAt = Date.now();
  try {
    const batch: string[] = [];
    for (let i = 0; i < Math.min(BATCH, symbols.length); i++) batch.push(symbols[(scanCursor + i) % symbols.length]!);
    scanCursor = (scanCursor + batch.length) % symbols.length;
    // op-audit-20260908: ONE batched premiumIndex call (no symbol param → ALL
    // markers, weight ~10) replaces 6 per-symbol calls per rotation — funding
    // coverage climbs 6/33 → full domain in one pass AND the per-second fapi
    // weight bursts that tripped -1003 endpoint bans disappear.
    // v12.2 TASK-52: when the fapi batch starves, ONE batched bybit tickers
    // call (weight-cheap, separate venue) feeds the whole rotation instead —
    // funding + mark stay alive through ban windows.
    const premRows = await fapi<Array<PremRow & { symbol: string }>>(`/fapi/v1/premiumIndex`).catch(() => null);
    let premMap = new Map<string, PremRow>();
    for (const p of premRows ?? []) if (p?.symbol) premMap.set(p.symbol, p);
    if (premMap.size === 0) {
      const tickers = await bybitTickerMap().catch(() => null);
      if (tickers && tickers.size > 0) {
        console.log(`[oi-funding] fapi premiumIndex starved — bybit tickers batch (${tickers.size} symbols, Task-52)`);
        for (const symbol of batch) {
          const t = tickers.get(symbol);
          if (t && t.fundingRate !== null) {
            premMap.set(symbol, { lastFundingRate: String(t.fundingRate), markPrice: String(t.markPrice ?? t.lastPrice), nextFundingTime: t.nextFundingTime ?? 0 });
          }
        }
      }
    }
    for (const symbol of batch) {
      const prev = board.get(symbol) ?? null;
      const row = await scanSymbol(symbol, premMap.get(symbol) ?? null, prev).catch(() => null);
      if (row) board.set(symbol, row);
    }
    await persistBoard();
  } finally {
    scanInFlight = false;
  }
}

/** Sync hot-path read for the engine/triggers — stale rows (>20min) never gate. */
export function peekOiFund(symbol: string): OiFundRow | null {
  const r = board.get(symbol);
  if (!r || Date.now() - r.at > 20 * 60_000) return null;
  return r;
}

/** Full board for /api/oi-funding — sorted by OI notional.
    Bug fix 2026-09-08: the wire shape promises OiFundRowDTO.oiUsdM but the
    internal row stores the $M value as `oiUsd` — map it at the boundary so the
    OI board card renders real notionals instead of $0. */
export async function getOiFundBoard(): Promise<{ at: string; coverage: number; rows: Array<OiFundRow & { oiUsdM: number | null }> }> {
  await loadBoard();
  const rows = [...board.values()].sort((a, b) => (b.oiUsd ?? 0) - (a.oiUsd ?? 0));
  return { at: new Date().toISOString(), coverage: rows.length, rows: rows.slice(0, 48).map((r) => ({ ...r, oiUsdM: r.oiUsd })) };
}
