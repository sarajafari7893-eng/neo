// ── FlowRadar Neo shared types (client-safe) ──

export type Direction = "LONG" | "SHORT";
export type SignalStatus = "ACTIVE" | "TP1" | "TP2" | "TP3" | "SL" | "EXPIRED" | "CLOSED";
export type EventLevel = "info" | "success" | "warn" | "error" | "ai";

export interface FactorVoteDTO {
  factor: string;
  vote: number;
  detail: string;
}

export interface FlowDTO {
  verdict: "CONFIRMS" | "CONFLICTS" | "NEUTRAL" | "UNAVAILABLE" | "NO-DATA";
  score: number;
  reasons: string[];
  oiWeight: number;
  // v12.1 Task-48 ② — honest blindness telemetry (NO-DATA ≠ NEUTRAL)
  coverage?: number;
  blind?: boolean;
  metrics: {
    oiDelta10m: number | null;
    oiDelta1h: number | null;
    oiValueUsd: number | null;
    cvdNetPctOfVol: number | null;
    takerRatio: number | null;
    takerMean: number | null;
    crowdLongShort: number | null;
    crowdLongPct: number | null;
    funding8h: number | null;
  };
}

export interface LiqStatusDTO {
  online: boolean;
  connected: boolean;
  dataStalled: boolean;
  buffered: number;
  lastEventAt: number | null;
  uptimeSec: number;
}

// ── v8.0 MULTI-TF FLOW SCANNER (EPOCH-2) ──
export interface FlowScanTfDTO {
  tf: string; // 4h | 1h | 15m | 5m
  score: number; // −100..+100 along the TF's own read
  bias: "LONG" | "SHORT" | "NEUTRAL";
  trend: "UP" | "DOWN" | "FLAT";
  structure: "BOS_UP" | "BOS_DOWN" | "CHOH_UP" | "CHOH_DOWN" | "SWEEP_HIGH" | "SWEEP_LOW" | "RANGE";
  sweep: boolean;
  cvdPct: number | null;
  volZ: number | null;
}

export interface FlowScanSymbolDTO {
  symbol: string;
  at: number;
  netScore: number; // HTF-weighted consensus −100..+100
  netBias: "LONG" | "SHORT" | "NEUTRAL";
  alignment: number; // TFs matching netBias (0..4)
  tfs: FlowScanTfDTO[];
  funding8h: number | null;
  oiDelta1h: number | null;
}

export interface FlowBoardDTO {
  at: string;
  coverage: number;
  rows: FlowScanSymbolDTO[];
}

// ── v8.1 P1/P2 — OI/FUNDING BOARD · LIQ HEATMAP · VOL FORECAST · RISK OVERLAY ──
export interface OiFundRowDTO {
  symbol: string;
  at: number;
  markPrice: number | null;
  funding8h: number | null; // % per 8h (signed)
  oiUsdM: number | null; // notional open interest in $M
  oiDelta15m: number | null;
  oiDelta1h: number | null;
  oiDelta4h: number | null;
  oiZ1h: number | null;
}

export interface OiFundBoardDTO {
  at: string;
  coverage: number;
  rows: OiFundRowDTO[];
}

export interface LiqClusterDTO {
  side: "LONGS_BELOW" | "SHORTS_ABOVE";
  price: number;
  distPct: number;
  estUsdM: number;
  sharePct: number;
}

export interface LiqHeatDTO {
  symbol: string;
  at: number;
  price: number;
  oiUsdM: number | null;
  oiScaled: boolean;
  totalBelowUsdM: number;
  totalAboveUsdM: number;
  clusters: LiqClusterDTO[];
  nearestBelow: LiqClusterDTO | null;
  nearestAbove: LiqClusterDTO | null;
}

export interface LiqHeatBoardDTO {
  at: string;
  coverage: number;
  rows: LiqHeatDTO[];
}

