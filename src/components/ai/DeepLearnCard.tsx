"use client";

import { useCallback, useEffect, useState } from "react";
import { FlaskConical, Infinity as InfinityIcon } from "lucide-react";
import { BentoCard, NeonBadge } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";

/**
 * DeepLearnCard — v6.0 AI research desk panel (AI CORE section).
 * Shows the full-TP × stop-out research memory: lab contrast, the latest
 * lessons (pattern → evidence → action). FULLY AUTONOMOUS: the desk studies
 * every TP3/stop-out outcome on its own 30min cycle — no manual trigger exists.
 */

interface LessonDTO {
  at: string;
  scope: string;
  pattern: string;
  evidence: string;
  action: string;
  confidence: number;
  label: string;
}
interface LabDTO {
  fullTp: { count: number; ratePct: number; avgConfidence: number; avgRr: number; avgHoldMin: number; flowConfirmShare: number };
  stopped: { count: number; avgConfidence: number; avgHoldMin: number; flowConflictShare: number };
  contrast: { confDelta: number; rrDelta: number; note: string };
}
interface StateDTO {
  lastRunAt: string | null;
  runs: number;
  casesLearned: number;
  lessons: LessonDTO[];
  lastQuestion: string | null;
  lastAnswer: string | null;
  label: string;
}
interface ApiResponse {
  lab?: LabDTO;
  state?: StateDTO;
}

const SCOPE_TONE: Record<string, "neon" | "danger" | "violet"> = {
  TP3_FULL: "neon",
  SL: "danger",
  MIXED: "violet",
};

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="glass-soft rounded-lg px-2.5 py-2">
      <div className="label-tech text-[9px]">{label}</div>
      <div className={cn("mt-0.5 font-terminal text-sm font-bold tabular-nums", tone ?? "text-ink")}>{value}</div>
    </div>
  );
}

export default function DeepLearnCard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/deep-learn", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as ApiResponse);
    } catch {
      /* keep previous */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 120_000);
    return () => clearInterval(iv);
  }, [load]);

  const state = data?.state;
  const lab = data?.lab;
  const lessons = state?.lessons ?? [];

  return (
    <BentoCard className="mt-4 p-4 sm:p-5" delay={0.05}>
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="size-4 text-violet-neon" aria-hidden />
        <span className="label-tech">AI DEEP-LEARN LAB — TP3 × STOP-OUT RESEARCH DESK</span>
        <NeonBadge tone={state?.label === "MODEL" ? "violet" : state?.label === "HEURISTIC" ? "amber" : "muted"}>
          {state?.label ?? "IDLE"} · {state?.runs ?? 0} CYCLES
        </NeonBadge>
        <NeonBadge tone="violet" glow className="ml-auto">
          <InfinityIcon className="size-3" aria-hidden /> AUTO · EVERY 30MIN
        </NeonBadge>
      </div>

      <p className="mt-2 font-terminal text-[10px] leading-relaxed tracking-[0.06em] text-ink-3">
        FULLY AUTONOMOUS RESEARCH DESK — EVERY FULL-TP (TP3) AND STOPPED-OUT DEPLOYMENT GOES THROUGH AN LLM RESEARCH Q&amp;A ON ITS OWN 30MIN CYCLE; LESSONS ARE STORED AND INJECTED INTO EVERY AGENT (ANALYST · GOVERNOR · CARD BRIEFS). NO MANUAL TRIGGER EXISTS (v6.0).
      </p>

      {/* lab contrast KPIs */}
      {lab && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Kpi label="FULL-TP WINS" value={String(lab.fullTp.count)} tone="text-neon" />
          <Kpi label="FULL-TP RATE" value={`${lab.fullTp.ratePct}%`} tone="text-neon" />
          <Kpi label="STOP-OUTS" value={String(lab.stopped.count)} tone="text-danger-neon" />
          <Kpi
            label="CONF Δ WIN/LOSS"
            value={`${lab.contrast.confDelta >= 0 ? "+" : ""}${lab.contrast.confDelta}`}
            tone={lab.contrast.confDelta >= 0 ? "text-cyan-neon" : "text-amber-neon"}
          />
        </div>
      )}

      {lab && (
        <p className="mt-2 rounded border border-white/6 bg-white/[0.02] px-2.5 py-2 text-xs leading-relaxed text-ink-2">
          <span className="font-terminal text-[9px] font-bold tracking-[0.18em] text-cyan-neon">MEASURED CONTRAST · </span>
          {lab.contrast.note}
        </p>
      )}

      {/* lessons */}
      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
        {loading && !state ? (
          <p className="font-terminal text-[10px] text-ink-3">loading research memory…</p>
        ) : lessons.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center font-terminal text-[10px] uppercase tracking-[0.2em] text-ink-3">
            NO LESSONS YET — CYCLES RUN AUTOMATICALLY AS TP3/SL OUTCOMES SETTLE
          </div>
        ) : (
          lessons.map((l, i) => (
            <article key={`${l.at}-${i}`} className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <NeonBadge tone={SCOPE_TONE[l.scope] ?? "muted"}>{l.scope}</NeonBadge>
                <NeonBadge tone={l.label === "MODEL" ? "violet" : "muted"}>{l.label}</NeonBadge>
                <span className="font-terminal text-[9px] tracking-[0.12em] text-ink-3">
                  conf {Math.round(l.confidence)}% · {new Date(l.at).toISOString().slice(5, 16).replace("T", " ")}Z
                </span>
              </div>
              <p className="mt-1.5 text-sm font-medium leading-relaxed text-ink">{l.pattern}</p>
              {l.evidence && <p className="mt-1 text-xs leading-relaxed text-ink-3">evidence: {l.evidence}</p>}
              {l.action && <p className="mt-1.5 text-xs leading-relaxed text-cyan-neon/90">→ {l.action}</p>}
            </article>
          ))
        )}
      </div>

      {state?.lastAnswer && (
        <details className="mt-3 rounded-lg border border-[rgba(69,240,223,0.2)] bg-[rgba(69,240,223,0.04)] px-3 py-2">
          <summary className="cursor-pointer font-terminal text-[10px] font-bold tracking-[0.18em] text-cyan-neon">
            LATEST RESEARCH Q&amp;A TRANSCRIPT
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink-2">{state.lastAnswer}</p>
        </details>
      )}
    </BentoCard>
  );
}
