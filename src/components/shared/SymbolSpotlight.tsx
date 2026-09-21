"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ScanLine, Star, TrendingDown, TrendingUp, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NeonBadge, Sparkline, ConfidenceBar } from "@/components/shared/primitives";
import { LevelChart, type HistoryPoint } from "@/components/shared/LevelChart";
import type { MarketAssetDTO, PlatformStats, SignalDTO } from "@/lib/api-types";
import { fmtCompact, fmtPct, fmtPrice, fmtCountdown, ttlRemainingMs } from "@/lib/format";
import { usePulse, useNow } from "@/hooks/usePulse";
import { useUi } from "@/store/ui";
import { useAlerts } from "@/store/alerts";
import { cn } from "@/lib/utils";

/**
 * SymbolSpotlight — drill-down on a single market:
 * live price header + KPI strip + 24h price chart with the latest open
 * signal's TP/SL levels overlaid + this symbol's recent deployments.
 * Opened from the Market Matrix (hero/rows/watchlist) or the ⌘K palette.
 */

const STATUS_TONE: Record<string, "neon" | "cyan" | "danger" | "amber" | "muted"> = {
  ACTIVE: "neon", TP1: "cyan", TP2: "cyan", TP3: "neon", SL: "danger", EXPIRED: "amber", CLOSED: "muted",
};

