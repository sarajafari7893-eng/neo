// ── MARGIN SIZING MODES (Task 65 — operator mandate «فرمول پیشنهادی را کامل
// و مهارندسی اجرا کن») ────────────────────────────────────────────────────
// Backtest verdict (2026-10-02, 1031 closed signals, no-lookahead):
//   CONFIDENCE (legacy, equity×2..8% linear in conf)  → −$10.65 · PF 0.837
//   FLAT $2                                           → −$3.02 · PF 0.979
//   ANTI_MARTINGALE base$2 ×0.5 after each SL         → +$2.99 · PF 1.064
// Root cause: the 68 biggest-margin trades (m ≥ $2, conf 77-94) produced 88%
// of ALL net losses — confidence had zero outcome correlation (r=+0.027) and
// loss clusters got the biggest checks. Sizing NEVER changes pnlPercent or
// win-rate — it only re-weights dollars (honest doctrine note).
//
// Engineering contract:
//  · computeMarginBase returns the BASE — the whole governor/regime/risk
//    overlay stack in engine.ts (riskPerTrade, regimeSize, crowdCut,
//    shortSizeMult, probation, riskMult, …) multiplies ANY base unchanged.
//  · The consecutive-SL run is recomputed from the DB at every deploy
//    (stateless, restart-proof, recycle-proof) — parity with the backtest
//    walk: SL increments, TP1/TP2/TP3 restores, EXPIRED/CLOSED ignored.
//  · Mode lives in EngineSetting("sizing.mode") — live-switchable, no restart.
//  · Safety clamps (floor / freeMargin / 10%-equity cap) never bind at the
//    current ~$90 equity but protect a shrunken account.

import { db } from "@/lib/db";
import { confidenceMargin } from "@/lib/accounting";

export type SizingMode = "CONFIDENCE" | "FLAT" | "ANTI_MARTINGALE";

export const SIZING_KEY = "sizing.mode";
export const SIZING_MODES: readonly SizingMode[] = ["CONFIDENCE", "FLAT", "ANTI_MARTINGALE"];

export interface SizingConfig {
  mode: SizingMode;
  /** FLAT: fixed $ margin per deploy */
  flatBase: number;
  /** ANTI_MARTINGALE: base size, halved per consecutive SL, restored on TP */
  antiBase: number;
  /** per-SL decay factor (0.5 = halve) */
  decay: number;
  /** min $ margin after decay */
  floor: number;
  /** cap on the consecutive-SL exponent */
  consecCap: number;
}

export const SIZING_DEFAULTS: SizingConfig = {
  mode: "CONFIDENCE",
  flatBase: 2,
  antiBase: 2,
  decay: 0.5,
  floor: 0.5,
  consecCap: 4,
};

function sanitize(raw: Partial<SizingConfig> | null | undefined): SizingConfig {
  const cfg: SizingConfig = { ...SIZING_DEFAULTS };
  if (!raw) return cfg;
  if (raw.mode && (SIZING_MODES as readonly string[]).includes(raw.mode)) cfg.mode = raw.mode;
  for (const k of ["flatBase", "antiBase", "decay", "floor", "consecCap"] as const) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v > 0) cfg[k] = v;
  }
  if (cfg.decay > 0.95) cfg.decay = 0.95; // must actually decay
  if (cfg.consecCap > 8) cfg.consecCap = 8;
  return cfg;
}

/** Read the live sizing config (single EngineSetting PK read — pulse-cheap). */
export async function getSizingConfig(): Promise<SizingConfig> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: SIZING_KEY } });
    return sanitize(row ? (JSON.parse(row.value) as Partial<SizingConfig>) : null);
  } catch {
    return { ...SIZING_DEFAULTS };
  }
}

/** Persist a sizing patch (audited by the caller via fireEvent). */
export async function setSizingConfig(patch: Partial<SizingConfig>): Promise<SizingConfig> {
  const next = sanitize({ ...(await getSizingConfig()), ...patch });
  const value = JSON.stringify(next);
  await db.engineSetting.upsert({ where: { key: SIZING_KEY }, update: { value }, create: { key: SIZING_KEY, value } });
  return next;
}

