"use client";

// ── v5.1 AI AGENT — SKILLS & AUTONOMY manifest ──
// Q2: "آیا برای AI اسکیل و دستوری تعیین شده؟ آیا مانند یک ایجنت مستقل آموزش و عمل می‌کند؟"
// This card is the honest answer rendered from /api/ai/agent: the SKILLS the agent
// may execute, the AUTHORITY clamps that bound them, the MEMORY it learns from,
// and the RECENT ACTIONS it took on its own — all measured, none invented.

import { useCallback, useEffect, useState } from "react";
import { Bot, ShieldCheck, GraduationCap, History, Cpu, Eye } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";

interface Skill {
  id: string;
  name: string;
  scope: string;
  autonomous: boolean;
  state: string;
}

interface AgentManifest {
  version: string;
  mandate: string;
  skills: Skill[];
  authority: {
    clamps: Record<string, { min: number; max: number; def: number }>;
    current: Record<string, number>;
    describe: string;
    note: string;
  };
  memory: {
    settledSignals: number;
    realizedWinRate: number;
    calibration: { status: string; settled: number; target: number; rows: number };
    learnedGate: { allowed: boolean; reason: string };
    learner: { auto: boolean; intervalHours: number; lastRunAt: string | null };
    lastBacktest: { n: number; winRate: number; wilsonLB: number; avgNetPct: number; verdict: string } | null;
  };
  autonomy: { governorEngaged: boolean; manualModesRemoved?: boolean; intervalMin: number; maxActions: number; cycles: number; running: boolean };
  recentActions: Array<{ at: string; message: string }>;
  supervisor?: {
    checks: number;
    audits: number;
    hallucinationFlags: number;
    simulationFlags: number;
    llmRing?: Array<{ at: string; source: string; outcome: string }>;
  };
}

const SKILL_TINT: Record<string, string> = {
  MARKET_SCAN: "text-neon",
  DEPLOY_GATES: "text-amber-neon",
  GOVERN: "text-violet-neon",
  BACKTEST_LEARN: "text-cyan-neon",
  CALIBRATE: "text-neon",
  RISK_SENSE: "text-danger-neon",
  VERACITY: "text-magenta-neon",
};

