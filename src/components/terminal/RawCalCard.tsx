"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, FlaskConical, Gauge, Microscope, Power, Scale, ShieldCheck, TrendingUp, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";

/**
 * RawCalCard — v9.2 RAW-CAL CAPTURE MODE control + PACE MONITOR (operator
 * mandate 2026-09-13: «پایش ریتم صدور RAW-CAL و رشد کتاب EPOCH-2 به سمت ۱۰۰»)
 * + v9.3 SAMPLE QUALITY LAB (operator mandate 2026-09-13: «کیفیت نمونه‌های
 * خام را بررسی کنیم تا کالیبراسیون R6 روی داده سالم بنشیند»). Arms/disarms
 * the UNFILTERED signal-issuance capture that feeds the engine-memory book
 * toward the AI CALIBRATION bar (100 EPOCH-2 settled). Pace monitor:
 * issue/settle rates, observed spacing, ETA to the bar, pipeline projection,
 * cadence grade, stall detection, milestone ledger (50→100), book-growth
 * sparkline. Quality lab: per-sample health scores (capture integrity, plan
 * completeness, outcome informativeness, representativeness), cohort health
 * tiles, warnings, and the R6 DATA-HEALTH GATE verdict. Feed: /api/rawcal
 * (10s poll).
 */

interface PaceInfo {
  armed: boolean;
  settledE2: number;
  needed: number;
  target: number;
  issueRate3hPerH: number;
  issueRateSinceArmPerH: number;
  observedSpacingMin: { mean: number | null; min: number | null; max: number | null; samples: number };
  openRaw: number;
  maxOpen: number;
  spacingMin: number;
  settleRate3hPerH: number;
  settleRate6hPerH: number;
  meanSettleMin: number | null;
  etaHours: number | null;
  etaAt: string | null;
  steadyRatePerH?: number | null;
  etaSteadyHours?: number | null;
  etaSteadyAt?: string | null;
  openE2?: number;
  pipelineProjection: number;
  cadenceGrade: "A" | "B" | "C" | "D" | "OFF";
  stalls: { issueStallMin: number | null; settleStallMin: number | null; lastBlockNote: string | null };
  sparkline: Array<{ t: string; v: number }>;
  journalRows: number;
}

interface SampleQuality {
  serial: number;
  symbol: string;
  direction: string;
  strategy: string;
  status: string;
  settled: boolean;
  pnlPercent: number;
  holdMin: number | null;
  score: number;
  cls: "HEALTHY" | "REVIEW" | "CENSORED" | "PENDING";
  flags: string[];
}

interface QualityInfo {
  at: string;
  issuedTotal: number;
  openRaw: number;
  settledRaw: number;
  healthy: number;
  review: number;
  censored: number;
  healthyPct: number | null;
  informativePct: number | null;
  expiredNoTouch: number;
  snapshotPct: number | null;
  symbols: number;
  topSymbolShare: number | null;
  longPct: number | null;
  shortPct: number | null;
  meanAbsPnl: number | null;
  meanHoldMin: number | null;
  clusterCount: number;
  warnings: string[];
  gate: { verdict: "WARMING" | "GREEN" | "AMBER" | "RED"; healthFloor: number; blockers: string[] };
  samples: SampleQuality[];
}