// ── v8.1 P2 — VOLATILITY FORECAST BOARD (vol-forecast.ts surface) ──
export interface VolForecastDTO {
  symbol: string;
  at: number;
  ewmaBarPct: number; // EWMA(λ=0.94) stdev, %/15m bar
  ewma1hPct: number; // EWMA scaled √4 → %/1h horizon
  har6hPct: number; // realized-vol blend over the 6h window
  regime: "LOW" | "NORMAL" | "ELEVATED" | "EXTREME";
  percentile: number; // 0..100 vs the symbol's own trailing distribution
  atr15mPct: number; // ATR(14)% on 15m bars
}

export interface VolBoardDTO {
  at: string;
  coverage: number;
  rows: VolForecastDTO[];
}

// ── v8.1 P2 — PORTFOLIO RISK OVERLAY STATE (risk-overlay.ts surface) ──
export interface RiskClusterDTO {
  symbols: string[];
  direction: "LONG" | "SHORT" | "MIXED";
  marginUsd: number;
  corr: number; // mean |ρ| within the cluster
  equityPct: number;
}

export interface RiskStateDTO {
  at: number;
  equity: number;
  peakEquity: number;
  drawdownPct: number;
  exposureUsd: number;
  openCount: number;
  clusters: RiskClusterDTO[];
  worstClusterPct: number;
  sizeMult: number; // drawdown sizing 0.5..1.0
  verdict: "OK" | "THROTTLE" | "BLOCK";
  reasons: string[];
}

export interface SignalDTO {
  id: string;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  tp1: number;
  tp2: number;
  tp3: number;
  stopLoss: number;
  leverage: number;
  marginUsd: number;
  confidence: number;
  riskReward: number;
  timeframe: string;
  strategy: string;
  status: SignalStatus;
  reachedTp: number;
  pnlPercent: number;
  maxPnlPercent: number;
  analysis: string;
  tags: string[];
  serial: number;
  feeUsd: number;
  swapUsd: number;
  factors: FactorVoteDTO[] | null;
  flow: FlowDTO | null;
  afterlife: string | null;
  afterlifeAt: string | null;
  maxPostPnlPercent: number;
  operatorNotes: string;
  notesUpdatedAt: string | null;
  engine: string;
  ttlMinutes: number;
  ttlExtensions: number; // v6.1 dynamic expiry gate — grants consumed
  expiresAt: string;
  createdAt: string;
  closedAt: string | null;
}

export interface SignalEventDTO {
  id: string;
  signalId: string | null;
  type: string;
  symbol: string | null;
  message: string;
  level: EventLevel;
  createdAt: string;
}

export interface MarketAssetDTO {
  id: string;
  symbol: string;
  name: string;
  price: number;
  prevPrice: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  sparkline: number[];
  maxDevBps: number;
  source: string;
  exchanges: Array<{ venue: string; price: number | null; latencyMs: number | null }> | null;
}

export interface EquityPoint {
  date: string;
  cum: number;
  daily: number;
}

export interface SymbolAgg {
  symbol: string;
  count: number;
  wins: number;
  pnl: number;
}

export interface TimeframeAgg {
  timeframe: string;
  count: number;
  wins: number;
  pnl: number;
}

export interface ConfidenceBucket {
  bucket: string;
  count: number;
  wins: number;
  winRate: number;
}

export interface StrategyAgg {
  strategy: string;
  count: number;
  wins: number;
  pnl: number;
  avgConfidence: number;
}

/** v5.4 — TP ladder depth: TP1/TP2 proven hits vs full-TP3 wins vs stop-outs. */
export interface TpFunnel {
  settledOrProven: number;
  tp1Hits: number;
  tp2Hits: number;
  tp3FullWins: number;
  slLosses: number;
  expired: number;
  tp1Rate: number;
  tp2Rate: number;
  fullTpRate: number;
  avgRrFullWins: number;
  avgConfFullWins: number;
  avgHoldTp3Min: number;
}

export interface PaperAccount {
  startBalance: number;
  balance: number; // start + realized (all-time)
  equity: number; // balance + unrealized (open positions)
  unrealizedPnl: number;
  /** v12.0 — legacy full-margin current-price unrealized over ALL priced rows
   * (the breaker reads unrealizedPnl: tranche-aware + settlement-safe only).
   * The gap between the two is banked-tranche re-pricing + unsafe rows. */
  unrealizedPnlAllRows?: number;
  unsafeOpenRows?: number;
  exposureUsd: number; // sum margin of open positions
  freeMargin: number;
  marginUsedPct: number; // exposure / equity
  openPositions: number;
  feesPaid: number; // all-time realized taker + swap
  /** v11.5 — global open-pnl close-all breaker (operator mandate): when Σ
   * open NET pnl ≥ targetUsd the engine closes every position at the mark. */
  closeAll: {
    enabled: boolean;
    targetUsd: number;
    lastTriggeredAt: string | null;
    triggerCount: number;
  } | null;
}

