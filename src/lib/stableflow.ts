// ── NEXUS//SIGNALS — v11.0 STABLECOIN FLOW LIB (server-only) ────────────────
// Family-E substrate shared by: engine gates (DEPEG-MUTE / STABLE-REGIME),
// shadow-veto telemetry, /api/stableflow, and the TG digest.
//
// SOURCE OF TRUTH: the stable-feed mini-service (:3017) polls DefiLlama
// (free, no key, no AI — IRAN-VPS compatible) and atomically writes
//   .data/stable-feed/board.json        — the live regime board
//   .data/stable-feed/events.jsonl      — MINTBURN / DEPEG / REGIME events
//   .data/stable-feed/backfill/*.json   — daily history (~9y, backtest substrate)
// The app NEVER talks to DefiLlama and NEVER blocks on the service: reads are
// file-only, cached 10s, and every failure degrades to null (fail-open with
// honest nulls — gates stay silent when the substrate is absent).
//
// DB doctrine: mini-services never write SQLite. maybePersistStableFlow()
// (called from the engine tick rail, 15min throttle) mirrors LIVE snapshots
// and events into StableFlowEvent via Prisma — deduped by watermark query.
//
// Doctrines encoded here:
//   · DEPEG-MUTE — |pegDev| ≥ 1% on ANY tracked stable = systemic liquidity
//     emergency → refuse new deploys fail-closed (tail-risk protection,
//     near-zero false-positive cost; the USDC-May2023 class of event).
//   · STABLE-REGIME — SHADOW ONLY: a RISK-OFF contraction is journaled as a
//     would-block so the shadow arms can ground-truth it; enforcement is a
//     separate operator decision (EngineSetting "stableflow.regimeGate").
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";

export const DATA_DIR = path.join(process.cwd(), ".data", "stable-feed");
const BOARD_FILE = path.join(DATA_DIR, "board.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");

// thresholds (documented operator-facing knobs — constants, not knobs, until
// the shadow arms prove which values deserve to be tunable)
export const DEPEG_MUTE_PCT = 1.0; // systemic emergency — enforced
export const DEPEG_WARN_PCT = 0.5; // event-level only
export const REGIME_ON_PCT = 0.5; // 7d total-supply growth = risk-on
export const REGIME_OFF_PCT = -0.5; // 7d total-supply contraction = risk-off
export const MINTBURN_USD = 150e6; // |Δ24h| per asset worth an event row
export const BOARD_FRESH_MS = 40 * 60_000; // board older than this = stale

export type StableRegime = "RISK-ON" | "NEUTRAL" | "RISK-OFF";

export interface StableBoardAsset {
  asset: string; // USDT | USDC | DAI | USDE | USDS
  mcapUsd: number | null;
  delta1hPct: number | null;
  delta24hPct: number | null;
  delta24hUsd: number | null;
  delta7dPct: number | null;
  pegDevPct: number | null; // (price - 1) × 100
}

export interface StableBoard {
  at: number; // ms epoch — when the service last computed it
  totalMcapUsd: number | null;
  totalDelta24hPct: number | null;
  totalDelta7dPct: number | null;
  assets: StableBoardAsset[];
  maxPegDevPct: number | null; // worst |pegDev| across tracked assets
  regime: StableRegime;
  regimeReason: string;
}

// ── pure helpers (unit-testable, no I/O) ────────────────────────────────────

export function parseBoard(raw: string | null | undefined): StableBoard | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as StableBoard;
    if (typeof b?.at !== "number" || !Array.isArray(b?.assets)) return null;
    return b;
  } catch {
    return null;
  }
}

export function isBoardFresh(b: StableBoard | null): boolean {
  return !!b && Date.now() - b.at < BOARD_FRESH_MS;
}

export function depegMuted(b: StableBoard | null): { muted: boolean; reason: string } {
  if (!b) return { muted: false, reason: "no stable board" };
  const worst = b.assets
    .map((a) => ({ asset: a.asset, dev: a.pegDevPct }))
    .filter((x): x is { asset: string; dev: number } => x.dev !== null && Math.abs(x.dev) >= DEPEG_MUTE_PCT)
    .sort((x, y) => Math.abs(y.dev) - Math.abs(x.dev))[0];
  if (!worst) return { muted: false, reason: "peg ok" };
  return {
    muted: true,
    reason: `${worst.asset} peg deviation ${worst.dev >= 0 ? "+" : ""}${worst.dev.toFixed(2)}% (≥ ±${DEPEG_MUTE_PCT}%) — systemic stablecoin liquidity emergency`,
  };
}

export interface StableRegimeVerdict {
  flag: boolean; // true = would-block candidate (shadow journal)
  note: string;
}

export function stableRegimeVerdict(b: StableBoard, direction: "LONG" | "SHORT"): StableRegimeVerdict {
  if (b.regime === "RISK-OFF") {
    return {
      flag: direction === "LONG",
      note: `stable regime RISK-OFF (${b.regimeReason}) — LONG deploys are the flagged cohort`,
    };
  }
  if (b.regime === "RISK-ON" && direction === "SHORT") {
    return {
      flag: false, // risk-on shorts are common (momentum shorts) — telemetry only, not a flag
      note: `stable regime RISK-ON (${b.regimeReason}) — SHORT telemetry-only`,
    };
  }
  return { flag: false, note: `stable regime ${b.regime}` };
}

