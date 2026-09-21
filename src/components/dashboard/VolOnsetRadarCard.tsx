"use client";

/* ── VOL-ONSET RADAR (AI CORE surface) ──────────────────────────────
   Operator request 2026-09-07: «VOL-ONSET RADAR و VOL-CAUSE FORENSICS
   رو هم به صفحه AI CORE ببر» — moved from MARKET MATRIX to the AI CORE
   desk, beside SMART MONEY · WHALE FLOW (same relocation pattern).
   Ranks by onset score whose recency term is exactly the operator's
   "time since last eruption bar × coefficient": 30pts × 0.5^(age/180m)
   half-life decay — a LEADING view vs the lagging |Δ24h| board. */

import { useEffect, useMemo, useState } from "react";
import { Activity, FlaskConical, Radio, Zap } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { useUi } from "@/store/ui";
import { cn } from "@/lib/utils";

interface OnsetRowDTO {
  symbol: string;
  score: number;
  hot: boolean;
  minutesSince: number;
  direction: "UP" | "DOWN";
  displacementX: number;
  eruptRetPct: number;
  followThroughPct: number;
  source: "kline" | "ticks";
}
interface OnsetGroupDTO {
  n: number;
  wins: number;
  winRatePct: number | null;
  avgNetPct: number | null;
  totalNetUsd: number;
}
interface OnsetTagStatsDTO {
  settledTotal: number;
  tagged: OnsetGroupDTO;
  taggedAligned: OnsetGroupDTO;
  taggedCounter: OnsetGroupDTO;
  rest: OnsetGroupDTO;
}
interface OnsetStudyDTO {
  at: string;
  all: { n: number; wr: number | null; wilsonLB: number };
  up: { n: number; meanFwd6: number | null };
  down: { n: number; meanFwd6: number | null };
  verdict: string;
}
interface VolOnsetDTO {
  computedAt: string;
  fromCache: boolean;
  universe: number;
  hotCount: number;
  rules: { tfMinutes: number; eruptionMult: number; trailingBars: number; hotMinutes: number; halfLifeMin: number };
  tagStats: OnsetTagStatsDTO;
  study: OnsetStudyDTO | null;
  rows: OnsetRowDTO[];
}

function useVolOnset(intervalMs = 30_000): VolOnsetDTO | null {
  const [data, setData] = useState<VolOnsetDTO | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/vol-onset", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as VolOnsetDTO;
        if (alive) setData(j);
      } catch {
        /* keep last-good — radar is telemetry, never breaks the page */
      }
    };
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return data;
}

