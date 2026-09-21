"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import { ArrowRight, TerminalSquare } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import HeroPanel from "@/components/dashboard/HeroPanel";
import TickerMarquee from "@/components/dashboard/TickerMarquee";
import StatCards from "@/components/dashboard/StatCards";
import LiveSignalRail from "@/components/dashboard/LiveSignalRail";
import MarketMovers from "@/components/dashboard/MarketMovers";
import { AccountBar } from "@/components/dashboard/AccountBar";
import { RiskDesk } from "@/components/dashboard/RiskDesk";
import { useNow, usePulse } from "@/hooks/usePulse";
import type { EquityPoint, EventLevel, SignalEventDTO } from "@/lib/api-types";
import { fmtUsd, timeAgo } from "@/lib/format";
import { useUi } from "@/store/ui";
import { useNeon } from "@/components/analytics/chart-theme";
import SentinelPanel from "@/components/dashboard/SentinelPanel";

/* ── Equity curve (recharts, client-side) ─────────────────── */

function EquityTip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const v = payload[0]?.value;
  return (
    <div className="glass rounded-lg px-3 py-2 font-terminal text-xs shadow-[0_0_24px_-8px_rgb(var(--neon-rgb)/0.55)]">
      <div className="label-tech">{label}</div>
      <div className="mt-0.5 font-bold text-neon neon-text">{typeof v === "number" ? fmtUsd(v, false) : "—"}</div>
    </div>
  );
}