export interface AfterlifeStats {
  tracking: number;
  tp1: number;
  tp2: number;
  tp3: number;
  sl: number;
  flat: number;
  avgPostMfe: number; // mean maxPostPnlPercent of EXPIRED signals
  wouldHaveWonPct: number; // % of EXPIRED whose price hit TP1 within 48h after TTL
}

/** v9.0 LIFECYCLE AUDIT (operator request 2026-09-12: «چرا در Session Stats
 * نتایج TTL_EXTENDED و BE_TRAIL و AFTERLIFE ثبت نمیشه؟») — lifetime counters
 * read straight from the DB (SignalEvent + Signal), immune to the 120-event
 * terminal window that previously let BE_TRAIL/TTL_EXTENDED rows collapse to
 * zero and kept the AFTERLIFE row at the currently-tracking count only. */
export interface LifecycleStats {
  beTrail: number; // lifetime BE_TRAIL events (breakeven arms)
  beTrailSignals: number; // distinct signals that armed breakeven
  beTrailRescued: number; // armed signals that settled TP-proven or ≥0 NET
  beTrailFeeOnly: number; // armed signals that closed at entry (fee-only bleed)
  beTrailStopped: number; // armed signals that still closed below entry
  ttlExtendedEvents: number; // lifetime TTL_EXTENDED events fired
  ttlExtendedGrants: number; // Σ ttlExtensions across all signals
  ttlSignalsWithExt: number; // distinct signals that consumed the expiry gate
  ttlCapturedUsd: number; // NET usd captured by extended signals that reached TP
  afterlifeResolved: number; // TP1_HIT/TP2_HIT/TP3_HIT/SL_HIT/FLAT confirmed
  afterlifeTracking: number; // EXPIRED signals still inside the 48h window
  afterlifeTotal: number; // resolved + tracking
  learningWired: boolean; // lifecycle evidence feeds the 6h AUTO-LEARNER (v9.0)
  // v10.3 TRUE-LIFETIME session stats (operator 2026-09-15 «Session Stats داده های قدیمی …
  // باید با داده های زنده پرشود»): the terminal rows previously mixed a 7-day stats
  // window with the 60-signal pulse slice — old rows went stale as the book grew.
  // These counters are straight DB aggregates over ALL rows (memoized 30s).
  lifetimeSignals: number; // every signal row in the epoch (CREATED)
  tp1HitsLifetime: number; // reachedTp >= 1 (any rung implies TP1)
  tp2HitsLifetime: number; // reachedTp >= 2
  tp3HitsLifetime: number; // closed TP3 OR afterlife TP3_HIT
  slLifetime: number; // settled SL rows
  expiredLifetime: number; // settled EXPIRED rows
}

/** v6.1 — NET EST PNL ledger: per-bucket realized NET usd (EXPIRED vs TP vs STOP) per time bucket.
 *  v6.2 — operator mandate: estPnlPct = Σ of each signal's ACTUAL engine result (fee-NET,
 *  levered pnlPercent — the old idealized +50/−30 norms are gone) and avgPct = per-trade
 *  expectancy (Σ% / trades). Buckets are ASIA/TEHRAN local calendar units. */
export interface PnlLedgerRow {
  key: string; // 2026-09-04 | 2026-W36 | 2026-09
  label: string; // MM-DD | W36 | YYYY-MM
  expiredUsd: number;
  tpUsd: number;
  stopUsd: number;
  otherUsd: number; // CLOSED (delisted orphan force-close)
  netUsd: number;
  expiredN: number;
  tpN: number;
  stopN: number;
  otherN: number;
  estPnlPct: number; // Σ ACTUAL engine NET levered % (reality-based, v6.2)
  avgPct: number; // per-trade expectancy: estPnlPct / trades
}

