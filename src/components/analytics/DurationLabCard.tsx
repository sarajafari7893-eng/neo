"use client";

import { useCallback, useEffect, useState } from "react";
import { Hourglass, Skull, Stethoscope } from "lucide-react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { NeonBadge } from "@/components/shared/primitives";
import { AXIS_LINE_STROKE, AXIS_TICK, DANGER, GRID_STROKE, MUTED_LINE, NexusTooltip, NEON, AMBER } from "./chart-theme";
import { cn } from "@/lib/utils";
import type { DurationReport } from "@/lib/duration";

/**
 * DurationLabCard — v6.7.1 TIMING FORENSICS (operator mandate 2026-09-08).
 * Answers, with evidence: how long do signals stay open (min/median/avg/max),
 * what is the status-rate by holding duration, and WHY do some trades die at
 * SL inside minutes — BE-trail fee-only exits are separated from REAL fast
 * kills, each carrying its deploy-time flow snapshot (CVD / OI / funding /
 * flow verdict) as the senior-core training evidence chain.
 */

const FMT_MIN = (m: number): string => (m >= 60 ? `${(m / 60).toFixed(m >= 600 ? 0 : 1)}h` : `${m.toFixed(m < 10 ? 1 : 0)}m`);

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "neon" | "amber" | "danger" }) {
  const color = tone === "danger" ? DANGER : tone === "amber" ? AMBER : NEON;
  return (
    <div className="min-w-0 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2.5">
      <div className="label-tech truncate text-ink-3">{label}</div>
      <div className="mt-1 font-terminal text-lg font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 truncate font-terminal text-[9px] text-ink-3">{sub}</div> : null}
    </div>
  );
}

