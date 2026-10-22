"use client";

// ── OPS-SUPERVISOR card (v10.29) — senior-engineer oversight cron visibility ─
// Operator order 2026-09-25: a recurring supervisor cycle (every 2h, pulse-
// riding) that reviews the desk against the operator goals — WIN RATE ↑ and
// daily EST PNL % ↑ — diagnoses root causes from measured KPIs, and issues
// bounded directives (advisor proposals / alerts / journal notes).
// This card surfaces the last cycle + journal and lets the operator force a
// RUN NOW cycle. Poll 45s (the cron itself is self-gated server-side).

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Crosshair, Play, RefreshCw } from "lucide-react";
import { BentoCard, NeonBadge } from "@/components/shared/primitives";

interface OpsDirective {
  kind: "PROPOSAL" | "ALERT" | "NOTE";
  knob?: string;
  proposedValue?: number;
  rationale: string;
  applied?: string;
}

interface OpsCycle {
  at: string;
  verdict: "HEALTHY" | "WATCH" | "DEGRADE" | "CRITICAL";
  label: "MODEL" | "HEURISTIC";
  diagnosis: string;
  rootCauses: string[];
  winRateOutlook: string;
  estPnlOutlook: string;
  directives: OpsDirective[];
  kpis: { wr50: number | null; pnl24hUsd: number | null; estPnlTodayPct: number | null; issueStallMin: number | null };
}

interface OpsState {
  cycles: number;
  lastRunAt: string | null;
  lastCycleAt: number | null;
  intervalMs: number;
  nextDueAt: number | null;
  journal: OpsCycle[];
}

const VERDICT_TONE: Record<string, string> = {
  HEALTHY: "border-mint-neon/50 bg-mint-neon/10 text-mint-neon",
  WATCH: "border-amber-neon/50 bg-amber-neon/10 text-amber-neon",
  DEGRADE: "border-amber-neon/60 bg-amber-neon/15 text-amber-neon",
  CRITICAL: "border-danger-neon/50 bg-danger-neon/10 text-danger-neon",
};