export interface PnlLedgerTotals {
  expiredUsd: number;
  tpUsd: number;
  stopUsd: number;
  otherUsd: number;
  netUsd: number;
  expiredN: number;
  tpN: number;
  stopN: number;
  otherN: number;
  estPnlPct: number; // Σ ACTUAL engine NET levered %, all-time (v6.2)
  avgPct: number; // per-trade expectancy, all-time
  ttlExtended: number; // signals that consumed the dynamic expiry gate
  extCapturedUsd: number; // NET usd captured by extended signals that reached TP
  /** Task 56 LEDGER-AUDIT: integrity-flagged (qualityFlag) or non-settlement
   *  (VOID) rows excluded from the clean ledger — the paper account keeps
   *  full history, this ledger does not (v10.18 doctrine applied to the ledger). */
  excludedN: number;
}

export interface PnlLedger {
  daily: PnlLedgerRow[]; // last 30 calendar days (with data)
  weekly: PnlLedgerRow[]; // last 12 ISO weeks (with data)
  monthly: PnlLedgerRow[]; // last 12 calendar months (with data)
  totals: PnlLedgerTotals;
}

export interface VenueHealthDTO {
  venue: string;
  ok: boolean;
  latencyMs: number | null;
}

export interface TriggerEventDTO {
  at: number;
  layer: "L1_TAKER_SWEEP" | "L15_OBI_IMBALANCE" | "L2_VACUUM" | "L3_LIQ_CASCADE" | "L3P_LIQ_PRE" | "L35_CROWD_JUMP" | "L4_MACRO";
  symbol: string;
  side: "LONG" | "SHORT" | "NEUTRAL";
  strength: number;
  detail: string;
  acted: boolean;
  regime: string | null;
}

export interface TriggerBusDTO {
  counts: Record<string, number>;
  last: TriggerEventDTO[];
  rotation: number;
  rotationSize: number;
  lastCycleAt: number | null;
  lastSpawnAt: number | null;
  suppressed: string[];
  crowdCut: string[];
  macroNote: string;
}

export interface RegimeRowDTO {
  symbol: string;
  regime: string;
  label: string;
  strength: number;
}

export interface FeedStatusDTO {
  source: "LIVE" | "STALE" | "SIMULATED";
  lastOkAt: number | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  host: string | null;
  /** v13.5 — live Binance futures bookTicker ring (price-ws :3003 → .data/futws-quotes.json) */
  futws?: { fresh: boolean; rows: number; ageMs: number | null } | null;
  exchanges: VenueHealthDTO[];
  flow: { covered: number; lastOkAt: number | null; lastError: string | null };
  liq: LiqStatusDTO | null;
  triggers: TriggerBusDTO | null;
  regimes: RegimeRowDTO[];
  universe: { tracked: number; poolTotal: number; liquidPool: number; target: number; poolSource?: string } | null;
  pump: PumpEngineStatus | null; // v9.0 PUMP/DUMP RADAR (lib/pump-dump.ts)
  goldenLane: GoldenLaneBlockDTO | null; // Task 79 — pre-registered golden-formula paper lanes
}

// ── Task 79 GOLDEN-LANE (server mirror: lib/golden-lane.ts) ─────────────
export interface LaneMatchDTO {
  signalId: string;
  serial: number;
  lane: string;
  symbol: string;
  direction: string;
  strategy: string;
  tehranHour: number;
  tp1DistPct: number;
  status: string;
  closedAt: number | null;
  net2: number | null;
  win: boolean | null;
}

export interface LaneStatusDTO {
  id: string;
  name: string;
  windowStart: number;
  windowEnd: number;
  dayOfWindow: number;
  phase: "PAPER" | "PROMOTE-CANDIDATE" | "EXTEND" | "ABSTAIN" | "KILLED";
  detail: string;
  matched: number;
  open: number;
  settled: number;
  winRatePct: number | null;
  net2: number;
  gross2: number;
  avgNet2: number | null;
  bestDay: number | null;
  worstDay: number | null;
  todayNet2: number | null;
  weekNet2: number | null;
  dailyStopBreached: boolean;
  weeklyStopBreached: boolean;
  kills: { K1: boolean; K2: boolean; K3: boolean; K4: boolean };
  killDetail: string[];
  lastMatchAt: number | null;
  recent: LaneMatchDTO[];
}

