"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Radar, ScrollText, Trophy, TrendingDown } from "lucide-react";
import { NeonBadge } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";
import type { PumpPerformance } from "@/lib/pump-performance";
import type { PumpEngineStatus } from "@/lib/api-types";

/**
 * PumpPerformanceCard — v9.1 PUMP/DUMP RADAR · PERFORMANCE + AI JOURNAL
 * (operator mandate 2026-09-13: «ماژول نمایش عملکرد و جورنال برای هوش مرکزی»).
 * Shows the radar's measured success book per kind (criteria FIXED at
 * declaration — honest detector), 24h activity, top symbols, best/worst
 * tracks and the live radar journal (declare/unlock/deploy lines) that is
 * persisted to EngineSetting "pump.performance" for the central intelligence
 * (governor + advisor + engine memory consume the same evidence).
 */

interface PumpPerfResponse extends PumpPerformance {
  status: PumpEngineStatus;
  persistedThisCall: boolean;
}

const KIND_TONE: Record<string, { text: string; border: string; label: string }> = {
  PUMP: { text: "text-magenta-neon", border: "border-magenta-neon/40", label: "PUMP ENGINE" },
  DUMP: { text: "text-danger-neon", border: "border-danger-neon/40", label: "DUMP ENGINE" },
};

function Tile({ label, value, sub, tone = "neon" }: { label: string; value: string; sub?: string; tone?: "neon" | "amber" | "danger" | "violet" }) {
  const color = tone === "danger" ? "text-danger-neon" : tone === "amber" ? "text-amber-neon" : tone === "violet" ? "text-magenta-neon" : "text-neon";
  return (
    <div className="min-w-0 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2.5">
      <div className="label-tech truncate text-ink-3">{label}</div>
      <div className={cn("mt-1 font-terminal text-lg font-bold tabular-nums", color)}>{value}</div>
      {sub ? <div className="mt-0.5 truncate font-terminal text-[9px] text-ink-3">{sub}</div> : null}
    </div>
  );
}

