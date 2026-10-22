"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { useMounted, usePulse } from "@/hooks/usePulse";
import type { PlatformStats } from "@/lib/api-types";
import { fmtUsd } from "@/lib/format";
import { useUi } from "@/store/ui";
import { cn } from "@/lib/utils";
import { useNeon } from "@/components/analytics/chart-theme";
import { APP_ENGINE_LINE } from "@/lib/brand";

/* ── rAF count-up (SSR-safe: renders target until mounted) ── */
function useCountUp(target: number, duration = 1400): number {
  const mounted = useMounted();
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!mounted) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setValue(target * (1 - Math.pow(1 - p, 3))); // ease-out cubic
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [mounted, target, duration]);

  return mounted ? value : target;
}

/* ── animated hero stat ── */
function CountStat({
  label,
  target,
  format,
  valueClass,
  sub,
}: {
  label: string;
  target: number;
  format: (v: number) => string;
  valueClass?: string;
  sub?: string;
}) {
  const displayed = useCountUp(target);
  return (
    <div className="min-w-0">
      <div className="label-tech">{label}</div>
      <div
        className={cn(
          "mt-1 truncate font-terminal text-2xl font-extrabold tracking-tight sm:text-3xl",
          valueClass
        )}
      >
        {format(displayed)}
      </div>
      {sub && <div className="mt-0.5 font-terminal text-[10px] uppercase tracking-[0.18em] text-ink-3">{sub}</div>}
    </div>
  );
}

/* ── deterministic radar blips (hydration-safe) ── */
const BLIPS: ReadonlyArray<{ x: number; y: number; delay: number }> = [
  { x: 62, y: 26, delay: 0 },
  { x: 30, y: 48, delay: 0.7 },
  { x: 57, y: 68, delay: 1.4 },
  { x: 44, y: 36, delay: 2.1 },
  { x: 72, y: 56, delay: 2.8 },
  { x: 25, y: 70, delay: 3.5 },
];

