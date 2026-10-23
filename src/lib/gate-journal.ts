// ── FlowRadar Neo GATE JOURNAL + GAUGE ENGINE (server-only, v8.2) ──
// Operator mandate (2026-09-08): «یک موتور گیج اضافه کن تا بصورت زنده داده
// هایی که به مرز تایید یا رد شدن سیگنال میرسند را نشان دهد و جورنال را به
// هسته مرکزی برای یادگیری عمیق از دلایل ارسال کند».
//
// Every deploy-signal() threshold verdict is journaled here with its FULL
// reason payload: the signed confluence votes (confirm vs oppose), every
// threshold modifier (regime / BTC-spill / chase / MTF-board / liq-heat),
// the effective threshold it faced, and the distance-to-gate. Hard gate
// blocks (memory/strategy/learned/flow/onset-retest/risk-cluster) and
// actual deployments are recorded too — so the boundary band between
// CONFIRM and REJECT becomes a measurable, learnable dataset instead of
// a one-line 409 error.
//
// Storage: in-memory rings (fast, capped) + append-only JSONL
// (.data/gate-journal.jsonl) so history survives dev recompiles and
// restarts, and the central AI core can be fed the exact same records.
// No SQLite writes — the single-writer discipline stays untouched.

import { appendFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

// ── types (client-safe mirrors live in lib/api-types.ts) ──────

export type GateBand = "PASS" | "BOUNDARY" | "REJECT";
export type GateSource = "auto-scan" | "trigger" | "forced" | "shadow";

export interface ThrBreakdown {
  regime: number; // regimeRuling thrAdj (chop surcharge / trend discount / vol tax)
  spill: number; // v6.3 BTC-spillover surcharge (guard L2)
  chase: number; // v6.7.2 LONG-chase asymmetry surcharge
  mtf: number; // v8.0 multi-TF flow board ± (conflict +5 / aligned −4)
  liq: number; // v8.1 liq-heat proximity ± (flush risk +4 / squeeze fuel −3)
  lesson?: number; // v9.3 deep-learn lesson injection (deterministic, operator mandate ب)
  venue?: number; // v12.9 NO-BINANCE-CONFIRM surcharge (operator mandate: multi-venue confirmation, especially Binance)
}

export interface GateFactor {
  factor: string;
  vote: number;
  detail?: string;
}

export interface GateSample {
  at: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  score: number; // signed adjScore (regime scoreAdj already applied)
  effMin: number; // effective threshold this candidate faced
  baseMin: number; // operator base MIN_SCORE (gate.minScore)
  gap: number; // |score| − effMin (negative = short of the gate)
  band: GateBand;
  thr: ThrBreakdown;
  confirms: GateFactor[]; // votes aligned with the direction (top 3 by |vote|)
  opposes: GateFactor[]; // votes fighting the direction (top 3 by |vote|)
  notes: string | null; // joined regime/spill/chase/mtf/liq notes
  source: GateSource;
  best: boolean; // closest-to-gate candidate of its scan batch
}

export type GateName =
  | "FEED-FRESH"
  | "SIM-PRICE"
  | "REGIME"
  | "MEMORY"
  | "STRATEGY"
  | "LEARNED"
  | "FLOW"
  | "ONSET-RETEST"
  | "RISK-CLUSTER"
  | "SHADOW-VETO" // v8.2 AI-core Phase 1 — veto fires only in mode=veto, evidence-gated
  | "SHORT-GUARD" // v8.4 R1 — audit corrective action: SHORT book veto/HTF-align gate
  | "CHASE-PRICE" // v9.3 anti-late-entry — entry price ran too far past the detection reference
  | "DISLOCATION" // v10.15 cross-exchange venue-dislocation gate — rolling-5-scan median ≥ skipBps skips the candidate (SUPERVISOR proposal, operator APPROVE msg 861802422)
  | "DECISIVE" // v10.6 decisive-excursion filter — predicted no-touch deploys skipped pre-entry
  | "VOL-BARRIER" // v10.9.2 vol-scaled vertical barrier — slow-touch candidates skipped / TTL solved from projected 1R touch
  | "STALE-ANCHOR" // Task 53 — anchor freshness gate at deploy
  | "DEPEG-MUTE" // Task 53 — stablecoin depeg global circuit breaker (fail-closed)
  | "STABLE-REGIME" // Task 53 — stablecoin regime gate (SHADOW: journals, never blocks)
  | "DEGEN-STOP" // 2026-09-24 integrity guard — degenerate stop geometry refused at deploy
  | "SYMBOL-CAP" // v11.4 same-symbol concentration cap — EQ-92 P2 / EQ-94 mandate (RLC×2 / LUMIA×2 same-symbol SL chains)
  | "STRAT-PAUSE" // v11.6 EQ-97 — data-driven per-strategy pause gate (review #1 action: AI-SCALP 14d n=284 WR 6.0% net −$39.35)
  | "QUAD-SHORT" // v11.6 EQ-97 ③-c — SHORT refused in Q2_SQUEEZE BTC-quadrant context (book-edge n=111 net −$28.94/60d)
  | "REENTRY-LOCKOUT" // v11.7 Task-41 — per-symbol stop-chain guard: AUTO deploy refused N minutes after a net-negative SL close (AGTUSDT storm: 6 deploys/21m/4 SL)
  | "REARM-BRAKE" // v12.7 SENTINEL-20261020 — same-direction post-stop cooldown 360m/720m: binds auto+RAW-CAL capture+radar (NX-2910→NX-2911 6s relay); only operator-forced passes tagged
  | "LIQUIDITY-FLOOR" // v11.8 Task-42 — per-symbol deployability floor: volume24h < min or zero real venue quotes (feed-integrity; AGT sat at sim with 4 null venues)
  | "PHANTOM-FEED" // v11.9 Task-43 — corrupted-tape veto: regime jumps in recent PricePoints (XMRUSDT oscillated 118.7↔607.75 ×5; NX-2736/2744 stopped on phantom prints) block auto deploys
  | "BOTTOM-FADE" // v12.1 Task-48 ③ — SHORT refused when entry sells the bottom X% of the ±30m range into oversold/stretch (NX-2770 RSI 18 / NX-2779 %B −0.01 / NX-2769 %B −0.25)
  | "V-REVERSAL" // v12.1 Task-48 ④ — SHORT refused while a young violent bounce runs off the local low (NX-2770 bounced +3.71% at entry → +21% pump); LONG mirror shadow-only
  | "FLOW-GATE" // v12.1 Task-48 ② — optional gate on flow-blind deploys (EngineSetting "flow-gate"; default tag-only — 10d ledger: blind cohort +$204.20/n=553 WR 57.1% OUTPERFORMED sighted +$7.11/n=235)
  | "ENTRY-LEVER" // v11.3 late-entry shield — evidence-gated deterministic levers (EXT/FLOW/CAUSE/STALE/SCALP/LEVCAP/MOMENTUM)
  | "CHASE-EXTREME" // v12.8 AUDIT-20261023 — ≥1.5×ATR extended burst + RSI extreme refused outright (NX-3013 top-tick RSI 87.4 / NX-3020 hole-chase)
  | "REENTRY-WHIPSAW" // v12.8 AUDIT-20261023 — opposite-direction flip <240m after a net-negative stop refused for all machine lanes (NX-3014→NX-3020 −61.2%×2)
  | "FLUSH-EXHAUSTION" // v12.9 AUDIT-NX3046 — deploying WITH a ≥max(12%,1.2×ATR%) 4-bar cascade / SHORT below 20-bar low in a live waterfall / implied SL < 0.5×max-3-bar-range (NX-3046 −40.4% terminal-tick, dead in 23.4s)
  | "SINGLE-VENUE"; // v12.9 AUDIT-NX3046 — only ONE live venue: cross-venue confirmation impossible, machine deploy refused (JCT 12 deploys/48h on BYBIT-only tape); operator-forced passes tagged

export interface GateBlock {
  at: number;
  gate: GateName;
  symbol: string | null;
  direction: string | null;
  reason: string;
}

export interface GateDeploy {
  at: number;
  serial: number;
  symbol: string;
  direction: string;
  strategy: string;
  score: number; // raw confluence score at deploy
  effMin: number; // threshold it beat
  flowScore: number | null;
  conviction: number;
  tags: string[];
}

// ── storage ───────────────────────────────────────────────────

const SAMPLE_CAP = 8000;
const BLOCK_CAP = 800;
const DEPLOY_CAP = 300;
const BOUNDARY_DEDUP_MS = 60_000; // per symbol|direction — boundary state persists tick after tick
const REJECT_DEDUP_MS = 150_000;
const PASS_DEDUP_MS = 60_000; // PASS verdicts change slowly too — keep the ring dense with boundary data
const BLOCK_DEDUP_MS = 120_000;

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "gate-journal.jsonl");
const FILE_MAX_BYTES = 8 * 1024 * 1024;