export function PumpPerformanceCard({ className }: { className?: string }) {
  const [perf, setPerf] = useState<PumpPerfResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/analytics/pump", { cache: "no-store" });
      if (res.ok) setPerf((await res.json()) as PumpPerfResponse);
    } catch {
      /* keep previous state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 90_000);
    return () => clearInterval(iv);
  }, [load]);

  if (loading && !perf) {
    return (
      <div className="flex min-h-[200px] items-center justify-center gap-2 font-terminal text-[11px] text-ink-3" role="status" aria-live="polite">
        <Radar className="size-3.5 animate-spin" aria-hidden />
        MEASURING RADAR PERFORMANCE…
      </div>
    );
  }
  if (!perf) {
    return <div className="p-4 font-terminal text-[11px] text-ink-3">radar performance unavailable — retrying next cycle</div>;
  }

  const t = perf.totals;
  const st = perf.status;

  return (
    <div className={cn("min-w-0", className)}>
      {/* ── headline + authority ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <NeonBadge tone={st.authority === "direct" ? "violet" : "muted"} glow={st.authority === "direct"}>
          {st.authority === "direct" ? "DIRECT SIGNAL AUTHORITY" : "GATED AUTHORITY"}
        </NeonBadge>
        <NeonBadge tone={st.gate.unlocked ? "neon" : "amber"}>
          GATE {st.gate.unlocked ? "UNLOCKED" : "LOCKED"} · {st.gate.successful}/{st.gate.required}
        </NeonBadge>
        <NeonBadge tone="muted">TAPE {st.tapeSymbols} SYM · {st.warm ? "WARM" : "WARMING"}</NeonBadge>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-2">{perf.headline}</p>

      {/* ── totals tiles ── */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="TRACKS" value={String(t.tracks)} sub={`${t.resolved} resolved · ${t.pending} live`} />
        <Tile label="SUCCESS RATE" value={`${t.successRatePct}%`} sub={`${t.success}✓ / ${t.failure}✕`} tone={t.successRatePct >= 50 ? "neon" : "amber"} />
        <Tile label="24H DECLARED" value={String(perf.window24h.declared)} sub={`${perf.window24h.success}✓ · ${perf.window24h.failure}✕`} tone="violet" />
        <Tile label="RADAR SIGNALS" value={String(t.spawnedSignals)} sub={st.authority === "direct" ? "direct authority live" : "via gate stack"} tone="amber" />
      </div>

      {/* ── per-kind book ── */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {perf.perKind.map((k) => {
          const tone = KIND_TONE[k.kind]!;
          return (
            <div key={k.kind} className={cn("rounded-lg border bg-white/[0.02] p-3", tone.border)}>
              <div className="flex items-center gap-1.5">
                <Radar className={cn("size-3.5", tone.text)} aria-hidden />
                <span className={cn("label-tech", tone.text)}>{tone.label}</span>
                <span className="ml-auto font-terminal text-sm font-bold tabular-nums text-ink">
                  {k.success}/{k.resolved} · {k.successRatePct}%
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
                <div
                  className={cn("h-full rounded-full", k.kind === "PUMP" ? "bg-magenta-neon/70" : "bg-danger-neon/70")}
                  style={{ width: `${Math.min(100, k.successRatePct)}%` }}
                />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1.5 font-terminal text-[9px] text-ink-3">
                <span>AVG MFE <b className={cn("tabular-nums", k.avgMfePct >= 2 ? "text-neon" : "text-ink-2")}>+{k.avgMfePct.toFixed(2)}%</b></span>
                <span>AVG MAE <b className="tabular-nums text-danger-neon/90">−{k.avgMaePct.toFixed(2)}%</b></span>
                <span>RESOLVE <b className="tabular-nums text-ink-2">{k.avgResolutionMin < 60 ? `${k.avgResolutionMin.toFixed(0)}m` : `${(k.avgResolutionMin / 60).toFixed(1)}h`}</b></span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── best / worst + top symbols ── */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-neon/20 bg-neon/[0.03] p-2.5">
          <div className="flex items-center gap-1.5">
            <Trophy className="size-3 text-neon" aria-hidden />
            <span className="label-tech text-neon">BEST TRACK</span>
          </div>
          <div className="mt-1 font-terminal text-[11px] text-ink-2">
            {perf.best ? (
              <>
                {perf.best.symbol} <span className="text-magenta-neon">{perf.best.kind}</span> · MFE <b className="text-neon">+{perf.best.mfePct.toFixed(2)}%</b> · {perf.best.outcome ?? "live"}
              </>
            ) : (
              <span className="text-ink-3">no resolved tracks yet</span>
            )}
          </div>
        </div>
        <div className="rounded-lg border border-danger-neon/20 bg-danger-neon/[0.03] p-2.5">
          <div className="flex items-center gap-1.5">
            <TrendingDown className="size-3 text-danger-neon" aria-hidden />
            <span className="label-tech text-danger-neon">WORST TRACK</span>
          </div>
          <div className="mt-1 font-terminal text-[11px] text-ink-2">
            {perf.worst ? (
              <>
                {perf.worst.symbol} <span className="text-magenta-neon">{perf.worst.kind}</span> · MAE <b className="text-danger-neon">−{perf.worst.maePct.toFixed(2)}%</b> · {perf.worst.outcome ?? "live"}
              </>
            ) : (
              <span className="text-ink-3">no resolved tracks yet</span>
            )}
          </div>
        </div>
      </div>
      {perf.topSymbols.length > 0 && (
        <p className="mt-2 font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-ink-3">
          TOP SYMBOLS · {perf.topSymbols.map((s) => `${s.symbol.replace("USDT", "")} ${s.success}/${s.tracks} (${s.successRatePct}%)`).join(" · ")}
        </p>
      )}

      {/* ── AI journal — the central intelligence's radar evidence chain ── */}
      <div className="mt-3 rounded-lg border border-magenta-neon/25 bg-magenta-neon/[0.04] p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <ScrollText className="size-3.5 text-magenta-neon" aria-hidden />
          <span className="label-tech text-magenta-neon">RADAR JOURNAL → CENTRAL INTELLIGENCE</span>
          <NeonBadge tone="violet" className="ml-auto">
            <Activity className="size-2.5" aria-hidden /> EngineSetting &quot;pump.performance&quot;
          </NeonBadge>
        </div>
        <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto scrollbar-thin pr-1" role="region" aria-label="Radar journal entries">
          {perf.journal.length === 0 && <div className="font-terminal text-[10px] text-ink-3">journal warming — radar events land here as the tape ignites</div>}
          {perf.journal.map((e, i) => (
            <div key={i} className="flex gap-2 rounded border border-white/6 bg-white/[0.02] px-2 py-1.5">
              <span className="shrink-0 font-terminal text-[9px] tabular-nums text-ink-3">
                {new Date(e.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              </span>
              <span className={cn("font-terminal text-[10px] leading-relaxed", e.level === "success" ? "text-neon" : e.level === "ai" ? "text-magenta-neon/90" : "text-ink-2")}>{e.message}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-ink-3">
          JOURNAL INJECTED INTO ENGINE MEMORY + GOVERNOR CONTEXT — THE AI CORE READS THE SAME EVIDENCE IT DISPLAYS HERE · SUCCESS CRITERIA FIXED AT DECLARATION (HONEST DETECTOR, NO POST-HOC RESCORING)
        </p>
      </div>
    </div>
  );
}

export default PumpPerformanceCard;
