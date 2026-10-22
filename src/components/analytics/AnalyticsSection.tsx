"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { toPng } from "html-to-image";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, FileSpreadsheet, NotebookPen, Radar, ChevronRight, ImageDown, Loader2, MousePointerClick, Telescope, Trash2 } from "lucide-react";
import { usePulse, useNow } from "@/hooks/usePulse";
import { useUi } from "@/store/ui";
import { useAlerts } from "@/store/alerts";
import { BentoCard, NeonBadge, SectionHeader } from "@/components/shared/primitives";
import { StrategyDrillDialog } from "@/components/analytics/StrategyDrillDown";
import { TpDeepLabCard } from "@/components/analytics/TpDeepLabCard";
import { DurationLabCard } from "@/components/analytics/DurationLabCard";
import { PumpPerformanceCard } from "@/components/analytics/PumpPerformanceCard";
import { NetPnlLedgerCard } from "@/components/analytics/NetPnlLedgerCard";
import { fmtPct, fmtUsd, timeAgo } from "@/lib/format";
import { APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";
import {
  AMBER,
  AXIS_LINE_STROKE,
  AXIS_TICK,
  DANGER,
  EquityTooltip,
  GRID_STROKE,
  MUTED_LINE,
  NexusTooltip,
  useChartPalette,
  useNeon,
} from "./chart-theme";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/* ══ Local helpers ══════════════════════════════════════════ */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** "MM-DD" (equityCurve date key) → "JUN 01" */
function shortDate(raw: string): string {
  const m = /^(\d{2})-(\d{2})$/.exec(raw);
  if (m) {
    const idx = Number(m[1]) - 1;
    return `${MONTHS[idx] ?? "??"} ${m[2]}`;
  }
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return `${MONTHS[d.getMonth()] ?? "??"} ${String(d.getDate()).padStart(2, "0")}`;
  return raw;
}

function signedUsd(v: number): string {
  return `${v > 0 ? "+" : ""}${fmtUsd(v)}`;
}

/** heat zone color ramp — mirrors the RiskDesk gauge zones */
function heatColor(v: number): string {
  if (v < 35) return "#00ffa3";
  if (v < 62) return "#ffb347";
  if (v < 82) return "#ff7a45";
  return "#ff4d5e";
}

/** CSV cell quoting + spreadsheet formula-injection neutralization (=,+,-,@,tab prefixes) */
function q(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** trigger a client-side file download for a CSV string */
function downloadCsv(name: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Empty-state placeholder — preserves chart height, Radar sweep icon */
function EmptyChart({ height, label }: { height: number; label?: string }) {
  return (
    <div
      role="status"
      style={{ height }}
      className="flex flex-col items-center justify-center gap-2 text-ink-3"
    >
      <Radar className="anim-spin-slow h-6 w-6" strokeWidth={1.5} aria-hidden />
      <span className="font-terminal text-[10px] uppercase tracking-[0.22em]">
        {label ?? "AWAITING DATA — ENGINE CALIBRATING"}
      </span>
    </div>
  );
}

/** BentoCard + terminal title row + optional badge. framer-motion stagger via BentoCard delay. */
function ChartCard({
  title,
  badge,
  delay = 0,
  tone = "neon",
  corners = false,
  dotColor,
  className,
  children,
}: {
  title: string;
  badge?: ReactNode;
  delay?: number;
  tone?: "neon" | "violet" | "magenta";
  corners?: boolean;
  dotColor?: string;
  className?: string;
  children: ReactNode;
}) {
  const accentNeon = useNeon();
  const dot = dotColor ?? accentNeon;
  return (
    <BentoCard tone={tone} corners={corners} delay={delay} className={cn("min-w-0", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="anim-pulse-dot inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: dot, boxShadow: `0 0 8px ${dot}` }}
            aria-hidden
          />
          <h3 className="truncate font-terminal text-xs font-bold uppercase tracking-[0.2em] text-ink">{title}</h3>
        </div>
        {badge}
      </div>
      {children}
    </BentoCard>
  );
}

/** Tiny inline metric bar used in the strategy matrix */
function MiniBar({ value, color, label }: { value: number; color: string; label: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="flex min-w-[110px] items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full"
          style={{ width: `${clamped}%`, background: color, boxShadow: `0 0 8px ${color}66` }}
        />
      </div>
      <span className="w-10 text-right font-terminal text-[10px] text-ink-2">{label}</span>
    </div>
  );
}

const SKELETON_SPANS = [
  "h-[320px] md:col-span-2 xl:col-span-4",
  "h-[260px] md:col-span-2 xl:col-span-2",
  "h-[300px] md:col-span-2 xl:col-span-2",
  "h-[280px] xl:col-span-1",
  "h-[280px] xl:col-span-1",
  "h-[280px] md:col-span-2 xl:col-span-2",
  "h-[300px] md:col-span-2 xl:col-span-2",
  "h-[280px] md:col-span-2 xl:col-span-2",
  "h-[280px] md:col-span-2 xl:col-span-2",
  "h-[300px] md:col-span-2 xl:col-span-2",
  "h-[300px] md:col-span-2 xl:col-span-4",
];

function SkeletonGrid() {
  return (
    <div aria-hidden className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {SKELETON_SPANS.map((span, i) => (
        <div key={i} className={cn("bento min-w-0 animate-pulse", span)} />
      ))}
    </div>
  );
}

/* ══ Section ════════════════════════════════════════════════ */

export default function AnalyticsSection() {
  const { data } = usePulse();
  const NEON = useNeon(); // accent-following hex for Recharts/SVG props
  const palette = useChartPalette(); // full accent-aware series palette
  const stats = data?.stats;
  const signals = useMemo(() => data?.signals ?? [], [data]);
  const [drillStrategy, setDrillStrategy] = useState<string | null>(null);
  const setSpotlightSymbol = useUi((s) => s.setSpotlightSymbol);
  const setOpenSignal = useUi((s) => s.setOpenSignal);
  const now = useNow(30_000); // relative timestamps for journal entries
  const analyticsExportAt = useUi((s) => s.analyticsExportAt);
  const analyticsCsvAt = useUi((s) => s.analyticsCsvAt);
  const requestHandledRef = useRef(0);
  const csvHandledRef = useRef(0);

  /* ── session heat timeline (persisted store, sampled by the RiskDesk) ── */
  const heatTimeline = useAlerts((s) => s.heatTimeline);
  const clearHeatTimeline = useAlerts((s) => s.clearHeatTimeline);
  const heatData = useMemo(
    () =>
      heatTimeline.map((p) => ({
        t: p.t,
        v: Math.round(p.v * 10) / 10,
        label: new Date(p.t).toLocaleTimeString("en-GB", { hour12: false }),
      })),
    [heatTimeline],
  );
  const heatStats = useMemo(() => {
    if (heatData.length === 0) return null;
    const vs = heatData.map((p) => p.v);
    return {
      now: vs[vs.length - 1]!,
      lo: Math.min(...vs),
      hi: Math.max(...vs),
      avg: vs.reduce((a, b) => a + b, 0) / vs.length,
      count: vs.length,
    };
  }, [heatData]);

  /* ── PNG export (html-to-image, excludes the button itself) ── */
  const sectionRef = useRef<HTMLElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportPng = useCallback(async () => {
    const node = sectionRef.current;
    if (!node || exporting) return;
    setExporting(true);
    try {
      // settle fonts/charts before rasterizing
      if (document.fonts?.ready) await document.fonts.ready;
      const dataUrl = await toPng(node, {
        pixelRatio: 2,
        backgroundColor: "#05070a",
        filter: (n) => !(n instanceof HTMLElement && n.dataset?.exportIgnore === "true"),
      });
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
      const a = document.createElement("a");
      a.download = `flowradar-analytics-${stamp}.png`;
      a.href = dataUrl;
      a.click();
      toast.success("ANALYTICS EXPORTED", {
        description: "Performance intel saved as PNG snapshot.",
      });
    } catch {
      toast.error("EXPORT FAILED", {
        description: "Could not rasterize the section — try again.",
      });
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  /* ⌘K "Export analytics PNG" — palette flips the view + stamps a tick;
     react here once charts have mounted (450ms settle), then capture */
  useEffect(() => {
    if (!analyticsExportAt || analyticsExportAt === requestHandledRef.current) return;
    requestHandledRef.current = analyticsExportAt;
    const t = setTimeout(() => void exportPng(), 450);
    return () => clearTimeout(t);
  }, [analyticsExportAt, exportPng]);

  /* ── CSV export — full performance intel as sectioned spreadsheet ── */
  const exportAnalyticsCsv = useCallback(() => {
    if (!stats) return;
    const rows: string[] = [];
    const section = (title: string, header: string, body: Array<Array<string | number>>) => {
      rows.push("", `# ${title}`, header);
      for (const r of body) rows.push(r.map(q).join(","));
    };

    rows.push(`${APP_NAME} — ANALYTICS EXPORT`);
    rows.push(["GENERATED", new Date().toISOString()].map(q).join(","));
    rows.push(["WINDOW", "ROLLING 7D SNAPSHOT"].map(q).join(","));

    section("SUMMARY", "metric,value", [
      ["TOTAL SIGNALS", stats.totalSignals],
      ["ACTIVE", stats.activeCount],
      ["WINS", stats.wins],
      ["LOSSES", stats.losses],
      ["EXPIRED", stats.expired],
      ["WIN RATE %", stats.winRate.toFixed(2)],
      ["NET PNL USD", stats.totalPnlUsd.toFixed(2)],
      ["PNL 24H USD", stats.pnl24hUsd.toFixed(2)],
      ["AVG PNL %", stats.avgPnlPercent.toFixed(2)],
      ["AVG RISK REWARD", stats.avgRiskReward.toFixed(2)],
      ["AVG CONFIDENCE", stats.avgConfidence.toFixed(2)],
      ["PEAK EQUITY USD", stats.peakEquity.toFixed(2)],
      ["EQUITY USD", stats.account.equity.toFixed(2)],
      ["STREAK", `${stats.streak.type} x${stats.streak.count}`],
      ["LONG / SHORT", `${stats.byDirection.long} / ${stats.byDirection.short}`],
    ]);

    if (stats.equityCurve.length)
      section("EQUITY CURVE", "date,dailyPnlUsd,cumulativeUsd", stats.equityCurve.map((p) => [p.date, p.daily.toFixed(2), p.cum.toFixed(2)]));
    if (stats.bySymbol.length)
      section("SYMBOL LEADERBOARD", "symbol,deployed,wins,netPnlUsd", stats.bySymbol.map((s) => [s.symbol, s.count, s.wins, s.pnl.toFixed(2)]));
    if (stats.byTimeframe.length)
      section("TIMEFRAME EDGE", "timeframe,deployed,wins,netPnlUsd,winRatePct", stats.byTimeframe.map((t) => [t.timeframe, t.count, t.wins, t.pnl.toFixed(2), t.count ? ((t.wins / t.count) * 100).toFixed(1) : "0.0"]));
    if (stats.byStrategy.length)
      section("STRATEGY MATRIX", "strategy,deployed,wins,avgConfidence,netPnlUsd", stats.byStrategy.map((s) => [s.strategy, s.count, s.wins, s.avgConfidence.toFixed(1), s.pnl.toFixed(2)]));
    if (stats.confidenceBuckets.length)
      section("CONVICTION BUCKETS", "bucket,signals,wins,winRatePct", stats.confidenceBuckets.map((b) => [b.bucket, b.count, b.wins, b.winRate.toFixed(1)]));
    section(
      "TP FUNNEL (TP-PROVEN)",
      "level,count,ratePct",
      [
        ["TP1_HITS", stats.tpFunnel.tp1Hits, stats.tpFunnel.tp1Rate],
        ["TP2_HITS", stats.tpFunnel.tp2Hits, stats.tpFunnel.tp2Rate],
        ["FULL_TP3", stats.tpFunnel.tp3FullWins, stats.tpFunnel.fullTpRate],
        ["STOPPED_OUT", stats.tpFunnel.slLosses, ""],
        ["EXPIRED", stats.tpFunnel.expired, ""],
      ]
    );
    // v6.1 NET EST PNL LEDGER — bucketed EXPIRED/TP/STOP realized NET usd + v6.2 ACTUAL % ledger
    const ledgerTotals = stats.pnlLedger.totals;
    section("NET EST PNL LEDGER — TOTALS", "bucket,netUsd,trades", [
      ["TP_LADDER", ledgerTotals.tpUsd.toFixed(2), ledgerTotals.tpN],
      ["STOP", ledgerTotals.stopUsd.toFixed(2), ledgerTotals.stopN],
      ["EXPIRED", ledgerTotals.expiredUsd.toFixed(2), ledgerTotals.expiredN],
      ...(ledgerTotals.otherN ? [["OTHER", ledgerTotals.otherUsd.toFixed(2), ledgerTotals.otherN] as [string, string, number]] : []),
      ["NET_ALL", ledgerTotals.netUsd.toFixed(2), ledgerTotals.tpN + ledgerTotals.stopN + ledgerTotals.expiredN + ledgerTotals.otherN],
      ["TTL_EXTENSIONS_GRANTED", ledgerTotals.ttlExtended, ""],
      ["EXT_CAPTURED_USD", ledgerTotals.extCapturedUsd.toFixed(2), ""],
      ["EST_PNL_PCT_ACTUAL_SUM", ledgerTotals.estPnlPct.toFixed(1), ""],
      ["EST_PNL_PCT_AVG_PER_TRADE", ledgerTotals.avgPct.toFixed(1), ""],
    ]);
    for (const w of ["daily", "weekly", "monthly"] as const) {
      const rowsW = stats.pnlLedger[w];
      if (rowsW.length)
        section(`NET EST PNL LEDGER — ${w.toUpperCase()}`, "bucket,tpUsd,tpN,stopUsd,stopN,expiredUsd,expiredN,netUsd,estPnlPctActual,avgPctPerTrade", rowsW.map((r) => [r.key, r.tpUsd.toFixed(2), r.tpN, r.stopUsd.toFixed(2), r.stopN, r.expiredUsd.toFixed(2), r.expiredN, r.netUsd.toFixed(2), r.estPnlPct.toFixed(1), r.avgPct.toFixed(1)]));
    }
    const journalRows = signals
      .filter((s) => (s.operatorNotes ?? "").trim().length > 0)
      .sort((a, b) => (b.notesUpdatedAt ?? "").localeCompare(a.notesUpdatedAt ?? ""));
    if (journalRows.length)
      section(
        "OPERATOR LOG",
        "symbol,direction,status,updatedAt,notes",
        journalRows.map((s) => [
          s.symbol,
          s.direction,
          s.status,
          s.notesUpdatedAt ?? "",
          (s.operatorNotes ?? "").replace(/\r?\n/g, " ⏎ "),
        ])
      );
    if (heatTimeline.length)
      section("SESSION HEAT", "timestamp,heat", heatTimeline.map((p) => [new Date(p.t).toISOString(), p.v.toFixed(1)]));

    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    downloadCsv(`flowradar-analytics-${stamp}.csv`, rows.join("\n"));
    toast.success("ANALYTICS CSV EXPORTED", {
      description: `${rows.length} rows — summary, curves, leaderboards, journal & heat log.`,
    });
  }, [stats, heatTimeline, signals]);

  /* ⌘K "Export analytics CSV" — same settle-then-fire pattern as the PNG path */
  useEffect(() => {
    if (!analyticsCsvAt || analyticsCsvAt === csvHandledRef.current) return;
    csvHandledRef.current = analyticsCsvAt;
    const t = setTimeout(() => exportAnalyticsCsv(), 450);
    return () => clearTimeout(t);
  }, [analyticsCsvAt, exportAnalyticsCsv]);

  /* ⌘K "Open operator log" — scroll to the journal card + flash it (cyan ring pulse) */
  const operatorLogRef = useRef<HTMLDivElement | null>(null);
  const [logFlash, setLogFlash] = useState(false);
  const operatorLogJumpAt = useUi((s) => s.operatorLogJumpAt);
  const logHandledRef = useRef(0);
  useEffect(() => {
    if (!operatorLogJumpAt || operatorLogJumpAt === logHandledRef.current) return;
    logHandledRef.current = operatorLogJumpAt;
    operatorLogRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setLogFlash(true);
    const t = setTimeout(() => setLogFlash(false), 2400);
    return () => clearTimeout(t);
  }, [operatorLogJumpAt]);

  const equity = useMemo(
    () => (stats?.equityCurve ?? []).map((p) => ({ ...p, label: shortDate(p.date) })),
    [stats],
  );
  const tfData = useMemo(
    () =>
      (stats?.byTimeframe ?? []).map((t) => ({
        ...t,
        winRate: t.count ? Math.round((t.wins / t.count) * 100) : 0,
      })),
    [stats],
  );
  /** worst-first so rank #1 renders at the TOP of the horizontal chart */
  const symTop = useMemo(
    () => [...(stats?.bySymbol ?? [])].sort((a, b) => a.pnl - b.pnl).slice(-6),
    [stats],
  );

  /** resolved-trade PnL% histogram — computed client-side from the signal snapshot */
  const pnlHisto = useMemo(() => {
    const RESOLVED = new Set(["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"]);
    const buckets = [
      { label: "≤-100", min: -Infinity, max: -100, neg: true },
      { label: "-100/-50", min: -100, max: -50, neg: true },
      { label: "-50/-25", min: -50, max: -25, neg: true },
      { label: "-25/0", min: -25, max: 0, neg: true },
      { label: "0/25", min: 0, max: 25, neg: false },
      { label: "25/50", min: 25, max: 50, neg: false },
      { label: "50/100", min: 50, max: 100, neg: false },
      { label: ">100", min: 100, max: Infinity, neg: false },
    ];
    const resolved = signals.filter((s) => RESOLVED.has(s.status));
    const out = buckets.map((b) => ({
      label: b.label,
      neg: b.neg,
      count: resolved.filter((s) => s.pnlPercent > b.min && s.pnlPercent <= b.max).length,
    }));
    // exact-zero pnl slips through (p > min && p <= max); snap it into 0/25
    const zeroCount = resolved.filter((s) => s.pnlPercent === 0).length;
    if (zeroCount) out[4].count += zeroCount;
    return out;
  }, [signals]);
  const histoTotal = pnlHisto.reduce((acc, b) => acc + b.count, 0);

  /* ── operator journal intel — computed from the live signal pool ── */
  const journal = useMemo(() => {
    const RESOLVED = new Set(["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"]);
    const journaled = signals.filter((s) => (s.operatorNotes ?? "").trim().length > 0);
    const bySymbol = new Map<string, number>();
    for (const s of journaled) bySymbol.set(s.symbol, (bySymbol.get(s.symbol) ?? 0) + 1);
    const topSymbols = [...bySymbol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const recent = [...journaled]
      .filter((s) => s.notesUpdatedAt)
      .sort((a, b) => (b.notesUpdatedAt ?? "").localeCompare(a.notesUpdatedAt ?? ""))
      .slice(0, 3);
    const totalChars = journaled.reduce((acc, s) => acc + s.operatorNotes.trim().length, 0);
    const resolvedJournaled = journaled.filter((s) => RESOLVED.has(s.status)).length;
    return {
      count: journaled.length,
      coverage: signals.length ? (journaled.length / signals.length) * 100 : 0,
      topSymbols,
      recent,
      avgLen: journaled.length ? totalChars / journaled.length : 0,
      resolvedJournaled,
    };
  }, [signals]);

  if (!stats) {
    return (
      <section id="analytics" aria-label="Performance intelligence" className="mx-auto w-full max-w-[1400px] px-4 py-10 sm:px-6 lg:px-8">
        <SectionHeader
          index="03"
          title="PERFORMANCE INTELLIGENCE"
          subtitle="Engine PnL distribution, accuracy & regime breakdown — rolling 7 days"
        />
        <SkeletonGrid />
      </section>
    );
  }

  const latest = equity.length ? equity[equity.length - 1] : undefined;
  // TASK-40: the WIN/LOSS SPLIT card now headlines the ALL-TIME TP-proven
  // split (stats.allTimeSplit) — the old pie fed on the rolling 7-day window
  // (stats.wins/losses/expired), so its counts shrank hourly as rows aged out
  // of the window and the shrinkage read like data loss. All-time is
  // monotonic: it only ever grows. The 7d window stays visible as context.
  const closedTotal = stats.allTimeSplit.settled;
  const outcome = [
    { name: "WINS", value: stats.allTimeSplit.wins, color: NEON },
    { name: "LOSSES", value: stats.allTimeSplit.losses, color: DANGER },
    { name: "EXPIRED", value: stats.allTimeSplit.expired, color: AMBER },
  ].filter((d) => d.value > 0);

  const dirLong = stats.byDirection.long;
  const dirShort = stats.byDirection.short;
  const dirTotal = dirLong + dirShort;
  const dirMax = Math.max(dirLong, dirShort, 1);
  const dirData = [
    { name: "LONG", value: dirLong, fill: NEON },
    { name: "SHORT", value: dirShort, fill: palette.opposing },
  ];
  const bestSymbol = stats.bySymbol[0];

  return (
    <section
      id="analytics"
      ref={sectionRef}
      aria-label="Performance intelligence"
      className="mx-auto w-full max-w-[1400px] px-4 py-10 sm:px-6 lg:px-8"
    >
      <SectionHeader
        index="03"
        title="PERFORMANCE INTELLIGENCE"
        subtitle="Engine PnL distribution, accuracy & regime breakdown — rolling 7 days"
        right={
          <div className="flex items-center gap-2">
            <NeonBadge tone={stats.totalPnlUsd >= 0 ? "neon" : "danger"} glow>
              {signedUsd(stats.totalPnlUsd)} NET · 7D
            </NeonBadge>
            <button
              type="button"
              data-export-ignore="true"
              onClick={exportAnalyticsCsv}
              aria-label="Export analytics as CSV spreadsheet"
              className="inline-flex h-11 items-center gap-1.5 rounded-md border border-[rgba(69,240,223,0.35)] bg-[rgba(69,240,223,0.05)] px-3 font-terminal text-[10px] font-bold tracking-[0.16em] text-cyan-neon transition-all hover:bg-[rgba(69,240,223,0.13)] hover:shadow-[0_0_14px_rgba(69,240,223,0.35)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(69,240,223,0.6)] sm:h-8 sm:px-2.5"
            >
              <FileSpreadsheet className="h-3 w-3" aria-hidden />
              CSV
            </button>
            <button
              type="button"
              data-export-ignore="true"
              onClick={exportPng}
              disabled={exporting}
              aria-label="Export analytics as PNG image"
              className="inline-flex h-11 items-center gap-1.5 rounded-md border border-[rgb(var(--neon-rgb)/0.35)] bg-[rgb(var(--neon-rgb)/0.06)] px-3 font-terminal text-[10px] font-bold tracking-[0.16em] text-neon transition-all hover:bg-[rgb(var(--neon-rgb)/0.14)] hover:shadow-[0_0_14px_rgb(var(--neon-rgb)/0.3)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--neon-rgb)/0.6)] disabled:cursor-wait disabled:opacity-50 sm:h-8 sm:px-2.5"
            >
              {exporting ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <ImageDown className="h-3 w-3" aria-hidden />}
              {exporting ? "RENDERING" : "PNG"}
            </button>
          </div>
        }
      />

      <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* ── A · EQUITY CURVE ─────────────────────────────── */}
        <ChartCard
          title="EQUITY CURVE"
          corners
          delay={0}
          className="md:col-span-2 xl:col-span-4"
          badge={
            <div className="flex items-center gap-2">
              <NeonBadge tone={(latest?.cum ?? 0) >= 0 ? "neon" : "danger"} glow>
                {signedUsd(latest?.cum ?? 0)} CUM
              </NeonBadge>
              <NeonBadge tone="muted" className="hidden sm:inline-flex">
                PEAK {fmtUsd(stats.peakEquity)}
              </NeonBadge>
            </div>
          }
        >
          {equity.length === 0 ? (
            <EmptyChart height={260} />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={equity} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="nexus-equity-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={NEON} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={NEON} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 5" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: AXIS_LINE_STROKE }}
                  tickMargin={8}
                  minTickGap={24}
                />
                <YAxis
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: AXIS_LINE_STROKE }}
                  width={58}
                  tickFormatter={(v: number) => fmtUsd(v)}
                />
                <Tooltip
                  content={<EquityTooltip />}
                  cursor={{
                    stroke: NEON,
                    strokeWidth: 1,
                    strokeDasharray: "4 4",
                    strokeOpacity: 0.55,
                    style: { filter: `drop-shadow(0 0 5px ${NEON}aa)` },
                  }}
                  position={{ y: 8 }}
                />
                <ReferenceLine y={0} stroke={MUTED_LINE} strokeDasharray="4 4" />
                <Area
                  type="monotone"
                  dataKey="cum"
                  name="EQUITY"
                  stroke={NEON}
                  strokeWidth={2}
                  fill="url(#nexus-equity-fill)"
                  dot={false}
                  activeDot={{
                    r: 5,
                    fill: NEON,
                    stroke: "#05070a",
                    strokeWidth: 2,
                    style: { filter: "drop-shadow(0 0 6px rgb(var(--neon-rgb)/0.9))" },
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* ── B · DAILY PNL ────────────────────────────────── */}
        <ChartCard
          title="DAILY PNL"
          delay={0.05}
          className="md:col-span-2 xl:col-span-2"
          badge={<NeonBadge tone="muted">{equity.length} SESSIONS</NeonBadge>}
        >
          {equity.length === 0 ? (
            <EmptyChart height={200} />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={equity} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 5" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: AXIS_LINE_STROKE }}
                  tickMargin={8}
                  minTickGap={16}
                />
                <YAxis
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={54}
                  tickFormatter={(v: number) => fmtUsd(v)}
                />
                <Tooltip content={<NexusTooltip prefix="$" />} cursor={{ fill: "rgb(var(--neon-rgb)/0.05)" }} />
                <ReferenceLine y={0} stroke={MUTED_LINE} />
                <Bar dataKey="daily" name="PNL" radius={[3, 3, 0, 0]}>
                  {equity.map((p) => (
                    <Cell key={p.date} fill={p.daily >= 0 ? NEON : DANGER} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* ── B2 · NET EST PNL LEDGER — expired/TP/stop net realized, daily/weekly/monthly ── */}
        <ChartCard
          title="NET EST PNL LEDGER"
          tone="violet"
          dotColor="#ffb347"
          delay={0.06}
          className="md:col-span-2 xl:col-span-2"
          badge={
            <NeonBadge tone={stats.pnlLedger.totals.netUsd >= 0 ? "neon" : "danger"} glow>
              NET {stats.pnlLedger.totals.netUsd >= 0 ? "+" : ""}${stats.pnlLedger.totals.netUsd.toFixed(2)}
            </NeonBadge>
          }
        >
          <NetPnlLedgerCard ledger={stats.pnlLedger} afterlife={stats.afterlife} />
        </ChartCard>

        {/* ── C · WIN / LOSS SPLIT (TP-proven accounting, ALL-TIME) ── */}
        <ChartCard
          title="WIN / LOSS SPLIT"
          delay={0.1}
          className="xl:col-span-1"
          badge={
            <NeonBadge tone={stats.allTimeSplit.winRate >= 50 ? "neon" : "danger"} glow>
              ALL-TIME {fmtPct(stats.allTimeSplit.winRate, false)}
            </NeonBadge>
          }
        >
          {closedTotal === 0 ? (
            <EmptyChart height={200} />
          ) : (
            <>
              <div className="relative">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Tooltip content={<NexusTooltip />} />
                    <Pie
                      data={outcome}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={55}
                      outerRadius={80}
                      paddingAngle={3}
                      cornerRadius={4}
                      stroke="none"
                    >
                      {outcome.map((d) => (
                        <Cell key={d.name} fill={d.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="neon-text font-terminal text-xl font-bold text-neon tabular-nums">
                    {fmtPct(stats.allTimeSplit.winRate, false)}
                  </span>
                  <span className="label-tech mt-0.5">ALL-TIME WIN RATE</span>
                </div>
              </div>
              <div className="mt-3 space-y-1">
                {outcome.map((d) => (
                  <div key={d.name} className="flex items-center justify-between gap-2 font-terminal text-[11px]">
                    <span className="flex items-center gap-1.5 text-ink-2">
                      <span
                        className="inline-block h-2 w-2 rounded-sm"
                        style={{ background: d.color, boxShadow: `0 0 6px ${d.color}80` }}
                        aria-hidden
                      />
                      {d.name}
                    </span>
                    <span className="font-bold text-ink tabular-nums">{d.value}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-ink-3">
                TP-PROVEN: EVERY TP1/TP2/TP3 TOUCH COUNTS AS A WIN — EVEN IF THE TRADE LATER STOPS OUT AT BREAKEVEN OR EXPIRES
              </p>
              <p className="mt-1 font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-ink-3">
                ALL-TIME LEDGER IS MONOTONIC · 7D WINDOW CONTEXT: {stats.winRate}% WR · {stats.wins}W/{stats.losses}L/{stats.expired}E
              </p>
            </>
          )}
        </ChartCard>

        {/* ── C2 · TP DEPTH × DEEP-LEARN — ladder funnel + AI research desk ── */}
        <ChartCard
          title="TP DEPTH × DEEP-LEARN"
          tone="violet"
          dotColor="#45f0df"
          delay={0.12}
          className="md:col-span-2 xl:col-span-2"
          badge={
            <NeonBadge tone="violet">
              LADDER {stats.tpFunnel.tp1Hits}→{stats.tpFunnel.tp2Hits}→{stats.tpFunnel.tp3FullWins}
            </NeonBadge>
          }
        >
          <TpDeepLabCard funnel={stats.tpFunnel} />
        </ChartCard>

        {/* ── D · DIRECTION BIAS ───────────────────────────── */}
        <ChartCard
          title="DIRECTION BIAS"
          tone="magenta"
          dotColor={palette.opposing}
          delay={0.15}
          className="xl:col-span-1"
          badge={
            <NeonBadge tone={dirLong >= dirShort ? "neon" : "magenta"}>
              {dirLong >= dirShort ? "LONG-LEAN" : "SHORT-LEAN"}
            </NeonBadge>
          }
        >
          {dirTotal === 0 ? (
            <EmptyChart height={200} />
          ) : (
            <>
              <div className="relative">
                <ResponsiveContainer width="100%" height={200}>
                  <RadialBarChart data={dirData} innerRadius="42%" outerRadius="100%" startAngle={90} endAngle={-270}>
                    <PolarAngleAxis type="number" domain={[0, dirMax]} tick={false} axisLine={false} />
                    <RadialBar background={{ fill: "rgba(159,180,171,0.08)" }} dataKey="value" cornerRadius={4} />
                    <Tooltip content={<NexusTooltip />} cursor={false} />
                  </RadialBarChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="font-terminal text-xl font-bold text-ink tabular-nums">{dirTotal}</span>
                  <span className="label-tech mt-0.5">SIGNALS</span>
                </div>
              </div>
              <div className="mt-3 space-y-1">
                {dirData.map((d) => (
                  <div key={d.name} className="flex items-center justify-between gap-2 font-terminal text-[11px]">
                    <span className="flex items-center gap-1.5 font-bold" style={{ color: d.fill }}>
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: d.fill, boxShadow: `0 0 6px ${d.fill}` }}
                        aria-hidden
                      />
                      {d.name}
                    </span>
                    <span className="text-ink-2 tabular-nums">
                      <span className="font-bold text-ink">{d.value}</span>
                      {" · "}
                      {Math.round((d.value / dirTotal) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </ChartCard>

        {/* ── E · TIMEFRAME EDGE ───────────────────────────── */}
        <ChartCard
          title="TIMEFRAME EDGE"
          delay={0.2}
          className="md:col-span-2 xl:col-span-2"
          badge={<NeonBadge tone="cyan">{tfData.length} REGIMES</NeonBadge>}
        >
          {tfData.length === 0 ? (
            <EmptyChart height={200} />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={tfData} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 5" vertical={false} />
                <XAxis
                  dataKey="timeframe"
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: AXIS_LINE_STROKE }}
                  tickMargin={8}
                />
                <YAxis
                  yAxisId="count"
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                  allowDecimals={false}
                />
                <YAxis
                  yAxisId="rate"
                  orientation="right"
                  domain={[0, 100]}
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={38}
                  tickFormatter={(v: number) => `${Math.round(v)}%`}
                />
                <Tooltip content={<NexusTooltip units={{ winRate: "%" }} />} cursor={{ fill: "rgba(69,240,223,0.05)" }} />
                <Bar
                  yAxisId="count"
                  dataKey="count"
                  name="SIGNALS"
                  fill={palette.quaternary}
                  fillOpacity={0.8}
                  radius={[3, 3, 0, 0]}
                  barSize={28}
                />
                <Line
                  yAxisId="rate"
                  dataKey="winRate"
                  name="WIN RATE"
                  stroke={NEON}
                  strokeWidth={2}
                  dot={{ r: 3, fill: NEON, strokeWidth: 0 }}
                  activeDot={{ r: 5, stroke: "#05070a", strokeWidth: 2 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* ── F · SYMBOL LEADERBOARD ───────────────────────── */}
        <ChartCard
          title="SYMBOL LEADERBOARD"
          delay={0.25}
          className="md:col-span-2 xl:col-span-2"
          badge={
            <NeonBadge tone={bestSymbol && bestSymbol.pnl >= 0 ? "neon" : "danger"}>
              {bestSymbol ? `TOP ${bestSymbol.symbol}` : "NO DATA"}
            </NeonBadge>
          }
        >
          {symTop.length === 0 ? (
            <EmptyChart height={220} />
          ) : (
            <>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={symTop} layout="vertical" margin={{ top: 4, right: 14, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 5" horizontal={false} />
                <XAxis
                  type="number"
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: AXIS_LINE_STROKE }}
                  tickMargin={6}
                  tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? fmtUsd(v) : `$${Math.round(v)}`)}
                />
                <YAxis
                  type="category"
                  dataKey="symbol"
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: AXIS_LINE_STROKE }}
                  width={62}
                />
                <Tooltip content={<NexusTooltip prefix="$" />} cursor={{ fill: "rgb(var(--neon-rgb)/0.04)" }} />
                <ReferenceLine x={0} stroke={MUTED_LINE} />
                <Bar
                  dataKey="pnl"
                  name="NET PNL"
                  radius={[0, 3, 3, 0]}
                  barSize={16}
                  style={{ cursor: "pointer" }}
                  onClick={(entry: unknown) => {
                    const sym = (entry as { payload?: { symbol?: string } } | undefined)?.payload?.symbol;
                    if (sym) setSpotlightSymbol(sym);
                  }}
                >
                  {symTop.map((s) => (
                    <Cell key={s.symbol} fill={s.pnl >= 0 ? NEON : DANGER} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {/* spotlight launcher chips — tap for the market drill-down */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="label-tech inline-flex items-center gap-1 text-ink-3">
                <Telescope size={10} className="text-neon" aria-hidden /> SPOTLIGHT
              </span>
              {[...symTop].reverse().map((s) => (
                <button
                  key={s.symbol}
                  type="button"
                  onClick={() => setSpotlightSymbol(s.symbol)}
                  aria-label={`Open ${s.symbol} spotlight`}
                  className="glass-soft group inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-terminal text-[9px] font-bold tracking-[0.12em] text-ink transition-all hover:border-[rgb(var(--neon-rgb)/0.4)] hover:bg-[rgb(var(--neon-rgb)/0.08)] hover:shadow-[0_0_12px_rgb(var(--neon-rgb)/0.2)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--neon-rgb)/0.6)]"
                >
                  {s.symbol.replace(/USDT$/, "")}
                  <span className={cn("tabular-nums", s.pnl >= 0 ? "text-neon" : "text-danger-neon")}>
                    {s.pnl >= 0 ? "+" : ""}{Math.round(s.pnl)}
                  </span>
                </button>
              ))}
            </div>
            </>
          )}
        </ChartCard>

        {/* ── G · CONVICTION ACCURACY ──────────────────────── */}
        <ChartCard
          title="CONVICTION ACCURACY"
          tone="violet"
          dotColor={palette.secondary}
          delay={0.3}
          className="md:col-span-2 xl:col-span-2"
          badge={<NeonBadge tone="violet">BUCKETS 60→95</NeonBadge>}
        >
          {stats.confidenceBuckets.length === 0 ? (
            <EmptyChart height={200} />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={stats.confidenceBuckets} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 5" vertical={false} />
                  <XAxis
                    dataKey="bucket"
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={{ stroke: AXIS_LINE_STROKE }}
                    tickMargin={8}
                  />
                  <YAxis
                    yAxisId="count"
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={32}
                    allowDecimals={false}
                  />
                  <YAxis
                    yAxisId="rate"
                    orientation="right"
                    domain={[0, 100]}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={38}
                    tickFormatter={(v: number) => `${Math.round(v)}%`}
                  />
                  <Tooltip
                    content={<NexusTooltip units={{ winRate: "%" }} />}
                    cursor={{ fill: "rgba(178,107,255,0.06)" }}
                  />
                  <Bar
                    yAxisId="count"
                    dataKey="count"
                    name="SIGNALS"
                    fill={palette.secondary}
                    fillOpacity={0.85}
                    radius={[3, 3, 0, 0]}
                    barSize={34}
                  />
                  <Line
                    yAxisId="rate"
                    dataKey="winRate"
                    name="WIN RATE"
                    stroke={palette.tertiary}
                    strokeWidth={2}
                    dot={{ r: 3, fill: palette.tertiary, strokeWidth: 0 }}
                    activeDot={{ r: 5, stroke: "#05070a", strokeWidth: 2 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
              <p className="mt-2 font-terminal text-[10px] tracking-wide text-ink-3">
                HIGHER ENGINE CONVICTION → HIGHER REALIZED WIN RATE (SIMULATED)
              </p>
            </>
          )}
        </ChartCard>

        {/* ── G2 · PNL DISTRIBUTION ─────────────────────── */}
        <ChartCard
          title="PNL DISTRIBUTION"
          delay={0.32}
          className="md:col-span-2 xl:col-span-2"
          badge={
            <NeonBadge tone={stats.totalPnlUsd >= 0 ? "neon" : "danger"}>
              {histoTotal} TRADES
            </NeonBadge>
          }
        >
          {histoTotal === 0 ? (
            <EmptyChart height={200} />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={pnlHisto} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 5" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ ...AXIS_TICK, fontSize: 9 }}
                    tickLine={false}
                    axisLine={{ stroke: AXIS_LINE_STROKE }}
                    tickMargin={6}
                    interval={0}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={28}
                    allowDecimals={false}
                  />
                  <Tooltip
                    content={
                      <NexusTooltip
                        units={{ count: " trades" }}
                      />
                    }
                    cursor={{ fill: "rgb(var(--neon-rgb)/0.05)" }}
                  />
                  <ReferenceLine y={0} stroke={MUTED_LINE} />
                  <Bar dataKey="count" name="TRADES" radius={[3, 3, 0, 0]} barSize={26}>
                    {pnlHisto.map((b) => (
                      <Cell
                        key={b.label}
                        fill={b.neg ? DANGER : NEON}
                        fillOpacity={0.85}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <p className="mt-2 font-terminal text-[10px] tracking-wide text-ink-3">
                RESOLVED TRADE PNL% PER LEVERAGED BUCKET — LEVERAGE AMPLIFIES BOTH TAILS
              </p>
            </>
          )}
        </ChartCard>

        {/* ── G2b · OPERATOR LOG — journal intel & recent entries ─────── */}
        <div
          id="operator-log"
          ref={operatorLogRef}
          className={cn("scroll-mt-28 rounded-xl md:col-span-2 xl:col-span-2", logFlash && "operator-log-flash")}
        >
        <ChartCard
          title="OPERATOR LOG"
          dotColor="#45f0df"
          delay={0.33}
          badge={
            <NeonBadge tone="cyan">
              {journal.count} JOURNALED · {Math.round(journal.coverage)}%
            </NeonBadge>
          }
        >
          {journal.count === 0 ? (
            <EmptyChart height={200} label="NO JOURNAL ENTRIES YET — WRITE ONE FROM ANY SIGNAL DETAIL" />
          ) : (
            <div className="space-y-3">
              {/* stat chips */}
              <div className="grid max-w-[640px] grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    { label: "ENTRIES", v: String(journal.count) },
                    { label: "COVERAGE", v: `${journal.coverage.toFixed(0)}%` },
                    { label: "AVG LEN", v: `${Math.round(journal.avgLen)}c` },
                    { label: "RESOLVED", v: String(journal.resolvedJournaled) },
                  ] as const
                ).map((chip) => (
                  <div key={chip.label} className="glass-soft rounded-lg px-2 py-1.5 text-center">
                    <div className="font-terminal text-[13px] font-bold tabular-nums text-cyan-neon" style={{ textShadow: "0 0 10px rgba(69,240,223,0.27)" }}>
                      {chip.v}
                    </div>
                    <div className="label-tech mt-0.5 text-[8px]">{chip.label}</div>
                  </div>
                ))}
              </div>

              {/* most-journaled symbols — mini bars, tap for spotlight */}
              {journal.topSymbols.length > 0 && (
                <div>
                  <div className="label-tech mb-1.5">MOST-JOURNALED SYMBOLS</div>
                  <div className="space-y-1.5">
                    {journal.topSymbols.map(([sym, n]) => {
                      const max = journal.topSymbols[0][1] ?? 1;
                      return (
                        <button
                          key={sym}
                          type="button"
                          onClick={() => setSpotlightSymbol(sym)}
                          aria-label={`Open ${sym} spotlight — ${n} journal entries`}
                          className="group flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--neon-rgb)/0.5)]"
                        >
                          <span className="w-16 shrink-0 font-terminal text-[10px] font-bold tracking-[0.08em] text-ink-2 transition-colors group-hover:text-neon">
                            {sym.replace(/USDT$/, "")}
                          </span>
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                            <span
                              className="block h-full rounded-full transition-all"
                              style={{
                                width: `${(n / max) * 100}%`,
                                background: "#45f0df",
                                boxShadow: "0 0 8px rgba(69,240,223,0.45)",
                              }}
                            />
                          </span>
                          <span className="w-6 shrink-0 text-right font-terminal text-[10px] font-bold tabular-nums text-cyan-neon">
                            {n}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* recent entries — tap to open the deployment */}
              {journal.recent.length > 0 && (
                <div>
                  <div className="label-tech mb-1.5">RECENT ENTRIES</div>
                  <div className="space-y-1">
                    {journal.recent.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setOpenSignal(s.id)}
                        aria-label={`Open ${s.symbol} ${s.direction} signal detail — journaled ${timeAgo(s.notesUpdatedAt!, now || Date.now())}`}
                        title="Open signal detail"
                        className="group flex w-full items-start gap-2 rounded-md border border-transparent px-1.5 py-1.5 text-left transition-all hover:border-[rgba(69,240,223,0.25)] hover:bg-[rgba(69,240,223,0.05)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--neon-rgb)/0.5)]"
                      >
                        <span className="shrink-0 rounded border border-[rgba(69,240,223,0.3)] px-1 font-terminal text-[9px] font-bold leading-5 tracking-[0.08em] text-cyan-neon">
                          {s.symbol.replace(/USDT$/, "")}
                        </span>
                        <span className="line-clamp-1 min-w-0 flex-1 font-terminal text-[10px] leading-5 tracking-[0.02em] text-ink-2 transition-colors group-hover:text-ink">
                          {s.operatorNotes.trim().replace(/\s+/g, " ").slice(0, 110)}
                          {s.operatorNotes.trim().length > 110 ? "…" : ""}
                        </span>
                        <span className="ml-auto inline-flex shrink-0 items-center gap-1 font-terminal text-[9px] tabular-nums text-ink-3">
                          {now ? timeAgo(s.notesUpdatedAt!, now).toUpperCase() : "—"}
                          <MousePointerClick
                            size={10}
                            aria-hidden
                            className="opacity-0 transition-opacity group-hover:text-cyan-neon group-hover:opacity-100"
                          />
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <p className="flex items-center gap-1.5 font-terminal text-[9px] tracking-[0.12em] text-ink-3">
                <NotebookPen size={9} className="text-cyan-neon" aria-hidden />
                JOURNALS PERSIST IN THE ENGINE RECORD — WRITE FROM ANY SIGNAL DETAIL DIALOG
              </p>
            </div>
          )}
        </ChartCard>
        </div>

        {/* ── G3 · SESSION HEAT — long-lived operator heat log ─────── */}
        <ChartCard
          title="SESSION HEAT"
          dotColor="#ffb347"
          delay={0.34}
          className="md:col-span-2 xl:col-span-4"
          badge={
            <div className="flex items-center gap-1.5" data-export-ignore="true">
              <NeonBadge tone="amber">{heatStats ? `${heatStats.count} SAMPLES` : "SAMPLING"}</NeonBadge>
              {heatStats && (
                <button
                  type="button"
                  data-export-ignore="true"
                  onClick={() => {
                    clearHeatTimeline();
                    toast.success("HEAT LOG CLEARED", { description: "Session heat log reset — resampling from now." });
                  }}
                  aria-label="Clear session heat log"
                  title="Clear session heat log"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-ink-3 transition-all hover:border-[rgba(255,77,94,0.4)] hover:bg-[rgba(255,77,94,0.08)] hover:text-danger-neon focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(255,77,94,0.5)]"
                >
                  <Trash2 size={11} aria-hidden />
                </button>
              )}
            </div>
          }
        >
          {!heatStats ? (
            <EmptyChart height={200} label="SAMPLING PORTFOLIO HEAT — TREND FORMS IN ~1-2 MIN" />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={heatData} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="nexus-heat-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ffb347" stopOpacity={0.32} />
                      <stop offset="100%" stopColor="#ffb347" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 5" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ ...AXIS_TICK, fontSize: 9 }}
                    tickLine={false}
                    axisLine={{ stroke: AXIS_LINE_STROKE }}
                    tickMargin={8}
                    minTickGap={42}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ ...AXIS_TICK, fontSize: 9 }}
                    tickLine={false}
                    axisLine={false}
                    width={30}
                    tickFormatter={(v: number) => `${Math.round(v)}`}
                  />
                  <Tooltip
                    content={<NexusTooltip units={{ v: " heat" }} />}
                    cursor={{ stroke: "rgba(255,179,71,0.35)", strokeWidth: 1, strokeDasharray: "4 4" }}
                  />
                  {/* WARM / HOT zone thresholds — mirrors the RiskDesk gauge */}
                  <ReferenceLine y={35} stroke="rgba(255,179,71,0.3)" strokeDasharray="3 5" />
                  <ReferenceLine y={62} stroke="rgba(255,122,69,0.32)" strokeDasharray="3 5" />
                  <Area
                    type="monotone"
                    dataKey="v"
                    name="HEAT"
                    stroke="#ffb347"
                    strokeWidth={2}
                    fill="url(#nexus-heat-fill)"
                    dot={false}
                    activeDot={{
                      r: 5,
                      fill: heatColor(heatStats.now),
                      stroke: "#05070a",
                      strokeWidth: 2,
                      style: { filter: "drop-shadow(0 0 6px rgba(255,179,71,0.9))" },
                    }}
                  />
                </AreaChart>
              </ResponsiveContainer>
              <div className="mt-3 grid max-w-[640px] grid-cols-2 gap-2 sm:grid-cols-4">
                {(
                  [
                    { label: "NOW", v: heatStats.now },
                    { label: "LO", v: heatStats.lo },
                    { label: "HI", v: heatStats.hi },
                    { label: "AVG", v: heatStats.avg },
                  ] as const
                ).map((chip) => (
                  <div key={chip.label} className="glass-soft rounded-lg px-2 py-1.5 text-center">
                    <div className="font-terminal text-[13px] font-bold tabular-nums" style={{ color: heatColor(chip.v), textShadow: `0 0 10px ${heatColor(chip.v)}44` }}>
                      {Math.round(chip.v)}
                    </div>
                    <div className="label-tech mt-0.5 text-[8px]">{chip.label}</div>
                  </div>
                ))}
              </div>
              <p className="mt-2 flex items-center gap-1.5 font-terminal text-[9px] tracking-[0.12em] text-ink-3">
                <Activity size={9} className="text-amber-neon" aria-hidden />
                SAMPLED EVERY ~20s · PERSISTS ACROSS RELOADS · CAP ~80MIN
              </p>
            </>
          )}
        </ChartCard>

        {/* ── H · STRATEGY MATRIX ──────────────────────────── */}
        <ChartCard
          title="STRATEGY MATRIX"
          corners
          delay={0.35}
          className="md:col-span-2 xl:col-span-4"
          badge={<NeonBadge tone="muted">{stats.byStrategy.length} STRATEGIES · TAP TO DRILL</NeonBadge>}
        >
          {stats.byStrategy.length === 0 ? (
            <EmptyChart height={220} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-[rgb(var(--neon-rgb)/0.14)] hover:bg-transparent">
                  <TableHead className="label-tech">STRATEGY</TableHead>
                  <TableHead className="label-tech text-right">DEPLOYED</TableHead>
                  <TableHead className="label-tech text-right">WINS</TableHead>
                  <TableHead className="label-tech min-w-[150px]">WIN RATE</TableHead>
                  <TableHead className="label-tech min-w-[150px]">AVG CONVICTION</TableHead>
                  <TableHead className="label-tech text-right">NET PNL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.byStrategy.map((s) => {
                  const wr = s.count ? (s.wins / s.count) * 100 : 0;
                  return (
                    <TableRow
                      key={s.strategy}
                      onClick={() => setDrillStrategy(s.strategy)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setDrillStrategy(s.strategy);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label={`Open ${s.strategy} strategy deep-dive`}
                      className="group cursor-pointer border-[rgba(159,180,171,0.08)] font-terminal text-xs outline-none transition-colors hover:bg-[rgba(178,107,255,0.06)] focus-visible:bg-[rgba(178,107,255,0.08)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-violet-neon/50"
                    >
                      <TableCell className="font-bold uppercase text-ink">
                        <span className="inline-flex items-center gap-1.5">
                          {s.strategy}
                          <ChevronRight size={11} className="text-ink-3 transition-all duration-300 group-hover:translate-x-0.5 group-hover:text-violet-neon" aria-hidden />
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-ink-2 tabular-nums">{s.count}</TableCell>
                      <TableCell className="text-right text-ink-2 tabular-nums">{s.wins}</TableCell>
                      <TableCell>
                        <MiniBar value={wr} color={NEON} label={`${Math.round(wr)}%`} />
                      </TableCell>
                      <TableCell>
                        <MiniBar value={s.avgConfidence} color={palette.secondary} label={`${Math.round(s.avgConfidence)}%`} />
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-bold tabular-nums",
                          s.pnl >= 0 ? "text-neon" : "text-danger-neon",
                        )}
                      >
                        {signedUsd(s.pnl)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </ChartCard>

        {/* ── I · DURATION LAB — timing forensics (v6.7.1) — operator: LAST column ── */}
        <ChartCard
          title="DURATION LAB · TIMING FORENSICS"
          tone="violet"
          dotColor="#ffb347"
          delay={0.38}
          className="md:col-span-2 xl:col-span-2"
          badge={<NeonBadge tone="violet">HOLD-TIME × WIN-RATE</NeonBadge>}
        >
          <DurationLabCard />
        </ChartCard>

        {/* ── J · PUMP/DUMP RADAR PERFORMANCE — v9.1 (operator 2026-09-13) ── */}
        <ChartCard
          title="PUMP/DUMP RADAR · PERFORMANCE + AI JOURNAL"
          tone="violet"
          dotColor="#ff4fd8"
          delay={0.4}
          className="md:col-span-2 xl:col-span-2"
          badge={<NeonBadge tone="violet">DETECTOR SUCCESS BOOK</NeonBadge>}
        >
          <PumpPerformanceCard />
        </ChartCard>
      </div>

      <StrategyDrillDialog strategy={drillStrategy} onClose={() => setDrillStrategy(null)} />
    </section>
  );
}