interface RawCalStatus {
  armed: boolean;
  armedAt: string | null;
  armedBy: string;
  disarmReason: string | null;
  disarmedAt: string | null;
  issued: number;
  issuedTotal: number;
  lastIssueAt: string | null;
  lastIssueSerial: number | null;
  target: number;
  spacingMin: number;
  maxOpen: number;
  autoLiftAt: string | null;
  settledN: number;
  needed: number;
  openRaw: number;
  settledRaw: number;
  winsRaw: number;
  rawWinRatePct: number | null;
  pace?: PaceInfo | null;
  milestones?: { steps: Array<{ step: number; fired: boolean; at: string | null; pending: boolean }>; settledE2: number } | null;
  blocks?: Array<{ t: number; note: string }>;
  quality?: QualityInfo | null;
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function etaClock(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

/** Inline SVG book-growth sparkline (settled EPOCH-2 over the journal window). */
function GrowthSpark({ series }: { series: Array<{ t: string; v: number }> }) {
  if (series.length < 2) {
    return (
      <div className="flex h-9 items-center justify-center font-terminal text-[9px] text-ink-3">
        BOOK CURVE WARMING — journal fills every 10min
      </div>
    );
  }
  const W = 100;
  const H = 26;
  // NaN guard (v9.4.2): journal rows can carry null/gap equity values — any
  // non-finite point would turn vMin/vMax into NaN and crash React children.
  const vs = series.map((p) => p.v).filter((v) => Number.isFinite(v));
  if (vs.length < 2) {
    return (
      <div className="flex h-9 items-center justify-center font-terminal text-[9px] text-ink-3">
        BOOK CURVE WARMING — journal fills every 10min
      </div>
    );
  }
  const vMin = Math.min(...vs);
  const vMax = Math.max(...vs);
  const span = Math.max(1, vMax - vMin);
  const pts = series
    .map((p, i) => ({ x: (i / (series.length - 1)) * W, v: p.v }))
    .filter((p): p is { x: number; v: number } => Number.isFinite(p.v))
    .map((p) => {
      const y = H - ((p.v - vMin) / span) * (H - 4) - 2;
      return `${p.x.toFixed(1)},${y.toFixed(1)}`;
    });
  const area = `M0,${H} L${pts.join(" L")} L${W},${H} Z`;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-9 w-full" aria-hidden>
        <path d={area} fill="url(#rawcalSparkFill)" opacity={0.35} />
        <polyline points={pts.join(" ")} fill="none" stroke="var(--amber-neon)" strokeWidth={1.4} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <defs>
          <linearGradient id="rawcalSparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--amber-neon)" stopOpacity={0.8} />
            <stop offset="100%" stopColor="var(--amber-neon)" stopOpacity={0} />
          </linearGradient>
        </defs>
      </svg>
      <span className="absolute left-0 top-0 font-terminal text-[8px] text-ink-3">{vMin.toFixed(2)}</span>
      <span className="absolute right-0 top-0 font-terminal text-[8px] text-amber-neon">{vMax.toFixed(2)}</span>
    </div>
  );
}

const GRADE_TONE: Record<string, string> = {
  A: "border-mint-neon/50 bg-mint-neon/10 text-mint-neon",
  B: "border-cyan-neon/50 bg-cyan-neon/10 text-cyan-neon",
  C: "border-amber-neon/50 bg-amber-neon/10 text-amber-neon",
  D: "border-danger-neon/50 bg-danger-neon/10 text-danger-neon",
  OFF: "border-white/10 bg-white/5 text-ink-3",
};

const GATE_TONE: Record<string, string> = {
  GREEN: "border-mint-neon/50 bg-mint-neon/10 text-mint-neon",
  AMBER: "border-amber-neon/50 bg-amber-neon/10 text-amber-neon",
  RED: "border-danger-neon/50 bg-danger-neon/10 text-danger-neon",
  WARMING: "border-white/10 bg-white/5 text-ink-3",
};

const CLS_TONE: Record<string, string> = {
  HEALTHY: "border-mint-neon/40 bg-mint-neon/10 text-mint-neon",
  REVIEW: "border-amber-neon/40 bg-amber-neon/10 text-amber-neon",
  CENSORED: "border-danger-neon/40 bg-danger-neon/10 text-danger-neon",
  PENDING: "border-white/10 bg-white/5 text-ink-3",
};

export default function RawCalCard() {
  const [st, setSt] = useState<RawCalStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/rawcal", { cache: "no-store" });
      if (res.ok) setSt((await res.json()) as RawCalStatus);
    } catch {
      /* next tick retries */
    }
  }, []);

  useEffect(() => {
    void pull();
    const id = setInterval(pull, 10_000);
    return () => clearInterval(id);
  }, [pull]);

  const act = useCallback(
    async (action: "arm" | "disarm") => {
      setBusy(true);
      try {
        const res = await fetch("/api/rawcal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, reason: action === "disarm" ? "operator command — return to filtered operation" : undefined }),
        });
        const json = (await res.json()) as { ok?: boolean; error?: string };
        if (res.ok && json.ok) {
          toast.success(action === "arm" ? "RAW-CAL capture mode ARMED" : "RAW-CAL mode disarmed — filtered operation restored");
        } else {
          toast.error(json.error ?? "rawcal action failed");
        }
      } catch {
        toast.error("rawcal action failed");
      } finally {
        setBusy(false);
        void pull();
      }
    },
    [pull],
  );

  const pct = st ? Math.min(100, (st.settledN / st.target) * 100) : 0;
  const pace = st?.pace ?? null;
  const stallIssue = !!pace?.stalls.issueStallMin;
  const stallSettle = !!pace?.stalls.settleStallMin;
  const anyStall = stallIssue || stallSettle;

  return (
    <BentoCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <FlaskConical className={cn("h-4 w-4", st?.armed ? "text-amber-neon" : "text-ink-3")} aria-hidden />
          <span className="label-tech">RAW-CAL · Capture Mode — unfiltered calibration issuance</span>
          {st?.armed && <LiveDot />}
        </div>
        <NeonBadge tone={st?.armed ? "amber" : "muted"} glow={!!st?.armed}>
          {st?.armed ? "ARMED — UNFILTERED" : "OFF — FILTERED"}
        </NeonBadge>
      </div>
      {!st ? (
        <div className="flex min-h-[120px] items-center justify-center font-terminal text-[10px] text-ink-3">LOADING CAPTURE STATE…</div>
      ) : (
        <div className="min-w-0">
          {/* doctrine line */}
          <p className="text-[11px] leading-relaxed text-ink-2">
            {st.armed
              ? "Unfiltered issuance is LIVE — every scan's best flow is recorded as a RAW-CAL signal (data capture + tracking + journaling to ENGINE MEMORY). Auto-cancels at the calibration bar."
              : "Filtered operation under central-intelligence command. Arm to issue unfiltered RAW-CAL records and accelerate the AI CALIBRATION bar."}
          </p>

          {/* progress toward 100 */}
          <div className="mt-3">
            <div className="flex items-center gap-2 font-terminal text-[10px]">
              <Scale className="size-3 text-amber-neon" aria-hidden />
              <span className="font-bold text-ink-2">AI CALIBRATION BAR</span>
              <span className="ml-auto tabular-nums text-ink">
                <b className="text-amber-neon">{st.settledN}</b>/{st.target} settled · {st.needed} to go
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/8">
              <div className="h-full rounded-full bg-gradient-to-r from-amber-neon/70 to-amber-neon" style={{ width: `${pct}%` }} />
            </div>
            {pace && (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-terminal text-[9px] text-ink-3">
                <span>
                  PIPELINE+BOOK ≈ <b className="text-ink">{pace.pipelineProjection}</b> (open EPOCH-2 will still settle)
                </span>
                {pace.meanSettleMin !== null && (
                  <span>
                    MEAN SETTLE <b className="text-ink">{pace.meanSettleMin}m</b>
                  </span>
                )}
              </div>
            )}
          </div>

          {/* stats grid */}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2">
              <div className="label-tech truncate text-ink-3">ISSUED</div>
              <div className="mt-0.5 font-terminal text-base font-bold tabular-nums text-amber-neon">{st.issuedTotal}</div>
              <div className="font-terminal text-[9px] text-ink-3">{st.settledRaw} settled · {st.winsRaw}✓{st.rawWinRatePct !== null ? ` · ${st.rawWinRatePct}%` : ""}</div>
            </div>
            <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2">
              <div className="label-tech truncate text-ink-3">OPEN</div>
              <div className="mt-0.5 font-terminal text-base font-bold tabular-nums text-ink">{st.openRaw}<span className="text-ink-3">/{st.maxOpen}</span></div>
              <div className="font-terminal text-[9px] text-ink-3">cap rail</div>
            </div>
            <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2">
              <div className="label-tech truncate text-ink-3">LAST</div>
              <div className="mt-0.5 font-terminal text-base font-bold tabular-nums text-ink">{st.lastIssueSerial ? `NX-${String(st.lastIssueSerial).padStart(4, "0")}` : "—"}</div>
              <div className="font-terminal text-[9px] text-ink-3">{ago(st.lastIssueAt)} ago</div>
            </div>
            <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2">
              <div className="label-tech truncate text-ink-3">SPACING</div>
              <div className="mt-0.5 font-terminal text-base font-bold tabular-nums text-ink">≥{st.spacingMin}m</div>
              <div className="font-terminal text-[9px] text-ink-3">anti-flood rail</div>
            </div>
          </div>

          {/* ── v9.2 PACE MONITOR ── */}
          {pace && (
            <div className="mt-3 rounded-lg border border-white/8 bg-white/[0.02] p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-terminal text-[10px] font-bold text-ink-2">
                  <Gauge className={cn("size-3", anyStall ? "text-danger-neon" : "text-mint-neon")} aria-hidden />
                  PACE MONITOR — issuance rhythm · book growth
                </div>
                <span
                  className={cn("rounded border px-1.5 py-0.5 font-terminal text-[9px] font-bold tracking-wider", GRADE_TONE[pace.cadenceGrade] ?? GRADE_TONE.OFF)}
                  title={`cadence grade ${pace.cadenceGrade} — A ≥3/h, B ≥1.5/h, C ≥0.5/h, D stalled`}
                >
                  CADENCE {pace.cadenceGrade}
                </span>
              </div>

              {/* pace tiles */}
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-md border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="label-tech truncate text-ink-3">ISSUE/H</div>
                  <div className="mt-0.5 font-terminal text-sm font-bold tabular-nums text-ink">{pace.issueRate3hPerH.toFixed(1)}</div>
                  <div className="font-terminal text-[9px] text-ink-3">3h · arm {pace.issueRateSinceArmPerH.toFixed(1)}/h</div>
                </div>
                <div className="rounded-md border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="label-tech truncate text-ink-3">SETTLE/H</div>
                  <div className="mt-0.5 font-terminal text-sm font-bold tabular-nums text-mint-neon">{pace.settleRate3hPerH.toFixed(1)}</div>
                  <div className="font-terminal text-[9px] text-ink-3">3h · 6h {pace.settleRate6hPerH.toFixed(1)}/h</div>
                </div>
                <div className="rounded-md border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="label-tech truncate text-ink-3">OBS. SPACING</div>
                  <div className="mt-0.5 font-terminal text-sm font-bold tabular-nums text-ink">
                    {pace.observedSpacingMin.mean !== null ? `${pace.observedSpacingMin.mean}m` : "—"}
                  </div>
                  <div className="font-terminal text-[9px] text-ink-3">{pace.observedSpacingMin.samples} gaps {pace.observedSpacingMin.min !== null ? `· ${pace.observedSpacingMin.min}–${pace.observedSpacingMin.max}m` : ""}</div>
                </div>
                <div className="rounded-md border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="label-tech truncate text-ink-3">ETA TO 100</div>
                  <div className="mt-0.5 font-terminal text-sm font-bold tabular-nums text-amber-neon">{pace.etaHours !== null ? `${pace.etaHours >= 100 ? "99+" : pace.etaHours.toFixed(1)}h` : "N/A"}</div>
                  <div className="font-terminal text-[9px] text-ink-3">
                    {pace.etaSteadyHours != null ? (
                      <span title="steady-state projection — raw cadence ∩ settle-throughput cap (open slots ÷ mean settle time)">
                        SS {pace.etaSteadyHours >= 100 ? "99+" : pace.etaSteadyHours.toFixed(1)}h @ {pace.steadyRatePerH ?? "—"}/h
                      </span>
                    ) : (
                      <span>{pace.etaAt ? `≈ ${etaClock(pace.etaAt)} local` : "no settle signal yet"}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* book-growth sparkline */}
              <div className="mt-2 rounded-md border border-white/8 bg-white/[0.02] px-2 pb-1.5 pt-2">
                <div className="flex items-center gap-1.5 font-terminal text-[9px] text-ink-3">
                  <TrendingUp className="size-3 text-amber-neon" aria-hidden />
                  EPOCH-2 BOOK GROWTH <span className="ml-auto">{pace.journalRows} snapshots · 10min cadence</span>
                </div>
                <GrowthSpark series={pace.sparkline} />
              </div>

              {/* stall / cadence line */}
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-terminal text-[9px]">
                {anyStall ? (
                  <>
                    <span className="rounded border border-danger-neon/40 bg-danger-neon/10 px-1.5 py-0.5 font-bold text-danger-neon">
                      {stallIssue ? `ISSUE STALL ${pace.stalls.issueStallMin}m` : ""}
                      {stallIssue && stallSettle ? " · " : ""}
                      {stallSettle ? `SETTLE STALL ${pace.stalls.settleStallMin}m` : ""}
                    </span>
                    <span className="text-ink-3">last block: {pace.stalls.lastBlockNote ?? "—"}</span>
                  </>
                ) : (
                  <span className={cn("inline-flex items-center gap-1 rounded border border-mint-neon/30 bg-mint-neon/5 px-1.5 py-0.5 font-bold text-mint-neon", st.armed && "animate-pulse")}>
                    <Activity className="size-2.5" aria-hidden />
                    {st.armed ? "CADENCE NOMINAL — rails holding" : "MODE OFF — filtered command"}
                  </span>
                )}
              </div>

              {/* milestone ledger */}
              {st.milestones && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-2">
                  <span className="label-tech text-ink-3">MILESTONES</span>
                  {st.milestones.steps.map((m) => {
                    const next = !m.fired && m.step === st.milestones!.steps.find((x) => !x.fired)?.step;
                    return (
                      <span
                        key={m.step}
                        title={m.fired ? `fired ${ago(m.at)} ago` : `pending — book at ${st.milestones?.settledE2 ?? "—"}`}
                        className={cn(
                          "rounded border px-1.5 py-0.5 font-terminal text-[9px] font-bold tabular-nums",
                          m.fired
                            ? "border-mint-neon/40 bg-mint-neon/10 text-mint-neon"
                            : next
                              ? "border-amber-neon/50 bg-amber-neon/10 text-amber-neon animate-pulse"
                              : "border-white/10 bg-white/[0.03] text-ink-3",
                        )}
                      >
                        {m.step}
                        {m.fired ? "✓" : ""}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* recent block notes (why issuance last paused) */}
              {st.blocks && st.blocks.length > 0 && (
                <div className="mt-2 max-h-16 overflow-y-auto border-t border-white/5 pt-1.5" title="recent issuance-block reasons">
                  {st.blocks.slice(-4).reverse().map((b, i) => (
                    <div key={`${b.t}-${i}`} className="flex items-baseline gap-2 font-terminal text-[8.5px] leading-relaxed text-ink-3">
                      <span className="shrink-0 tabular-nums text-ink-3/70">{ago(new Date(b.t).toISOString())} ago</span>
                      <span className="truncate">{b.note}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── v9.3 SAMPLE QUALITY LAB — R6 DATA HEALTH ── */}
          {st.quality && (
            <div className="mt-3 rounded-lg border border-white/8 bg-white/[0.02] p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-terminal text-[10px] font-bold text-ink-2">
                  <Microscope className={cn("size-3", st.quality.gate.verdict === "RED" ? "text-danger-neon" : st.quality.gate.verdict === "WARMING" ? "text-ink-3" : "text-mint-neon")} aria-hidden />
                  SAMPLE QUALITY — R6 DATA HEALTH
                </div>
                <span
                  className={cn("rounded border px-1.5 py-0.5 font-terminal text-[9px] font-bold tracking-wider", GATE_TONE[st.quality.gate.verdict] ?? GATE_TONE.WARMING)}
                  title={`R6 data-health gate — floor ${st.quality.gate.healthFloor}% healthy cohort`}
                >
                  GATE {st.quality.gate.verdict}
                </span>
              </div>
              <p className="mt-1 font-terminal text-[9px] leading-relaxed text-ink-3">
                cohort {st.quality.settledRaw} settled / {st.quality.issuedTotal} issued ({st.quality.openRaw} in flight) · {st.quality.healthy}✓ healthy · {st.quality.review}? review · {st.quality.censored}✗ censored
              </p>

              {/* health tiles — 2×2 (the terminal column is narrow; 4-up truncates) */}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="rounded-md border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="label-tech truncate text-ink-3">HEALTHY</div>
                  <div className={cn("mt-0.5 font-terminal text-sm font-bold tabular-nums", st.quality.healthyPct === null ? "text-ink-3" : st.quality.healthyPct >= st.quality.gate.healthFloor ? "text-mint-neon" : st.quality.healthyPct >= 70 ? "text-amber-neon" : "text-danger-neon")}>
                    {st.quality.healthyPct !== null ? `${st.quality.healthyPct}%` : "—"}
                  </div>
                  <div className="font-terminal text-[9px] text-ink-3">floor {st.quality.gate.healthFloor}%</div>
                </div>
                <div className="rounded-md border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="label-tech truncate text-ink-3">INFORMATIVE</div>
                  <div className="mt-0.5 font-terminal text-sm font-bold tabular-nums text-ink">{st.quality.informativePct !== null ? `${st.quality.informativePct}%` : "—"}</div>
                  <div className="font-terminal text-[9px] text-ink-3">TP/SL proved · {st.quality.expiredNoTouch} censored</div>
                </div>
                <div className="rounded-md border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="label-tech truncate text-ink-3">SNAPSHOTS</div>
                  <div className={cn("mt-0.5 font-terminal text-sm font-bold tabular-nums", st.quality.snapshotPct !== null && st.quality.snapshotPct < 80 ? "text-amber-neon" : "text-ink")}>{st.quality.snapshotPct !== null ? `${st.quality.snapshotPct}%` : "—"}</div>
                  <div className="font-terminal text-[9px] text-ink-3">factors+flow+MTF kept</div>
                </div>
                <div className="rounded-md border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="label-tech truncate text-ink-3">COVERAGE</div>
                  <div className="mt-0.5 font-terminal text-sm font-bold tabular-nums text-ink">
                    {st.quality.longPct !== null ? `${st.quality.longPct}L/${st.quality.shortPct}S` : "—"}
                  </div>
                  <div className="font-terminal text-[9px] text-ink-3">{st.quality.symbols} sym{st.quality.topSymbolShare !== null ? ` · top ${st.quality.topSymbolShare}%` : ""}</div>
                </div>
              </div>

              {/* warnings */}
              {st.quality.warnings.length > 0 && (
                <div className="mt-2 space-y-1">
                  {st.quality.warnings.slice(0, 3).map((w, i) => (
                    <div key={i} className="flex items-start gap-1.5 font-terminal text-[9px] leading-relaxed text-amber-neon/90">
                      <TriangleAlert className="mt-0.5 size-2.5 shrink-0" aria-hidden />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* per-sample table */}
              {st.quality.samples.length > 0 && (
                <div className="mt-2 max-h-44 overflow-y-auto rounded-md border border-white/8 bg-white/[0.02]" title="RAW-CAL samples — settled cohort first, then in-flight (score = integrity+plan+outcome+representativeness, 0-100)">
                  <table className="w-full border-collapse font-terminal text-[9px]">
                    <thead>
                      <tr className="border-b border-white/8 text-left text-ink-3">
                        <th className="px-2 py-1 font-medium">SAMPLE</th>
                        <th className="px-1 py-1 font-medium">SIDE</th>
                        <th className="px-1 py-1 font-medium">STATUS</th>
                        <th className="px-1 py-1 text-right font-medium">PNL</th>
                        <th className="px-1 py-1 text-right font-medium">HELD</th>
                        <th className="px-2 py-1 text-right font-medium">GRADE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {st.quality.samples.map((s) => (
                        <tr key={s.serial} className="border-b border-white/5 last:border-0 text-ink-2">
                          <td className="px-2 py-1">
                            <span className="font-bold text-ink">NX-{String(s.serial).padStart(4, "0")}</span>{" "}
                            <span className="text-ink-3">{s.symbol}</span>
                            {s.flags.length > 0 && <span className="ml-1 text-amber-neon/70" title={s.flags.join(" · ")}>⚑{s.flags.length}</span>}
                          </td>
                          <td className={cn("px-1 py-1 font-bold", s.direction === "LONG" ? "text-mint-neon" : "text-danger-neon")}>{s.direction === "LONG" ? "L" : "S"}</td>
                          <td className="px-1 py-1">{s.status}</td>
                          <td className={cn("px-1 py-1 text-right tabular-nums", s.pnlPercent > 0 ? "text-mint-neon" : s.pnlPercent < 0 ? "text-danger-neon" : "text-ink-3")}>
                            {s.settled ? `${s.pnlPercent > 0 ? "+" : ""}${s.pnlPercent}%` : "—"}
                          </td>
                          <td className="px-1 py-1 text-right tabular-nums text-ink-3">{s.holdMin !== null ? `${s.holdMin}m` : s.settled ? "—" : "open"}</td>
                          <td className="px-2 py-1 text-right">
                            <span className={cn("inline-block rounded border px-1 py-0.5 text-[8.5px] font-bold tabular-nums", CLS_TONE[s.cls])} title={`score ${s.score}/100 — HEALTHY ≥75, REVIEW ≥50, CENSORED <50`}>
                              {s.cls === "PENDING" ? "PEND" : s.score}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* gate footer */}
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-white/5 pt-1.5 font-terminal text-[9px] leading-relaxed">
                <ShieldCheck className={cn("size-2.5 shrink-0", st.quality.gate.verdict === "RED" ? "text-danger-neon" : "text-mint-neon")} aria-hidden />
                {st.quality.gate.verdict === "WARMING" ? (
                  <span className="text-ink-3">grading starts at the first raw settle — every settle re-scores the cohort</span>
                ) : st.quality.gate.blockers.length > 0 ? (
                  <span className="text-danger-neon/90">BLOCKERS: {st.quality.gate.blockers.join(" · ")}</span>
                ) : (
                  <span className="text-mint-neon/80">R6 recalibration may rest on this cohort — no blockers</span>
                )}
                {st.quality.meanAbsPnl !== null && <span className="ml-auto text-ink-3">mean |pnl| {st.quality.meanAbsPnl}% · mean hold {st.quality.meanHoldMin ?? "—"}m</span>}
              </div>
            </div>
          )}


          {/* arm/disarm control */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {st.armed ? (
              <button
                onClick={() => void act("disarm")}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-danger-neon/40 bg-danger-neon/10 px-3 py-2 font-terminal text-[10px] font-bold tracking-wider text-danger-neon transition hover:bg-danger-neon/20 disabled:opacity-50"
              >
                <Power className="size-3" aria-hidden />
                {busy ? "DISARMING…" : "DISARM — RETURN TO FILTERED"}
              </button>
            ) : (
              <button
                onClick={() => void act("arm")}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-neon/40 bg-amber-neon/10 px-3 py-2 font-terminal text-[10px] font-bold tracking-wider text-amber-neon transition hover:bg-amber-neon/20 disabled:opacity-50"
              >
                <FlaskConical className="size-3" aria-hidden />
                {busy ? "ARMING…" : "ARM — ISSUE UNFILTERED RAW-CAL"}
              </button>
            )}
            <span className="font-terminal text-[9px] leading-relaxed text-ink-3">
              {st.armed ? `ARMED ${ago(st.armedAt)} AGO BY ${st.armedBy || "OPERATOR"}` : st.autoLiftAt ? `AUTO-LIFTED ${ago(st.autoLiftAt)} AGO — NEW CALIBRATION IN COMMAND` : st.disarmReason ? `DISARMED: ${st.disarmReason.slice(0, 60)}` : "IDLE"}
            </span>
          </div>

          <p className="mt-2 font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-ink-3">
            HONESTY RAILS STAY HARD (FEED-FRESH + SIM-PRICE BAN) · RAW RECORDS KEEP REAL FACTOR VOTES SO THE R6 RECALIBRATION AT N≥100 ATTRIBUTES OUTCOMES TO ACTUAL FACTORS
          </p>
        </div>
      )}
    </BentoCard>
  );
}