/**
 * Consecutive-SL run since the last TP-status close — the anti-martingale
 * exponent. Walks the newest closed signals; SL counts up, TP1/TP2/TP3 stops,
 * EXPIRED/CLOSED are ignored (exactly the backtest's walk, now from the DB so
 * it survives restarts and recycles with zero persisted state).
 */
export async function getConsecutiveSlCount(cfg: SizingConfig): Promise<number> {
  const rows = await db.signal.findMany({
    where: { closedAt: { not: null } },
    orderBy: { closedAt: "desc" },
    take: 60,
    select: { status: true },
  });
  let k = 0;
  for (const r of rows) {
    if (r.status === "SL") {
      k++;
      if (k >= cfg.consecCap) break;
    } else if (r.status === "TP1" || r.status === "TP2" || r.status === "TP3") {
      break;
    }
  }
  return k;
}

export interface MarginBaseResult {
  margin: number;
  mode: SizingMode;
  /** consecutive-SL exponent actually used (0 for FLAT/CONFIDENCE) */
  consecSl: number;
}

// ── Task 66 TRADEABILITY FLOOR (operator bug: «با این مقدار مارجین اصلا
// امکان باز شدن پوزیشن وجود دارد؟») ──────────────────────────────────────
// Binance USDT-M rejects orders below MIN_NOTIONAL — a dust margin cannot
// EXIST in reality. Forensics 2026-10-02: 339/1040 (32.6%) of ledger rows
// were untradeable dust (notional < 5 USDT; worst NX-1042 = $0.03×10x =
// $0.30 notional). Floor-aware backtest revision: anti-mart base$2 +$2.99
// → +$0.59 (floor binds 30%), base$3 → +$3.71 (PF 1.059) — base 3 deployed.
export const MIN_NOTIONAL_DEFAULT_USD = 5;
/** per-symbol overrides — Binance raised BTCUSDT min notional (2026-04: 100→50 USDT); ETHUSDT = 20 USDT. */
export const MIN_NOTIONAL_OVERRIDES: Record<string, number> = { BTCUSDT: 50, ETHUSDT: 20 };

export function minNotionalUsd(symbol: string): number {
  return MIN_NOTIONAL_OVERRIDES[symbol.toUpperCase()] ?? MIN_NOTIONAL_DEFAULT_USD;
}

/** smallest tradeable margin at a given leverage (margin × leverage ≥ minNotional). */
export function tradeableFloorMargin(symbol: string, leverage: number): number {
  return minNotionalUsd(symbol) / Math.max(1, leverage);
}

/**
 * Mode-aware margin BASE. Legacy parity: CONFIDENCE = confidenceMargin
 * (equity × 2%..8% linear in conf 55→96, clamped [1, 10% equity, freeMargin]).
 * ANTI_MARTINGALE derives the consecutive-SL exponent from the DB inside this
 * call, so the deploy path stays a single await.
 */
export async function computeMarginBase(
  cfg: SizingConfig,
  confidence: number,
  equity: number,
  freeMargin: number
): Promise<MarginBaseResult> {
  const room = Math.max(0, Math.min(freeMargin, equity * 0.1));
  if (cfg.mode === "FLAT") {
    const margin = Number(Math.max(cfg.floor, Math.min(cfg.flatBase, room)).toFixed(2));
    return { margin, mode: "FLAT", consecSl: 0 };
  }
  if (cfg.mode === "ANTI_MARTINGALE") {
    const k = await getConsecutiveSlCount(cfg);
    const margin = Number(Math.max(cfg.floor, Math.min(cfg.antiBase, room) * Math.pow(cfg.decay, k)).toFixed(2));
    return { margin, mode: "ANTI_MARTINGALE", consecSl: k };
  }
  return { margin: confidenceMargin(confidence, equity, freeMargin), mode: "CONFIDENCE", consecSl: 0 };
}
