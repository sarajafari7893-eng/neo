// ── FlowRadar Neo v8.2 SHADOW-VETO — AI-core PHASE 0 (server-only) ──
// Operator mandate 2026-09-09: «قدم بعدی پیشنهادی رو کامل و مهندسی انجام بده»
// — the suggested next step from the AI-core usefulness doctrine
// (OP-AUDIT-TERMINAL-0908 ④ + OP-GATE-GAUGE-0908): a TIERED- AUTHORITY second
// opinion at the deploy gate, fully instrumented before it ever gains power.
//
//   Phase 0 (THIS): shadow mode — the adjudicator reviews every candidate in
//   the fence window (hair-thin passes gap 0..+3, near-miss rejects gap
//   −8..0), its verdicts are journaled, and BOTH sides of the fence are
//   outcome-tracked:
//     · PASS-side verdicts link to the REAL deployed trade (the would-veto
//       cohort keeps trading — that is the counterfactual evidence).
//     · REJECT-side TRADE verdicts open PAPER trades with engine-identical
//       geometry — the "would-have-won" ledger for fence rejects.
//   Phase 1 (gated): veto mode — unlockable ONLY on measured evidence
//   (≥30 settled per arm + Wilson-LB separation + negative veto-cohort PnL).
//   In veto mode a fresh VETO verdict blocks the deploy (fail-open: stale or
//   missing verdict → deploy proceeds) and the blocked trade is paper-tracked
//   so revocation pressure stays measurable.
//
// Division of labour: gate-journal.ts = capture · verdict.ts = learning ·
// THIS module = the adjudicator + outcome closure + A/B evidence. Zero SQLite
// writes for records (memory rings + .data/shadow-veto.jsonl); only the
// rarely-written config persists in EngineSetting (verdictcore.state pattern).
// Fail-open everywhere: this module must never throw into the deploy path.
//
// v10.19 FULL ACTIVATION (operator mandate 2026-09-24 «Shadow veto را کامل فعال کن»):
//   (1) LINK-DELTA REBUILD (lost v10.17, restored): hydration now MERGES
//       duplicate verdict records — the JSONL re-persists a verdict when its
//       state upgrades (serial bind / outcome closure / orphan sweep), but the
//       old first-record-wins hydration silently reverted linked verdicts to
//       unlinked on every restart (the real-veto 17→12 regression).
//   (2) ORPHAN SWEEP: the retro-link sweep now stamps verdicts whose fence
//       window closed with NO bindable deploy as swept orphans (sweptAt).
//       Forensic 2026-09-24: 84% of the stale backlog was structural orphan
//       (candidate adjudicated, deploy refused downstream) — counting them as
//       leaks DEADLOCKED the v10.16 promotion gate forever. The gate now
//       counts ACTIVE leaks only.
//   (3) mode=veto activated by OPERATOR MANDATE (audited force — arms were
//       27/30 + 12/30, evidence not yet full; veto stays fail-open, MODEL-
//       verdict-only, revocable, paper-tracked).

import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { seqStopEvaluate, type SeqStopResult } from "./seq-stop"; // v10.11 SEQ-STOP (operator APPROVE 2026-09-17)
import path from "node:path";
import { db } from "@/lib/db";
import { getGateSettings } from "@/lib/gate-settings";
import { feeBreakdown, ladderWeightedMove, LADDER_TRANCHES } from "@/lib/accounting";
import { fetchKlines } from "@/lib/market-feed";
import { buildSnapshot } from "@/lib/indicators";
import type { GateFactor, GateSource, ThrBreakdown } from "@/lib/gate-journal";

// ── types ─────────────────────────────────────────────────────

export type ShadowVetoMode = "off" | "shadow" | "veto";
export type FenceSide = "PASS" | "REJECT"; // hair-thin pass (0..+3) vs near-miss reject (−8..0)
export type Adjudication = "TRADE" | "VETO";

export interface ShadowVetoConfig {
  mode: ShadowVetoMode;
  windowPass: number; // adjudicate PASS candidates with gap ≤ this (default +3)
  windowReject: number; // adjudicate rejects with gap ≥ this (default −8)
  budgetPerHour: number; // max LLM adjudications / hour
  minSpacingMs: number; // min spacing between LLM calls
  dedupMs: number; // per symbol|direction re-adjudication interval
  cacheTtlMs: number; // deploy-time veto lookup freshness
  paperMarginUsd: number; // hypothetical margin for paper trades
  autoPromote: boolean; // v9.3 — flip to mode=veto automatically when promotionEvidence reports READY (operator mandate ج)
  observeCapture: boolean; // v10.6 (operator mandate 2026-09-15 «پرشدن بازوهای shadow-veto را سرعت و بهبود ببخش»):
  // RAW-CAL capture deploys run with ALL quality gates bypassed — including the
  // deploy-time adjudication — so 100+ capture issues produced ZERO pass-side
  // verdicts and the REAL arms starved (real-keep 9/30 after 113 issues).
  // observe=true: capture deploys still get an OBSERVE-ONLY adjudication (side
  // PASS, never vetoes — capture authority is untouched) linked to the real
  // serial, so every capture settle lands in the real-keep / real-veto arms.
}

export interface ShadowOutcome {
  status: string; // TP1/TP2/TP3/SL/EXPIRED/CLOSED or paper equivalents
  pnlPercent: number; // margin-relative NET (engine contract)
  pnlUsd: number;
  win: boolean; // pnlPercent > 0 || reachedTp ≥ 1 (engine win rule)
  closedAt: number;
}

export interface ShadowVerdict {
  id: string; // SV-xxxx
  at: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  side: FenceSide;
  gap: number;
  score: number;
  effMin: number;
  thr: ThrBreakdown;
  verdict: Adjudication;
  confidence: number; // 0..100
  reason: string;
  label: "MODEL" | "HEURISTIC";
  audit: { cited: number; unmatched: number[]; verdict: "CLEAN" | "SUSPECT" | "VIOLATION" } | null; // v8.2.1 grounding audit (null = legacy record / no model attempt)
  source: GateSource;
  serial: number | null; // real-trade linkage (PASS side)
  outcome: ShadowOutcome | null; // settled real outcome
  epoch?: string; // v10.7 ARM-EPOCH — regime stamp; legacy (un-stamped) records stay audit-only
  origin?: "capture" | "fence"; // v10.16 PROVENANCE (audit 4-f) — "capture" = RAW-CAL capture-observe adjudication (observe-only instrumentation, NEVER fence evidence); "fence" = normal gate-fence adjudication. Legacy records predate the stamp and are identified by their [CAPTURE-OBSERVE] reason suffix (see isCaptureOrigin).
  sweptAt?: number; // v10.19 ORPHAN SWEEP — timestamp the retro-link sweep confirmed this verdict's fence window closed with NO bindable deploy (structural orphan: candidate adjudicated, deploy refused downstream by max-open/spacing/governor/risk gates). Swept orphans are honest non-evidence, promotion-inert — NOT active leaks.
}

export interface PaperTrade {
  id: string; // PP-xxxx
  verdictId: string;
  originSide: FenceSide;
  originVerdict: Adjudication;
  at: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  entry: number;
  stop: number; // effective (trailed) stop
  initialStop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  leverage: number;
  marginUsd: number;
  slDistPct: number;
  rr: number;
  ttlMinutes: number;
  status: "OPEN" | "TP1" | "TP2" | "TP3" | "SL" | "EXPIRED";
  reachedTp: number; // 0..3 — TP-proven ledger
  maxPnlPercent: number;
  pnlPercent: number; // final NET (margin-relative) once settled
  pnlUsd: number;
  outcome: ShadowOutcome | null;
  closeNote: string | null;
  epoch?: string; // v10.7 ARM-EPOCH — regime stamp inherited at creation
}

// ── storage (mirrors gate-journal: rings + JSONL, zero SQLite) ──

const VERDICT_CAP = 600;
// v10.7 ARM-EPOCH HYGIENE (operator-approved 2026-09-16 «تایید کامل و مهندسی
// ARM-EPOCH HYGIENE» — SUPERVISOR proposal, web-search-validated min-sample
// guardrail + regime-tagging practice). The A/B arms are REGIME evidence: a
// ring that mixes pre/post-v10.6 outcomes lets a stale regime outvote the
// live one (paper-keep 94/30 = 3× target) and feeds autoPromote stale
// aggregates. Three properties, minimal-diff:
//   (1) EPOCH STAMP — every entry carries the epoch it was born in.
//   (2) PAPER FIFO CAP 60 — the paper ring is capped at 60 (was 400) so the
//       paper cohorts stay recent-regime; OPEN papers are evicted LAST so a
//       burst cannot orphan live counterfactuals mid-settlement.
//   (3) SAME-EPOCH PROMOTION — arms + promotion cohorts count CURRENT-epoch
//       entries only; legacy (un-stamped) records stay in the rings for
//       audit/history but can no longer vote. Accelerated qualification:
//       n≥20 with Wilson-LB95 ≥ 50% instead of the full n≥30.
// v10.10 REGIME-ALIGNED SHADOW COHORTS (SUPERVISOR proposal 19:00Z, operator
// APPROVE via bridge 2026-09-16 19:01Z «پیشنهاد سوپروایزر را تایید می کنم»):
// promotion evidence moves from ANCHORED (cumulative-since-epoch) cohorts to
// FIXED ROLLING-30 settled windows per arm — the same window semantics as the
// realizedEdge memory gate. Rationale: the gate suppresses on rolling-30 while
// anchored promotion cohorts wait for epoch-anchored fills the gate itself
// throttles to a trickle between runs → structural promotion deadlock (real
// arms frozen 7/8-9/30 for 30h+). Epoch stays as a hygiene TAG (un-stamped
// legacy rows still never vote); a previous-epoch row sits in the window only
// until 30 fresher settles slide it out. Walk-forward best practice prefers
// fixed rolling windows when regime change makes stale evidence obsolete.
export const ARM_EPOCH = "E-20260915"; // opened at the v10.6 observeCapture regime
const ROLLING_WINDOW = 30; // v10.10 — per-arm evidence window (most-recent settled)
const PAPER_CAP = 60;
const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "shadow-veto.jsonl");
const FILE_MAX_BYTES = 6 * 1024 * 1024;

const verdicts: ShadowVerdict[] = [];
const papers: PaperTrade[] = [];
let persisted = 0;
let hydrating: Promise<void> | null = null;
let seq = 0;
// v8.2.1 INGEST DISCIPLINE — Turbopack can run TWO module instances (old engine
// closure + freshly compiled routes) that BOTH adjudicate and write this JSONL
// with independent seq counters (length-derived seq caused id reuse: SV/PP-0039
// written twice). All ingestion therefore goes through id-unique + candidate-
// collapse gates so rings stay honest no matter how many instances write.
const seenIds = new Set<string>();
const INGEST_COLLAPSE_MS = 10 * 60_000; // same candidate adjudicated twice within 10min = cross-instance duplicate