const samples: GateSample[] = [];
const blocks: GateBlock[] = [];
const deploys: GateDeploy[] = [];
const lastAccepted = new Map<string, number>();
let persisted = 0;
let hydrating: Promise<void> | null = null;
// v8.2.1 SPLIT-BRAIN COUNTERMEASURE — Turbopack dev compiles one module
// instance PER ROUTE: the engine tick's instance writes the JSONL while a
// freshly-compiled read route starts with EMPTY rings and (before this fix)
// never hydrated, because hydration was only triggered from write paths.
// readPos tracks how many bytes of the JSONL this instance has already
// ingested, so reads can TAIL the file incrementally no matter which
// instance is doing the writing (including our own — persist() advances
// readPos so records we wrote ourselves are never re-ingested).
let readPos = 0;
let hydratedAt = 0; // epoch ms of the last successful hydrate/refresh — 0 = cold rings
let refreshing: Promise<void> | null = null;
let lastRefreshAt = 0;
const REFRESH_MIN_INTERVAL_MS = 10_000;
const REFRESH_MAX_BITE = 512 * 1024; // bounded bite per refresh
const seenSerials = new Set<number>(); // deploy serials ingested (hydrate + refresh) — cross-instance deploy dedupe

async function hydrate(): Promise<void> {
  if (hydrating) return hydrating;
  hydrating = (async () => {
    try {
      const buf = await readFile(FILE, "utf8").catch(() => "");
      if (!buf) return;
      const lines = buf.split("\n").filter(Boolean);
      const tail = lines.slice(-6000); // bounded restore
      for (const line of tail) {
        try {
          const rec = JSON.parse(line) as { k: "s" | "b" | "d"; v: GateSample | GateBlock | GateDeploy };
          if (rec.k === "s" && samples.length < SAMPLE_CAP) samples.push(rec.v as GateSample);
          else if (rec.k === "b" && blocks.length < BLOCK_CAP) blocks.push(rec.v as GateBlock);
          else if (rec.k === "d" && deploys.length < DEPLOY_CAP) deploys.push(rec.v as GateDeploy);
        } catch {
          /* skip torn line */
        }
      }
      const st = await stat(FILE).catch(() => null);
      persisted = st?.size ?? 0;
      // the whole file has been consumed (tail kept) — mark the read position
      readPos = st?.size ?? 0;
      hydratedAt = Date.now();
      // prime the dedup map from the hydrated history so a freshly-compiled
      // instance does not instantly re-accept everything another instance
      // journaled seconds ago (dedup continuity across instance swaps)
      for (const s of samples) {
        const key = `${s.symbol}|${s.direction}|${s.band}`;
        const prev = lastAccepted.get(key) ?? 0;
        if (s.at > prev) lastAccepted.set(key, s.at);
      }
      for (const b of blocks) {
        const key = `${b.gate}|${b.symbol ?? "*"}`;
        const prev = lastAccepted.get(key) ?? 0;
        if (b.at > prev) lastAccepted.set(key, b.at);
      }
      for (const d of deploys) if (d.serial > 0) seenSerials.add(d.serial);
      if ((st?.size ?? 0) > FILE_MAX_BYTES) {
        await rename(FILE, `${FILE}.old`).catch(() => undefined);
        persisted = 0; // (was a stale-size bug: rotation must reset the counter)
        readPos = 0;
      }
    } catch {
      /* fresh start — journaling must never break the engine */
    }
  })();
  return hydrating;
}