export interface GoldenLaneBlockDTO {
  configured: boolean;
  marginUsd: number;
  dailyStop: number;
  weeklyStop: number;
  windowStart: number;
  windowEnd: number;
  extensions: number;
  tampered: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  lanes: LaneStatusDTO[];
}

// ── v9.0 PUMP/DUMP RADAR (server mirror: lib/pump-dump.ts) ──────────────
export interface PumpTrackDTO {
  id: string;
  symbol: string;
  kind: "PUMP" | "DUMP";
  phase: string; // ONSET | EXTENSION | EXHAUSTION | RESOLVED
  outcome: string | null; // SUCCESS | FAILURE | null while tracking
  anchorPrice: number;
  mfePct: number;
  maePct: number;
  score: number;
  vel5mPct: number | null;
  volBurstX: number | null;
  detectedAt: string;
  resolvedAt: string | null;
  successNote: string | null;
}

export interface PumpEngineStatus {
  gate: {
    unlocked: boolean;
    successful: number;
    failed: number;
    total: number;
    required: number;
    unlockedAt: string | null;
  };
  authority: "direct" | "gated"; // v9.1 — operator-granted direct signal authority
  /** v11.1 — nomination funnel counters: every silent drop is now visible
   *  (operator: «چرا ردیابی‌ها تبدیل به سیگنال نمی‌شود؟»). */
  nomination: {
    declared: number;
    learningHeld: number;
    belowDeployFloor: number;
    spacingDrop: number;
    maxActiveDrop: number;
    nominated: number;
    deployed: number;
    engineVetoed: number;
    successResolutions: number;
    renomSkippedHasCard: number;
    renomAttempts: number;
    renomDeployed: number;
    renomSpacingDrop: number;
    renomMaxActiveDrop: number;
    // v12.1 Task-48 ① — R6 RADAR LANE funnel counters
    laneAttempts: number;
    laneCapDrop: number;
    laneProbationNote: string;
    laneDeployed: number;
    laneVetoed: number;
  };
  active: PumpTrackDTO[];
  recent: PumpTrackDTO[];
  tapeSymbols: number;
  warm: boolean;
}

export interface PlatformStats {
  totalSignals: number;
  activeCount: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number;
  /** TASK-40 (2026-09-27): ALL-TIME TP-proven split — same semantics as the
   * rolling-7d headline counters but over the FULL table (monotonic). The
   * WIN/LOSS SPLIT card headlines this because a rolling window shrinks by
   * itself as rows age out and reads like data loss. */
  allTimeSplit: {
    wins: number;
    losses: number;
    expired: number;
    settled: number;
    winRate: number;
  };
  totalPnlUsd: number;
  pnl24hUsd: number;
  avgPnlPercent: number;
  bestTrade: { symbol: string; pnlPercent: number; pnlUsd: number } | null;
  worstTrade: { symbol: string; pnlPercent: number; pnlUsd: number } | null;
  streak: { type: "win" | "loss"; count: number };
  avgRiskReward: number;
  avgConfidence: number;
  totalVolumeUsd: number;
  equityCurve: EquityPoint[];
  bySymbol: SymbolAgg[];
  byDirection: { long: number; short: number };
  byTimeframe: TimeframeAgg[];
  byStrategy: StrategyAgg[];
  confidenceBuckets: ConfidenceBucket[];
  peakEquity: number;
  account: PaperAccount;
  afterlife: AfterlifeStats;
  /** v10.18 clean-ledger transparency — flagged rows excluded from headline analytics */
  dataQuality: {
    excludedTotal: number;
    degenStop: number;
    invertedStop: number;
    restoreCatchup: number;
    /** Task 56: rows voided by the PHANTOM-FEED-0930 forensic guard */
    phantomFeed: number;
  };
  lifecycle: LifecycleStats;
  tpFunnel: TpFunnel;
  pnlLedger: PnlLedger;
  /** Task 65 SIZING-MODES — live margin sizing control state */
  sizing: SizingStats;
}

