"use client";

// ── AI ADVISOR panel (v6.6) — the operator-approval desk ────────────────────
// Shows the evidence-gated calibration proposals the advisor queued, the
// BREAKOUT conditional-trial tracker, and recent decisions. APPROVE is the
// only button in the whole app that can move a gate knob from outside the
// governor — the Q3 contract: the engine proposes, THE OPERATOR disposes.

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Brain, ChevronRight, Gavel, Loader2, RefreshCw, Scale, XCircle } from "lucide-react";
import { toast } from "sonner";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/format";
import { nexusMutate, OperatorAuthRequiredError } from "@/lib/nexus-client";

interface Proposal {
  id: string;
  cycle: number;
  knob: string;
  currentValue: number;
  proposedValue: number;
  direction: string;
  rationale: string;
  evidence: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  applyNote: string | null;
}

interface AdvisorPayload {
  state: { cycles: number; lastRunAt: string | null };
  pendingCount: number;
  proposals: Proposal[];
  experiment: {
    guard: number;
    cohortN: number;
    pf: number | null;
    pnlUsd: number;
    targetN: number;
    threshold: number;
    verdict: string;
  };
  stats: {
    settled: number;
    last20PnlUsd: number;
  };
}

const STATUS_TONE: Record<string, string> = {
  PENDING: "text-amber-neon border-[rgba(255,179,71,0.4)] bg-[rgba(255,179,71,0.08)]",
  APPLIED: "text-neon border-[rgba(0,255,157,0.4)] bg-[rgba(0,255,157,0.08)]",
  REJECTED: "text-danger-neon border-[rgba(255,77,94,0.4)] bg-[rgba(255,77,94,0.08)]",
  EXPIRED: "text-ink-3 border-white/10 bg-white/[0.02]",
};