function maxIdSeq(list: Array<{ id: string }>): number {
  let max = 0;
  for (const r of list) {
    const m = /^S[VP]-(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function ingestVerdict(v: ShadowVerdict): boolean {
  if (!v || typeof v.id !== "string") return false;
  // v10.19 LINK-DELTA REBUILD (restored lost v10.17): the JSONL re-persists a
  // verdict whenever its state UPGRADES (linkRealDeploy binds the serial, the
  // outcome sweep closes it, the orphan sweep stamps it). First-record-wins
  // hydration silently DROPPED those upgrades — every restart reverted linked-
  // but-unsettled verdicts back to unlinked (the real-veto 17→12 regression
  // after the 2026-09-21 restarts). Duplicate ids now MERGE their upgrade
  // fields into the already-ingested record, order-independent.
  if (seenIds.has(v.id)) {
    const ex = verdicts.find((x) => x.id === v.id);
    if (ex) {
      if (ex.serial === null && v.serial !== null) ex.serial = v.serial;
      if (!ex.outcome && v.outcome) ex.outcome = v.outcome;
      if (ex.sweptAt === undefined && v.sweptAt !== undefined) ex.sweptAt = v.sweptAt;
    }
    return false;
  }
  v.audit = v.audit ?? null; // normalize legacy records
  // collapse cross-instance duplicate adjudications of the same candidate —
  // scan backwards to the candidate's latest record; inside the window = dupe
  for (let i = verdicts.length - 1; i >= 0; i--) {
    const x = verdicts[i]!;
    if (x.symbol === v.symbol && x.direction === v.direction) {
      if (Math.abs(x.at - v.at) < INGEST_COLLAPSE_MS) return false;
      break;
    }
  }
  seenIds.add(v.id);
  verdicts.push(v);
  if (verdicts.length > VERDICT_CAP) verdicts.splice(0, verdicts.length - VERDICT_CAP);
  return true;
}

function ingestPaper(p: PaperTrade): boolean {
  if (!p || typeof p.id !== "string") return false;
  if (seenIds.has(p.id)) return false;
  seenIds.add(p.id);
  papers.push(p);
  trimPapers();
  return true;
}

/** v10.7 FIFO cap with evidence-safety — evict oldest SETTLED papers first;
 * only when the ring is all-OPEN (degenerate burst) fall back to oldest-first.
 * A settled record can always be re-derived from the rotated journal, but a
 * live counterfactual evicted mid-flight is lost evidence forever. */
function trimPapers(): void {
  if (papers.length <= PAPER_CAP) return;
  let overflow = papers.length - PAPER_CAP;
  for (let i = 0; i < papers.length && overflow > 0; ) {
    if (papers[i]!.outcome) {
      papers.splice(i, 1);
      overflow--;
    } else i++;
  }
  if (papers.length > PAPER_CAP) papers.splice(0, papers.length - PAPER_CAP);
}
// v8.2.1 SPLIT-BRAIN COUNTERMEASURE (mirrors gate-journal.ts) — Turbopack dev
// compiles one module instance PER ROUTE; the engine's instance adjudicates +
// writes the JSONL while a freshly-compiled read route would otherwise show a
// frozen/empty view forever. readPos-tailing keeps every reader live.
let readPos = 0;
let hydratedAt = 0;
let refreshing: Promise<void> | null = null;
let lastRefreshAt = 0;
const REFRESH_MIN_INTERVAL_MS = 10_000;
const REFRESH_MAX_BITE = 512 * 1024;

const DEFAULT_CONFIG: ShadowVetoConfig = {
  mode: "shadow",
  windowPass: 3,
  windowReject: -8,
  budgetPerHour: 12,
  minSpacingMs: 90_000,
  dedupMs: 30 * 60_000,
  cacheTtlMs: 8 * 60_000,
  paperMarginUsd: 5,
  autoPromote: true, // v9.3 — arms fill → real veto activates itself, no operator flip needed
  observeCapture: true, // v10.6 — capture deploys adjudicated observe-only so REAL arms fill
};

const CONFIG_KEY = "shadowveto.config";
let configCache: ShadowVetoConfig | null = null;
let configLoadedAt = 0;

async function hydrate(): Promise<void> {
  if (hydrating) return hydrating;
  hydrating = (async () => {
    try {
      const buf = await readFile(FILE, "utf8").catch(() => "");
      if (buf) {
        const lines = buf.split("\n").filter(Boolean);
        for (const line of lines.slice(-3000)) {
          try {
            const rec = JSON.parse(line) as { k: string; v: unknown };
            if (rec.k === "v") ingestVerdict(rec.v as ShadowVerdict);
            else if (rec.k === "p") ingestPaper(rec.v as PaperTrade);
            else if (rec.k === "o") applyOutcomeRecord(rec.v as { id: string; outcome: ShadowOutcome });
            else if (rec.k === "pc") applyPaperClose(rec.v as { id: string; status: PaperTrade["status"]; reachedTp: number; pnlPercent: number; pnlUsd: number; stop: number; outcome: ShadowOutcome; closeNote: string });
          } catch {
            /* torn line */
          }
        }
        // v8.2.1 — seq MUST derive from the MAX id on disk (length-derived seq
        // reused ids when two module instances wrote with independent counters)
        seq = Math.max(maxIdSeq(verdicts), maxIdSeq(papers));
      }
      const st = await stat(FILE).catch(() => null);
      persisted = st?.size ?? 0;
      readPos = st?.size ?? 0;
      hydratedAt = Date.now();
      // dedup continuity across instance swaps — a fresh instance must not
      // instantly re-adjudicate what another instance just adjudicated
      for (const v of verdicts) {
        const key = `${v.symbol}|${v.direction}`;
        const prev = lastAdjAt.get(key) ?? 0;
        if (v.at > prev) lastAdjAt.set(key, v.at);
      }
      if ((st?.size ?? 0) > FILE_MAX_BYTES) {
        // v10.6.1 persist-guard (operator APPROVE 2026-09-18): rotation is the
        // destructive rewrite — if a fresher boot just rotated, resync our
        // counters from disk instead of renaming over its rotation.
        const { persistGuardOk, persistWatermark, serializePersist } = await import("./persist-guard");
        await serializePersist("shadow-veto-journal", async () => {
          if (!(await persistGuardOk("shadow-veto-journal"))) {
            const fresh = await stat(FILE).catch(() => null);
            persisted = Math.min(fresh?.size ?? 0, FILE_MAX_BYTES);
            readPos = fresh?.size ?? 0;
            return;
          }
          await rename(FILE, `${FILE}.old`).catch(() => undefined);
          await persistWatermark("shadow-veto-journal");
          persisted = 0;
          readPos = 0;
        });
      }
    } catch {
      /* journaling must never break the engine */
    }
  })();
  return hydrating;
}

async function persist(rec: { k: string; v: unknown }): Promise<void> {
  try {
    const line = JSON.stringify(rec) + "\n";
    await appendFile(FILE, line, "utf8");
    persisted += line.length;
    readPos += line.length; // our own bytes are already in the rings
    if (persisted > FILE_MAX_BYTES) {
      // v10.6.1 persist-guard: serialize rotation + re-stat before renaming so
      // concurrent writers (or a stale generation) never clobber a fresh file.
      const { persistGuardOk, persistWatermark, serializePersist } = await import("./persist-guard");
      await serializePersist("shadow-veto-journal", async () => {
        const cur = await stat(FILE).catch(() => null);
        if ((cur?.size ?? 0) <= FILE_MAX_BYTES) {
          // someone else already rotated — just resync our counters
          persisted = Math.min(cur?.size ?? 0, FILE_MAX_BYTES);
          readPos = cur?.size ?? 0;
          return;
        }
        if (!(await persistGuardOk("shadow-veto-journal"))) {
          const fresh = await stat(FILE).catch(() => null);
          persisted = Math.min(fresh?.size ?? 0, FILE_MAX_BYTES);
          readPos = fresh?.size ?? 0;
          return;
        }
        await rename(FILE, `${FILE}.old`).catch(() => undefined);
        await persistWatermark("shadow-veto-journal");
        persisted = 0;
        readPos = 0;
      });
    }
  } catch {
    /* non-fatal */
  }
}

export async function shadowVetoReady(): Promise<void> {
  await hydrate();
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch {
    /* exists */
  }
}

/** v8.2.1 READ-PATH LIVENESS — tail-ingest another instance's writes (see
 * gate-journal.gateJournalRefresh for the full rationale). Throttled,
 * single-flight, rotation-safe, bounded bite. */
export async function shadowVetoRefresh(maxAgeMs = REFRESH_MIN_INTERVAL_MS): Promise<void> {
  if (Date.now() - lastRefreshAt < maxAgeMs) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const st = await stat(FILE).catch(() => null);
      if (!st) return;
      if (st.size < readPos) readPos = 0; // rotated
      if (st.size === readPos) return;
      const len = Math.min(st.size - readPos, REFRESH_MAX_BITE);
      const fh = await open(FILE, "r").catch(() => null);
      if (!fh) return;
      try {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, readPos);
        let text = buf.toString("utf8", 0, bytesRead);
        const lastNl = text.lastIndexOf("\n");
        if (lastNl === -1) return; // partial line — wait for the writer
        text = text.slice(0, lastNl + 1);
        readPos += Buffer.byteLength(text, "utf8");
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line) as { k: string; v: unknown };
            if (rec.k === "v") {
              const v = rec.v as ShadowVerdict;
              const m = /^SV-(\d+)$/.exec(v.id ?? "");
              if (ingestVerdict(v) && m) seq = Math.max(seq, Number(m[1]));
            } else if (rec.k === "p") {
              ingestPaper(rec.v as PaperTrade);
            } else if (rec.k === "o") applyOutcomeRecord(rec.v as { id: string; outcome: ShadowOutcome });
            else if (rec.k === "pc") applyPaperClose(rec.v as { id: string; status: PaperTrade["status"]; reachedTp: number; pnlPercent: number; pnlUsd: number; stop: number; outcome: ShadowOutcome; closeNote: string });
          } catch {
            /* torn line */
          }
        }
        hydratedAt = Date.now();
      } finally {
        await fh.close().catch(() => undefined);
      }
    } catch {
      /* non-fatal */
    } finally {
      lastRefreshAt = Date.now();
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function applyOutcomeRecord(rec: { id: string; outcome: ShadowOutcome }): void {
  const v = [...verdicts].reverse().find((x) => x.id === rec.id);
  if (v && !v.outcome) v.outcome = rec.outcome;
}

function applyPaperClose(rec: { id: string; status: PaperTrade["status"]; reachedTp: number; pnlPercent: number; pnlUsd: number; stop: number; outcome: ShadowOutcome; closeNote: string }): void {
  const p = [...papers].reverse().find((x) => x.id === rec.id);
  if (p && !p.outcome) {
    p.status = rec.status;
    p.reachedTp = rec.reachedTp;
    p.pnlPercent = rec.pnlPercent;
    p.pnlUsd = rec.pnlUsd;
    p.stop = rec.stop;
    p.outcome = rec.outcome;
    p.closeNote = rec.closeNote;
  }
}

// ── config (EngineSetting — the rare-write exception, verdictcore pattern) ──

export async function getShadowVetoConfig(force = false): Promise<ShadowVetoConfig> {
  if (!force && configCache && Date.now() - configLoadedAt < 15_000) return configCache;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: CONFIG_KEY } });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<ShadowVetoConfig>;
      configCache = {
        mode: (["off", "shadow", "veto"] as const).includes(parsed.mode as ShadowVetoMode) ? (parsed.mode as ShadowVetoMode) : DEFAULT_CONFIG.mode,
        windowPass: Number.isFinite(parsed.windowPass) ? Math.max(0, Math.min(10, parsed.windowPass!)) : DEFAULT_CONFIG.windowPass,
        windowReject: Number.isFinite(parsed.windowReject) ? Math.max(-30, Math.min(0, parsed.windowReject!)) : DEFAULT_CONFIG.windowReject,
        budgetPerHour: Number.isFinite(parsed.budgetPerHour) ? Math.max(2, Math.min(40, parsed.budgetPerHour!)) : DEFAULT_CONFIG.budgetPerHour,
        minSpacingMs: Number.isFinite(parsed.minSpacingMs) ? Math.max(30_000, parsed.minSpacingMs!) : DEFAULT_CONFIG.minSpacingMs,
        dedupMs: Number.isFinite(parsed.dedupMs) ? Math.max(5 * 60_000, parsed.dedupMs!) : DEFAULT_CONFIG.dedupMs,
        cacheTtlMs: Number.isFinite(parsed.cacheTtlMs) ? Math.max(60_000, parsed.cacheTtlMs!) : DEFAULT_CONFIG.cacheTtlMs,
        paperMarginUsd: Number.isFinite(parsed.paperMarginUsd) ? Math.max(1, Math.min(20, parsed.paperMarginUsd!)) : DEFAULT_CONFIG.paperMarginUsd,
        autoPromote: typeof parsed.autoPromote === "boolean" ? parsed.autoPromote : DEFAULT_CONFIG.autoPromote,
        observeCapture: typeof parsed.observeCapture === "boolean" ? parsed.observeCapture : DEFAULT_CONFIG.observeCapture,
      };
    } else configCache = { ...DEFAULT_CONFIG };
  } catch {
    configCache = configCache ?? { ...DEFAULT_CONFIG };
  }
  configLoadedAt = Date.now();
  return configCache!;
}