/** Plain accent area chart for symbols with no open signal (no levels to draw). */
function PriceArea({ history, height = 190 }: { history: HistoryPoint[]; height?: number }) {
  const W = 560;
  const H = height;
  const data = useMemo(() => {
    const prices = history.map((h) => h.price).filter((n) => Number.isFinite(n));
    if (prices.length < 2) return null;
    let min = Math.min(...prices);
    let max = Math.max(...prices);
    const pad = (max - min) * 0.08 || max * 0.01;
    min -= pad;
    max += pad;
    const padB = 14;
    const ih = H - padB - 6;
    const y = (p: number) => 6 + ih - ((p - min) / (max - min)) * ih;
    const x = (i: number) => (i / (prices.length - 1)) * W;
    const line = prices.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
    const area = `${line} L${W},${H - padB} L0,${H - padB} Z`;
    return { line, area, y, x };
  }, [history, H]);

  if (!data) {
    return (
      <div className="flex h-[190px] items-center justify-center rounded-lg border border-white/5 bg-white/[0.015]">
        <span className="label-tech">COLLECTING PRICE HISTORY…</span>
      </div>
    );
  }
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="24h price history">
      <defs>
        <linearGradient id="spot-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--neon)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--neon)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={data.area} fill="url(#spot-area)" />
      <path d={data.line} fill="none" stroke="var(--neon)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Kpi({ label, value, tone = "text-ink" }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="glass-soft rounded-lg px-2.5 py-2">
      <div className="label-tech">{label}</div>
      <div className={cn("mt-0.5 font-terminal text-sm font-bold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

export function SymbolSpotlight() {
  const { spotlightSymbol, setSpotlightSymbol, setActiveSymbol, setView } = useUi();
  const { data, stale } = usePulse();
  const now = useNow(1000);
  const watchlist = useAlerts((s) => s.watchlist);
  const toggleWatch = useAlerts((s) => s.toggleWatch);

  const [history, setHistory] = useState<HistoryPoint[]>([]);

  const asset: MarketAssetDTO | undefined = useMemo(
    () => data?.market.find((m) => m.symbol === spotlightSymbol),
    [data?.market, spotlightSymbol]
  );

  const symbolSignals: SignalDTO[] = useMemo(() => {
    if (!data || !spotlightSymbol) return [];
    const all = data.signals.filter((s) => s.symbol === spotlightSymbol);
    const openFirst = (a: SignalDTO, b: SignalDTO) => {
      const aOpen = !a.closedAt ? 0 : 1;
      const bOpen = !b.closedAt ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    };
    return all.sort(openFirst).slice(0, 6);
  }, [data, spotlightSymbol]);

  /* latest open signal → drives the level overlay */
  const overlaySignal = useMemo(
    () => symbolSignals.find((s) => !s.closedAt && ["ACTIVE", "TP1", "TP2"].includes(s.status)) ?? null,
    [symbolSignals]
  );

  const symbolAgg = useMemo(
    () => data?.stats.bySymbol.find((a) => a.symbol === spotlightSymbol) ?? null,
    [data?.stats.bySymbol, spotlightSymbol]
  );

  /* live tail — splice the pulse price onto the fetched series so BOTH charts
     (plain + levels overlay) visibly move on every pulse, even between the
     60s history refetches */
  const historyLive = useMemo<HistoryPoint[]>(() => {
    const price = asset?.price;
    if (!history.length || !price || !Number.isFinite(price)) return history;
    const pts = [...history];
    const last = pts[pts.length - 1];
    const eps = price > 100 ? 0.02 : price > 1 ? 0.0005 : 0.00002;
    if (Math.abs(last.price - price) <= eps) return history; // already current
    pts.push({ t: new Date().toISOString(), price });
    return pts;
  }, [history, asset?.price]);

  /* v5.4 FROZEN-CHART FIX — the old effect depended on `asset`, whose object
     identity changes on EVERY pulse (~3s), so history was cleared + refetched
     nonstop and the PRICE ACTION × LEVELS card never settled. Now: fetch once
     per symbol open + a 60s refresh interval; the live pulse price is spliced
     onto the series tail by LevelChart so the line still rides every pulse. */
  useEffect(() => {
    if (!spotlightSymbol) return;
    let alive = true;
    const load = () => {
      fetch(`/api/market/history?symbol=${encodeURIComponent(spotlightSymbol)}&hours=24`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("history failed"))))
        .then((j: { series?: HistoryPoint[] }) => {
          if (alive) setHistory(j.series ?? []);
        })
        .catch(() => {
          /* keep the last good series — a failed poll must not blank the chart */
        });
    };
    setHistory([]);
    load();
    const iv = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [spotlightSymbol]);

  const open = Boolean(spotlightSymbol);
  const watched = spotlightSymbol ? watchlist.includes(spotlightSymbol) : false;
  const up = (asset?.change24h ?? 0) >= 0;

  function aiScan() {
    if (!spotlightSymbol) return;
    setActiveSymbol(spotlightSymbol);
    setView("ai");
    setSpotlightSymbol(null);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && setSpotlightSymbol(null)}>
      <DialogContent className="max-h-[92vh] max-w-[min(96vw,760px)] gap-0 overflow-y-auto border-[rgb(var(--neon-rgb)/0.22)] bg-[linear-gradient(150deg,rgba(14,21,27,0.98),rgba(6,10,13,0.97))] p-0 shadow-[0_0_70px_-14px_rgb(var(--neon-rgb)/0.35)]">
        {spotlightSymbol && (
          <>
            <DialogHeader className="sr-only">
              <DialogTitle>{spotlightSymbol} spotlight</DialogTitle>
              <DialogDescription>Market drill-down for {spotlightSymbol}</DialogDescription>
            </DialogHeader>

            {/* ── header: identity + live price + actions ── */}
            <div className="sticky top-0 z-10 border-b border-white/8 bg-[rgba(9,14,18,0.94)] px-5 py-4 backdrop-blur">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <h2 className="truncate font-terminal text-2xl font-extrabold tracking-tight text-foreground">
                      {spotlightSymbol}
                    </h2>
                    <NeonBadge tone={up ? "neon" : "danger"} glow>
                      {up ? "▲" : "▼"} {fmtPct(asset?.change24h ?? 0)}
                    </NeonBadge>
                    {overlaySignal && (
                      <NeonBadge tone="cyan">LEVELS: SIG-{overlaySignal.id.slice(-4).toUpperCase()}</NeonBadge>
                    )}
                  </div>
                  <div className="label-tech mt-1">{asset?.name ?? "…"}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => spotlightSymbol && toggleWatch(spotlightSymbol)}
                    aria-pressed={watched}
                    aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-lg border transition-all",
                      watched
                        ? "border-[rgba(255,179,71,0.5)] bg-[rgba(255,179,71,0.12)] text-amber-neon"
                        : "border-white/10 bg-white/[0.03] text-ink-3 hover:border-[rgba(255,179,71,0.4)] hover:text-amber-neon"
                    )}
                  >
                    <Star size={14} className={cn(watched && "fill-current")} />
                  </button>
                  <button
                    type="button"
                    onClick={aiScan}
                    className="flex h-9 items-center gap-1.5 rounded-lg border border-[rgba(178,107,255,0.4)] bg-[rgba(178,107,255,0.08)] px-3 font-terminal text-[10px] font-bold tracking-[0.16em] text-violet-neon transition-colors hover:bg-[rgba(178,107,255,0.16)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-neon/60"
                  >
                    <ScanLine size={13} aria-hidden />
                    AI SCAN
                  </button>
                </div>
              </div>

              {/* live price line */}
              <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
                <div className="flex items-baseline gap-3">
                  <motion.span
                    key={asset?.price}
                    initial={{ opacity: 0.4, y: -3 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35 }}
                    className="font-terminal text-3xl font-extrabold tabular-nums text-ink"
                  >
                    {asset ? fmtPrice(asset.price) : "—"}
                  </motion.span>
                  {asset && (
                    <Sparkline
                      data={asset.sparkline}
                      width={110}
                      height={26}
                      tone={up ? "neon" : "danger"}
                      fill={false}
                      className="hidden sm:block"
                    />
                  )}
                </div>
                <span
                  className={cn(
                    "flex items-center gap-1.5 font-terminal text-[10px] tracking-[0.18em]",
                    stale ? "text-danger-neon" : "text-ink-3"
                  )}
                  role="status"
                >
                  <span
                    className={cn(
                      "inline-block h-1.5 w-1.5 rounded-full anim-pulse-dot",
                      stale ? "bg-danger-neon" : "bg-neon"
                    )}
                    aria-hidden
                  />
                  {stale ? "STALE FEED — RECONNECTING" : "LIVE FEED · 24H WINDOW"}
                </span>
              </div>
            </div>

            <div className="space-y-4 px-5 py-4">
              {/* ── KPI strip ── */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Kpi label="24H HIGH" value={asset ? fmtPrice(asset.high24h) : "—"} />
                <Kpi label="24H LOW" value={asset ? fmtPrice(asset.low24h) : "—"} />
                <Kpi label="VOL 24H" value={asset ? fmtCompact(asset.volume24h) : "—"} />
                <Kpi
                  label="OPEN SIGS"
                  value={symbolSignals.filter((s) => !s.closedAt).length}
                  tone="text-neon"
                />
                <Kpi
                  label="HIT RATE"
                  value={symbolAgg && symbolAgg.count ? `${Math.round((symbolAgg.wins / symbolAgg.count) * 100)}%` : "—"}
                  tone="text-cyan-neon"
                />
                <Kpi
                  label="NET PNL"
                  value={symbolAgg ? `${symbolAgg.pnl >= 0 ? "+" : ""}${fmtCompact(symbolAgg.pnl)}` : "—"}
                  tone={cn(symbolAgg && symbolAgg.pnl < 0 ? "text-danger-neon" : "text-neon")}
                />
              </div>

              {/* ── price chart (+ levels when an open signal exists) ── */}
              <section aria-label="Price chart with levels">
                <div className="label-tech mb-1.5">
                  {overlaySignal ? "PRICE ACTION × LEVELS — 24H" : "PRICE ACTION — 24H"}
                </div>
                {overlaySignal ? (
                  <LevelChart
                    signal={overlaySignal}
                    history={historyLive}
                    livePrice={asset?.price}
                    height={200}
                  />
                ) : (
                  <PriceArea history={historyLive} height={200} />
                )}
                {!overlaySignal && (
                  <p className="mt-1.5 font-terminal text-[10px] tracking-[0.14em] text-ink-3">
                    NO OPEN DEPLOYMENT — LEVELS OVERLAY ARMS WHEN THE ENGINE DEPLOYS {spotlightSymbol}.
                  </p>
                )}
              </section>

              {/* ── deployment history ── */}
              <section aria-label="Signal history for symbol">
                <div className="label-tech mb-1.5">RECENT DEPLOYMENTS · {spotlightSymbol}</div>
                {symbolSignals.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center font-terminal text-[10px] uppercase tracking-[0.2em] text-ink-3">
                    NO ENGINE DEPLOYMENTS ON RECORD
                  </div>
                ) : (
                  <ul className="max-h-[240px] space-y-1.5 overflow-y-auto pr-1">
                    {symbolSignals.map((s) => {
                      const long = s.direction === "LONG";
                      const isOpen = !s.closedAt;
                      const remaining = now === 0 ? 1 : ttlRemainingMs(s.expiresAt, now);
                      const ttlLabel = isOpen
                        ? remaining > 0
                          ? `TTL ${fmtCountdown(s.expiresAt, now === 0 ? Date.now() : now).slice(3)}`
                          : "TTL EXPIRING"
                        : s.closedAt
                          ? `CLOSED ${new Date(s.closedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                          : "CLOSED";
                      return (
                        <li
                          key={s.id}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2 transition-colors hover:border-[rgb(var(--neon-rgb)/0.25)]"
                        >
                          <NeonBadge tone={long ? "neon" : "magenta"}>
                            {long ? <TrendingUp size={10} strokeWidth={2.5} /> : <TrendingDown size={10} strokeWidth={2.5} />}
                            {s.direction}
                          </NeonBadge>
                          <span className="font-terminal text-[10px] font-bold uppercase tracking-[0.14em] text-violet-neon">
                            {s.strategy}
                          </span>
                          <span className="font-terminal text-[10px] text-ink-3">{s.timeframe}</span>
                          <span className="font-terminal text-[11px] tabular-nums text-ink-2">
                            E {fmtPrice(s.entryPrice)}
                          </span>
                          <NeonBadge tone={STATUS_TONE[s.status] ?? "muted"}>{s.status}</NeonBadge>
                          <span
                            className={cn(
                              "ml-auto font-terminal text-xs font-bold tabular-nums",
                              s.pnlPercent >= 0 ? "text-neon" : "text-danger-neon"
                            )}
                          >
                            {fmtPct(s.pnlPercent)}
                          </span>
                          <span className="font-terminal text-[9px] tracking-[0.12em] text-ink-3">{ttlLabel}</span>
                          <ConfidenceBar value={s.confidence} className="hidden w-24 shrink-0 lg:flex" />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>

            {/* close affordance (DialogContent also renders an X) */}
            <button
              type="button"
              onClick={() => setSpotlightSymbol(null)}
              aria-label="Close spotlight"
              className="absolute right-4 top-4 hidden"
              tabIndex={-1}
            >
              <X size={14} />
            </button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