function EquityMini({ curve, total, className }: { curve: EquityPoint[]; total: number; className?: string }) {
  const neon = useNeon(); // accent-following equity curve
  const chartData = useMemo(
    () =>
      curve.map((p) => ({
        date: p.date.length > 5 ? p.date.slice(-5) : p.date,
        cum: Math.round(p.cum * 100) / 100,
      })),
    [curve]
  );

  return (
    <BentoCard className={className}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="label-tech">Equity curve // 7D</span>
          <LiveDot />
        </div>
        <NeonBadge tone="neon" glow>
          {fmtUsd(total)}
        </NeonBadge>
      </div>

      {chartData.length < 2 ? (
        <div className="flex h-[200px] items-center justify-center rounded-lg border border-dashed border-neon/20">
          <span className="label-tech">No equity data — engine warming up</span>
        </div>
      ) : (
        <div className="h-[200px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="eqNeonFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={neon} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={neon} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgb(var(--neon-rgb)/0.07)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: "#5c6f66", fontSize: 10, fontFamily: "var(--font-terminal), monospace" }}
                axisLine={{ stroke: "rgb(var(--neon-rgb)/0.15)" }}
                tickLine={false}
                minTickGap={28}
                interval="preserveStartEnd"
              />
              <YAxis
                width={56}
                tick={{ fill: "#5c6f66", fontSize: 10, fontFamily: "var(--font-terminal), monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => fmtUsd(v)}
                domain={["auto", "auto"]}
              />
              <Tooltip content={<EquityTip />} cursor={{ stroke: "rgb(var(--neon-rgb)/0.35)", strokeDasharray: "4 4" }} />
              <Area
                type="monotone"
                dataKey="cum"
                name="Equity"
                stroke={neon}
                strokeWidth={2}
                fill="url(#eqNeonFill)"
                dot={false}
                activeDot={{ r: 4, fill: neon, stroke: "#04120c", strokeWidth: 2 }}
                style={{ filter: "drop-shadow(0 0 6px rgb(var(--neon-rgb)/0.45))" }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </BentoCard>
  );
}

/* ── Engine feed preview ──────────────────────────────────── */

type BadgeTone = "neon" | "violet" | "magenta" | "amber" | "danger" | "cyan" | "muted";
const levelTone: Record<EventLevel, BadgeTone> = {
  info: "cyan",
  success: "neon",
  warn: "amber",
  error: "danger",
  ai: "violet",
};

function TerminalFeedPreview({ events, className }: { events: SignalEventDTO[]; className?: string }) {
  const setView = useUi((s) => s.setView);
  const now = useNow(10_000);
  const latest = events.slice(0, 7);

  return (
    <BentoCard tone="violet" className={className}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <TerminalSquare className="h-4 w-4 text-violet-neon" aria-hidden />
          <span className="label-tech">Engine feed</span>
          <LiveDot tone="violet" />
        </div>
        <button
          type="button"
          onClick={() => setView("terminal")}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 font-terminal text-xs font-bold uppercase tracking-[0.18em] text-violet-neon transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-neon/60"
        >
          Open terminal <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {latest.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-violet-neon/25">
          <span className="label-tech">Awaiting engine events…</span>
        </div>
      ) : (
        <ul className="max-h-56 space-y-2.5 overflow-y-auto pr-1">
          {latest.map((e) => (
            <li key={e.id} className="flex items-start gap-2.5">
              <NeonBadge tone={levelTone[e.level]} className="mt-0.5 shrink-0">
                {e.type.slice(0, 14)}
              </NeonBadge>
              <p className="min-w-0 flex-1 break-words font-terminal text-[11px] leading-relaxed text-ink-2">{e.message}</p>
              <span className="shrink-0 font-terminal text-[10px] tracking-[0.1em] text-ink-3">
                {now > 0 ? timeAgo(e.createdAt, now) : "--:--"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </BentoCard>
  );
}

/* ── Full-page skeleton (first load / refetch from cold) ──── */

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6" aria-busy="true" aria-label="Loading dashboard">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="bento h-[300px] animate-pulse lg:col-span-2" />
        <div className="bento h-[300px] animate-pulse" />
      </div>
      <div className="glass h-16 animate-pulse rounded-xl" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="bento h-[330px] animate-pulse lg:col-span-4" />
        <div className="bento h-[330px] animate-pulse lg:col-span-8" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bento h-36 animate-pulse" />
        ))}
      </div>
      <div className="space-y-4">
        <div className="h-7 w-64 animate-pulse rounded bg-white/5" />
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bento h-52 w-[280px] shrink-0 animate-pulse" />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="bento h-[280px] animate-pulse lg:col-span-7" />
        <div className="bento h-[280px] animate-pulse lg:col-span-5" />
      </div>
    </div>
  );
}

/* ── Dashboard assembly ───────────────────────────────────── */

import TelegramBridgeCard from "@/components/bridge/TelegramBridgeCard";

export default function DashboardSection() {
  const { data } = usePulse();

  if (!data) return <DashboardSkeleton />;

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <HeroPanel stats={data.stats} />
      <AccountBar />
      <RiskDesk />
      <TickerMarquee />
      <StatCards stats={data.stats} />
      <LiveSignalRail signals={data.signals} market={data.market} />
      <MarketMovers market={data.market} />
      {/* 2026-09-08 operator order: Flow scanner / Liq radar / Vol-risk moved to TERMINAL view */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <EquityMini curve={data.stats.equityCurve} total={data.stats.totalPnlUsd} className="lg:col-span-7" />
        <TerminalFeedPreview events={data.events} className="lg:col-span-5" />
      </div>
      {/* 2026-09-21 operator order: NEXUS-SENTINEL deep-monitor panel (:3030) */}
      <SentinelPanel />
      {/* 2026-09-11 operator round: two-way Telegram bridge (inbox + reply) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <TelegramBridgeCard />
        </div>
        <div className="lg:col-span-5">
          <SkinBadge />
        </div>
      </div>
    </div>
  );
}

/* ── v8.2 daily-skin badge — proves the daily Telegram artwork rotation ── */

function SkinBadge() {
  const [skin, setSkin] = useState<{
    name: string; accent: string; key: string; artKind: string; dayKey: string; ready: boolean;
    kinds?: Record<string, boolean>; kindReady?: number; kindTotal?: number;
  } | null>(null);
  useEffect(() => {
    fetch("/api/report/skin", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setSkin(j.skin ?? null))
      .catch(() => setSkin(null));
  }, []);
  const kindEntries = skin?.kinds ? Object.entries(skin.kinds) : [];
  return (
    <section className="bento flex h-full min-h-[9rem] flex-col justify-between gap-3 p-4" aria-label="Telegram artwork daily skin">
      <div className="font-terminal text-[11px] tracking-[0.22em] text-ink-2">TELEGRAM ART SKIN</div>
      <div className="flex items-center gap-3">
        <span
          className="inline-block h-8 w-8 shrink-0 rounded-lg border border-white/15"
          style={{ background: skin?.accent ?? "#00ffa3", boxShadow: `0 0 18px ${(skin?.accent ?? "#00ffa3")}55` }}
          aria-hidden
        />
        <div>
          <div className="font-terminal text-lg font-bold tracking-[0.14em] text-ink-1">{skin ? skin.name : "…"}</div>
          <div className="font-terminal text-[9px] tracking-widest text-ink-3">
            {skin
              ? skin.ready
                ? `${skin.dayKey} · skin-${skin.key}.png`
                : `${skin.dayKey} · fallback art-${skin.artKind}.png`
              : "loading skin"}
          </div>
        </div>
      </div>
      {/* v9.5 kind coverage — per-card-type art inside today's style */}
      {kindEntries.length > 0 && (
        <div className="flex items-center gap-2" aria-label="card-kind art coverage">
          {kindEntries.map(([k, ok]) => (
            <span
              key={k}
              title={`${k}: ${ok ? `skin-${skin?.key}-${k}.png` : "fallback"}`}
              className={`rounded border px-1 py-0.5 font-terminal text-[8px] tracking-wider ${
                ok ? "border-mint-neon/40 bg-mint-neon/10 text-mint-neon" : "border-white/10 bg-white/5 text-ink-3"
              }`}
            >
              {k}
            </span>
          ))}
          <span className="ml-auto font-terminal text-[8px] tracking-widest text-ink-3">
            {skin?.kindReady ?? 0}/{skin?.kindTotal ?? 0}
          </span>
        </div>
      )}
      <div className="font-terminal text-[9px] leading-relaxed tracking-widest text-ink-3">
        ART MATCHES THE CARD — LONG · SHORT · TP · STOP INSIDE THE DAY&apos;S SKIN
      </div>
    </section>
  );
}