export async function saveShadowVetoConfig(patch: Partial<ShadowVetoConfig>): Promise<ShadowVetoConfig> {
  const cur = await getShadowVetoConfig(true);
  const next: ShadowVetoConfig = { ...cur, ...patch };
  await db.engineSetting.upsert({
    where: { key: CONFIG_KEY },
    create: { key: CONFIG_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  configCache = next;
  configLoadedAt = Date.now();
  return next;
}

// ── statistics helpers ────────────────────────────────────────

/** Wilson score LOWER bound at 95% (z=1.96) — the A/B evidence statistic. */
export function wilsonLB(wins: number, n: number): number | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, ((centre - spread) / denom) * 100);
}

// ── budget / dedup state ──────────────────────────────────────

const callStamps: number[] = [];
let lastCallAt = 0;
const lastAdjAt = new Map<string, number>();
const verdictCache = new Map<string, ShadowVerdict>(); // symbol|direction → latest
let pendingCount = 0;
const MAX_PENDING = 3;

function withinBudget(cfg: ShadowVetoConfig): boolean {
  const now = Date.now();
  while (callStamps.length && now - callStamps[0]! > 3600_000) callStamps.shift();
  if (callStamps.length >= cfg.budgetPerHour) return false;
  if (now - lastCallAt < cfg.minSpacingMs) return false;
  return true;
}

// ── fence offers (engine calls after recordGateSamples) ───────

export interface FenceCandidate {
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  score: number; // signed adjScore
  effMin: number;
  baseMin: number;
  thr: ThrBreakdown;
  confirms: GateFactor[];
  opposes: GateFactor[];
  notes: string | null;
  source: GateSource;
  passed: boolean;
}

/** Offer a scan batch's fence candidates to the adjudicator. Fire-and-forget,
 * self-budgeted, deduped — never throws, never blocks the scan. */
export async function offerFenceAdjudication(batch: FenceCandidate[]): Promise<void> {
  try {
    const cfg = await getShadowVetoConfig();
    if (cfg.mode === "off" || batch.length === 0 || pendingCount >= MAX_PENDING) return;
    await shadowVetoReady();
    const now = Date.now();
    // closest-to-gate first so the budget buys the most informative verdicts
    const fence = batch
      .map((c) => ({ c, gap: Math.abs(c.score) - c.effMin }))
      .filter(({ c, gap }) => (c.passed ? gap >= 0 && gap <= cfg.windowPass : gap < 0 && gap >= cfg.windowReject))
      .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
    for (const { c, gap } of fence) {
      const key = `${c.symbol}|${c.direction}`;
      const last = lastAdjAt.get(key) ?? 0;
      if (now - last < cfg.dedupMs) continue;
      const cached = verdictCache.get(key);
      if (cached && now - cached.at < cfg.cacheTtlMs) continue; // fresh verdict already in place
      lastAdjAt.set(key, now);
      pendingCount++;
      void runAdjudication(c, c.passed ? "PASS" : "REJECT", gap)
        .catch(() => undefined)
        .finally(() => {
          pendingCount = Math.max(0, pendingCount - 1);
        });
    }
  } catch {
    /* never break the scan */
  }
}

async function runAdjudication(c: FenceCandidate, side: FenceSide, gap: number): Promise<void> {
  const cfg = await getShadowVetoConfig(true);
  if (cfg.mode === "off") return;
  if (!withinBudget(cfg)) return;
  callStamps.push(Date.now());
  lastCallAt = Date.now();
  await adjudicateCore(c, side, gap, cfg); // origin defaults to "fence" — the normal gate-fence path
}

/** v10.6 CAPTURE-OBSERVE (operator mandate «پرشدن بازوهای shadow-veto را سرعت و بهبود ببخش»،
 * 2026-09-15). ROOT CAUSE of the REAL-arm starvation: RAW-CAL capture deploys run
 * with bypassQuality=true, which SKIPS the entire shadow-veto deploy path — so 113
 * capture issues produced ZERO pass-side verdicts and real-keep froze at 9/30
 * (n-keep is the binding promotion criterion). observe(): an OBSERVE-ONLY
 * adjudication on every capture deploy — side PASS (the trade IS deploying),
 * verdict NEVER vetoes (capture authority untouched), linked to the real serial
 * by the existing linkRealDeploy → settle → closeRealOutcomes chain. Every
 * capture settle now lands in the real-keep / real-veto A/B arms. Budget-honest:
 * shares the LLM accounting (callStamps) with a small observe headroom, spaced
 * by minSpacingMs; capture cadence (~12min spacing) keeps it ≈3-5 calls/h. */
let lastObserveAt = 0;
export async function shadowVetoObserve(ctx: DeployGateCtx): Promise<void> {
  try {
    const cfg = await getShadowVetoConfig(true);
    if (cfg.mode === "off" || !cfg.observeCapture) return;
    await shadowVetoReady();
    const now = Date.now();
    if (now - lastObserveAt < cfg.minSpacingMs) return;
    const key = `${ctx.symbol}|${ctx.direction}`;
    const cached = verdictCache.get(key);
    if (cached && now - cached.at < cfg.cacheTtlMs && cached.side === "PASS" && cached.serial === null) return; // fresh unlinked verdict — linkRealDeploy will bind it
    lastObserveAt = now;
    callStamps.push(now);
    lastCallAt = now;
    await adjudicateCore(
      {
        symbol: ctx.symbol,
        direction: ctx.direction,
        strategy: ctx.strategy,
        score: ctx.score,
        effMin: ctx.effMin,
        baseMin: 0,
        thr: ctx.thr,
        confirms: ctx.confirms,
        opposes: ctx.opposes,
        notes: ctx.notes,
        source: ctx.source,
        passed: true,
      },
      "PASS",
      ctx.gap,
      cfg,
      " [CAPTURE-OBSERVE]",
      "capture", // v10.16 — stamped so promotion evidence can exclude the capture path
    );
  } catch {
    /* observe must never break the deploy */
  }
}

async function adjudicateCore(c: FenceCandidate, side: FenceSide, gap: number, cfg: ShadowVetoConfig, tag = "", origin: "capture" | "fence" = "fence"): Promise<void> {
  const { aiShadowAdjudication } = await import("@/lib/ai");
  const res = await aiShadowAdjudication({
    symbol: c.symbol,
    direction: c.direction,
    strategy: c.strategy,
    side,
    gap,
    score: c.score,
    effMin: c.effMin,
    thr: c.thr as unknown as Record<string, number>,
    confirms: c.confirms,
    opposes: c.opposes,
    notes: c.notes,
  });
  seq++;
  const rec: ShadowVerdict = {
    id: `SV-${String(seq).padStart(4, "0")}`,
    at: Date.now(),
    symbol: c.symbol,
    direction: c.direction,
    strategy: c.strategy,
    side,
    gap,
    score: c.score,
    effMin: c.effMin,
    thr: c.thr,
    verdict: res.verdict,
    confidence: res.confidence,
    reason: `${res.reason}${tag}`,
    label: res.label,
    audit: res.audit ?? null, // v8.2.1 grounding audit rides the record
    source: c.source,
    serial: null,
    outcome: null,
    epoch: ARM_EPOCH, // v10.7 — born into the current evidence epoch
    origin, // v10.16 — capture vs fence provenance (readers ignore unknown fields; JSONL is additive)
  };
  verdicts.push(rec);
  seenIds.add(rec.id); // id-discipline: this instance's live verdicts are also "seen"
  if (verdicts.length > VERDICT_CAP) verdicts.splice(0, verdicts.length - VERDICT_CAP);
  verdictCache.set(`${c.symbol}|${c.direction}`, rec);
  void persist({ k: "v", v: rec });

  // v8.2.1 — an audited HALLUCINATION is an operator-visible event (rate-bounded
  // by the adjudication budget itself; this path only fires on VIOLATION)
  if (res.audit?.verdict === "VIOLATION") {
    await import("@/lib/engine")
      .then((m) => m.fireEvent(null, c.symbol, "ENGINE", "warn", `SHADOW-VETO ${rec.id}: model verdict DISCARDED — grounding violation (${res.audit!.unmatched.length} citations not in evidence bundle). Heuristic adjudication used instead.`))
      .catch(() => undefined);
  }

  // REJECT-side TRADE verdict = the core disagrees with the numeric gate →
  // open the counterfactual paper trade (the would-have-won ledger).
  if (side === "REJECT" && res.verdict === "TRADE") void openPaperTrade(rec, cfg.paperMarginUsd).catch(() => undefined);

  // rate-limited audit event so the operator sees the core speaking
  if ((side === "REJECT" && res.verdict === "TRADE") || (side === "PASS" && res.verdict === "VETO")) {
    const pos = side === "PASS" ? "hair-thin pass" : `fence reject gap ${gap.toFixed(1)}`;
    const msg = `SHADOW-VETO ${rec.id}: ${c.symbol} ${c.direction} (${pos}) → ${res.verdict} @ ${res.confidence}% — ${res.reason}`;
    await import("@/lib/engine")
      .then((m) => m.fireEvent(null, c.symbol, "ENGINE", "ai", msg))
      .catch(() => undefined);
  }
}

// ── deploy-time gate (Phase 1; cache lookup only — zero added latency) ──

export interface DeployGateCtx {
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  score: number;
  effMin: number;
  gap: number;
  thr: ThrBreakdown;
  confirms: GateFactor[];
  opposes: GateFactor[];
  notes: string | null;
  entryPrice: number;
  source: GateSource;
}

export interface DeployGateResult {
  veto: boolean;
  verdictId: string | null;
  reason: string | null;
  mode: ShadowVetoMode;
}

/** Deploy-path check. FAIL-OPEN by design: no fresh verdict, mode≠veto, or any
 * error → the deploy proceeds. When a VETO actually blocks, the blocked trade
 * is paper-tracked so revocation pressure stays measurable. */
export async function shadowVetoDeployGate(ctx: DeployGateCtx): Promise<DeployGateResult> {
  const failOpen: DeployGateResult = { veto: false, verdictId: null, reason: null, mode: "shadow" };
  try {
    const cfg = await getShadowVetoConfig();
    failOpen.mode = cfg.mode;
    if (cfg.mode !== "veto" || ctx.gap > cfg.windowPass) return failOpen;
    await shadowVetoReady();
    const key = `${ctx.symbol}|${ctx.direction}`;
    const cached = verdictCache.get(key);
    const fresh = cached && Date.now() - cached.at < cfg.cacheTtlMs && cached.side === "PASS";
    if (!fresh || !cached) {
      // pre-warm for the next evaluation of this fence candidate
      void offerFenceAdjudication([
        {
          symbol: ctx.symbol,
          direction: ctx.direction,
          strategy: ctx.strategy,
          score: ctx.score,
          effMin: ctx.effMin,
          baseMin: 0,
          thr: ctx.thr,
          confirms: ctx.confirms,
          opposes: ctx.opposes,
          notes: ctx.notes,
          source: ctx.source,
          passed: true,
        },
      ]);
      return failOpen;
    }
    // v8.4.1 HARD GUARD — only MODEL verdicts may ever block a real deploy.
    // Heuristic verdicts are honest fallbacks (429 storms, grounding violations)
    // but a deterministic net-vote sign must never veto real capital. Fail-open.
    if (cached.label !== "MODEL") {
      void offerFenceAdjudication([
        {
          symbol: ctx.symbol,
          direction: ctx.direction,
          strategy: ctx.strategy,
          score: ctx.score,
          effMin: ctx.effMin,
          baseMin: 0,
          thr: ctx.thr,
          confirms: ctx.confirms,
          opposes: ctx.opposes,
          notes: ctx.notes,
          source: ctx.source,
          passed: true,
        },
      ]);
      return failOpen;
    }
    if (cached.verdict !== "VETO") return failOpen;
    // VETO fires — record the block + the counterfactual paper trade
    const geo = await paperGeometry(ctx.symbol, ctx.direction, ctx.strategy, ctx.entryPrice).catch(() => null);
    if (!geo) return failOpen;
    seq++;
    const paper = newPaperShell(`PP-${String(seq).padStart(4, "0")}`, cached, cfg, geo);
    papers.push(paper);
    trimPapers();
    void persist({ k: "p", v: paper });
    return { veto: true, verdictId: cached.id, reason: `${cached.label} ${cached.confidence}% — ${cached.reason}`, mode: cfg.mode };
  } catch {
    return failOpen;
  }
}

// ── real-outcome linkage ──────────────────────────────────────

/** Called right after db.signal.create — binds the freshest PASS-side verdict
 * for this symbol|direction to the real serial so the settle sweep can close
 * the loop with the REAL outcome. */
export async function linkRealDeploy(serial: number, symbol: string, direction: string): Promise<void> {
  try {
    if (!serial) return;
    await shadowVetoReady();
    const key = `${symbol}|${direction}`;
    const now = Date.now();
    const candidate = [...verdicts]
      .reverse()
      .find((v) => `${v.symbol}|${v.direction}` === key && v.side === "PASS" && v.serial === null && now - v.at < 15 * 60_000);
    if (candidate) {
      candidate.serial = serial;
      void persist({ k: "v", v: candidate });
    }
  } catch {
    /* linkage must never break the deploy */
  }
}

const SETTLED = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];