/** Task 65 — margin sizing mode (EngineSetting "sizing.mode", live-switchable).
 *  Backtest 2026-10-02: CONFIDENCE −$10.65 · FLAT$2 −$3.02 · ANTI_MART +$2.99. */
export interface SizingStats {
  mode: "CONFIDENCE" | "FLAT" | "ANTI_MARTINGALE";
  flatBase: number;
  antiBase: number;
  decay: number;
  floor: number;
  consecCap: number;
  /** consecutive-SL run since last TP (anti-martingale exponent) */
  consecSl: number;
}

export interface PulseSnapshot {
  ts: number;
  market: MarketAssetDTO[];
  signals: SignalDTO[];
  events: SignalEventDTO[];
  stats: PlatformStats;
  feed: FeedStatusDTO;
}

// ── v8.2 GATE GAUGE // SIGNAL AUDIT (server mirror: lib/gate-journal.ts) ──

export interface GateFactorDTO {
  factor: string;
  vote: number;
  detail?: string;
}

export interface GateThrDTO {
  regime: number;
  spill: number;
  chase: number;
  mtf: number;
  liq: number;
}

export type GateBand = "PASS" | "BOUNDARY" | "REJECT";

export interface GateSampleDTO {
  at: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  score: number;
  effMin: number;
  baseMin: number;
  gap: number;
  band: GateBand;
  thr: GateThrDTO;
  confirms: GateFactorDTO[];
  opposes: GateFactorDTO[];
  notes: string | null;
  source: "auto-scan" | "trigger" | "forced" | "shadow";
  best: boolean;
}

export type GateNameDTO =
  | "FEED-FRESH"
  | "SIM-PRICE"
  | "REGIME"
  | "MEMORY"
  | "STRATEGY"
  | "LEARNED"
  | "FLOW"
  | "ONSET-RETEST"
  | "RISK-CLUSTER"
  | "SHADOW-VETO"
  | "SHORT-GUARD" // v8.4 R1 — audit corrective action (mirrors gate-journal GateName)
  | "CHASE-PRICE" // v9.3 anti-late-entry — entry too far past the detection reference
  | "DECISIVE" // v10.6 decisive-excursion filter — predicted no-touch deploys skipped pre-entry
  | "VOL-BARRIER" // v10.9.2 vol-scaled vertical barrier — slow-touch skip / solved TTL (mirrors gate-journal GateName)
  | "DISLOCATION" // v10.15 cross-exchange venue-dislocation gate
  | "DEGEN-STOP" // 2026-09-24 integrity guard — degenerate stop geometry refused at deploy
  | "SYMBOL-CAP" // v11.4 same-symbol concentration cap (mirrors gate-journal GateName)
  | "ENTRY-LEVER" // v11.3 late-entry shield — evidence-gated deterministic levers
  | "STALE-ANCHOR" // Task 53 — anchor freshness gate at deploy
  | "DEPEG-MUTE" // Task 53 — stablecoin depeg global circuit breaker (fail-closed)
  | "STABLE-REGIME"; // Task 53 — stablecoin regime gate (SHADOW: journals, never blocks)

export interface GateBlockDTO {
  at: number;
  gate: GateNameDTO;
  symbol: string | null;
  direction: string | null;
  reason: string;
}

export interface GateDeployDTO {
  at: number;
  serial: number;
  symbol: string;
  direction: string;
  strategy: string;
  score: number;
  effMin: number;
  flowScore: number | null;
  conviction: number;
  tags: string[];
}

export interface GateReasonAggDTO {
  factor: string;
  count: number;
  avgVote: number;
  lastDetail: string | null;
}

export interface GateThrAggDTO {
  name: string;
  count: number;
  avg: number;
}

export interface GateStatsDTO {
  windowHours: number;
  samples: number;
  byBand: { PASS: number; BOUNDARY: number; REJECT: number };
  boundary: { avgGap: number; worstGap: number; sharePct: number } | null;
  confirmReasons: GateReasonAggDTO[];
  opposeReasons: GateReasonAggDTO[];
  thrModifiers: GateThrAggDTO[];
  blocks: Array<{ gate: GateNameDTO; count: number; lastReason: string }>;
  deploys: number;
  avgDeployScore: number | null;
}