function fmtAge(minutes: number): string {
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${minutes}m`;
}

export default function VolOnsetRadarCard() {
  const vo = useVolOnset();
  const rows = useMemo(() => vo?.rows.slice(0, 6) ?? [], [vo]);
  const ts = vo?.tagStats;
  const setSpotlightSymbol = useUi((s) => s.setSpotlightSymbol);

  return (
    <BentoCard tone="magenta" corners className="mt-4">
      <div aria-hidden className="grid-bg-fine pointer-events-none absolute inset-0 rounded-[inherit] opacity-20 [mask-image:radial-gradient(circle_at_85%_0%,black_10%,transparent_70%)]" />
      <div className="relative">
        {/* header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Radio size={13} className="text-magenta-neon" aria-hidden />
            <span className="label-tech">VOL-ONSET RADAR</span>
            <NeonBadge tone="amber" className="px-2 py-0.5 text-[10px]">
              LEADING · recency-ranked
            </NeonBadge>
          </div>
          <div className="flex items-center gap-2">
            {vo && vo.hotCount > 0 && (
              <NeonBadge tone="neon" glow className="px-2 py-0.5 text-[10px]">
                <Zap size={10} className="fill-current" aria-hidden /> {vo.hotCount} HOT
              </NeonBadge>
            )}
            <span className="label-tech hidden text-[10px] text-ink-3 sm:inline">
              {vo ? `${vo.universe} syms · ${vo.rules.tfMinutes}m bars · ≥${vo.rules.eruptionMult}× median · t½ ${vo.rules.halfLifeMin}m` : "connecting…"}
            </span>
          </div>
        </div>

        {/* rows */}
        {rows.length === 0 ? (
          <div className="label-tech mt-3 rounded-lg border border-dashed border-magenta-neon/25 p-4 text-center text-[11px] text-ink-3">
            {vo ? "NO ERUPTION BARS IN TRAILING 24H — QUIET TAPE" : "SCANNING 15m TAPE FOR ERUPTIONS…"}
          </div>
        ) : (
          <ul className="mt-2 divide-y divide-white/5">
            {rows.map((r, i) => {
              const up = r.direction === "UP";
              return (
                <li key={r.symbol}>
                  <button
                    type="button"
                    onClick={() => setSpotlightSymbol(r.symbol)}
                    aria-label={`Open ${r.symbol} spotlight — onset score ${r.score}, eruption ${fmtAge(r.minutesSince)} ago ${r.direction}`}
                    className={cn(
                      "flex min-h-12 w-full items-center gap-2.5 rounded-lg px-1 py-2 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-magenta-neon/60",
                      r.hot && "bg-[rgba(255,179,71,0.05)]"
                    )}
                  >
                    <span className="w-6 shrink-0 font-terminal text-[11px] font-bold text-ink-3">#{i + 1}</span>
                    {r.hot ? (
                      <LiveDot tone="amber" />
                    ) : (
                      <span className="w-2 shrink-0" aria-hidden />
                    )}
                    <span className="w-20 shrink-0 truncate font-terminal text-sm font-bold text-foreground sm:w-24">{r.symbol}</span>
                    <span className={cn("w-14 shrink-0 font-terminal text-[11px] font-bold", up ? "text-neon" : "text-danger-neon")}>
                      {up ? "▲ UP" : "▼ DOWN"}
                    </span>
                    <span className="flex w-20 shrink-0 flex-col gap-1 sm:w-24" aria-label={`onset score ${r.score} of 100`}>
                      <span className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                        <span
                          className={cn("block h-full rounded-full", r.hot ? "bg-amber-neon" : "bg-magenta-neon/70")}
                          style={{ width: `${Math.max(4, r.score)}%` }}
                        />
                      </span>
                      <span className="font-terminal text-[10px] font-bold tabular-nums text-ink-2">{r.score}/100</span>
                    </span>
                    <span className="hidden min-w-14 text-right font-terminal text-[11px] tabular-nums text-ink-3 sm:block" title="time since last eruption bar">
                      {fmtAge(r.minutesSince)}
                    </span>
                    <span className="hidden text-right font-terminal text-[11px] tabular-nums text-ink-2 md:block" title="displacement × trailing median">
                      ×{r.displacementX.toFixed(1)}
                    </span>
                    <span
                      className={cn(
                        "ml-auto hidden shrink-0 text-right font-terminal text-[11px] font-bold tabular-nums sm:block",
                        r.followThroughPct >= 0 ? "text-neon" : "text-danger-neon"
                      )}
                      title="post-eruption drift in eruption direction"
                    >
                      {r.followThroughPct >= 0 ? "+" : ""}
                      {r.followThroughPct.toFixed(1)}%
                    </span>
                    {r.hot && (
                      <NeonBadge tone="amber" className="ml-1 shrink-0 px-1.5 py-0.5 text-[9px]">
                        HOT
                      </NeonBadge>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* learning loop — calibrator evidence footer */}
        <div className="mt-3 rounded-lg border border-white/8 bg-white/[0.02] p-3">
          <div className="flex items-center gap-2">
            <FlaskConical size={12} className="text-magenta-neon" aria-hidden />
            <span className="label-tech text-[10px]">LEARNING LOOP — VOL-ONSET vs REST (settled signals)</span>
          </div>
          {ts ? (
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "TAGGED n", value: String(ts.tagged.n), hint: "signals carried a VOL-ONSET tag" },
                { label: "ALIGNED n", value: String(ts.taggedAligned.n), hint: "deployment agreed with the eruption direction (LONG+↑ / SHORT+↓)" },
                { label: "TAGGED WR", value: ts.tagged.winRatePct === null ? "—" : `${ts.tagged.winRatePct}%`, hint: "win rate of tagged signals" },
                { label: "TAGGED AVG NET", value: ts.tagged.avgNetPct === null ? "—" : `${ts.tagged.avgNetPct >= 0 ? "+" : ""}${ts.tagged.avgNetPct}%`, hint: "avg net PNL% of tagged signals" },
                { label: "ALIGNED NET $", value: `$${ts.taggedAligned.totalNetUsd.toFixed(2)}`, hint: "net USD of direction-aligned tagged signals" },
                { label: "COUNTER NET $", value: `$${ts.taggedCounter.totalNetUsd.toFixed(2)}`, hint: "net USD of counter-direction tagged signals" },
              ].map((c) => (
                <div key={c.label} className="rounded-md border border-white/8 bg-white/[0.02] px-2.5 py-1.5" title={c.hint}>
                  <div className="label-tech text-[9px] text-ink-3">{c.label}</div>
                  <div className="font-terminal text-sm font-bold tabular-nums text-ink">{c.value}</div>
                </div>
              ))}
              <div className="col-span-2 mt-1 sm:col-span-4">
                {ts.tagged.n > 0 && ts.rest.n > 0 && ts.tagged.avgNetPct !== null && ts.rest.avgNetPct !== null ? (
                  <p className="text-[11px] leading-snug text-ink-3">
                    Rest baseline: n={ts.rest.n} · WR {ts.rest.winRatePct}% · avg net {ts.rest.avgNetPct >= 0 ? "+" : ""}
                    {ts.rest.avgNetPct}% · net ${ts.rest.totalNetUsd.toFixed(2)} — tagged-vs-rest expectancy Δ{" "}
                    <span className={cn("font-bold", ts.tagged.avgNetPct - ts.rest.avgNetPct >= 0 ? "text-neon" : "text-danger-neon")}>
                      {ts.tagged.avgNetPct - ts.rest.avgNetPct >= 0 ? "+" : ""}
                      {(ts.tagged.avgNetPct - ts.rest.avgNetPct).toFixed(2)}%
                    </span>{" "}
                    (calibrator admits the pattern only if Δ holds positive with n ≥ 30).
                  </p>
                ) : (
                  <p className="text-[11px] leading-snug text-ink-3">
                    Awaiting the first settled VOL-ONSET-tagged signal — the loop rebuilds stats as the new corpus settles
                    ({ts.settledTotal} settled so far). Engine tags deployments at scan time; telemetry-only contract, vote 0.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="label-tech mt-2 text-[10px] text-ink-3">MEASURING…</p>
          )}
        </div>

        {/* research-desk study verdict (forward-return replay, EngineSetting) */}
        {vo?.study && (
          <p className="mt-2 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2 text-[11px] leading-snug text-ink-3">
            <span className="label-tech mr-1.5 text-[10px] text-magenta-neon">RESEARCH</span>
            fwd-6h replay n={vo.study.all.n} · WR {vo.study.all.wr}% (Wilson-LB {vo.study.all.wilsonLB}%) ·
            UP-eruptions <span className="font-bold text-neon">{vo.study.up.meanFwd6 !== null ? `+${vo.study.up.meanFwd6.toFixed(2)}%` : "—"}</span> vs DOWN-eruptions{" "}
            <span className="font-bold text-danger-neon">{vo.study.down.meanFwd6 !== null ? `${vo.study.down.meanFwd6.toFixed(2)}%` : "—"}</span> —{" "}
            direction-aware tags (↑/↓) now let the calibrator learn the two strata separately.
          </p>
        )}

        {/* methodology footnote */}
        <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-snug text-ink-3">
          <Activity size={11} className="mt-0.5 shrink-0 text-magenta-neon" aria-hidden />
          Rank = eruption displacement (40) + recency decay “time since eruption bar × coefficient” (30, t½ {vo?.rules.halfLifeMin ?? 180}m) + follow-through (20) + pre-eruption warmth (10) — a leading onset view, unlike the lagging |Δ24h| board.
        </p>
      </div>
    </BentoCard>
  );
}