// ── cached board reader (file-only, 10s TTL, fail-open) ─────────────────────

let boardCache: { at: number; board: StableBoard | null } = { at: 0, board: null };

export function getStableBoardSync(): StableBoard | null {
  if (Date.now() - boardCache.at < 10_000) return boardCache.board;
  let board: StableBoard | null = null;
  try {
    board = parseBoard(readFileSync(BOARD_FILE, "utf8"));
  } catch {
    board = null; // service absent / not booted yet — honest null
  }
  boardCache = { at: Date.now(), board };
  return board;
}

export async function getStableBoard(): Promise<StableBoard | null> {
  return getStableBoardSync();
}

// ── event journal (service writes JSONL; app reads the tail) ────────────────

export interface StableFlowJournalEvent {
  ts: number; // ms
  kind: "MINTBURN" | "DEPEG" | "REGIME";
  asset: string;
  text: string;
  sev?: "info" | "warn" | "crit";
}

export function readRecentStableEvents(limit = 50): StableFlowJournalEvent[] {
  try {
    const raw = readFileSync(EVENTS_FILE, "utf8").trim();
    if (!raw) return [];
    const lines = raw.split("\n").slice(-limit);
    const out: StableFlowJournalEvent[] = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l));
      } catch {
        /* skip torn line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── DB persistence (app-side; Prisma owns writes) ───────────────────────────
// Mirrors the service's board + recent events into StableFlowEvent. Watermark
// = MAX(ts) per source, so restarts never duplicate rows. Honest-null: any
// failure returns a quiet {ok:false} — never breaks the engine tick.

const PERSIST_MIN_MS = 15 * 60_000;
let lastPersistAt = 0;
let persisting: Promise<{ ok: boolean; detail: string }> | null = null;

export async function maybePersistStableFlow(force = false): Promise<{ ok: boolean; detail: string }> {
  if (!force && Date.now() - lastPersistAt < PERSIST_MIN_MS) return { ok: true, detail: "throttled" };
  if (persisting) return persisting;
  persisting = (async () => {
    try {
      const board = getStableBoardSync();
      if (!board || !isBoardFresh(board)) return { ok: false, detail: "no fresh board" };
      // watermark: newest LIVE snapshot ts already persisted
      const wm = await db.stableFlowEvent.findFirst({
        where: { source: "LIVE", kind: "SNAPSHOT" },
        orderBy: { ts: "desc" },
        select: { ts: true },
      });
      const wmMs = wm?.ts ? new Date(wm.ts).getTime() : 0;
      if (board.at <= wmMs) return { ok: true, detail: "board already persisted" };

      const rows: Parameters<typeof db.stableFlowEvent.createMany>[0]["data"] = [];
      const pct = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
      // exact USD delta from a % move: Δ = mcap × (1 − 1/(1+pct/100))
      const usdFromPct = (mcap: number | null, p: number | null): number | undefined =>
        mcap !== null && p !== null ? Math.round(mcap * (1 - 1 / (1 + p / 100))) : undefined;
      for (const a of board.assets) {
        rows.push({
          ts: new Date(board.at),
          source: "LIVE",
          kind: "SNAPSHOT",
          asset: a.asset,
          mcapUsd: a.mcapUsd ?? undefined,
          delta1hUsd: usdFromPct(a.mcapUsd, a.delta1hPct),
          delta24hUsd: a.delta24hUsd ?? usdFromPct(a.mcapUsd, a.delta24hPct),
          delta7dUsd: usdFromPct(a.mcapUsd, a.delta7dPct),
          pegDevPct: pct(a.pegDevPct) ?? undefined,
        });
      }
      rows.push({
        ts: new Date(board.at),
        source: "LIVE",
        kind: "SNAPSHOT",
        asset: "TOTAL",
        mcapUsd: board.totalMcapUsd ?? undefined,
        delta24hUsd: usdFromPct(board.totalMcapUsd, board.totalDelta24hPct),
        delta7dUsd: usdFromPct(board.totalMcapUsd, board.totalDelta7dPct),
        regime: board.regime,
        note: board.regimeReason,
      });
      // NOTE: Prisma 6 SQLite has no skipDuplicates — the watermark above is
      // the dedup guarantee (single app process + wmMs guard make this safe).
      await db.stableFlowEvent.createMany({ data: rows });

      // events since the watermark — mirrored with kind preserved
      const evs = readRecentStableEvents(30).filter((e) => e.ts > wmMs && e.ts <= Date.now());
      if (evs.length > 0) {
        await db.stableFlowEvent.createMany({
          data: evs.map((e) => ({
            ts: new Date(e.ts),
            source: "LIVE" as const,
            kind: e.kind,
            asset: e.asset,
            note: e.text.slice(0, 240),
          })),
        });
      }
      lastPersistAt = Date.now();
      return { ok: true, detail: `persisted ${rows.length} snapshots + ${evs.length} events (wm ${new Date(wmMs).toISOString()})` };
    } catch (e) {
      return { ok: false, detail: String(e).slice(0, 120) };
    } finally {
      persisting = null;
    }
  })();
  return persisting;
}