export interface GateLessonDTO {
  at: string;
  scope: string;
  pattern: string;
  action: string;
  label: string;
  confidence: number;
}

export interface GateGaugeDTO {
  ts: number;
  gate: { minScore: number; describe: string };
  live: GateSampleDTO[];
  stats: GateStatsDTO;
  blocks: GateBlockDTO[];
  deploys: GateDeployDTO[];
  core: { runs: number; lastRunAt: string | null; lastAnswer: string | null; lessons: GateLessonDTO[] };
  health: { samples: number; blocks: number; deploys: number; fileKB: number; hydratedAt: number };
}

/* ── v8.2 SHADOW-VETO — AI-core Phase 0 (lib/shadow-veto.ts) ── */

export type ShadowVetoModeDTO = "off" | "shadow" | "veto";

export interface ShadowOutcomeDTO {
  status: string;
  pnlPercent: number;
  pnlUsd: number;
  win: boolean;
  closedAt: number;
}

export interface ShadowVerdictDTO {
  id: string;
  at: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  side: "PASS" | "REJECT";
  gap: number;
  score: number;
  effMin: number;
  verdict: "TRADE" | "VETO";
  confidence: number;
  reason: string;
  label: "MODEL" | "HEURISTIC";
  audit: { cited: number; unmatched: number[]; verdict: "CLEAN" | "SUSPECT" | "VIOLATION" } | null; // v8.2.1 grounding audit
  source: string;
  serial: number | null;
  outcome: ShadowOutcomeDTO | null;
}

export interface ShadowPaperDTO {
  id: string;
  verdictId: string;
  originSide: "PASS" | "REJECT";
  originVerdict: "TRADE" | "VETO";
  at: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  leverage: number;
  marginUsd: number;
  rr: number;
  ttlMinutes: number;
  status: string;
  reachedTp: number;
  maxPnlPercent: number;
  pnlPercent: number;
  pnlUsd: number;
  outcome: ShadowOutcomeDTO | null;
  closeNote: string | null;
}

export interface ShadowArmDTO {
  id: "real-keep" | "real-veto" | "paper-keep" | "paper-veto";
  label: string;
  n: number;
  wins: number;
  winRatePct: number | null;
  wilsonLB: number | null;
  netUsd: number;
  target: number;
  epoch?: string; // v10.7 ARM-EPOCH — evidence epoch of this cohort
  frozenAt?: number; // v10.11 COHORT-FREEZE — set when read from the frozen decision-grade snapshot
}

export interface ShadowPromotionDTO {
  ready: boolean;
  criteria: Array<{ id: string; ok: boolean; detail: string }>;
  revocation: { pressure: boolean; detail: string };
  sequential?: { // v10.11 SEQ-STOP — always-valid sequential early-decision layer
    state: "CONTINUE" | "PROMOTE-EARLY" | "ABORT-EARLY";
    z: number | null;
    boundary: number | null;
    infoFrac: number | null;
    alphaSpent: number | null;
    dPct: number | null;
    minNMet: boolean;
    detail: string;
    checkedAt: number;
  };
}