export default function AdvisorCard() {
  const [data, setData] = useState<AdvisorPayload | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/advisor", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as AdvisorPayload);
    } catch {
      /* keep last snapshot */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    const c = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, [load]);

  const decide = useCallback(
    async (id: string, action: "approve" | "reject") => {
      setBusyId(id);
      try {
        // Task 34-1: auth-aware mutation — missing operator session surfaces a
        // guided login toast instead of a raw "unauthorized" error
        await nexusMutate<{ ok?: boolean; error?: string; proposal?: unknown }>("/api/advisor", { action, id });
        toast.success(action === "approve" ? "Proposal APPROVED — gate applied & audited" : "Proposal REJECTED — knob untouched, cooldown armed");
        await load();
      } catch (e) {
        if (!(e instanceof OperatorAuthRequiredError)) {
          toast.error(`Decision failed: ${e instanceof Error ? e.message : "advisor unreachable"}`);
        }
        // OperatorAuthRequiredError already showed its own guided toast
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const runCycle = useCallback(async () => {
    setRunning(true);
    try {
      // Task 34-1 bugfix: this path never checked res.ok — a 401/500 surfaced
      // as a SUCCESS toast with "0 proposals queued". Now honest end-to-end.
      const j = await nexusMutate<{ ok?: boolean; queued?: number; error?: string; skipped?: number }>("/api/advisor", { action: "run" });
      if (!j.ok) throw new Error(j.error ?? "cycle rejected");
      toast.success(`Advisor cycle complete — ${j.queued ?? 0} proposal(s) queued${j.skipped ? ` · ${j.skipped} skipped` : ""}`);
      await load();
    } catch (e) {
      if (!(e instanceof OperatorAuthRequiredError)) {
        toast.error(`Advisor cycle failed: ${e instanceof Error ? e.message : "advisor unreachable"}`);
      }
    } finally {
      setRunning(false);
    }
  }, [load]);

  const pending = data?.proposals.filter((p) => p.status === "PENDING") ?? [];
  const decided = data?.proposals.filter((p) => p.status !== "PENDING").slice(0, 3) ?? [];
  const exp = data?.experiment;

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.12}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Scale className="size-4 text-violet-neon" aria-hidden />
        <div>
          <h3 className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">AI ADVISOR</h3>
          <p className="label-tech mt-0.5">proposes with evidence · operator decides · engine applies</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {data && (
            <NeonBadge tone="muted">
              cycle #{data.state.cycles}
              {data.state.lastRunAt && now > 0 ? ` · ${timeAgo(data.state.lastRunAt, now)}` : ""}
            </NeonBadge>
          )}
          <NeonBadge tone={pending.length > 0 ? "amber" : "violet"} glow>
            <LiveDot tone={pending.length > 0 ? "amber" : "violet"} /> {pending.length} pending
          </NeonBadge>
        </div>
      </div>

      {/* ── BREAKOUT conditional-trial tracker (operator-approved experiment) ── */}
      {exp && (
        <div className="mb-4 rounded-lg border border-[rgba(178,107,255,0.25)] bg-[rgba(178,107,255,0.05)] px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Gavel className="size-3.5 text-violet-neon" aria-hidden />
            <span className="font-terminal text-[10px] font-bold uppercase tracking-[0.14em] text-ink-2">
              BREAKOUT TRIAL — guard {exp.guard === 1 ? "L1 CONDITIONAL (half-size, chop vetoed)" : exp.guard === 2 ? "L2 VETO" : "OFF"}
            </span>
            <NeonBadge
              tone={exp.verdict === "PASSING" ? "neon" : exp.verdict === "FAILING" ? "danger" : "muted"}
              className="ml-auto"
            >
              {exp.verdict}
            </NeonBadge>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-terminal text-[10px] tabular-nums text-ink-2">
            <span>
              cohort <b className="text-ink">{exp.cohortN}</b>/{exp.targetN} settles
            </span>
            <span>
              PF <b className={cn(exp.pf !== null && exp.pf > exp.threshold ? "text-neon" : "text-amber-neon")}>{exp.pf ?? "—"}</b>{" "}
              <span className="text-ink-3">(keep &gt; {exp.threshold})</span>
            </span>
            <span>
              net{" "}
              <b className={exp.pnlUsd >= 0 ? "text-neon" : "text-danger-neon"}>
                {exp.pnlUsd >= 0 ? "+" : ""}${exp.pnlUsd.toFixed(2)}
              </b>
            </span>
          </div>
          <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-white/5" role="presentation">
            <div
              className="h-full rounded-full bg-violet-neon"
              style={{ width: `${Math.min(100, (exp.cohortN / exp.targetN) * 100)}%`, boxShadow: "0 0 8px rgba(178,107,255,0.6)" }}
            />
          </div>
        </div>
      )}

      {/* ── pending proposals ── */}
      <div className="label-tech mb-2">Pending proposals</div>
      {pending.length === 0 ? (
        <p className="font-terminal text-[11px] text-ink-3">
          — queue empty · the advisor reads the ledger every 6h and only speaks when measured evidence clears its gates —
        </p>
      ) : (
        <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
          {pending.map((p) => (
            <div key={p.id} className="rounded-lg border border-[rgba(255,179,71,0.3)] bg-[rgba(255,179,71,0.04)] p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <NeonBadge tone={p.direction === "TIGHTEN" ? "amber" : "neon"}>{p.direction}</NeonBadge>
                <span className="font-terminal text-xs font-bold uppercase tracking-[0.1em] text-ink">{p.knob}</span>
                <span className="font-terminal text-sm tabular-nums text-ink">
                  {p.currentValue} <ChevronRight className="inline size-3.5 text-ink-3" aria-hidden /> <b>{p.proposedValue}</b>
                </span>
                <span className="ml-auto font-terminal text-[9px] uppercase tracking-[0.12em] text-ink-3">cycle #{p.cycle}</span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-ink-2">{p.rationale}</p>
              <details className="mt-2">
                <summary className="cursor-pointer font-terminal text-[9px] uppercase tracking-[0.14em] text-violet-neon/80 hover:text-violet-neon">
                  measured evidence
                </summary>
                <pre className="mt-1.5 overflow-x-auto rounded border border-white/8 bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-ink-2">
                  {JSON.stringify(safeParse(p.evidence), null, 2)}
                </pre>
              </details>
              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  disabled={busyId === p.id}
                  onClick={() => void decide(p.id, "approve")}
                  aria-label={`Approve proposal: ${p.knob} to ${p.proposedValue}`}
                  className={cn(
                    "min-h-11 flex-1 border border-[rgba(0,255,157,0.4)] bg-[rgba(0,255,157,0.1)] font-terminal text-[11px] font-bold uppercase tracking-[0.14em] text-neon",
                    "hover:bg-[rgba(0,255,157,0.22)] focus-visible:ring-neon/60 disabled:opacity-50"
                  )}
                >
                  {busyId === p.id ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <BadgeCheck className="size-4" aria-hidden />}
                  APPROVE
                </Button>
                <Button
                  type="button"
                  disabled={busyId === p.id}
                  onClick={() => void decide(p.id, "reject")}
                  aria-label={`Reject proposal: ${p.knob} to ${p.proposedValue}`}
                  className={cn(
                    "min-h-11 flex-1 border border-[rgba(255,77,94,0.4)] bg-[rgba(255,77,94,0.08)] font-terminal text-[11px] font-bold uppercase tracking-[0.14em] text-danger-neon",
                    "hover:bg-[rgba(255,77,94,0.18)] focus-visible:ring-danger-neon/60 disabled:opacity-50"
                  )}
                >
                  <XCircle className="size-4" aria-hidden />
                  REJECT
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── recent decisions ── */}
      {decided.length > 0 && (
        <div className="mt-4">
          <div className="label-tech mb-2">Recent decisions</div>
          <div className="space-y-1.5">
            {decided.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2 rounded border border-white/5 bg-white/[0.02] px-2.5 py-2">
                <span className={cn("rounded border px-1.5 py-0.5 font-terminal text-[9px] font-bold uppercase", STATUS_TONE[p.status] ?? STATUS_TONE.EXPIRED)}>{p.status}</span>
                <span className="font-terminal text-[11px] text-ink-2">
                  {p.knob} {p.currentValue}→{p.proposedValue}
                </span>
                <span className="ml-auto font-terminal text-[9px] text-ink-3">
                  {p.decidedAt && now > 0 ? timeAgo(p.decidedAt, now) : "--"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── footer: stats + manual cycle ── */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
        {data && (
          <span className="font-terminal text-[9px] uppercase tracking-[0.1em] text-ink-3">
            ledger {data.stats.settled} settled · last-20 {data.stats.last20PnlUsd >= 0 ? "+" : ""}${data.stats.last20PnlUsd.toFixed(2)} · every change clamped + audited
          </span>
        )}
        <Button
          type="button"
          onClick={() => void runCycle()}
          disabled={running}
          aria-label="Run advisor evidence cycle now"
          className={cn(
            "ml-auto min-h-11 border border-[rgba(178,107,255,0.4)] bg-[rgba(178,107,255,0.12)] px-3 font-terminal text-[10px] font-bold uppercase tracking-[0.14em] text-violet-neon",
            "hover:bg-[rgba(178,107,255,0.25)] focus-visible:ring-violet-neon/60 disabled:opacity-50"
          )}
        >
          {running ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
          RUN CYCLE
        </Button>
      </div>

      <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-[rgba(178,107,255,0.25)] bg-[rgba(178,107,255,0.05)] px-3 py-2 font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-ink-2">
        <Brain className="mt-0.5 size-3 shrink-0 text-violet-neon" aria-hidden />
        <span>
          THE ADVISOR CANNOT SELF-APPLY — proposals ride the 00:00 Tehran Telegram report; APPROVE here or reject to arm the cooldown. Two rejections freeze the knob for 7 days.
        </span>
      </p>
    </BentoCard>
  );
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