/** v8.4.3 RETRO-LINK SWEEP → v10.16 WIDE-WINDOW DRAIN (audit 4-f).
 *
 * Root cause (operator report 2026-09-12: «شاخص‌های REAL پر نمی‌شود»): the
 * fence BATCH (offerFenceAdjudication on journal rows) adjudicates a deploy's
 * own hair-pass row minutes AFTER the deploy already ran linkRealDeploy —
 * the verdict is born with serial=null after the only live-link chance has
 * passed. Result: 35/36 PASS verdicts never bound to the trades they
 * described, and the REAL arms stayed 0/30.
 *
 * v10.16: the sweep still could NOT drain its own backlog — (a) the match
 * window (−15min pre-deploy … +40min post-deploy) missed verdicts born at the
 * edges of that envelope, and (b) the trade lookback was fixed at 24h, so a
 * PASS verdict older than 24h could NEVER find its deploy again — the
 * "125 PASS verdicts older than 24h never linked" telemetry alert was
 * structurally permanent. Fixes, evidence-honesty preserved:
 *   · match window widened to ±90min (verdict born up to 90min before or after
 *     the deploy it describes — nearest-Δt greedy still picks the tightest
 *     pair);
 *   · the trade lookback now covers the OLDEST unlinked verdict (minus the
 *     90min pre-warm margin), bounded at 7 days, so the stale backlog drains
 *     instead of aging out.
 * Identity constraints UNCHANGED: same symbol|direction, one-to-one (a serial
 * binds at most one verdict and vice versa), never touches REJECT-side
 * verdicts or already-linked ones. Outcome closure stays with the existing
 * closeRealOutcomes sweep. Invoked on the engine's existing tick-%40 cadence
 * (same block as closeRealOutcomes / maybeAutoPromote), so the backlog drains
 * automatically without any new scheduler. */
