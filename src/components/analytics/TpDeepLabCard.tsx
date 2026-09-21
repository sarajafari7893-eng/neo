"use client";

import { useCallback, useEffect, useState } from "react";
import { GraduationCap, Infinity as InfinityIcon } from "lucide-react";
import { NeonBadge } from "@/components/shared/primitives";
import type { TpFunnel } from "@/lib/api-types";
import { cn } from "@/lib/utils";

/**
 * TpDeepLabCard — v6.0 TP ladder depth + the AI deep-learn research desk.
 * Funnel: TP1 → TP2 → full TP3 proven hits vs SL/EXPIRED, then the latest
 * lessons the autonomous LLM research desk distilled from full-TP + stopped-out
 * cases. No manual trigger — the desk researches on its own 30min cycle.
 */

interface DeepLearnLessonDTO {
  at: string;
  scope: string;
  pattern: string;
  evidence: string;
  action: string;
  confidence: number;
  label: string;
}
interface DeepLearnResponse {
  lab?: unknown;
  state?: {
    runs: number;
    casesLearned: number;
    lessons: DeepLearnLessonDTO[];
    label: string;
  };
}

const SCOPE_TONE: Record<string, "neon" | "danger" | "violet"> = {
  TP3_FULL: "neon",
  SL: "danger",
  MIXED: "violet",
};

function FunnelRow({ label, value, total, color, note }: { label: string; value: number; total: number; color: string; note?: string }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-[68px] shrink-0 font-terminal text-[10px] font-bold tracking-[0.1em]" style={{ color }}>
        {label}
      </span>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/5" role="presentation">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color, boxShadow: `0 0 10px ${color}55` }} />
      </div>
      <span className="w-16 shrink-0 text-right font-terminal text-[11px] font-bold tabular-nums text-ink">
        {value}
        {note ? <span className="ml-1 text-[9px] font-normal text-ink-3">{note}</span> : null}
      </span>
    </div>
  );
}

export function TpDeepLabCard({ funnel, className }: { funnel: TpFunnel; className?: string }) {
  const [dl, setDl] = useState<DeepLearnResponse["state"] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ai/deep-learn", { cache: "no-store" });
      if (res.ok) {
        const j = (await res.json()) as DeepLearnResponse;
        setDl(j.state ?? null);
      }
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

  const denom = Math.max(1, funnel.settledOrProven);
  const lessons = dl?.lessons ?? [];

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <NeonBadge tone="cyan" glow>
          TP1 {funnel.tp1Rate}% · TP2 {funnel.tp2Rate}%
        </NeonBadge>
        <NeonBadge tone={funnel.fullTpRate >= 25 ? "neon" : "muted"}>FULL-TP {funnel.fullTpRate}%</NeonBadge>
        <span className="label-tech ml-auto text-ink-3">TP-PROVEN WIN ACCOUNTING</span>
      </div>

      {/* ladder funnel */}
      <div className="mt-3 space-y-2">
        <FunnelRow label="TP1 HIT" value={funnel.tp1Hits} total={denom} color="#45f0df" note={`${funnel.tp1Rate}%`} />
        <FunnelRow label="TP2 HIT" value={funnel.tp2Hits} total={denom} color="#00ffa3" note={`${funnel.tp2Rate}%`} />
        <FunnelRow label="FULL TP3" value={funnel.tp3FullWins} total={denom} color="#b26bff" note={`${funnel.fullTpRate}%`} />
        <FunnelRow label="STOPPED" value={funnel.slLosses} total={denom} color="#ff4d5e" />
        <FunnelRow label="EXPIRED" value={funnel.expired} total={denom} color="#ffb347" />
      </div>

      {funnel.tp3FullWins > 0 && (
        <p className="mt-2 font-terminal text-[10px] tracking-[0.08em] text-ink-3">
          FULL-TP WINNERS: avg conf {funnel.avgConfFullWins} · avg R:R 1:{funnel.avgRrFullWins.toFixed(1)} · avg hold {funnel.avgHoldTp3Min}m
        </p>
      )}

      {/* deep-learn lessons */}
      <div className="mt-4 rounded-lg border border-[rgba(69,240,223,0.18)] bg-[rgba(69,240,223,0.04)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <GraduationCap className="size-3.5 text-cyan-neon" aria-hidden />
          <span className="label-tech text-cyan-neon">DEEP-LEARN DESK — TP3 × STOP-OUT RESEARCH</span>
          {dl && (
            <NeonBadge tone={dl.label === "MODEL" ? "violet" : "muted"}>
              {dl.label === "MODEL" ? "MODEL" : dl.label === "HEURISTIC" ? "HEURISTIC" : "IDLE"} · {dl.runs} RUNS
            </NeonBadge>
          )}
          <NeonBadge tone="violet" glow className="ml-auto">
            <InfinityIcon className="size-3" aria-hidden /> AUTO · 30MIN
          </NeonBadge>
        </div>

        {loading && !dl ? (
          <p className="mt-2 font-terminal text-[10px] text-ink-3">loading research memory…</p>
        ) : lessons.length === 0 ? (
          <p className="mt-2 font-terminal text-[10px] text-ink-3">
            no lessons yet — the desk studies every full-TP &amp; stop-out outcome and stores the patterns here
          </p>
        ) : (
          <ul className="mt-2.5 space-y-2">
            {lessons.slice(0, 2).map((l, i) => (
              <li key={`${l.at}-${i}`} className="rounded border border-white/6 bg-white/[0.02] px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <NeonBadge tone={SCOPE_TONE[l.scope] ?? "muted"}>{l.scope}</NeonBadge>
                  <span className="font-terminal text-[9px] text-ink-3">conf {Math.round(l.confidence)}% · {l.label}</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{l.pattern}</p>
                {l.action && <p className="mt-1 text-[11px] leading-relaxed text-cyan-neon/85">→ {l.action}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