const KIND_TONE: Record<string, string> = {
  PROPOSAL: "text-violet-neon",
  ALERT: "text-danger-neon",
  NOTE: "text-ink-3",
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `:${String(m % 60).padStart(2, "0")}` : ""} ago`;
}

export default function OpsSupervisorCard() {
  const [st, setSt] = useState<OpsState | null>(null);
  const [busy, setBusy] = useState(false);

  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/ops-supervisor", { cache: "no-store" });
      if (res.ok) setSt((await res.json()) as OpsState);
    } catch {
      /* next tick retries */
    }
  }, []);

  useEffect(() => {
    void pull();
    const id = setInterval(pull, 45_000);
    return () => clearInterval(id);
  }, [pull]);

  const runNow = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/ops-supervisor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run-now" }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && json.ok) toast.success("OPS-SUPERVISOR cycle complete — check the digest");
      else toast.error(json.error ?? "cycle failed");
    } catch {
      toast.error("cycle failed");
    } finally {
      setBusy(false);
      void pull();
    }
  }, []);

  const last = st?.journal?.[st.journal.length - 1] ?? null;
  const prev = st?.journal?.[st.journal.length - 2] ?? null;
  const nextDueMin = st?.nextDueAt ? Math.max(0, Math.round((st.nextDueAt - Date.now()) / 60_000)) : null;

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.12}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Crosshair className="size-3.5 text-violet-neon" aria-hidden />
        <span className="label-tech">Ops Supervisor · Senior Engineer</span>
        {last && (
          <NeonBadge tone={last.verdict === "HEALTHY" ? "neon" : last.verdict === "CRITICAL" ? "danger" : "amber"} className="ml-auto">
            {last.verdict} · {last.label}
          </NeonBadge>
        )}
      </div>

      {!st || !last ? (
        <div className="flex flex-col gap-2 py-4 font-terminal text-[11px] text-ink-3">
          <span>{st ? "no cycle yet — first cycle fires on the next 2h cadence (or RUN NOW)" : "linking to the supervisor…"}</span>
        </div>
      ) : (
        <div className="space-y-2.5">
          {/* KPI strip — the operator goals */}
          <div className="grid grid-cols-3 gap-2 font-terminal text-[10px]">
            <div className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1.5">
              <div className="label-tech text-[9px] text-ink-3">WIN RATE 50</div>
              <div className="mt-0.5 font-bold tabular-nums text-ink">{last.kpis.wr50 != null ? `${last.kpis.wr50}%` : "--"}</div>
            </div>
            <div className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1.5">
              <div className="label-tech text-[9px] text-ink-3">EST PNL TODAY</div>
              <div className={`mt-0.5 font-bold tabular-nums ${(last.kpis.estPnlTodayPct ?? 0) >= 0 ? "text-neon" : "text-danger-neon"}`}>
                {last.kpis.estPnlTodayPct != null ? `${last.kpis.estPnlTodayPct >= 0 ? "+" : ""}${last.kpis.estPnlTodayPct}%` : "--"}
              </div>
            </div>
            <div className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1.5">
              <div className="label-tech text-[9px] text-ink-3">PNL 24H</div>
              <div className={`mt-0.5 font-bold tabular-nums ${(last.kpis.pnl24hUsd ?? 0) >= 0 ? "text-neon" : "text-danger-neon"}`}>
                {last.kpis.pnl24hUsd != null ? `${last.kpis.pnl24hUsd >= 0 ? "+" : ""}$${last.kpis.pnl24hUsd}` : "--"}
              </div>
            </div>
          </div>

          {/* diagnosis */}
          <p className="text-[11px] leading-relaxed text-ink-2" title={last.diagnosis}>
            {last.diagnosis}
          </p>

          {/* root causes + directives — bounded scroll */}
          {(last.rootCauses.length > 0 || last.directives.length > 0) && (
            <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1" style={{ scrollbarWidth: "thin" }}>
              {last.rootCauses.map((r, i) => (
                <div key={`rc-${i}`} className="flex items-start gap-1.5 font-terminal text-[10px] text-amber-neon/90">
                  <span aria-hidden>▸</span>
                  <span>{r}</span>
                </div>
              ))}
              {last.directives.map((d, i) => (
                <div key={`d-${i}`} className="rounded border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="flex items-center gap-1.5 font-terminal text-[9px] font-bold tracking-[0.1em]">
                    <span className={KIND_TONE[d.kind] ?? "text-ink-3"}>[{d.kind}]</span>
                    {d.knob && (
                      <span className="tabular-nums text-ink-2">
                        {d.knob}
                        {typeof d.proposedValue === "number" ? ` → ${d.proposedValue}` : ""}
                      </span>
                    )}
                    {d.applied && <span className="ml-auto truncate text-[9px] text-ink-3">{d.applied}</span>}
                  </div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-ink-2">{d.rationale}</p>
                </div>
              ))}
            </div>
          )}

          {/* footer: cadence + controls */}
          <div className="flex items-center justify-between gap-2 border-t border-white/8 pt-2 font-terminal text-[9px] text-ink-3">
            <span>
              cycle #{st.cycles} · last {ago(last.at)}
              {prev ? ` · prev ${prev.verdict}` : ""}
              {nextDueMin != null ? ` · next in ${nextDueMin >= 60 ? `${Math.floor(nextDueMin / 60)}h${nextDueMin % 60 ? `:${String(nextDueMin % 60).padStart(2, "0")}` : ""}` : `${nextDueMin}m`}` : ""}
            </span>
            <button
              type="button"
              onClick={runNow}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[rgb(var(--neon-rgb)/0.35)] bg-[rgb(var(--neon-rgb)/0.06)] px-2.5 font-terminal text-[10px] font-bold tracking-[0.12em] text-neon transition-all hover:bg-[rgb(var(--neon-rgb)/0.14)] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Force a supervisor cycle now"
            >
              {busy ? <RefreshCw size={10} className="animate-spin" aria-hidden /> : <Play size={10} aria-hidden />}
              RUN NOW
            </button>
          </div>
        </div>
      )}
    </BentoCard>
  );
}
