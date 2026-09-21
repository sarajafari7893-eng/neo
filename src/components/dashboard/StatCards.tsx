"use client";

import type { ReactNode } from "react";
import { Activity, Brain, Flame, Radar, Target, Trophy } from "lucide-react";
import { BentoCard, ConfidenceBar, LiveDot, Sparkline } from "@/components/shared/primitives";
import type { PlatformStats } from "@/lib/api-types";
import { fmtPct, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNeon } from "@/components/analytics/chart-theme";

/* tone → icon chip classes */
const chipTone = {
  neon: "border-[rgb(var(--neon-rgb)/0.3)] bg-[rgb(var(--neon-rgb)/0.08)] text-neon",
  violet: "border-[rgba(178,107,255,0.35)] bg-[rgba(178,107,255,0.08)] text-violet-neon",
  magenta: "border-[rgba(255,78,205,0.35)] bg-[rgba(255,78,205,0.08)] text-magenta-neon",
  amber: "border-[rgba(255,179,71,0.35)] bg-[rgba(255,179,71,0.08)] text-amber-neon",
  danger: "border-[rgba(255,77,94,0.35)] bg-[rgba(255,77,94,0.08)] text-danger-neon",
} as const;

type ChipTone = keyof typeof chipTone;

function IconChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border", chipTone[tone])}>
      {children}
    </span>
  );
}

/* micro donut for WIN RATE — inline SVG circle */
function MicroDonut({ value, size = 46 }: { value: number; size?: number }) {
  const neon = useNeon(); // accent-following arc
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, value / 100)));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="4" fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={neon}
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={off}
        style={{ filter: "drop-shadow(0 0 5px rgb(var(--neon-rgb)/0.75))", transition: "stroke-dashoffset 0.9s ease" }}
      />
    </svg>
  );
}

const STAGGER = 0.06;

export default function StatCards({ stats }: { stats: PlatformStats }) {
  const pnlUp = stats.pnl24hUsd >= 0;
  const winStreak = stats.streak.type === "win";
  const dailyCurve = stats.equityCurve.slice(-8).map((p) => p.daily);
  const best = stats.bestTrade;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
      {/* 24H PNL */}
      <BentoCard delay={0 * STAGGER} className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <span className="label-tech">24H PNL</span>
          <IconChip tone={pnlUp ? "neon" : "danger"}>
            <Activity className="h-4 w-4" aria-hidden />
          </IconChip>
        </div>
        <div className={cn("mt-3 truncate font-terminal text-xl font-extrabold tracking-tight sm:text-2xl", pnlUp ? "text-neon neon-text" : "text-danger-neon neon-text-danger")}>
          {fmtUsd(stats.pnl24hUsd)}
        </div>
        <div className="mt-1 font-terminal text-[10px] uppercase tracking-[0.16em] text-ink-3">
          avg trade {fmtPct(stats.avgPnlPercent)}
        </div>
        {dailyCurve.length >= 2 && (
          <Sparkline data={dailyCurve} width={110} height={22} tone={pnlUp ? "neon" : "danger"} className="mt-2 w-full" />
        )}
      </BentoCard>

      {/* WIN RATE */}
      <BentoCard delay={1 * STAGGER} className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <span className="label-tech">WIN RATE</span>
          <IconChip tone="neon">
            <Target className="h-4 w-4" aria-hidden />
          </IconChip>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate font-terminal text-xl font-extrabold tracking-tight text-neon neon-text sm:text-2xl">
              {stats.winRate}%
            </div>
            <div className="mt-1 font-terminal text-[10px] uppercase tracking-[0.16em] text-ink-3">
              w {stats.wins} · l {stats.losses}
            </div>
          </div>
          <div className="relative shrink-0">
            <MicroDonut value={stats.winRate} />
            <span className="absolute inset-0 flex items-center justify-center font-terminal text-[9px] font-bold text-neon">
              {Math.round(stats.winRate)}
            </span>
          </div>
        </div>
      </BentoCard>

      {/* OPEN POSITIONS */}
      <BentoCard tone="violet" delay={2 * STAGGER} className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <span className="label-tech">OPEN POSITIONS</span>
          <IconChip tone="violet">
            <Radar className="h-4 w-4" aria-hidden />
          </IconChip>
        </div>
        <div className="mt-3 truncate font-terminal text-xl font-extrabold tracking-tight text-violet-neon neon-text-violet sm:text-2xl">
          {stats.activeCount}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <LiveDot tone="violet" />
          <span className="font-terminal text-[10px] uppercase tracking-[0.16em] text-ink-3">live tracking</span>
        </div>
      </BentoCard>

      {/* STREAK */}
      <BentoCard tone={stats.streak.count === 0 ? "neon" : winStreak ? "neon" : "magenta"} delay={3 * STAGGER} className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <span className="label-tech">STREAK</span>
          <IconChip tone={winStreak ? "neon" : "danger"}>
            <Flame className="h-4 w-4" aria-hidden />
          </IconChip>
        </div>
        <div className="mt-3 truncate font-terminal text-xl font-extrabold tracking-tight sm:text-2xl">
          <span className={stats.streak.count === 0 ? "text-ink-3" : winStreak ? "text-neon neon-text" : "text-magenta-neon neon-text-magenta"}>{stats.streak.count}</span>
          <span className="ml-1.5 font-terminal text-[10px] font-bold uppercase tracking-[0.16em] text-ink-2">
            {stats.streak.count === 0 ? "streak reset" : winStreak ? "win streak" : "loss streak"}
          </span>
        </div>
        <div className="mt-1 font-terminal text-[10px] uppercase tracking-[0.16em] text-ink-3">
          peak equity {fmtUsd(stats.peakEquity)}
        </div>
      </BentoCard>

      {/* BEST TRADE */}
      <BentoCard delay={4 * STAGGER} className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <span className="label-tech">BEST TRADE</span>
          <IconChip tone="amber">
            <Trophy className="h-4 w-4" aria-hidden />
          </IconChip>
        </div>
        {best ? (
          <>
            <div className="mt-3 truncate font-terminal text-xl font-extrabold tracking-tight text-amber-neon neon-text-amber sm:text-2xl">
              {best.symbol}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-terminal text-xs font-bold text-neon">{fmtPct(best.pnlPercent)}</span>
              <span className="font-terminal text-[10px] uppercase tracking-[0.16em] text-ink-3">{fmtUsd(best.pnlUsd)} realized</span>
            </div>
          </>
        ) : (
          <>
            <div className="mt-3 font-terminal text-xl font-extrabold tracking-tight text-ink-3">—</div>
            <div className="mt-1 font-terminal text-[10px] uppercase tracking-[0.16em] text-ink-3">awaiting first fill</div>
          </>
        )}
      </BentoCard>

      {/* AVG CONVICTION */}
      <BentoCard tone="violet" delay={5 * STAGGER} className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <span className="label-tech">AVG CONVICTION</span>
          <IconChip tone="violet">
            <Brain className="h-4 w-4" aria-hidden />
          </IconChip>
        </div>
        <div className="mt-3 truncate font-terminal text-xl font-extrabold tracking-tight text-violet-neon neon-text-violet sm:text-2xl">
          {stats.avgConfidence}%
        </div>
        <ConfidenceBar value={stats.avgConfidence} className="mt-2" />
      </BentoCard>
    </div>
  );
}