function RadarArt() {
  const { data: pulse } = usePulse(15000);
  const uni = pulse?.feed?.universe ?? null;
  const mounted = useMounted();
  const neon = useNeon(); // accent-following center dot
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-4 py-2">
      {/* radar disc */}
      <div className="relative aspect-square w-44 sm:w-52" role="img" aria-label="Engine radar scanning live markets">
        <div className="absolute inset-0 overflow-hidden rounded-full">
          {/* static rings + crosshair */}
          <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full">
            <circle cx="100" cy="100" r="96" fill="none" stroke="rgb(var(--neon-rgb)/0.22)" strokeWidth="1" />
            <circle cx="100" cy="100" r="72" fill="none" stroke="rgb(var(--neon-rgb)/0.14)" strokeWidth="1" />
            <circle cx="100" cy="100" r="48" fill="none" stroke="rgb(var(--neon-rgb)/0.14)" strokeWidth="1" />
            <circle cx="100" cy="100" r="24" fill="none" stroke="rgb(var(--neon-rgb)/0.1)" strokeWidth="1" />
            <line x1="100" y1="6" x2="100" y2="194" stroke="rgb(var(--neon-rgb)/0.12)" strokeWidth="1" />
            <line x1="6" y1="100" x2="194" y2="100" stroke="rgb(var(--neon-rgb)/0.12)" strokeWidth="1" />
            <circle cx="100" cy="100" r="2.5" fill={neon} />
          </svg>
          {/* conic sweep wedge */}
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "conic-gradient(from 0deg, rgb(var(--neon-rgb)/0.38), rgb(var(--neon-rgb)/0.14) 52deg, transparent 72deg, transparent 360deg)",
              animation: "radar-sweep 4s linear infinite",
            }}
          />
          {/* rotating dashed outer ring */}
          <svg viewBox="0 0 200 200" className="anim-spin-slow absolute inset-0 h-full w-full">
            <circle cx="100" cy="100" r="88" fill="none" stroke="rgb(var(--neon-rgb)/0.35)" strokeWidth="1.5" strokeDasharray="3 12" />
          </svg>
          {/* blips */}
          {mounted &&
            BLIPS.map((b, i) => (
              <span
                key={i}
                className="anim-pulse-dot absolute h-1.5 w-1.5 rounded-full bg-neon"
                style={{
                  left: `${b.x}%`,
                  top: `${b.y}%`,
                  animationDelay: `${b.delay}s`,
                  boxShadow: "0 0 8px rgb(var(--neon-rgb)/0.9)",
                }}
              />
            ))}
        </div>
        {/* HUD corner coordinates */}
        <span className="absolute -left-1 -top-4 font-terminal text-[9px] tracking-[0.16em] text-ink-3">51.5074° N</span>
        <span className="absolute -right-1 -top-4 font-terminal text-[9px] tracking-[0.16em] text-ink-3">0.1278° W</span>
        <span className="absolute -bottom-4 -left-1 font-terminal text-[9px] tracking-[0.16em] text-ink-3">SWEEP 4.0s</span>
        <span className="absolute -bottom-4 -right-1 font-terminal text-[9px] tracking-[0.16em] text-ink-3">PWR 98.2%</span>
      </div>

      {/* readout */}
      <div className="flex items-center gap-2">
        <LiveDot tone="violet" />
        <span className="font-terminal text-[10px] uppercase tracking-[0.22em] text-violet-neon">Sector scan active</span>
      </div>
      <div className="grid w-full grid-cols-3 gap-2 text-center">
        {[
          ["MARKETS", uni ? String(uni.tracked) : "--"],
          ["POOL", uni && uni.poolTotal ? `~${uni.poolTotal}` : "--"],
          ["LATENCY", pulse?.feed?.latencyMs != null ? `${pulse.feed.latencyMs}ms` : "--"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-md border border-white/5 bg-white/[0.02] px-1 py-1.5">
            <div className="font-terminal text-[10px] uppercase tracking-[0.16em] text-ink-3">{k}</div>
            <div className="font-terminal text-xs font-bold text-ink">{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Hero panel: 2/3 headline + 1/3 radar on lg ── */
export default function HeroPanel({ stats }: { stats: PlatformStats }) {
  const { data: pulse } = usePulse(15000);
  const scanDomain = pulse?.feed?.universe ?? null;
  const setView = useUi((s) => s.setView);

  // TASK-51 lineage readout — after any platform reset the operator must READ
  // continuity at a glance: boot time of this generation, running commit, and
  // ledger serial (serial ≈ pre-reset value ⇒ data survived the recycle).
  const [lineage, setLineage] = useState<{
    bootAt: string | null;
    gitSha: string | null;
    ledgerMaxSerial: number | null;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/healthz", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as {
          bootAt?: string;
          gitSha?: string | null;
          lineage?: { ledgerMaxSerial?: number | null };
        };
        if (alive)
          setLineage({
            bootAt: j.bootAt ?? null,
            gitSha: j.gitSha ?? null,
            ledgerMaxSerial: j.lineage?.ledgerMaxSerial ?? null,
          });
      } catch {
        /* fail-open: lineage is metadata, never a gate */
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const pnlPositive = stats.totalPnlUsd >= 0;

  // v6.0 TOTAL AUTONOMY: the manual "Deploy AI Signal" path was REMOVED —
  // deployment happens only via the autonomous trigger-bus → governor-gated
  // engine (POST /api/signals returns 423 by design; zero manual modes).

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* ── left: headline + stats + CTAs ── */}
      <BentoCard corners className="relative overflow-hidden lg:col-span-2">
        {/* grid + violet glow backdrop */}
        <div aria-hidden className="grid-bg pointer-events-none absolute inset-0 rounded-[inherit] opacity-50 [mask-image:radial-gradient(ellipse_at_20%_10%,black_30%,transparent_75%)]" />
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-violet-neon/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 h-64 w-64 rounded-full bg-neon/[0.07] blur-3xl" />

        <div className="relative flex h-full flex-col">
          {/* status line */}
          <div className="flex flex-wrap items-center gap-2.5">
            <LiveDot />
            <span className="font-terminal text-[10px] uppercase tracking-[0.22em] text-neon/80">{APP_ENGINE_LINE}</span>
            <NeonBadge tone="violet" className="ml-auto hidden sm:inline-flex">
              <Sparkles className="h-3 w-3" aria-hidden /> autonomous core
            </NeonBadge>
          </div>

          {/* headline */}
          <h1 className="mt-5 font-terminal text-[clamp(2.6rem,7vw,4.6rem)] font-extrabold leading-[0.95] tracking-tight">
            <span className="glitch block text-ink" data-text="SIGNAL">
              SIGNAL
            </span>
            <span className="glitch gradient-text block" data-text="COMMAND">
              COMMAND
            </span>
          </h1>

          <p className="mt-4 max-w-xl text-[13px] leading-relaxed text-ink-2 sm:text-sm">
            Autonomous engine scanning <span className="font-terminal text-neon">{scanDomain ? `${scanDomain.tracked} of ${scanDomain.poolTotal || "~"} USDT-M perps` : "the USDT-M futures market"}</span>
            <span className="mx-1.5 text-ink-3">·</span>flow-ranked, event-driven
            <span className="mx-1.5 text-ink-3">·</span>TTL-enforced discipline
          </p>

          {/* TASK-51 lineage strip — continuity you can READ (RESET-0929 doctrine) */}
          {lineage && (
            <div
              className="mt-2 flex flex-wrap items-center gap-x-2 font-terminal text-[10px] uppercase tracking-[0.18em] text-ink-3"
              aria-label="Generation lineage: boot time, ledger serial, running commit"
            >
              <span className="text-violet-neon/80">gen boot {lineage.bootAt ? `${new Date(lineage.bootAt).toISOString().slice(11, 16)}Z` : "--"}</span>
              <span aria-hidden>·</span>
              <span>
                ledger <span className="text-ink-2">#{lineage.ledgerMaxSerial ?? "--"}</span>
              </span>
              {lineage.gitSha && (
                <>
                  <span aria-hidden>·</span>
                  <span>{lineage.gitSha}</span>
                </>
              )}
            </div>
          )}

          {/* key stats */}
          <div className="mt-7 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-white/5 pt-5 sm:grid-cols-4">
            <CountStat
              label="WIN RATE"
              target={stats.winRate}
              format={(v) => `${v.toFixed(1)}%`}
              valueClass="text-neon neon-text"
            />
            <CountStat label="ACTIVE SIGNALS" target={stats.activeCount} format={(v) => `${Math.round(v)}`} valueClass="text-cyan-neon" />
            <CountStat
              label="TOTAL PNL 7D"
              target={stats.totalPnlUsd}
              format={(v) => fmtUsd(v)}
              valueClass={pnlPositive ? "text-ink" : "text-danger-neon neon-text-danger"}
              sub={pnlPositive ? "▲ NET PROFIT" : "▼ NET DRAWDOWN"}
            />
            <CountStat
              label="AVG R:R"
              target={stats.avgRiskReward}
              format={(v) => `1:${v.toFixed(2)}`}
              valueClass="text-violet-neon neon-text-violet"
            />
          </div>

          {/* CTAs — v6.0: NO manual deploy button. Deployment is 100% autonomous
              (trigger-bus → governor-gated engine); the operator CTA goes to the
              live matrix instead of forcing an un-audited signal. */}
          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => setView("signals")}
              className="group inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-neon px-6 font-terminal text-sm font-bold uppercase tracking-[0.14em] text-[#04120c] shadow-[0_0_26px_-6px_rgb(var(--neon-rgb)/0.75)] transition-all hover:shadow-[0_0_38px_-6px_rgb(var(--neon-rgb)/0.95)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Enter Signal Matrix
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </button>
            <a
              href="#ai-core"
              onClick={() => setView("ai")}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-lg border border-[rgba(178,107,255,0.45)] bg-[rgba(178,107,255,0.06)] px-6 font-terminal text-sm font-bold uppercase tracking-[0.14em] text-violet-neon transition-all hover:bg-[rgba(178,107,255,0.14)] hover:shadow-[0_0_30px_-8px_rgba(178,107,255,0.8)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-neon/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              AI Autonomous Core
            </a>
          </div>
        </div>
      </BentoCard>

      {/* ── right: radar art ── */}
      <BentoCard corners delay={0.12} className="relative overflow-hidden">
        <div aria-hidden className="grid-bg-fine pointer-events-none absolute inset-0 rounded-[inherit] opacity-40 [mask-image:radial-gradient(circle_at_50%_40%,black_20%,transparent_80%)]" />
        <div className="relative flex h-full flex-col">
          <div className="flex items-center justify-between">
            <span className="label-tech">Radar // Sector-04</span>
            <NeonBadge tone="neon" glow>
              live
            </NeonBadge>
          </div>
          <div className="mt-6 flex-1 px-2 pb-6 pt-2">
            <RadarArt />
          </div>
        </div>
      </BentoCard>
    </div>
  );
}