export async function retroLinkRealDeploys(): Promise<number> {
  try {
    await shadowVetoReady();
    const unlinked = verdicts.filter((v) => v.side === "PASS" && v.serial === null);
    if (unlinked.length === 0) return 0;
    const taken = new Set(verdicts.filter((v) => v.serial !== null).map((v) => v.serial!));
    // v10.16 — look back far enough to reach the OLDEST unlinked verdict's
    // deploy window (±90min), bounded at 7 days so the query stays cheap.
    const oldestUnlinked = unlinked.reduce((a, v) => Math.min(a, v.at), Date.now());
    const sinceMs = Math.max(Date.now() - 7 * 24 * 3600_000, oldestUnlinked - 90 * 60_000);
    const sigs = await db.signal.findMany({
      where: { createdAt: { gte: new Date(sinceMs) } }, // serial is non-nullable on Signal — no extra filter needed
      select: { serial: true, symbol: true, direction: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 400,
    });
    let bound = 0;
    // v10.19 ORPHAN SWEEP — coverage bounds of the fetch (take-400 desc): when
    // the query returns its FULL take, the oldest fetched row bounds coverage;
    // otherwise the query reaches sinceMs. A verdict is only stampable as an
    // orphan when its ENTIRE ±90min fence window lies inside covered ground —
    // absence is then PROOF no deploy ever existed, not a fetch artifact.
    const coverageLower = sigs.length === 400 && sigs.length > 0 ? sigs[sigs.length - 1]!.createdAt.getTime() : sinceMs;
    let swept = 0;
    for (const v of unlinked) {
      let anyInWindow = false; // v10.19 — a matching deploy exists (even if claimed)
      let best: { serial: number; dt: number } | null = null;
      for (const s of sigs) {
        if (s.symbol !== v.symbol || s.direction !== v.direction) continue;
        const dt = v.at - s.createdAt.getTime(); // <0 = verdict pre-warmed the deploy, >0 = fence batch after it
        // v10.16 — match window widened 15min→90min (both sides) so edge-born
        // verdicts and the >24h stale backlog can bind their own trades.
        if (dt < -90 * 60_000 || dt > 90 * 60_000) continue;
        anyInWindow = true;
        if (taken.has(s.serial!)) continue;
        if (!best || Math.abs(dt) < Math.abs(best.dt)) best = { serial: s.serial!, dt };
      }
      if (best) {
        v.serial = best.serial;
        taken.add(best.serial);
        void persist({ k: "v", v });
        bound++;
      } else if (
        v.sweptAt === undefined &&
        v.at + 90 * 60_000 < Date.now() && // fence window fully closed — a late deploy can no longer arrive
        v.at - 90 * 60_000 >= coverageLower && // window fully inside the query reach
        !anyInWindow // no same-symbol|direction deploy existed at all → structural orphan, promotion-inert
      ) {
        v.sweptAt = Date.now();
        void persist({ k: "v", v });
        swept++;
      }
    }
    if (swept > 0) console.log(`[shadow-veto] retro-link: bound=${bound} swept-orphans=${swept}`);
    return bound;
  } catch {
    return 0; // evidence plumbing must never throw into the tick
  }
}

/** Periodic (engine tick %40): close real outcomes for linked verdicts. */
export async function closeRealOutcomes(): Promise<number> {
  try {
    await shadowVetoReady();
    console.log("[PROBE-CLOSE] verdicts in memory:", verdicts.length);
    {
      const now = Date.now();
      const byAge = { d1: 0, d3: 0, older: 0 } as Record<string, number>;
      for (const v of verdicts) { const a = now - v.at; if (a < 86400e3) byAge.d1++; else if (a < 3*86400e3) byAge.d3++; else byAge.older++; }
      console.log("[PROBE-CLOSE] memory age buckets:", JSON.stringify(byAge));
      const unlinked24 = verdicts.filter(v => v.side === "PASS" && v.serial === null && now - v.at < 86400e3);
      console.log("[PROBE-CLOSE] unlinked PASS last24h in memory:", unlinked24.length);
      const minAt = Math.min(...verdicts.map(v => v.at)), maxAt = Math.max(...verdicts.map(v => v.at));
      console.log("[PROBE-CLOSE] memory window:", new Date(minAt).toISOString(), "→", new Date(maxAt).toISOString());
    }
    const pending = verdicts.filter((v) => v.serial !== null && v.outcome === null);
    if (pending.length === 0) return 0;
    let closed = 0;
    console.log("[PROBE-CLOSE] pending:", pending.length);
    for (const v of pending.slice(-40)) {
      const sig = await db.signal.findFirst({ where: { serial: v.serial! }, select: { status: true, pnlPercent: true, marginUsd: true, reachedTp: true, closedAt: true } });
      if (!sig) { console.log("[PROBE-CLOSE] no signal for serial", v.serial, v.id); continue; }
      if (!SETTLED.includes(sig.status)) continue;
      const pnlUsd = (sig.marginUsd * sig.pnlPercent) / 100;
      v.outcome = {
        status: sig.status,
        pnlPercent: sig.pnlPercent,
        pnlUsd: Number(pnlUsd.toFixed(3)),
        win: sig.pnlPercent > 0 || sig.reachedTp >= 1,
        closedAt: sig.closedAt?.getTime() ?? Date.now(),
      };
      void persist({ k: "o", v: { id: v.id, outcome: v.outcome } });
      closed++;
    }
    return closed;
  } catch (e) {
    console.error("[PROBE-CLOSE] FATAL:", e);
    return 0;
  }
}

// ── paper engine (engine-identical accounting, honest PAPER label) ──

const TTL_BY_STRATEGY: Record<string, [number, number]> = {
  "AI-SCALP": [60, 120],
  "MEAN-REVERT": [90, 180],
  MOMENTUM: [90, 180],
  BREAKOUT: [90, 180],
  "AI-SWING": [240, 480],
};
const RR_BASE: Record<string, number> = { "AI-SCALP": 2.1, "MEAN-REVERT": 2.4, MOMENTUM: 2.8, BREAKOUT: 3.1, "AI-SWING": 3.4 };

interface PaperGeometry {
  entry: number;
  stop: number;
  initialStop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  leverage: number;
  slDistPct: number;
  rr: number;
  ttlMinutes: number;
}

/** Base geometry for paper trades: slAtrMult × ATR stop (no regime/vol/flow
 * drivers — those are deploy-time only), levered-risk-capped leverage, base RR.
 * Direction-aware. Documented simplification: the paper arm measures
 * DIRECTIONAL edge at the fence, not perfect PnL replication. */
async function paperGeometry(symbol: string, direction: "LONG" | "SHORT", strategy: string, entryOverride: number | null): Promise<PaperGeometry> {
  const gate = await getGateSettings();
  const candles = await fetchKlines(symbol, "15m", 160).catch(() => null);
  const snap = candles ? buildSnapshot(symbol, candles) : null;
  const entry = entryOverride ?? snap?.price ?? 0;
  if (!entry) throw new Error("no price");
  const atrPct = snap?.atrPct ?? 1.5;
  const slDistPct = Math.min(5, Math.max(0.7, gate.slAtrMult * atrPct)) / 100;
  const levRaw = Math.round(Math.min(20, Math.max(5, 60 / (slDistPct * 100))));
  const leverage = gate.leveredRiskCap > 0 && slDistPct * 100 * levRaw > gate.leveredRiskCap ? Math.max(5, Math.floor(gate.leveredRiskCap / (slDistPct * 100))) : levRaw;
  const rr = RR_BASE[strategy] ?? 2.6;
  const tp2Mult = Math.min(2.2, Math.max(1.5, 1.2 + rr * 0.22));
  const [ttlMin, ttlMax] = TTL_BY_STRATEGY[strategy] ?? [90, 180];
  const isLong = direction === "LONG";
  const risk = entry * slDistPct;
  const fx = (v: number) => Number(v.toFixed(entry > 100 ? 2 : 6));
  return {
    entry: fx(entry),
    initialStop: fx(isLong ? entry - risk : entry + risk),
    stop: fx(isLong ? entry - risk : entry + risk),
    tp1: fx(isLong ? entry + risk : entry - risk),
    tp2: fx(isLong ? entry + risk * tp2Mult : entry - risk * tp2Mult),
    tp3: fx(isLong ? entry + risk * rr : entry - risk * rr),
    leverage,
    slDistPct,
    rr,
    ttlMinutes: Math.round(ttlMin + Math.random() * (ttlMax - ttlMin)),
  };
}

function newPaperShell(id: string, verdict: ShadowVerdict, cfg: ShadowVetoConfig, geo: PaperGeometry): PaperTrade {
  return {
    id,
    verdictId: verdict.id,
    originSide: verdict.side,
    originVerdict: verdict.verdict,
    at: Date.now(),
    symbol: verdict.symbol,
    direction: verdict.direction,
    strategy: verdict.strategy,
    entry: geo.entry,
    stop: geo.stop,
    initialStop: geo.initialStop,
    tp1: geo.tp1,
    tp2: geo.tp2,
    tp3: geo.tp3,
    leverage: geo.leverage,
    marginUsd: cfg.paperMarginUsd,
    slDistPct: geo.slDistPct,
    rr: geo.rr,
    ttlMinutes: geo.ttlMinutes,
    status: "OPEN",
    reachedTp: 0,
    maxPnlPercent: 0,
    pnlPercent: 0,
    pnlUsd: 0,
    outcome: null,
    closeNote: null,
    epoch: ARM_EPOCH, // v10.7 — born into the current evidence epoch
  };
}

/** Open the counterfactual paper trade for a REJECT-side TRADE verdict. */
async function openPaperTrade(verdict: ShadowVerdict, paperMarginUsd: number): Promise<void> {
  try {
    void paperMarginUsd;
    const cfg = await getShadowVetoConfig();
    const asset = await db.marketAsset.findUnique({ where: { symbol: verdict.symbol }, select: { price: true } });
    if (!asset?.price) return;
    const geo = await paperGeometry(verdict.symbol, verdict.direction, verdict.strategy, asset.price);
    seq++;
    const paper = newPaperShell(`PP-${String(seq).padStart(4, "0")}`, verdict, cfg, geo);
    papers.push(paper);
    trimPapers();
    void persist({ k: "p", v: paper });
  } catch {
    /* paper must never break anything */
  }
}

const movePctAt = (p: PaperTrade, px: number): number => ((px - p.entry) / p.entry) * (p.direction === "LONG" ? 1 : -1) * 100;

/** Cheap tick-guard: only build the price map when paper positions exist. */
export function shadowPaperCount(): number {
  let open = 0;
  for (const p of papers) if (!p.outcome) open++;
  return open;
}

/** Per-tick sweep — engine passes the fresh price map. Mirrors the real
 * resolver: rung ladders with trailing stops, tranche-weighted closes, fees
 * via feeBreakdown, TTL expiry. In-memory, cheap, never throws. */
export async function shadowPaperSweep(priceMap: Map<string, number>): Promise<number> {
  try {
    if (papers.length === 0) return 0;
    const now = Date.now();
    let closed = 0;
    for (const p of papers) {
      if (p.outcome) continue;
      const price = priceMap.get(p.symbol);
      if (!price) continue;
      const isLong = p.direction === "LONG";
      const hitSl = isLong ? price <= p.stop : price >= p.stop;
      const hitTp1 = isLong ? price >= p.tp1 : price <= p.tp1;
      const hitTp2 = isLong ? price >= p.tp2 : price <= p.tp2;
      const hitTp3 = isLong ? price >= p.tp3 : price <= p.tp3;

      if (hitSl) {
        closePaper(p, "SL", movePctAt(p, p.stop), now, `stopped @ ${p.stop} (trailed)`);
        closed++;
      } else if (hitTp3) {
        p.reachedTp = 3;
        closePaper(p, "TP3", movePctAt(p, p.tp3), now, `final target ${p.rr.toFixed(1)}R secured`);
        closed++;
      } else if (hitTp2 && p.reachedTp < 2) {
        p.reachedTp = 2;
        p.status = "TP2";
        p.stop = p.tp1; // trail to TP1 — +1R locked (engine semantics)
      } else if (hitTp1 && p.reachedTp < 1) {
        p.reachedTp = Math.max(p.reachedTp, 1);
        p.status = "TP1";
        p.stop = p.entry; // breakeven trail (engine semantics)
      } else if (now > p.at + p.ttlMinutes * 60_000) {
        closePaper(p, "EXPIRED", movePctAt(p, price), now, `TTL ${p.ttlMinutes}m elapsed at mark`);
        closed++;
      }
      // track MFE
      p.maxPnlPercent = Math.max(p.maxPnlPercent, Number((movePctAt(p, price) * p.leverage).toFixed(2)));
    }
    return closed;
  } catch {
    return 0;
  }
}

/** Tranche-aware close — identical math to the real resolver (v6.6). */
function closePaper(p: PaperTrade, status: PaperTrade["status"], exitMovePct: number, closedAt: number, note: string): void {
  const rung = (px: number) => movePctAt(p, px);
  const grossPct = p.reachedTp >= 1 ? ladderWeightedMove([{ weight: LADDER_TRANCHES.tp1, movePct: rung(p.tp1) }, ...(p.reachedTp >= 2 ? [{ weight: LADDER_TRANCHES.tp2, movePct: rung(p.tp2) }] : []), { weight: LADDER_TRANCHES.runner, movePct: status === "TP3" ? rung(p.tp3) : exitMovePct }]) : exitMovePct;
  const heldMin = Math.max(0, (closedAt - p.at) / 60_000);
  const fb = feeBreakdown(p.marginUsd, p.leverage, grossPct, heldMin);
  p.status = status;
  p.pnlPercent = Number(fb.netPct.toFixed(2));
  p.pnlUsd = Number(fb.netUsd.toFixed(3));
  p.outcome = {
    status,
    pnlPercent: p.pnlPercent,
    pnlUsd: p.pnlUsd,
    win: p.pnlPercent > 0 || p.reachedTp >= 1,
    closedAt,
  };
  p.closeNote = note;
  void persist({ k: "pc", v: { id: p.id, status: p.status, reachedTp: p.reachedTp, pnlPercent: p.pnlPercent, pnlUsd: p.pnlUsd, stop: p.stop, outcome: p.outcome, closeNote: note } });
}

// ── arms + promotion evidence ─────────────────────────────────

/**
 * v10.16 CAPTURE-ORIGIN PROVENANCE (audit 4-f) — is this verdict a RAW-CAL
 * capture-observe adjudication? Records created after the v10.16 stamp carry
 * the explicit `origin: "capture"` field; legacy records (born between v10.6
 * and the stamp, before the field existed) are identified by the
 * "[CAPTURE-OBSERVE]" reason suffix the observe path has appended to EVERY
 * capture adjudication since v10.6 (adjudicateCore's `tag` parameter).
 * Anything else — including un-stamped pre-v10.6 records — is fence evidence.
 */
function isCaptureOrigin(v: ShadowVerdict): boolean {
  return v.origin === "capture" || (v.origin === undefined && typeof v.reason === "string" && v.reason.includes("[CAPTURE-OBSERVE]"));
}

export interface ArmRow {
  id: "real-keep" | "real-veto" | "paper-keep" | "paper-veto";
  label: string;
  n: number;
  wins: number;
  winRatePct: number | null;
  wilsonLB: number | null;
  netUsd: number;
  target: number;
  epoch: string; // v10.7 — the evidence epoch these cohorts belong to
  frozenAt?: number; // v10.11 COHORT-FREEZE — set when the row is read from the frozen snapshot (live recompute = monitoring-only)
}

function armOf(rows: Array<{ pnlPercent: number; pnlUsd: number; win: boolean }>): { n: number; wins: number; netUsd: number } {
  const wins = rows.filter((r) => r.win).length;
  return { n: rows.length, wins, netUsd: Number(rows.reduce((a, r) => a + r.pnlUsd, 0).toFixed(2)) };
}

/** v10.7 ARM-EPOCH COHORTS → v10.10 REGIME-ALIGNED ROLLING-30 COHORTS →
 * v10.16 FENCE-ORIGIN ONLY (audit 4-f). Each arm reports its MOST-RECENT
 * ROLLING_WINDOW (30) settled, epoch-STAMPED outcomes (any stamp — a stale row
 * ages out as 30 fresher settles slide past it). v10.16: capture-observe
 * verdicts are EXCLUDED from BOTH real arms — they adjudicate RAW-CAL deploys
 * that ran with ALL quality gates bypassed (baseMin 0, passed:true), so they
 * are observe-only instrumentation on a NON-FENCE cohort; counting them let
 * promotion evidence accrue on rows the fence never judged (contaminated
 * real-keep 19/30 live). Filtering here feeds shadowArms() → promotionEvidence
 * → COHORT-FREEZE from one honest source: n/WR/net are computed over
 * fence-origin rows only, and the existing n-minimum criteria in
 * promotionEvidence then demand a FULL fence cohort before any promotion.
 * Legacy (un-stamped) non-capture records remain in the rings for
 * audit/history and still feed the feed-diagnostics + aggregate stats, but
 * they still never vote (v10.7 hygiene preserved): a pre-v10.6 regime must
 * never outvote the live one. */
function lastSettled<T extends { outcome: ShadowOutcome | null }>(rows: T[], k: number): T[] {
  return rows
    .filter((r) => r.outcome)
    .sort((a, b) => b.outcome!.closedAt - a.outcome!.closedAt)
    .slice(0, k);
}

/** v10.11 LIVE real-arm aggregates (pre-freeze overlay) — the truth the
 * COHORT-FREEZE snapshot is taken FROM and what monitoring compares against.
 * v10.16 — fence-origin only (see lastSettled doc): capture-origin verdicts
 * never enter the promotion cohorts. */
function liveRealArmAggregates(): { keep: { n: number; wins: number; netUsd: number }; veto: { n: number; wins: number; netUsd: number } } {
  const realPass = verdicts.filter((v) => v.side === "PASS" && v.epoch && v.outcome && !isCaptureOrigin(v));
  return {
    keep: armOf(lastSettled(realPass.filter((v) => v.verdict === "TRADE"), ROLLING_WINDOW).map((v) => ({ pnlPercent: v.outcome!.pnlPercent, pnlUsd: v.outcome!.pnlUsd, win: v.outcome!.win }))),
    veto: armOf(lastSettled(realPass.filter((v) => v.verdict === "VETO"), ROLLING_WINDOW).map((v) => ({ pnlPercent: v.outcome!.pnlPercent, pnlUsd: v.outcome!.pnlUsd, win: v.outcome!.win }))),
  };
}

export function shadowArms(): ArmRow[] {
  const live = liveRealArmAggregates();
  // v10.11 COHORT-FREEZE: once a decision-grade snapshot exists for the current
  // epoch, the REAL arms read the FROZEN aggregates (append-only, unfreezable
  // except by epoch rotation or revocation pressure) — the rolling window can
  // no longer re-sample under an open decision. Live values stay observable via
  // getShadowVetoState().armsLive.
  const frozen = cohortFreeze && cohortFreeze.epoch === ARM_EPOCH ? cohortFreeze : null;
  const realKeep = frozen ? { ...frozen.realKeep } : live.keep;
  const realVeto = frozen ? { ...frozen.realVeto } : live.veto;
  const paperSettled = papers.filter((p) => p.epoch && p.outcome);
  const paperKeep = armOf(lastSettled(paperSettled.filter((p) => p.originSide === "REJECT" && p.originVerdict === "TRADE"), ROLLING_WINDOW).map((p) => ({ pnlPercent: p.outcome!.pnlPercent, pnlUsd: p.outcome!.pnlUsd, win: p.outcome!.win })));
  const paperVeto = armOf(lastSettled(paperSettled.filter((p) => p.originSide === "PASS" && p.originVerdict === "VETO"), ROLLING_WINDOW).map((p) => ({ pnlPercent: p.outcome!.pnlPercent, pnlUsd: p.outcome!.pnlUsd, win: p.outcome!.win })));
  const mk = (id: ArmRow["id"], label: string, a: { n: number; wins: number; netUsd: number }, target: number): Omit<ArmRow, "epoch"> => ({
    id,
    label,
    n: a.n,
    wins: a.wins,
    winRatePct: a.n ? Number(((a.wins / a.n) * 100).toFixed(1)) : null,
    wilsonLB: wilsonLB(a.wins, a.n),
    netUsd: a.netUsd,
    target,
  });
  return [
    mk("real-keep", "REAL · core said TRADE", realKeep, 30),
    mk("real-veto", "REAL · core said VETO (still traded)", realVeto, 30),
    mk("paper-keep", "PAPER · reject the core would trade", paperKeep, 30),
    mk("paper-veto", "PAPER · pass the core blocked", paperVeto, 30),
  ].map((r) => ({
    ...r,
    epoch: ARM_EPOCH,
    ...(frozen && (r.id === "real-keep" || r.id === "real-veto") ? { frozenAt: frozen.frozenAt } : {}),
  }));
}

// ── v10.11 COHORT-FREEZE (SUPERVISOR proposal, operator APPROVE 2026-09-17) ──
// COHORT-FREEZE diagnosis: rolling-30 re-sampling lets the evidence window move
// UNDER an open decision (paper-keep re-sampling swings 20→26→30 wins in hours
// were observed live on 2026-09-16/17). Snapshot-first discipline, minimal
// form: the moment the real-arm evidence becomes decision-grade (both arms
// n≥30 = FILL, or SEQ-STOP reaches a terminal always-valid state), the real
// arm aggregates are frozen to an append-only snapshot; promotionEvidence
// reads the FROZEN cohort while live recompute continues as monitoring only.
// Unfreeze paths (evidence re-opens): epoch rotation (ARM_EPOCH changes) or
// revocation pressure firing while frozen. Paper arms are NEVER frozen — the
// revocation monitor must stay live.
export interface CohortFreeze {
  epoch: string;
  frozenAt: number;
  reason: "FILL" | "SEQ-STOP";
  seqState: SeqStopResult["state"];
  realKeep: { n: number; wins: number; netUsd: number };
  realVeto: { n: number; wins: number; netUsd: number };
}

const FREEZE_FILE = path.join(DATA_DIR, "sv-cohort-freeze.json");
let cohortFreeze: CohortFreeze | null = null;
let cohortFreezeLoaded = false;

async function loadCohortFreeze(): Promise<void> {
  if (cohortFreezeLoaded) return;
  cohortFreezeLoaded = true;
  try {
    const raw = await readFile(FREEZE_FILE, "utf8");
    const parsed = JSON.parse(raw) as CohortFreeze | null;
    if (parsed && typeof parsed.frozenAt === "number" && typeof parsed.epoch === "string") {
      if (parsed.epoch !== ARM_EPOCH) {
        await rename(FREEZE_FILE, `${FREEZE_FILE}.prev-epoch`).catch(() => undefined); // epoch rotation → evidence re-opens
        cohortFreeze = null;
        return;
      }
      cohortFreeze = parsed;
    }
  } catch {
    cohortFreeze = null; // no snapshot yet — normal
  }
}

/** Called from the async promotion consumers before promotionEvidence —
 * creates the freeze at the decision-grade moment, enforces revocation
 * unfreeze, and is a no-op thereafter (append-only). Never throws. */
export async function syncCohortFreeze(): Promise<CohortFreeze | null> {
  try {
    await loadCohortFreeze();
    const live = liveRealArmAggregates();
    // revocation unfreeze: frozen evidence + live paper-veto pressure → re-open
    if (cohortFreeze && cohortFreeze.epoch === ARM_EPOCH) {
      const paperSettled = papers.filter((p) => p.epoch && p.outcome);
      const pv = armOf(lastSettled(paperSettled.filter((p) => p.originSide === "PASS" && p.originVerdict === "VETO"), ROLLING_WINDOW).map((p) => ({ pnlPercent: p.outcome!.pnlPercent, pnlUsd: p.outcome!.pnlUsd, win: p.outcome!.win })));
      const pvLB = wilsonLB(pv.wins, pv.n);
      if (pv.n >= 15 && (pvLB ?? 0) >= 55 && pv.netUsd > 0) {
        await rename(FREEZE_FILE, `${FREEZE_FILE}.revoked-${Date.now()}`).catch(() => undefined);
        cohortFreeze = null;
      }
      return cohortFreeze;
    }
    // creation: decision-grade evidence gate
    if (!cohortFreeze) {
      const seq = seqStopEvaluate({ wins: live.keep.wins, n: live.keep.n, netUsd: live.keep.netUsd }, { wins: live.veto.wins, n: live.veto.n, netUsd: live.veto.netUsd });
      const fill = live.keep.n >= ROLLING_WINDOW && live.veto.n >= ROLLING_WINDOW;
      const seqTerminal = seq.state === "PROMOTE-EARLY" || seq.state === "ABORT-EARLY";
      if (fill || seqTerminal) {
        const snapshot: CohortFreeze = {
          epoch: ARM_EPOCH,
          frozenAt: Date.now(),
          reason: fill ? "FILL" : "SEQ-STOP",
          seqState: seq.state,
          realKeep: { ...live.keep },
          realVeto: { ...live.veto },
        };
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(FREEZE_FILE, JSON.stringify(snapshot, null, 1), "utf8");
        cohortFreeze = snapshot;
      }
    }
    return cohortFreeze;
  } catch {
    return cohortFreeze; // fail-open: freeze is an integrity layer, not a dependency
  }
}

export interface PromotionEvidence {
  ready: boolean;
  criteria: Array<{ id: string; ok: boolean; detail: string }>;
  revocation: { pressure: boolean; detail: string };
  sequential: SeqStopResult; // v10.11 SEQ-STOP — always-valid early decision layer
}

/** v10.7 REAL-ONLY promotion evidence → v10.10 ROLLING-30 EVIDENCE WINDOW →
 * v10.16 FENCE-ORIGIN COHORTS (audit 4-f). Cohort qualification, per real arm
 * (over the rolling-30 settled window — see shadowArms(); since v10.16 the
 * arms themselves are computed over fence-origin verdicts ONLY — the capture-
 * observe path stamps origin:"capture" and is filtered in
 * liveRealArmAggregates, so the n/WR/net below are fence-pure and a fence arm
 * below its minimum simply fails okN → no promotion):
 *   FULL  — n ≥ 30 settled (original bar), or
 *   FAST  — n ≥ 20 AND Wilson-LB95 ≥ 50% (guardrail min-sample practice: the
 *           lower bound of the win rate already clears coin-flip odds, so
 *           waiting for 30 adds latency without adding certainty).
 * Wilson separation + negative would-veto net are UNCHANGED. Epoch is a
 * hygiene tag only — the evidence window is the rolling-30 (v10.10). */
export function promotionEvidence(arms: ArmRow[]): PromotionEvidence {
  const realKeep = arms[0]!;
  const realVeto = arms[1]!;
  const paperVeto = arms[3]!;
  const both = realKeep.n >= 30 && realVeto.n >= 30;
  // v10.11 SEQ-STOP — the sequential early-decision layer (always-valid, OF
  // alpha-spending). It computes on the SAME arms the fixed gate sees (frozen
  // when a COHORT-FREEZE exists): a PROMOTE-EARLY state satisfies promotion
  // WITHOUT waiting for n=30 (min-n guard 12/arm inside), ABORT-EARLY vetoes
  // the hypothesis outright, CONTINUE leaves the fixed gate as sole path.
  const sequential = seqStopEvaluate(
    { wins: realKeep.wins, n: realKeep.n, netUsd: realKeep.netUsd },
    { wins: realVeto.wins, n: realVeto.n, netUsd: realVeto.netUsd },
  );
  const okN = (a: ArmRow): boolean => a.n >= 30 || (a.n >= 20 && (a.wilsonLB ?? 0) >= 50);
  const nDetail = (role: string, a: ArmRow): string => {
    const fast = a.n >= 20 && a.n < 30 && (a.wilsonLB ?? 0) >= 50;
    return `rolling-30 ${role} cohort ${a.n}/30${a.n >= 20 && a.n < 30 ? ` (fast path n≥20 + LB≥50%: ${fast ? "MET" : "unmet — LB " + (a.wilsonLB !== null ? a.wilsonLB.toFixed(1) : "n/a") + "%"})` : ""}`;
  };
  const criteria = [
    { id: "n-veto", ok: okN(realVeto), detail: nDetail("would-veto", realVeto) },
    { id: "n-keep", ok: okN(realKeep), detail: nDetail("would-keep", realKeep) },
    { id: "wr-sep", ok: both && (realVeto.wilsonLB ?? 0) < (realKeep.wilsonLB ?? 100), detail: `Wilson-LB veto ${realVeto.wilsonLB !== null ? `${realVeto.wilsonLB.toFixed(1)}%` : "n/a"} < keep ${realKeep.wilsonLB !== null ? `${realKeep.wilsonLB.toFixed(1)}%` : "n/a"} (95% separation)` },
    { id: "net", ok: realVeto.netUsd < 0, detail: `would-veto cohort net $${realVeto.netUsd.toFixed(2)} (must be negative)` },
  ];
  const legacyReady = criteria.every((c) => c.ok);
  const ready = legacyReady || sequential.state === "PROMOTE-EARLY";
  criteria.push({
    id: "seq-stop",
    ok: sequential.state === "PROMOTE-EARLY",
    detail: `${sequential.detail}${legacyReady ? " — legacy gate already satisfied, sequential is confirmatory" : ""}`,
  });
  const revPressure = paperVeto.n >= 15 && (paperVeto.wilsonLB ?? 0) >= 55 && paperVeto.netUsd > 0;
  return {
    ready,
    criteria,
    sequential,
    revocation: {
      pressure: revPressure,
      detail: revPressure
        ? `blocked-pass counterfactuals are winning without the veto (n=${paperVeto.n}, LB ${paperVeto.wilsonLB!.toFixed(1)}%, net $${paperVeto.netUsd.toFixed(2)}) — consider demoting to shadow`
        : `no revocation pressure (paper-veto n=${paperVeto.n}/15, LB ${paperVeto.wilsonLB !== null ? `${paperVeto.wilsonLB.toFixed(1)}%` : "n/a"}, net $${paperVeto.netUsd.toFixed(2)})`,
    },
  };
}

// ── v9.3 AUTO-PROMOTION WATCHDOG (operator mandate ج) ─────────
// The evidence gate (promotionEvidence) was always the ONLY sanctioned path to
// mode=veto, but it required an operator/API flip AFTER the arms filled — so a
// fully-qualified evidence stack sat idle. This watchdog closes that loop:
// every engine tick batch it re-checks the promotion criteria and, the moment
// ALL of them pass (n≥30/30 settled per arm + Wilson-LB95 separation + negative
// would-veto cohort net), flips mode shadow→veto ITSELF. The criteria are
// UNCHANGED — automation removes the latency, never the evidence. Reversible:
// revocation pressure (paper-veto arm winning without the veto) is reported on
// every promotion event so the operator/governor can demote.
let lastPromoteCheckAt = 0;
let lastBacklogBlockLogAt = 0; // v10.16 — rate-limit the audited block event (30min)

export async function maybeAutoPromote(): Promise<{ promoted: boolean; detail: string }> {
  const cfg = await getShadowVetoConfig(true);
  if (cfg.mode === "veto") return { promoted: false, detail: "already in veto mode" };
  if (!cfg.autoPromote) return { promoted: false, detail: "auto-promotion disabled by config" };
  if (Date.now() - lastPromoteCheckAt < 5 * 60_000) return { promoted: false, detail: "throttled" };
  lastPromoteCheckAt = Date.now();
  await shadowVetoReady();
  await shadowVetoRefresh(0); // judge on fresh rings, never a stale bite
  await syncCohortFreeze(); // v10.11 — freeze decision-grade evidence before judging; read frozen when present
  const ev = promotionEvidence(shadowArms());
  if (!ev.ready) return { promoted: false, detail: `evidence not ready (${ev.criteria.map((c) => `${c.id}:${c.ok ? "✓" : "✗"}`).join(" ")})` };
  // ── v10.16 PROMOTION BACKLOG GATE (audit 4-f) → v10.19 ACTIVE-LEAK SCOPING —
  // evidence-ready is not enough while the REAL-arm feed is under-linked.
  // v10.19: unlinkedPassStale counts ACTIVE leaks only (stale unlinked, not
  // swept-orphan, within link reach). Structural orphans (fence candidates
  // whose deploy was refused downstream — 84% of the historic backlog per the
  // 2026-09-24 forensic) and aged-out verdicts are promotion-inert; counting
  // them deadlocked this gate permanently (201 “stale” → never clearable).
  // Block >10 ACTIVE leaks, audited via the existing fireEvent pattern
  // (rate-limited — the block can persist for hours).
  const backlog = shadowPipelineDiag().unlinkedPassStale;
  if (backlog > 10) {
    const blockDetail = `SHADOW-VETO AUTO-PROMOTION BLOCKED (v10.19 backlog gate) — REAL-arm ACTIVE feed leak: ${backlog} unlinked PASS verdict(s) within link reach (> 10). Evidence could be reading an under-linked cohort; promotion deferred until retro-link drains the backlog.`;
    if (Date.now() - lastBacklogBlockLogAt > 30 * 60_000) {
      lastBacklogBlockLogAt = Date.now();
      await import("@/lib/engine")
        .then((m) => m.fireEvent(null, null, "ENGINE", "warn", blockDetail))
        .catch(() => undefined);
    }
    return { promoted: false, detail: blockDetail };
  }
  await saveShadowVetoConfig({ mode: "veto" });
  const detail = `SHADOW-VETO AUTO-PROMOTION — all evidence criteria met: ${ev.criteria.map((c) => `${c.detail} ✓`).join(" · ")} → mode=VETO ACTIVE (real veto authority, fail-open, revocable; revocation pressure: ${ev.revocation.pressure ? "YES — monitor paper-veto arm" : "none"}).`;
  return { promoted: true, detail };
}

// ── state + core grounding ────────────────────────────────────

export interface ShadowVetoHealth {
  verdicts: number;
  papers: number;
  fileKB: number;
  pending: number;
  callsLastHour: number;
  auditViolations: number; // v8.2.1 — discarded hallucinated verdicts
  hydratedAt: number; // v8.2.1 — 0 = cold rings
}

export async function getShadowVetoState(): Promise<{
  armEpoch: string; // v10.7 tag, v10.10 — arms are rolling-30; epoch is a regime tag, not the evidence window
  config: ShadowVetoConfig;
  stats: { total: number; passSide: number; rejectSide: number; vetoCount: number; tradeCount: number; modelSharePct: number | null; modelGroundedPct: number | null; avgConfidence: number | null; gateAgreement: number; paperOpen: number; paperSettled: number; recent24h: { n: number; modelSharePct: number | null; lastModelAgeH: number | null; lastVerdictAgeH: number | null } };
  arms: ArmRow[];
  armsLive: ArmRow[]; // v10.11 — unfrozen live recompute (monitoring-only while a COHORT-FREEZE exists)
  cohortFreeze: CohortFreeze | null; // v10.11 — decision-grade snapshot pointer
  promotion: PromotionEvidence;
  recent: ShadowVerdict[];
  paper: PaperTrade[];
  health: ShadowVetoHealth;
}> {
  await shadowVetoReady();
  await shadowVetoRefresh(); // stay live across module-instance splits
  const cfg = await getShadowVetoConfig();
  await syncCohortFreeze(); // v10.11 — create/refresh the decision-grade snapshot before evidence is read
  const modelN = verdicts.filter((v) => v.label === "MODEL").length;
  const audited = verdicts.filter((v) => v.label === "MODEL" && v.audit !== null);
  const groundedN = audited.filter((v) => v.audit!.verdict !== "VIOLATION").length;
  const auditViolations = verdicts.filter((v) => v.audit?.verdict === "VIOLATION").length;
  const rejectSideVerdicts = verdicts.filter((v) => v.side === "REJECT");
  const gateAgreement = rejectSideVerdicts.filter((v) => v.verdict === "VETO").length;
  const arms = shadowArms();
  // v10.11 — unfrozen live view for monitoring (identical to arms when no freeze exists)
  const liveAgg = liveRealArmAggregates();
  const frozen = cohortFreeze && cohortFreeze.epoch === ARM_EPOCH ? cohortFreeze : null;
  const armsLive: ArmRow[] = frozen
    ? arms.map((a) =>
        a.id === "real-keep"
          ? { ...a, ...liveAgg.keep, winRatePct: liveAgg.keep.n ? Number(((liveAgg.keep.wins / liveAgg.keep.n) * 100).toFixed(1)) : null, wilsonLB: wilsonLB(liveAgg.keep.wins, liveAgg.keep.n), frozenAt: undefined }
          : a.id === "real-veto"
            ? { ...a, ...liveAgg.veto, winRatePct: liveAgg.veto.n ? Number(((liveAgg.veto.wins / liveAgg.veto.n) * 100).toFixed(1)) : null, wilsonLB: wilsonLB(liveAgg.veto.wins, liveAgg.veto.n), frozenAt: undefined }
            : a,
      )
    : arms;
  const now = Date.now();
  while (callStamps.length && now - callStamps[0]! > 3600_000) callStamps.shift();
  // v10.21.2 RECENCY TRUTH (operator finding: window-aggregated MODEL SHARE masked
  // the 401 outage — 78% share over a week-old ring while every fresh call was
  // heuristic). The dashboard shows both: window share + last-24h share + link age.
  const dayAgo = now - 86_400_000;
  const w24 = verdicts.filter((v) => v.at >= dayAgo);
  const w24Model = w24.filter((v) => v.label === "MODEL").length;
  const lastModelAt = verdicts.reduce((a, v) => (v.label === "MODEL" && v.at > a ? v.at : a), 0);
  const lastVerdictAt = verdicts.reduce((a, v) => (v.at > a ? v.at : a), 0);
  return {
    armEpoch: ARM_EPOCH,
    config: cfg,
    stats: {
      total: verdicts.length,
      passSide: verdicts.filter((v) => v.side === "PASS").length,
      rejectSide: rejectSideVerdicts.length,
      vetoCount: verdicts.filter((v) => v.verdict === "VETO").length,
      tradeCount: verdicts.filter((v) => v.verdict === "TRADE").length,
      modelSharePct: verdicts.length ? Number(((modelN / verdicts.length) * 100).toFixed(1)) : null,
      modelGroundedPct: audited.length ? Number(((groundedN / audited.length) * 100).toFixed(1)) : null,
      avgConfidence: verdicts.length ? Number((verdicts.reduce((a, v) => a + v.confidence, 0) / verdicts.length).toFixed(1)) : null,
      gateAgreement,
      paperOpen: papers.filter((p) => !p.outcome).length,
      paperSettled: papers.filter((p) => p.outcome).length,
      recent24h: {
        n: w24.length,
        modelSharePct: w24.length ? Number(((w24Model / w24.length) * 100).toFixed(1)) : null,
        lastModelAgeH: lastModelAt ? Number(((now - lastModelAt) / 3_600_000).toFixed(1)) : null,
        lastVerdictAgeH: lastVerdictAt ? Number(((now - lastVerdictAt) / 3_600_000).toFixed(1)) : null,
      },
    },
    arms,
    armsLive,
    cohortFreeze: frozen,
    promotion: promotionEvidence(arms),
    recent: [...verdicts].sort((a, b) => b.at - a.at).slice(0, 14), // v8.2.1 — time-sorted (ingest order is interleaved across instances)
    paper: [...papers].sort((a, b) => b.at - a.at).slice(0, 10),
    health: {
      verdicts: verdicts.length,
      papers: papers.length,
      fileKB: Math.round(persisted / 1024),
      pending: pendingCount,
      callsLastHour: callStamps.length,
      auditViolations,
      hydratedAt,
    },
  };
}

/** Deep-learn / verdict-core grounding — measured arm numbers only. */
export async function shadowVetoForCore(maxVerdicts = 6): Promise<{ narrative: string; verdictFiles: string[] }> {
  await shadowVetoReady();
  await shadowVetoRefresh(0); // grounding consumers always see fresh rings
  const cfg = await getShadowVetoConfig();
  const arms = shadowArms();
  const promo = promotionEvidence(arms);
  const frozen = cohortFreeze && cohortFreeze.epoch === ARM_EPOCH ? cohortFreeze : null; // v10.11
  const rej = verdicts.filter((v) => v.side === "REJECT");
  const agreement = rej.length ? Math.round((rej.filter((v) => v.verdict === "VETO").length / rej.length) * 100) : null;
  const audited = verdicts.filter((v) => v.label === "MODEL" && v.audit !== null);
  const groundedN = audited.filter((v) => v.audit!.verdict !== "VIOLATION").length;
  const verdictFiles = verdicts
    .slice(-maxVerdicts)
    .reverse()
    .map((v) => `${new Date(v.at).toISOString()} ${v.symbol} ${v.direction} ${v.side === "PASS" ? "hair-pass" : "fence-reject"} gap ${v.gap.toFixed(1)} → ${v.verdict} @${v.confidence}% [${v.label}${v.audit ? `·audit:${v.audit.verdict}` : ""}] ${v.reason.slice(0, 120)}${v.outcome ? ` → settled ${v.outcome.status} ${v.outcome.pnlPercent >= 0 ? "+" : ""}${v.outcome.pnlPercent}%` : ""}`);
  const narrative = [
    `SHADOW-VETO (AI-core Phase 0, mode ${cfg.mode}): ${verdicts.length} adjudications — ${verdicts.filter((v) => v.side === "PASS").length} hair-thin passes / ${rej.length} fence rejects; ${verdicts.filter((v) => v.verdict === "VETO").length} VETO vs ${verdicts.filter((v) => v.verdict === "TRADE").length} TRADE; fence-reject agreement with the numeric gate ${agreement !== null ? `${agreement}%` : "n/a"}.`,
    `GROUNDING AUDIT: ${audited.length} MODEL verdicts audited number-by-number against their evidence bundles — ${groundedN} grounded, ${audited.length - groundedN} violations (violations are DISCARDED, the deterministic heuristic speaks instead; audit rate will lag legacy verdicts which predate the instrument).`,
    `A/B arms (rolling-30 settled, tag ${ARM_EPOCH}, win-rate / Wilson-LB95 / net): real-keep ${fmtArm(arms[0]!)} · real-veto ${fmtArm(arms[1]!)} · paper-keep ${fmtArm(arms[2]!)} · paper-veto ${fmtArm(arms[3]!)}. Cohorts are regime-aligned rolling-30 (v10.10 REGIME-ALIGNED SHADOW COHORTS) — legacy un-stamped regimes never vote.`,
    `Promotion to veto mode ${promo.ready ? "EVIDENCE-READY" : "not ready"} (${promo.criteria.map((c) => `${c.id}:${c.ok ? "✓" : "✗"}`).join(" ")}). ${promo.revocation.detail}.`,
    `SEQ-STOP (v10.11 always-valid early decision): ${promo.sequential.detail}. COHORT-FREEZE: ${frozen ? `REAL arms FROZEN since ${new Date(frozen.frozenAt).toISOString()} (${frozen.reason}); live recompute is monitoring-only` : "no snapshot — evidence window still open"}.`,
    "DOCTRINE: veto-only, fail-open, revocable, GROUNDED (no veto voice may rest on ungrounded reasoning). Paper arms use base geometry (slAtrMult×ATR stop, base RR) — directional-edge evidence, not PnL replication.",
  ].join(" ");
  return { narrative, verdictFiles };
}

function fmtArm(a: ArmRow): string {
  if (a.n === 0) return "n=0";
  return `n=${a.n} wr=${a.winRatePct}% lb=${a.wilsonLB !== null ? a.wilsonLB.toFixed(1) : "n/a"}% net=$${a.netUsd}`;
}

// ── v10.2 ARM FEED DIAGNOSTICS (sv-telemetry wiring audit) ────
// Operator mandate 2026-09-15: «داده‌های مورد نیاز به تمام بازوها سیم‌کشی و
// ارسال شود» — the telemetry hub needs per-arm feed visibility the summary
// DTO never carried: WHO feeds each arm, WHEN it was last fed/settled, and
// whether the feed is starving while the rest of the pipeline is alive.
// Pure ring reads — no extra I/O, fail-open by construction.

export interface ArmFeedDiag {
  id: ArmRow["id"];
  feedSource: string; // human-readable wiring description of what feeds this arm
  fed: number; // records that ever entered this arm's feed
  open: number; // awaiting settlement
  settled: number;
  lastFedAt: number; // 0 = never fed
  lastSettledAt: number; // 0 = never settled
  neverFed: boolean;
  starved: boolean; // fed before, but nothing new within starveMs while the adjudicator is active
  starveDetail: string | null;
}

/** Per-arm feed wiring audit over the FULL rings (not the capped DTO slices). */
export function shadowArmFeedDiagnostics(mode: ShadowVetoMode, starveMs = 12 * 3600_000): ArmFeedDiag[] {
  const now = Date.now();
  const lastAnyVerdictAt = verdicts.reduce((a, v) => Math.max(a, v.at), 0);
  const quietAdjudicator = lastAnyVerdictAt === 0 || now - lastAnyVerdictAt > starveMs;

  const diag = (
    id: ArmRow["id"],
    feedSource: string,
    fedRows: Array<{ at: number; outcome: ShadowOutcome | null }>,
  ): ArmFeedDiag => {
    const lastFedAt = fedRows.reduce((a, r) => Math.max(a, r.at), 0);
    const settledRows = fedRows.filter((r) => r.outcome);
    const lastSettledAt = settledRows.reduce((a, r) => Math.max(a, r.outcome!.closedAt), 0);
    const neverFed = fedRows.length === 0;
    const starved = mode !== "off" && !neverFed && now - lastFedAt > starveMs;
    let starveDetail: string | null = null;
    if (neverFed) {
      starveDetail = "feed wired, awaiting first qualifying record (disagreement/fence events are rare by design)";
    } else if (starved) {
      starveDetail = quietAdjudicator
        ? `whole adjudicator quiet — no fence candidates in window (last verdict ${lastAnyVerdictAt ? agoShort(now - lastAnyVerdictAt) : "never"})`
        : `arm-specific starvation — adjudicator active (last verdict ${agoShort(now - lastAnyVerdictAt)}) but nothing entered this arm in ${agoShort(now - lastFedAt)}`;
    }
    return { id, feedSource, fed: fedRows.length, open: fedRows.length - settledRows.length, settled: settledRows.length, lastFedAt, lastSettledAt, neverFed, starved, starveDetail };
  };

  return [
    diag("real-keep", "hair-thin PASS → core TRADE → real serial link → real settle", verdicts.filter((v) => v.side === "PASS" && v.verdict === "TRADE").map((v) => ({ at: v.at, outcome: v.outcome }))),
    diag("real-veto", "hair-thin PASS → core VETO → real trade still deploys (counterfactual) → real settle", verdicts.filter((v) => v.side === "PASS" && v.verdict === "VETO").map((v) => ({ at: v.at, outcome: v.outcome }))),
    diag("paper-keep", "fence REJECT → core TRADE → paper ledger (would-have-won) → paper sweep", papers.filter((p) => p.originSide === "REJECT" && p.originVerdict === "TRADE").map((p) => ({ at: p.at, outcome: p.outcome }))),
    diag("paper-veto", "hair-thin PASS → core VETO blocks deploy → paper track (revocation pressure)", papers.filter((p) => p.originSide === "PASS" && p.originVerdict === "VETO").map((p) => ({ at: p.at, outcome: p.outcome }))),
  ];
}

function agoShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Pipeline leak counters — the REAL-arm feed leak (v8.4.3) and closure
 * backlog visibility the telemetry hub reports on every capture. */
export interface ShadowPipelineDiag {
  unlinkedPass24h: number; // PASS verdicts still serial=null within retro-link reach
  unlinkedPassStale: number; // v10.19 ACTIVE LEAKS ONLY — stale unlinked PASS verdicts, not swept as orphans, still within the 7-day link reach (the promotion backlog gate + sv-telemetry alert read THIS)
  unlinkedPassOrphan: number; // v10.19 — swept: fence window closed with no bindable deploy; structural non-evidence, promotion-inert
  unlinkedPassAged: number; // v10.19 — stale unlinked, unswept, but OLDER than the 7-day link reach; can never link again (historic residue, counted separately)
  pendingRealOutcomes: number; // linked but not yet settled
  pendingPapers: number; // paper positions awaiting sweep
  lastVerdictAt: number;
  lastPaperOpenAt: number;
  verdicts24h: number;
  papers24h: number;
}

export function shadowPipelineDiag(): ShadowPipelineDiag {
  const now = Date.now();
  const d24 = now - 24 * 3600_000;
  const REACH_MS = 7 * 24 * 3600_000 + 90 * 60_000; // retro-link query reach (7d bound + 90min pre-warm margin)
  const unlinked = verdicts.filter((v) => v.side === "PASS" && v.serial === null);
  return {
    unlinkedPass24h: unlinked.filter((v) => now - v.at <= 24 * 3600_000).length,
    // v10.19 — ACTIVE leak = stale, unlinked, NOT swept-orphan, still within
    // link reach. Structural orphans and aged-out verdicts are counted
    // separately so the promotion backlog gate measures UNDER-LINKING (fixable
    // evidence loss), not the inherent orphan rate of fence adjudication
    // (2026-09-24 forensic: 235 orphans vs 44 true leaks in the stale backlog).
    unlinkedPassStale: unlinked.filter((v) => now - v.at > 24 * 3600_000 && v.sweptAt === undefined && now - v.at <= REACH_MS).length,
    unlinkedPassOrphan: unlinked.filter((v) => v.sweptAt !== undefined).length,
    unlinkedPassAged: unlinked.filter((v) => now - v.at > 24 * 3600_000 && v.sweptAt === undefined && now - v.at > REACH_MS).length,
    pendingRealOutcomes: verdicts.filter((v) => v.serial !== null && v.outcome === null).length,
    pendingPapers: papers.filter((p) => !p.outcome).length,
    lastVerdictAt: verdicts.reduce((a, v) => Math.max(a, v.at), 0),
    lastPaperOpenAt: papers.reduce((a, p) => Math.max(a, p.at), 0),
    verdicts24h: verdicts.filter((v) => v.at >= d24).length,
    papers24h: papers.filter((p) => p.at >= d24).length,
  };
}

/** Operator reset (keeps config, wipes evidence) — used by the API POST reset. */
export async function resetShadowEvidence(): Promise<void> {
  await shadowVetoReady();
  verdicts.length = 0;
  papers.length = 0;
  verdictCache.clear();
  lastAdjAt.clear();
  callStamps.length = 0;
  try {
    await rename(FILE, `${FILE}.old.${Date.now()}`).catch(() => undefined);
    persisted = 0;
  } catch {
    /* non-fatal */
  }
}
