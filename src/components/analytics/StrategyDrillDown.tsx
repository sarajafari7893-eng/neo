"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FlaskConical, TrendingDown, TrendingUp } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NeonBadge } from "@/components/shared/primitives";
import { usePulse } from "@/hooks/usePulse";
import { fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DANGER, NexusTooltip, useNeon, VIOLET } from "@/components/analytics/chart-theme";
import type { SignalDTO } from "@/lib/api-types";

/**
 * StrategyDrillDialog — deep-dive on a single strategy:
 * KPI strip → per-trade PnL% timeline (resolved only) → outcome split →
 * recent deployments. Computed client-side from the pulse signal cache.
 */

const RESOLVED = new Set(["TP1", "TP2", "TP3", "SL", "EXPIRED"]);
const STATUS_TONE: Record<string, string> = {
  TP1: "text-neon",
  TP2: "text-neon",
  TP3: "text-cyan-neon",
  SL: "text-danger-neon",
  EXPIRED: "text-amber-neon",
};

export function StrategyDrillDialog({ strategy, onClose }: { strategy: string | null; onClose: () => void }) {
  const { data } = usePulse(15000);
  const NEON = useNeon(); // accent-following hex for Recharts props

  const model = useMemo(() => {
    if (!strategy || !data) return null;
    const all = data.signals.filter((s) => s.strategy === strategy);
    const closed = all.filter((s) => RESOLVED.has(s.status) && s.closedAt);
    const pnlOf = (s: SignalDTO) => (s.marginUsd * s.pnlPercent) / 100;

    const wins = closed.filter((s) => ["TP1", "TP2", "TP3"].includes(s.status)).length;
    const losses = closed.filter((s) => s.status === "SL").length;
    const expired = closed.filter((s) => s.status === "EXPIRED").length;
    const netPnl = closed.reduce((a, s) => a + pnlOf(s), 0);
    const avgConf = all.length ? Math.round(all.reduce((a, s) => a + s.confidence, 0) / all.length) : 0;

    const chrono = [...closed].sort((a, b) => (a.closedAt ?? "").localeCompare(b.closedAt ?? ""));
    const trades = chrono.map((s, i) => ({
      idx: i + 1,
      label: `T${i + 1}`,
      symbol: s.symbol.replace(/USDT$/, ""),
      pnl: Number(s.pnlPercent.toFixed(1)),
      usd: Number(pnlOf(s).toFixed(2)),
      status: s.status,
    }));

    const sorted = [...closed].sort((a, b) => pnlOf(b) - pnlOf(a));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    // symbol split
    const symMap = new Map<string, { sym: string; pnl: number; n: number }>();
    for (const s of closed) {
      const k = s.symbol.replace(/USDT$/, "");
      const e = symMap.get(k) ?? { sym: k, pnl: 0, n: 0 };
      e.pnl += pnlOf(s);
      e.n += 1;
      symMap.set(k, e);
    }
    const bySymbol = [...symMap.values()].map((e) => ({ ...e, pnl: Number(e.pnl.toFixed(2)) })).sort((a, b) => b.pnl - a.pnl);

    return {
      all, closed, wins, losses, expired, netPnl, avgConf, trades,
      best: best ? { ...best, usd: pnlOf(best) } : null,
      worst: worst ? { ...worst, usd: pnlOf(worst) } : null,
      bySymbol,
      open: all.filter((s) => !RESOLVED.has(s.status)).length,
    };
  }, [strategy, data]);

  const wr = model && model.closed.length ? Math.round((model.wins / model.closed.length) * 100) : 0;

  return (
    <Dialog open={strategy !== null} onOpenChange={(v) => !v && onClose()}>
      {strategy !== null && (
        <DialogContent className="max-h-[88vh] w-[min(94vw,640px)] overflow-y-auto border-[rgba(178,107,255,0.28)] bg-[rgba(7,11,14,0.97)] backdrop-blur-xl sm:rounded-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-terminal uppercase tracking-[0.14em]">
              <FlaskConical size={15} className="text-violet-neon" aria-hidden />
              <span className="text-violet-neon neon-text-violet">{strategy}</span>
              <span className="label-tech ml-1">STRATEGY DEEP-DIVE</span>
            </DialogTitle>
            <DialogDescription className="font-terminal text-[10px] tracking-[0.14em] text-ink-3">
              LAST {model?.all.length ?? 0} DEPLOYMENTS · {model?.open ?? 0} STILL LIVE · ENGINE ROLLING WINDOW
            </DialogDescription>
          </DialogHeader>

          {!model || model.all.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-violet-neon/25 font-terminal text-[10px] tracking-[0.18em] text-ink-3">
              NO DEPLOYMENTS IN THE CURRENT WINDOW
            </div>
          ) : (
            <div className="space-y-4">
              {/* KPI strip */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Kpi label="DEPLOYED" value={String(model.all.length)} tone="violet" />
                <Kpi label="WIN RATE" value={`${wr}%`} tone={wr >= 50 ? "neon" : "amber"} />
                <Kpi
                  label="NET PNL"
                  value={`${model.netPnl >= 0 ? "+" : ""}${fmtUsd(model.netPnl)}`}
                  tone={model.netPnl >= 0 ? "neon" : "danger"}
                />
                <Kpi label="AVG CONVICTION" value={`${model.avgConf}%`} tone="cyan" />
              </div>

              {/* best / worst */}
              {model.best && model.worst && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="flex items-center gap-2.5 rounded-lg border border-[rgb(var(--neon-rgb)/0.2)] bg-[rgb(var(--neon-rgb)/0.05)] px-3 py-2">
                    <TrendingUp size={14} className="shrink-0 text-neon" aria-hidden />
                    <div className="min-w-0">
                      <div className="label-tech text-[8px]">BEST EXIT</div>
                      <div className="truncate font-terminal text-[11px] font-bold text-ink">
                        {model.best.symbol}{" "}
                        <span className="text-neon">+{model.best.pnlPercent.toFixed(1)}%</span>{" "}
                        <span className="text-ink-3">({fmtUsd(model.best.usd)})</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 rounded-lg border border-[rgba(255,77,94,0.2)] bg-[rgba(255,77,94,0.05)] px-3 py-2">
                    <TrendingDown size={14} className="shrink-0 text-danger-neon" aria-hidden />
                    <div className="min-w-0">
                      <div className="label-tech text-[8px]">WORST EXIT</div>
                      <div className="truncate font-terminal text-[11px] font-bold text-ink">
                        {model.worst.symbol}{" "}
                        <span className="text-danger-neon">{model.worst.pnlPercent.toFixed(1)}%</span>{" "}
                        <span className="text-ink-3">({fmtUsd(model.worst.usd)})</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* per-trade pnl timeline */}
              <section aria-label="Per-trade pnl timeline">
                <div className="label-tech mb-1.5">TRADE-BY-TRADE PNL% · RESOLVED</div>
                <div className="h-[150px] w-full rounded-lg border border-white/6 bg-white/[0.02] p-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={model.trades} margin={{ top: 8, right: 6, left: -22, bottom: 0 }}>
                      <XAxis dataKey="label" tick={{ fill: "#5c6f66", fontSize: 9, fontFamily: "var(--font-terminal), monospace" }} axisLine={{ stroke: "rgba(159,180,171,0.15)" }} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
                      <YAxis tick={{ fill: "#5c6f66", fontSize: 9, fontFamily: "var(--font-terminal), monospace" }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${v}`} />
                      <Tooltip content={<NexusTooltip unit="%" />} cursor={{ fill: "rgba(178,107,255,0.06)" }} />
                      <Bar dataKey="pnl" name="PNL%" radius={[3, 3, 0, 0]} barSize={14}>
                        {model.trades.map((t) => (
                          <Cell key={t.idx} fill={t.pnl >= 0 ? (t.status === "EXPIRED" ? VIOLET : NEON) : DANGER} fillOpacity={0.9} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>

              {/* outcome split + symbol split */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <section aria-label="Outcome split">
                  <div className="label-tech mb-1.5">OUTCOME SPLIT</div>
                  <div className="flex h-3 w-full overflow-hidden rounded-full border border-white/8">
                    <div className="h-full bg-neon" style={{ width: `${(model.wins / Math.max(1, model.closed.length)) * 100}%` }} />
                    <div className="h-full bg-danger-neon" style={{ width: `${(model.losses / Math.max(1, model.closed.length)) * 100}%` }} />
                    <div className="h-full bg-amber-neon" style={{ width: `${(model.expired / Math.max(1, model.closed.length)) * 100}%` }} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <NeonBadge tone="neon">{model.wins} WINS</NeonBadge>
                    <NeonBadge tone="danger">{model.losses} STOPS</NeonBadge>
                    <NeonBadge tone="amber">{model.expired} TTL</NeonBadge>
                  </div>
                </section>

                <section aria-label="Pnl by symbol">
                  <div className="label-tech mb-1.5">PNL BY SYMBOL</div>
                  <ul className="space-y-1">
                    {model.bySymbol.slice(0, 4).map((e) => (
                      <li key={e.sym} className="flex items-center gap-2 font-terminal text-[10px]">
                        <span className="w-14 shrink-0 font-bold text-ink">{e.sym}</span>
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/5">
                          <div
                            className={cn("h-full rounded-full", e.pnl >= 0 ? "bg-neon" : "bg-danger-neon")}
                            style={{ width: `${Math.min(100, (Math.abs(e.pnl) / Math.max(...model.bySymbol.map((x) => Math.abs(x.pnl)), 1)) * 100)}%` }}
                          />
                        </div>
                        <span className={cn("w-14 shrink-0 text-right tabular-nums", e.pnl >= 0 ? "text-neon" : "text-danger-neon")}>
                          {e.pnl >= 0 ? "+" : ""}{fmtUsd(e.pnl)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>

              {/* recent deployments */}
              <section aria-label="Recent deployments">
                <div className="label-tech mb-1.5">RECENT DEPLOYMENTS</div>
                <ul className="max-h-44 space-y-1 overflow-y-auto pr-0.5">
                  {model.all.slice(0, 8).map((s) => (
                    <li key={s.id} className="flex items-center gap-2 rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-1.5 font-terminal text-[10px]">
                      <span className="w-[74px] shrink-0 font-bold tracking-[0.08em] text-ink">{s.symbol}</span>
                      <span className={cn("w-10 shrink-0 font-bold", s.direction === "LONG" ? "text-neon" : "text-magenta-neon")}>{s.direction}</span>
                      <span className="hidden text-ink-3 sm:inline">{s.timeframe} · {s.leverage}×</span>
                      <span className={cn("ml-auto font-bold", STATUS_TONE[s.status] ?? "text-ink-2")}>{s.status}</span>
                      <span className={cn("w-16 shrink-0 text-right font-bold tabular-nums", s.pnlPercent >= 0 ? "text-neon" : "text-danger-neon")}>
                        {s.pnlPercent >= 0 ? "+" : ""}{s.pnlPercent.toFixed(1)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone: "neon" | "amber" | "danger" | "violet" | "cyan" }) {
  const toneCls = {
    neon: "text-neon border-[rgb(var(--neon-rgb)/0.25)]",
    amber: "text-amber-neon border-[rgba(255,179,71,0.25)]",
    danger: "text-danger-neon border-[rgba(255,77,94,0.25)]",
    violet: "text-violet-neon border-[rgba(178,107,255,0.25)]",
    cyan: "text-cyan-neon border-[rgba(69,240,223,0.25)]",
  }[tone];
  return (
    <div className={cn("rounded-lg border bg-white/[0.02] px-2.5 py-2 text-center", toneCls)}>
      <div className={cn("font-terminal text-sm font-extrabold tabular-nums", tone === "neon" && "neon-text")}>{value}</div>
      <div className="label-tech mt-0.5 text-[8px]">{label}</div>
    </div>
  );
}