async function persist(rec: { k: "s" | "b" | "d"; v: unknown }): Promise<void> {
  try {
    const line = JSON.stringify(rec) + "\n";
    await appendFile(FILE, line, "utf8");
    persisted += line.length;
    readPos += line.length; // our own bytes are already in the rings — never re-ingest
    if (persisted > FILE_MAX_BYTES) {
      await rename(FILE, `${FILE}.old`).catch(() => undefined);
      persisted = 0;
      readPos = 0;
    }
  } catch {
    /* non-fatal */
  }
}

export async function gateJournalReady(): Promise<void> {
  await hydrate();
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch {
    /* exists */
  }
}

/** v8.2.1 READ-PATH LIVENESS — tail-ingest whatever another module instance
 * wrote to the JSONL since our last read. Throttled (one stat+read per
 * REFRESH_MIN_INTERVAL_MS), single-flight, rotation-safe, bounded bite.
 * Cheap no-op when this instance wrote the bytes itself (readPos already
 * advanced by persist()). READ ROUTES MUST CALL THIS — it is what keeps the
 * gauge live across Turbopack's per-route module split-brain. */
export async function gateJournalRefresh(maxAgeMs = REFRESH_MIN_INTERVAL_MS): Promise<void> {
  if (Date.now() - lastRefreshAt < maxAgeMs) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const st = await stat(FILE).catch(() => null);
      if (!st) return;
      if (st.size < readPos) readPos = 0; // rotated — restart the tail on the fresh file
      if (st.size === readPos) return;
      const len = Math.min(st.size - readPos, REFRESH_MAX_BITE);
      const fh = await open(FILE, "r").catch(() => null);
      if (!fh) return;
      try {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, readPos);
        let text = buf.toString("utf8", 0, bytesRead);
        const lastNl = text.lastIndexOf("\n");
        if (lastNl === -1) return; // partial line at the tail — wait for the writer
        text = text.slice(0, lastNl + 1); // only consume COMPLETE lines
        readPos += Buffer.byteLength(text, "utf8");
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line) as { k: "s" | "b" | "d"; v: GateSample | GateBlock | GateDeploy };
            if (rec.k === "s") {
              const s = rec.v as GateSample;
              // v8.2.1 ingest discipline — a SECOND module instance may write the
              // same verdict; apply the exact same dedup rule as recordGateSamples
              // so rings/stats stay honest no matter the writer
              const key = `${s.symbol}|${s.direction}|${s.band}`;
              const interval = s.band === "BOUNDARY" ? BOUNDARY_DEDUP_MS : s.band === "REJECT" ? REJECT_DEDUP_MS : PASS_DEDUP_MS;
              const last = lastAccepted.get(key) ?? 0;
              if (interval && s.at - last < interval) continue;
              lastAccepted.set(key, s.at);
              samples.push(s);
              if (samples.length > SAMPLE_CAP) samples.splice(0, samples.length - SAMPLE_CAP);
            } else if (rec.k === "b") {
              const b = rec.v as GateBlock;
              const key = `${b.gate}|${b.symbol ?? "*"}`;
              if (b.at - (lastAccepted.get(key) ?? 0) < BLOCK_DEDUP_MS) continue;
              lastAccepted.set(key, b.at);
              blocks.push(b);
              if (blocks.length > BLOCK_CAP) blocks.splice(0, blocks.length - BLOCK_CAP);
            } else if (rec.k === "d") {
              const d = rec.v as GateDeploy;
              if (d.serial > 0 && seenSerials.has(d.serial)) continue; // duplicate deploy from another instance
              if (d.serial > 0) seenSerials.add(d.serial);
              deploys.push(d);
              if (deploys.length > DEPLOY_CAP) deploys.splice(0, deploys.length - DEPLOY_CAP);
            }
          } catch {
            /* torn line */
          }
        }
        hydratedAt = Date.now();
      } finally {
        await fh.close().catch(() => undefined);
      }
    } catch {
      /* non-fatal — reads must never break */
    } finally {
      lastRefreshAt = Date.now();
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// ── recording ─────────────────────────────────────────────────

function bandOf(gap: number, passed: boolean): GateBand {
  if (passed) return "PASS";
  return gap >= -8 ? "BOUNDARY" : "REJECT";
}

/** Journal one scan batch of threshold verdicts (engine calls this once per
 * deploy-signal() evaluation pass, before the early returns). Dedup keeps
 * persisting boundary/reject churn from flooding rings + disk. */
export async function recordGateSamples(
  batch: Array<Omit<GateSample, "at" | "best" | "band" | "gap"> & { passed: boolean }>,
): Promise<void> {
  if (batch.length === 0) return;
  await hydrate();
  const now = Date.now();
  let bestGap = Infinity;
  let bestIdx = -1;
  const enriched = batch.map((b, i) => {
    const gap = Math.abs(b.score) - b.effMin;
    if (Math.abs(gap) < bestGap) {
      bestGap = Math.abs(gap);
      bestIdx = i;
    }
    return { ...b, at: now, gap, band: bandOf(gap, b.passed) };
  });

  for (let i = 0; i < enriched.length; i++) {
    const s = enriched[i]!;
    const key = `${s.symbol}|${s.direction}|${s.band}`;
    const interval = s.band === "BOUNDARY" ? BOUNDARY_DEDUP_MS : s.band === "REJECT" ? REJECT_DEDUP_MS : PASS_DEDUP_MS;
    const last = lastAccepted.get(key) ?? 0;
    if (interval && now - last < interval) continue;
    lastAccepted.set(key, now);
    const rec: GateSample = {
      at: s.at,
      symbol: s.symbol,
      direction: s.direction,
      strategy: s.strategy,
      score: s.score,
      effMin: s.effMin,
      baseMin: s.baseMin,
      gap: s.gap,
      band: s.band,
      thr: s.thr,
      confirms: s.confirms,
      opposes: s.opposes,
      notes: s.notes,
      source: s.source,
      best: i === bestIdx,
    };
    samples.push(rec);
    if (samples.length > SAMPLE_CAP) samples.splice(0, samples.length - SAMPLE_CAP);
    void persist({ k: "s", v: rec });
  }
}

export async function recordGateBlock(b: Omit<GateBlock, "at">): Promise<void> {
  await hydrate();
  const now = Date.now();
  const key = `${b.gate}|${b.symbol ?? "*"}`;
  if (now - (lastAccepted.get(key) ?? 0) < BLOCK_DEDUP_MS) return;
  lastAccepted.set(key, now);
  const rec: GateBlock = { ...b, at: now };
  blocks.push(rec);
  if (blocks.length > BLOCK_CAP) blocks.splice(0, blocks.length - BLOCK_CAP);
  void persist({ k: "b", v: rec });
}

export async function recordGateDeploy(d: Omit<GateDeploy, "at">): Promise<void> {
  await hydrate();
  const rec: GateDeploy = { ...d, at: Date.now() };
  deploys.push(rec);
  if (deploys.length > DEPLOY_CAP) deploys.splice(0, deploys.length - DEPLOY_CAP);
  void persist({ k: "d", v: rec });
}

// ── reads ─────────────────────────────────────────────────────

/** Live gauge roster: latest verdict per symbol|direction, nearest-to-gate
 * first (BOUNDARY → PASS → REJECT, each by |gap|). */
export function gateLive(limit = 16): GateSample[] {
  const latest = new Map<string, GateSample>();
  for (const s of samples) latest.set(`${s.symbol}|${s.direction}`, s); // rings are append-ordered
  const rank = (b: GateBand) => (b === "BOUNDARY" ? 0 : b === "PASS" ? 1 : 2);
  return [...latest.values()]
    .sort((a, b) => rank(a.band) - rank(b.band) || Math.abs(a.gap) - Math.abs(b.gap))
    .slice(0, limit);
}

export interface GateReasonAgg {
  factor: string;
  count: number;
  avgVote: number;
  lastDetail: string | null;
}

export interface GateThrAgg {
  name: keyof ThrBreakdown;
  count: number;
  avg: number; // signed average — + = raises the gate (reject pressure)
}

export interface GateStats {
  windowHours: number;
  samples: number;
  byBand: { PASS: number; BOUNDARY: number; REJECT: number };
  boundary: { avgGap: number; worstGap: number; sharePct: number } | null;
  confirmReasons: GateReasonAgg[];
  opposeReasons: GateReasonAgg[];
  thrModifiers: GateThrAgg[];
  blocks: Array<{ gate: GateName; count: number; lastReason: string }>;
  deploys: number;
  avgDeployScore: number | null;
}

export function gateStats(windowHours = 6): GateStats {
  const since = Date.now() - windowHours * 3600_000;
  const win = samples.filter((s) => s.at >= since);
  const byBand = { PASS: 0, BOUNDARY: 0, REJECT: 0 };
  for (const s of win) byBand[s.band]++;

  const agg = (list: GateSample[], pick: (s: GateSample) => GateFactor[]): Map<string, { n: number; sum: number; last: string | null }> => {
    const m = new Map<string, { n: number; sum: number; last: string | null }>();
    for (const s of list)
      for (const f of pick(s)) {
        const e = m.get(f.factor) ?? { n: 0, sum: 0, last: null };
        e.n++;
        e.sum += f.vote;
        if (f.detail) e.last = f.detail;
        m.set(f.factor, e);
      }
    return m;
  };
  const toAgg = (m: Map<string, { n: number; sum: number; last: string | null }>): GateReasonAgg[] =>
    [...m.entries()]
      .map(([factor, e]) => ({ factor, count: e.n, avgVote: Number((e.sum / e.n).toFixed(2)), lastDetail: e.last }))
      .sort((a, b) => b.count - a.count);

  const confirmAgg = toAgg(agg(win, (s) => s.confirms));
  const opposeAgg = toAgg(agg(win, (s) => s.opposes));

  const thrNames: Array<keyof ThrBreakdown> = ["regime", "spill", "chase", "mtf", "liq", "lesson"];
  const thrModifiers: GateThrAgg[] = thrNames
    .map((name) => {
      const vals = win.map((s) => s.thr[name]).filter((v): v is number => v !== undefined && v !== 0);
      return { name, count: vals.length, avg: vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : 0 };
    })
    .filter((t) => t.count > 0);

  const blockMap = new Map<GateName, { count: number; lastReason: string }>();
  for (const b of blocks) {
    if (b.at < since) continue;
    const e = blockMap.get(b.gate) ?? { count: 0, lastReason: b.reason };
    e.count++;
    e.lastReason = b.reason;
    blockMap.set(b.gate, e);
  }

  const deploysWin = deploys.filter((d) => d.at >= since);
  const boundaryN = byBand.BOUNDARY;
  return {
    windowHours,
    samples: win.length,
    byBand,
    boundary:
      boundaryN > 0
        ? {
            avgGap: Number((win.filter((s) => s.band === "BOUNDARY").reduce((a, s) => a + s.gap, 0) / boundaryN).toFixed(2)),
            worstGap: Math.max(...win.filter((s) => s.band === "BOUNDARY").map((s) => s.gap)),
            sharePct: Number(((boundaryN / Math.max(1, win.length)) * 100).toFixed(1)),
          }
        : null,
    confirmReasons: confirmAgg.slice(0, 6),
    opposeReasons: opposeAgg.slice(0, 6),
    thrModifiers,
    blocks: [...blockMap.entries()].map(([gate, e]) => ({ gate, count: e.count, lastReason: e.lastReason })).sort((a, b) => b.count - a.count),
    deploys: deploysWin.length,
    avgDeployScore: deploysWin.length ? Number((deploysWin.reduce((a, d) => a + Math.abs(d.score), 0) / deploysWin.length).toFixed(1)) : null,
  };
}

export function gateRecentBlocks(limit = 8): GateBlock[] {
  return blocks.slice(-limit).reverse();
}

export function gateRecentDeploys(limit = 6): GateDeploy[] {
  return deploys.slice(-limit).reverse();
}

export function gateJournalHealth(): { samples: number; blocks: number; deploys: number; fileKB: number; hydratedAt: number } {
  return { samples: samples.length, blocks: blocks.length, deploys: deploys.length, fileKB: Math.round(persisted / 1024), hydratedAt };
}

/** Deep-learn grounding payload — the compact, audit-grade reason ledger the
 * central AI core studies. Machine-readable + one narrative line. */
export async function gateJournalForCore(windowHours = 12, maxBoundary = 8): Promise<{
  narrative: string;
  stats: GateStats;
  boundaryFiles: string[];
  blockFiles: string[];
}> {
  await gateJournalRefresh(0); // grounding consumers always see fresh rings
  const stats = gateStats(windowHours);
  const nearGate = samples
    .filter((s) => s.at >= Date.now() - windowHours * 3600_000 && s.band === "BOUNDARY")
    .sort((a, b) => b.at - a.at)
    .slice(0, maxBoundary);
  const boundaryFiles = nearGate.map((s) => {
    const conf = s.confirms.map((f) => `${f.factor}${f.vote >= 0 ? "+" : ""}${f.vote}`).join(",") || "n/a";
    const opp = s.opposes.map((f) => `${f.factor}${f.vote >= 0 ? "+" : ""}${f.vote}`).join(",") || "n/a";
    const thr = Object.entries(s.thr)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${k}${v! > 0 ? "+" : ""}${v}`)
      .join(" ") || "none";
    return `${new Date(s.at).toISOString()} ${s.symbol} ${s.direction} ${s.strategy} score ${s.score.toFixed(1)} vs eff ${s.effMin} (gap ${s.gap >= 0 ? "+" : ""}${s.gap.toFixed(1)}) · thr mods: ${thr} · confirms: ${conf} · opposes: ${opp}`;
  });
  const blockFiles = gateRecentBlocks(6).map((b) => `${new Date(b.at).toISOString()} ${b.gate}${b.symbol ? ` ${b.symbol}` : ""} — ${b.reason.slice(0, 140)}`);
  const topConfirm = stats.confirmReasons[0];
  const topOppose = stats.opposeReasons[0];
  const narrative = [
    `${stats.samples} threshold verdicts in ${windowHours}h: ${stats.byBand.PASS} passed, ${stats.byBand.BOUNDARY} landed in the boundary band (gap −8..0, ${stats.boundary?.sharePct ?? 0}% of evaluations, avg gap ${stats.boundary?.avgGap ?? "n/a"}), ${stats.byBand.REJECT} rejected outright.`,
    `Dominant confirm factor: ${topConfirm ? `${topConfirm.factor} (×${topConfirm.count}, avg ${topConfirm.avgVote})` : "n/a"}. Dominant oppose factor: ${topOppose ? `${topOppose.factor} (×${topOppose.count}, avg ${topOppose.avgVote})` : "n/a"}.`,
    `Threshold modifiers live: ${stats.thrModifiers.map((t) => `${t.name}×${t.count} avg ${t.avg >= 0 ? "+" : ""}${t.avg}`).join(" · ") || "none"}.`,
    `Hard blocks: ${stats.blocks.map((b) => `${b.gate}×${b.count}`).join(" · ") || "none"}. Deployed: ${stats.deploys}${stats.avgDeployScore !== null ? ` (avg |score| ${stats.avgDeployScore})` : ""}.`,
  ].join(" ");
  return { narrative, stats, boundaryFiles, blockFiles };
}
