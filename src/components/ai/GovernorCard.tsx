"use client";

// ── v6.0 AI GOVERNOR — the LLM analyst as a PERMANENT operator ──
// FULL AUTONOMY (operator mandate: «هیچ حالت دستی برای یادگیری و استقرار
// نباید باشه»): the governor is always engaged, cycles on its own scheduler,
// and tunes deployment gates only inside operator clamps. The manual
// ENGAGE/DISENGAGE and RUN CYCLE controls were removed — this card is a
// read-only window into autonomous decision-making.

import { useCallback, useEffect, useState } from "react";
import { BrainCircuit, ShieldCheck, ScrollText, Infinity as InfinityIcon } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";

interface GovernorDecisionRow {
  action: string;
  value?: number;
  rationale: string;
  applied: boolean;
}

interface GovernorLogRow {
  at: string;
  trigger: "auto" | "supervisor";
  label: "MODEL" | "HEURISTIC";
  gatesBefore: string;
  gatesAfter: string;
  applied: number;
  decisions: GovernorDecisionRow[];
}

interface GovernorState {
  enabled: boolean;
  intervalMin: number;
  maxActions: number;
  cycles: number;
  lastRunAt: string | null;
  running: boolean;
  log: GovernorLogRow[];
}

const ACTION_LABEL: Record<string, string> = {
  set_min_score: "MIN_SCORE →",
  set_flow_veto: "FLOW-VETO →",
  set_flow_shortlist: "SHORTLIST →",
  set_universe: "UNIVERSE →",
  run_backtest: "RUN REPLAY",
  run_autotune: "RUN AUTO-TUNE",
  no_op: "HOLD (no-op)",
};

const TRIGGER_LABEL: Record<string, string> = {
  auto: "AUTO SCHEDULER",
  supervisor: "SUPERVISOR NUDGE",
};

export default function GovernorCard() {
  const [state, setState] = useState<GovernorState | null>(null);
  const [fetching, setFetching] = useState(true);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/governor", { cache: "no-store" });
      if (res.ok) setState((await res.json()) as GovernorState);
    } catch {
      /* keep last state */
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    void fetchState();
    const t = setInterval(() => void fetchState(), 30_000);
    return () => clearInterval(t);
  }, [fetchState]);

  const s = state;
  const running = s?.running ?? false;

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.1}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <BrainCircuit className="size-4 text-violet-neon" aria-hidden />
        <div>
          <h3 className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">AI GOVERNOR</h3>
          <p className="label-tech mt-0.5">LLM wired into the core · permanently engaged · zero manual modes (v6.0)</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {running ? (
            <NeonBadge tone="violet" glow>
              <LiveDot tone="violet" /> CYCLING…
            </NeonBadge>
          ) : (
            <NeonBadge tone="violet" glow>
              <InfinityIcon className="size-3" aria-hidden /> FULLY AUTONOMOUS
            </NeonBadge>
          )}
        </div>
      </div>

      {/* mandate strip */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2 font-terminal text-[10px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="size-3.5 text-neon" aria-hidden /> authority: gate tunables only, hard clamps enforced
        </span>
        <span className="text-ink-3">
          auto-cycle every {s?.intervalMin ?? 45}m · max {s?.maxActions ?? 2} actions · {s?.cycles ?? 0} cycles run
        </span>
        {s?.lastRunAt && <span className="text-ink-3">last {s.lastRunAt.slice(11, 16)}Z ({s.lastRunAt.slice(0, 10)})</span>}
      </div>

      {fetching && !s && <p className="font-terminal text-[11px] text-ink-3">— loading governor state… —</p>}

      {s && s.log.length === 0 && !fetching && (
        <p className="font-terminal text-[11px] leading-relaxed text-ink-3">
          The governor runs itself — every {s.intervalMin}min it feeds the LLM analyst the full measured telemetry bundle (gates, realized win-rate, learner verdict, flow coverage, open risk) and applies the returned decisions ONLY inside operator clamps. No operator trigger exists; the supervisor can nudge it during droughts.
        </p>
      )}

      {/* decision log */}
      {s && s.log.length > 0 && (
        <div className="max-h-64 space-y-2 overflow-y-auto pr-1" aria-label="Governor decision log">
          {s.log.slice(0, 6).map((row, i) => (
            <div key={`${row.at}-${i}`} className="rounded-lg border border-white/8 bg-white/[0.02] p-2.5">
              <div className="mb-1.5 flex flex-wrap items-center gap-2 font-terminal text-[9px] uppercase tracking-[0.12em]">
                <span className={cn("rounded border px-1.5 py-0.5 font-bold", row.label === "MODEL" ? "border-violet-neon/40 text-violet-neon" : "border-white/15 text-ink-3")}>{row.label}</span>
                <span className="text-ink-3">{row.at.slice(5, 16).replace("T", " ")}Z</span>
                <span className="text-ink-3">· {TRIGGER_LABEL[row.trigger] ?? row.trigger}</span>
                <span className={cn("ml-auto font-bold", row.applied > 0 ? "text-neon" : "text-ink-3")}>{row.applied}/{row.decisions.length} APPLIED</span>
              </div>
              <div className="space-y-1">
                {row.decisions.map((d, j) => (
                  <div key={`${d.action}-${j}`} className="flex items-start gap-1.5 font-terminal text-[10px] leading-relaxed">
                    <span className={cn("shrink-0 rounded border px-1 font-bold leading-5", d.applied ? "border-[rgb(var(--neon-rgb)/0.5)] text-neon" : "border-white/10 text-ink-3")}>
                      {ACTION_LABEL[d.action] ?? d.action} {d.value !== undefined && typeof d.value === "number" ? d.value : ""}
                    </span>
                    <span className="min-w-0 flex-1 text-ink-3">{d.rationale}</span>
                  </div>
                ))}
              </div>
              {row.gatesBefore !== row.gatesAfter && (
                <p className="mt-1.5 flex items-center gap-1 font-terminal text-[9px] text-ink-3">
                  <ScrollText className="size-3 shrink-0" aria-hidden /> gates: {row.gatesBefore} → <span className="text-neon">{row.gatesAfter}</span>
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </BentoCard>
  );
}