export default function AgentCard() {
  const [m, setM] = useState<AgentManifest | null>(null);
  const [fetching, setFetching] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/agent", { cache: "no-store" });
      if (res.ok) setM((await res.json()) as AgentManifest);
    } catch {
      /* keep last */
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 45_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.05}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Bot className="size-4 text-neon" aria-hidden />
        <div>
          <h3 className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">AI AGENT — SKILLS &amp; AUTONOMY</h3>
          <p className="label-tech mt-0.5">what the agent may do · what bounds it · what it has learned</p>
        </div>
        <NeonBadge tone="muted" className="ml-auto">
          {m?.version ?? "AI-AGENT v6.0"}
        </NeonBadge>
      </div>

      {!m && fetching && <p className="font-terminal text-[11px] text-ink-3">— loading agent manifest… —</p>}
      {!m && !fetching && <p className="font-terminal text-[11px] text-ink-3">— agent manifest unavailable —</p>}

      {m && (
        <div className="space-y-3">
          {/* mandate */}
          <p className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2 font-terminal text-[10px] leading-relaxed text-ink-2">{m.mandate}</p>

          {/* skills */}
          <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1" aria-label="Agent skills">
            {m.skills.map((s) => (
              <div key={s.id} className="rounded-lg border border-white/8 bg-white/[0.02] p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Cpu className={cn("size-3.5 shrink-0", SKILL_TINT[s.id] ?? "text-neon")} aria-hidden />
                  <span className="font-terminal text-[11px] font-bold uppercase tracking-[0.12em] text-ink">{s.name}</span>
                  <NeonBadge tone={s.autonomous ? "cyan" : "muted"} className="ml-auto">
                    <LiveDot tone={s.autonomous ? "neon" : "amber"} /> {s.autonomous ? "AUTONOMOUS" : "STANDBY"}
                  </NeonBadge>
                </div>
                <p className="mt-1 font-terminal text-[10px] leading-relaxed text-ink-2">{s.scope}</p>
                <p className="mt-0.5 font-terminal text-[9px] uppercase tracking-[0.08em] text-ink-3">state: {s.state}</p>
              </div>
            ))}
          </div>

          {/* authority */}
          <div className="rounded-lg border border-[rgba(255,179,71,0.25)] bg-[rgba(255,179,71,0.04)] p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 font-terminal text-[10px] font-bold uppercase tracking-[0.12em] text-amber-neon">
              <ShieldCheck className="size-3.5" aria-hidden /> authority bounds — hard clamps the agent can never cross
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {Object.entries(m.authority.clamps).map(([k, c]) => (
                <div key={k} className="rounded border border-white/8 bg-black/30 px-2 py-1.5">
                  <p className="truncate font-terminal text-[8px] uppercase tracking-[0.1em] text-ink-3">{k}</p>
                  <p className="font-terminal text-[11px] font-bold tabular-nums text-ink">
                    {m.authority.current[k] ?? "–"}
                    <span className="text-[8px] font-normal text-ink-3"> ({c.min}–{c.max})</span>
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-1.5 font-terminal text-[9px] text-ink-3">{m.authority.note}</p>
          </div>

          {/* memory / learning */}
          <div className="rounded-lg border border-white/8 bg-white/[0.02] p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 font-terminal text-[10px] font-bold uppercase tracking-[0.12em] text-cyan-neon">
              <GraduationCap className="size-3.5" aria-hidden /> learned memory — how it improves
            </div>
            <div className="grid grid-cols-2 gap-1.5 font-terminal text-[10px] sm:grid-cols-4">
              <div className="rounded border border-white/8 bg-black/30 px-2 py-1.5">
                <p className="text-[8px] uppercase tracking-[0.1em] text-ink-3">SETTLED</p>
                <p className="font-bold tabular-nums text-ink">{m.memory.settledSignals}</p>
              </div>
              <div className="rounded border border-white/8 bg-black/30 px-2 py-1.5">
                <p className="text-[8px] uppercase tracking-[0.1em] text-ink-3">REALIZED WR</p>
                <p className={cn("font-bold tabular-nums", m.memory.realizedWinRate >= 25 ? "text-neon" : "text-danger-neon")}>{m.memory.realizedWinRate}%</p>
              </div>
              <div className="rounded border border-white/8 bg-black/30 px-2 py-1.5">
                <p className="text-[8px] uppercase tracking-[0.1em] text-ink-3">CALIBRATION</p>
                <p className="font-bold text-ink">
                  {m.memory.calibration.status} <span className="text-[8px] text-ink-3">{m.memory.calibration.settled}/{m.memory.calibration.target}</span>
                </p>
              </div>
              <div className="rounded border border-white/8 bg-black/30 px-2 py-1.5">
                <p className="text-[8px] uppercase tracking-[0.1em] text-ink-3">LEARNED GATE</p>
                <p className={cn("font-bold", m.memory.learnedGate.allowed ? "text-neon" : "text-amber-neon")}>{m.memory.learnedGate.allowed ? "OPEN" : "SUPPRESSED"}</p>
              </div>
            </div>
            {m.memory.lastBacktest && (
              <p className="mt-1.5 font-terminal text-[9px] leading-relaxed text-ink-3">
                last replay: n={m.memory.lastBacktest.n} · WR {m.memory.lastBacktest.winRate}% · Wilson-LB {m.memory.lastBacktest.wilsonLB}% · expectancy {m.memory.lastBacktest.avgNetPct}%/trade — {m.memory.lastBacktest.verdict} · learner auto {m.memory.learner.auto ? `every ${m.memory.learner.intervalHours}h` : "off"}
              </p>
            )}
          </div>

          {/* VERACITY WATCHDOG — the supervisor's anti-hallucination / anti-simulation duty (v6.0) */}
          {m.supervisor && (
            <div className="rounded-lg border border-[rgba(255,78,205,0.25)] bg-[rgba(255,78,205,0.04)] p-2.5">
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5 font-terminal text-[10px] font-bold uppercase tracking-[0.12em] text-magenta-neon">
                <Eye className="size-3.5" aria-hidden /> veracity watchdog — zero hallucination, zero simulation
                <NeonBadge tone={m.supervisor.hallucinationFlags === 0 && m.supervisor.simulationFlags === 0 ? "neon" : "amber"} className="ml-auto">
                  <LiveDot tone={m.supervisor.hallucinationFlags === 0 && m.supervisor.simulationFlags === 0 ? "neon" : "amber"} />
                  {m.supervisor.hallucinationFlags === 0 && m.supervisor.simulationFlags === 0 ? "ALL CLEAN" : "FLAGS RAISED"}
                </NeonBadge>
              </div>
              <div className="grid grid-cols-2 gap-1.5 font-terminal text-[10px] sm:grid-cols-4">
                <div className="rounded border border-white/8 bg-black/30 px-2 py-1.5">
                  <p className="text-[8px] uppercase tracking-[0.1em] text-ink-3">OUTPUTS AUDITED</p>
                  <p className="font-bold tabular-nums text-ink">{m.supervisor.audits}</p>
                </div>
                <div className="rounded border border-white/8 bg-black/30 px-2 py-1.5">
                  <p className="text-[8px] uppercase tracking-[0.1em] text-ink-3">HALLUCINATION FLAGS</p>
                  <p className={cn("font-bold tabular-nums", m.supervisor.hallucinationFlags === 0 ? "text-neon" : "text-danger-neon")}>{m.supervisor.hallucinationFlags}</p>
                </div>
                <div className="rounded border border-white/8 bg-black/30 px-2 py-1.5">
                  <p className="text-[8px] uppercase tracking-[0.1em] text-ink-3">SIMULATION FLAGS</p>
                  <p className={cn("font-bold tabular-nums", m.supervisor.simulationFlags === 0 ? "text-neon" : "text-amber-neon")}>{m.supervisor.simulationFlags}</p>
                </div>
                <div className="rounded border border-white/8 bg-black/30 px-2 py-1.5">
                  <p className="text-[8px] uppercase tracking-[0.1em] text-ink-3">WATCH CHECKS</p>
                  <p className="font-bold tabular-nums text-ink">{m.supervisor.checks}</p>
                </div>
              </div>
              <p className="mt-1.5 font-terminal text-[9px] leading-relaxed text-ink-3">
                every model reply is audited number-by-number against the measured telemetry it saw — cited numbers that do not exist are flagged as hallucination; heuristic fallbacks must stay honestly labeled (no simulation). Full autonomy, zero manual modes.
              </p>
            </div>
          )}

          {/* recent autonomous actions */}
          {m.recentActions.length > 0 && (
            <div className="rounded-lg border border-white/8 bg-white/[0.02] p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5 font-terminal text-[10px] font-bold uppercase tracking-[0.12em] text-violet-neon">
                <History className="size-3.5" aria-hidden /> recent autonomous actions
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                {m.recentActions.map((a, i) => (
                  <p key={`${a.at}-${i}`} className="font-terminal text-[9px] leading-relaxed text-ink-3">
                    <span className="text-ink-2">{a.at.slice(5, 16).replace("T", " ")}</span> · {a.message}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </BentoCard>
  );
}