export interface ShadowVetoDTO {
  ts: number;
  armEpoch?: string; // v10.7 ARM-EPOCH — the epoch the arms + promotion cohorts belong to
  config: {
    mode: ShadowVetoModeDTO;
    windowPass: number;
    windowReject: number;
    budgetPerHour: number;
    minSpacingMs: number;
    dedupMs: number;
    cacheTtlMs: number;
    paperMarginUsd: number;
  };
  stats: {
    total: number;
    passSide: number;
    rejectSide: number;
    vetoCount: number;
    tradeCount: number;
    modelSharePct: number | null;
    modelGroundedPct: number | null; // v8.2.1 — grounded share of audited MODEL verdicts
    avgConfidence: number | null;
    gateAgreement: number;
    paperOpen: number;
    paperSettled: number;
    recent24h: { n: number; modelSharePct: number | null; lastModelAgeH: number | null; lastVerdictAgeH: number | null }; // v10.21.2 — recency truth next to the window aggregate
  };
  arms: ShadowArmDTO[];
  armsLive?: ShadowArmDTO[]; // v10.11 COHORT-FREEZE — unfrozen live recompute (monitoring-only)
  cohortFreeze?: { epoch: string; frozenAt: number; reason: "FILL" | "SEQ-STOP"; seqState: string; realKeep: { n: number; wins: number; netUsd: number }; realVeto: { n: number; wins: number; netUsd: number } } | null; // v10.11
  promotion: ShadowPromotionDTO;
  /** v11.0 PATTERN-VETO — the proven-performance filter's live evidence:
   * scoped veto authority per (strategy|direction) cell, granted only when the
   * cell's settled evidence passes the four-part proof. */
  patternVeto?: { enabled: boolean; proven: string[]; rows: Array<{ pattern: string; nKeep: number; wrKeep: number | null; netKeep: number; nVeto: number; wrVeto: number | null; netVeto: number; ubVeto: number | null; proven: boolean; detail: string }> };
  recent: ShadowVerdictDTO[];
  paper: ShadowPaperDTO[];
  health: { verdicts: number; papers: number; fileKB: number; pending: number; callsLastHour: number; auditViolations: number; hydratedAt: number };
  /** v8.4.1 neural-link health — 429 budget-shield state (operator visibility for "هوش غیرفعال شده") */
  llm?: { cooling: boolean; cooldownRemainsMs: number; consecutive429: number; lastOkAt: number | null };
}

/* ── v10.2 SV-TELEMETRY HUB — arm feed wiring + JSON persistence (lib/sv-telemetry.ts) ──
 * Operator mandate: track shadow-veto performance/status, wire the required
 * data to ALL arms, persist as a retrievable/usable JSON file. */

export interface SvArmFeedDTO {
  id: ShadowArmDTO["id"];
  label: string;
  feedSource: string; // what data path feeds this arm
  n: number;
  target: number;
  fillPct: number;
  wins: number;
  winRatePct: number | null;
  wilsonLB: number | null;
  netUsd: number;
  fed: number;
  open: number;
  settled: number;
  lastFedAt: number; // 0 = never fed
  lastSettledAt: number; // 0 = never settled
  neverFed: boolean;
  starved: boolean;
  starveDetail: string | null;
}

export interface SvWiringDTO {
  ok: boolean;
  detail: string;
}

export interface SvAlertDTO {
  id: string;
  at: number;
  level: "warn" | "info";
  text: string;
  delivered: boolean;
}

export interface SvHistorySampleDTO {
  t: number;
  mode: ShadowVetoModeDTO;
  verdicts: number;
  papers: number;
  arms: Array<{ id: string; n: number; netUsd: number; winRatePct: number | null }>;
}

export interface SvTelemetryDTO {
  schemaVersion: number;
  capturedAt: number;
  captureMs: number;
  mode: ShadowVetoModeDTO;
  config: ShadowVetoDTO["config"] & { autoPromote: boolean };
  stats: ShadowVetoDTO["stats"];
  arms: SvArmFeedDTO[];
  wiring: {
    adjudicator: SvWiringDTO;
    realLink: SvWiringDTO;
    outcomeClosure: SvWiringDTO;
    paperSweep: SvWiringDTO;
    llm: SvWiringDTO & { cooling: boolean; consecutive429: number };
    pipeline: {
      unlinkedPass24h: number;
      unlinkedPassStale: number;
      unlinkedPassOrphan: number; // v10.19 — swept structural orphans (promotion-inert)
      unlinkedPassAged: number; // v10.19 — beyond the 7-day link reach, never linkable again
      pendingRealOutcomes: number;
      pendingPapers: number;
      lastVerdictAt: number;
      lastPaperOpenAt: number;
      verdicts24h: number;
      papers24h: number;
    };
  };
  promotion: ShadowPromotionDTO;
  health: ShadowVetoDTO["health"];
  store: { file: string; fileKB: number; historySamples: number; lastCaptureAt: number; writes: number };
  alerts: SvAlertDTO[];
  history?: SvHistorySampleDTO[];
}