export function DurationLabCard({ className }: { className?: string }) {
  const [rep, setRep] = useState<DurationReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/analytics/duration", { cache: "no-store" });
      if (res.ok) setRep((await res.json()) as DurationReport);
    } catch {
      /* keep previous state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 120_000);
    return () => clearInterval(iv);
  }, [load]);

  if (loading && !rep) {
    return (
      <div className="flex min-h-[220px] items-center justify-center gap-2 font-terminal text-[11px] text-ink-3" role="status" aria-live="polite">
        <Hourglass className="size-3.5 animate-spin" aria-hidden />
        COMPUTING TIMING FORENSICS…
      </div>
    );
  }
  if (!rep) {
    return <div className="p-4 font-terminal text-[11px] text-ink-3">duration lab unavailable — retrying on next cycle</div>;
  }

  const fk = rep.fastKill;
  const realCases = fk.cases.filter((c) => c.realKill);
  const beCases = fk.cases.filter((c) => c.beTrailExit);

  return (
    <div className={cn("min-w-0", className)}>
      {/* ── summary tiles ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="MIN OPEN" value={FMT_MIN(rep.summary.min)} sub="fastest settled close" tone="amber" />
        <StatTile label="MEDIAN OPEN" value={FMT_MIN(rep.summary.median)} sub={`p25 ${FMT_MIN(rep.summary.p25)} · p75 ${FMT_MIN(rep.summary.p75)}`} />
        <StatTile label="AVG OPEN" value={FMT_MIN(rep.summary.avg)} sub={`${rep.settledN} settled · ${rep.activeN} active`} />
        <StatTile label="MAX OPEN" value={FMT_MIN(rep.summary.max)} sub={`p95 ${FMT_MIN(rep.summary.p95)}`} tone="neon" />
      </div>

      {/* ── win-rate by holding duration ── */}
      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="label-tech text-ink-2">STATUS RATE × HOLDING DURATION</span>
          <NeonBadge tone={rep.timeToTp1.n ? "violet" : "muted"}>TP1 CLOCK · MEDIAN {FMT_MIN(rep.timeToTp1.median)}</NeonBadge>
          <span className="label-tech ml-auto text-ink-3">BARS ΣPNL$ · LINE WIN%</span>
        </div>
        <div className="mt-2 h-[190px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rep.buckets} margin={{ top: 6, right: 4, bottom: 0, left: -18 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: AXIS_LINE_STROKE }} tickLine={false} />
              <YAxis yAxisId="usd" tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <YAxis yAxisId="wr" orientation="right" domain={[0, 100]} tick={AXIS_TICK} axisLine={false} tickLine={false} unit="%" />
              <Tooltip cursor={{ fill: "rgb(var(--neon-rgb)/0.05)" }} content={<NexusTooltip prefix="$" />} />
              <ReferenceLine yAxisId="usd" y={0} stroke={MUTED_LINE} />
              <Bar yAxisId="usd" dataKey="sumPnlUsd" name="Σ PNL $" radius={[3, 3, 0, 0]} maxBarSize={38}>
                {rep.buckets.map((b) => (
                  <Cell key={b.label} fill={b.sumPnlUsd >= 0 ? NEON : DANGER} fillOpacity={b.n === 0 ? 0.15 : 0.8} />
                ))}
              </Bar>
              <Line yAxisId="wr" type="monotone" dataKey="winRate" name="WIN %" stroke={NEON} strokeWidth={2} dot={{ r: 3, fill: NEON }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-1 font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-ink-3">
          {rep.buckets.map((b) => `${b.label}: n=${b.n} wr=${b.winRate}%`).join(" · ")}
        </p>
      </div>

      {/* ── fast-kill evidence table ── */}
      <div className="mt-4 rounded-lg border border-[rgba(255,77,94,0.22)] bg-[rgba(255,77,94,0.04)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Skull className="size-3.5 text-danger-neon" aria-hidden />
          <span className="label-tech text-danger-neon">FAST-KILL EVIDENCE — &lt;15MIN STRAIGHT-TO-SL</span>
          <NeonBadge tone="danger" glow className="ml-auto">
            REAL {realCases.length}
          </NeonBadge>
          <NeonBadge tone="muted">BE-TRAIL {beCases.length}</NeonBadge>
        </div>

        {/* diagnosis */}
        <div className="mt-2.5 rounded border border-white/8 bg-white/[0.02] p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Stethoscope className="size-3 text-amber-neon" aria-hidden />
            <span className="label-tech text-amber-neon">DIAGNOSIS</span>
            <NeonBadge tone={rep.diagnosis.verdict === "LATE_ENTRY_CASCADE_CHASE" ? "amber" : "muted"}>{rep.diagnosis.verdict}</NeonBadge>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{rep.diagnosis.headline}</p>
          <ul className="mt-1.5 space-y-1">
            {rep.diagnosis.evidence.slice(0, 5).map((e, i) => (
              <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-ink-3">
                <span className="mt-[3px] inline-block size-1 shrink-0 rounded-full bg-amber-neon/70" aria-hidden />
                {e}
              </li>
            ))}
          </ul>
        </div>

        {/* evidence rows — scrollable */}
        <div className="mt-2.5 max-h-96 overflow-auto scrollbar-thin" role="region" aria-label="Fast kill evidence table">
          <table className="w-full min-w-[560px] border-collapse font-terminal text-[10px] tabular-nums">
            <thead className="sticky top-0 z-10 bg-[rgba(5,8,10,0.92)] backdrop-blur">
              <tr className="text-left text-ink-3">
                <th className="px-1.5 py-1.5 font-normal">CASE</th>
                <th className="px-1.5 py-1.5 font-normal">DIR</th>
                <th className="px-1.5 py-1.5 text-right font-normal">DUR</th>
                <th className="px-1.5 py-1.5 text-right font-normal">SL DIST</th>
                <th className="px-1.5 py-1.5 text-right font-normal">MFE</th>
                <th className="px-1.5 py-1.5 text-right font-normal">SCORE</th>
                <th className="px-1.5 py-1.5 text-right font-normal">FLOW</th>
                <th className="px-1.5 py-1.5 font-normal">VERDICT</th>
              </tr>
            </thead>
            <tbody>
              {rep.fastKill.cases.map((c) => (
                <tr key={c.serial} className={cn("border-t border-white/5", c.beTrailExit ? "opacity-55" : "text-ink-2")}>
                  <td className="px-1.5 py-1.5">
                    <span className="text-ink">NX-{String(c.serial).padStart(4, "0")}</span>
                    <span className="ml-1 text-ink-3">{c.symbol.replace("USDT", "")}</span>
                  </td>
                  <td className={cn("px-1.5 py-1.5 font-bold", c.direction === "LONG" ? "text-cyan-neon" : "text-magenta-neon")}>{c.direction === "LONG" ? "L" : "S"}</td>
                  <td className="px-1.5 py-1.5 text-right font-bold" style={{ color: c.realKill ? DANGER : AMBER }}>
                    {c.durMin < 10 ? c.durMin.toFixed(1) : Math.round(c.durMin)}m
                  </td>
                  <td className="px-1.5 py-1.5 text-right text-ink-3">{c.beTrailExit ? "BE" : `${c.slDistPct.toFixed(2)}%·x${Math.round(c.leveredRiskPct / Math.max(c.slDistPct, 0.01))}`}</td>
                  <td className={cn("px-1.5 py-1.5 text-right", c.mfePct <= 0 ? "text-danger-neon" : "text-ink-3")}>{c.mfePct <= 0 ? "never+" : `+${c.mfePct.toFixed(1)}%`}</td>
                  <td className="px-1.5 py-1.5 text-right text-ink-3">{c.score}</td>
                  <td className={cn("px-1.5 py-1.5 text-right", c.flowVerdict === "CONFIRMS" ? "text-amber-neon" : "text-ink-3")}>
                    {c.flowVerdict === "CONFIRMS" ? `+${c.flowScore}` : c.flowVerdict === "CONFLICTS" ? `${c.flowScore}` : "—"}
                  </td>
                  <td className="px-1.5 py-1.5">
                    {c.beTrailExit ? (
                      <span className="text-ink-3">BE-TRAIL · fee-only</span>
                    ) : (
                      <span className="text-danger-neon">
                        {c.mfePct <= 0 ? "LATE ENTRY" : "FAKEOUT"}
                        {c.flowVerdict === "CONFIRMS" ? " · flow-chased" : ""}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-2 font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-ink-3">
          BE-TRAIL = STOP TRAILED TO ENTRY (v6.5 MID-LADDER ARM) → FEE-ONLY EXIT, NOT A REAL LOSS · LATE ENTRY = NEVER GREEN (MFE≤0) · FAKEOUT = WENT GREEN THEN REVERSED · EVIDENCE PERSISTED TO ENGINESETTING "duration.forensics" FOR THE SENIOR CORE ENGINEER
        </p>
      </div>
    </div>
  );
}

