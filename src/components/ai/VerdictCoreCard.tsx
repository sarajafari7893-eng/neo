"use client";

import { useCallback, useEffect, useState } from "react";
import { BrainCircuit, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import type { VerdictCoreState } from "@/lib/verdict";

/* ── v8.2 VERDICT-CORE desk (AI CORE page) — operator mandate: «جورنال را به
 * هسته مرکزی برای یادگیری عمیق از دلایل ارسال کند» ──
 * The gate journal (every threshold verdict + hard block + deployment, with
 * its full reason payload) streams to the central core on a 30min cadence;
 * this desk shows WHAT the core concluded (digest + lessons) and lets the
 * operator force a learning cycle NOW. The live needle/roster view lives on
 * the TERMINAL gate-gauge card — this is the learning half of the pair. */

interface CoreStateDTO {
  runs: number;
  lastRunAt: string | null;
  lastAnswer: string | null;
  lessons: Array<{ at: string; scope: string; pattern: string; action: string; label: string; confidence: number; evidence?: string }>;
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default function VerdictCoreCard() {
  const [state, setState] = useState<CoreStateDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);

  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/verdict-core", { cache: "no-store" });
      if (res.ok) setState((await res.json()) as CoreStateDTO);
    } catch {
      /* next tick retries */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void pull();
    const id = setInterval(pull, 60_000);
    return () => clearInterval(id);
  }, [pull]);

  const runNow = useCallback(async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/verdict-core", { method: "POST" });
      if (res.ok) {
        const fresh = (await res.json()) as CoreStateDTO;
        setState(fresh);
        toast.success(`VERDICT-CORE cycle #${fresh.runs} complete — lessons persisted to the central core`);
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? "learning cycle failed");
      }
    } catch {
      toast.error("neural link degraded — cycle aborted");
    } finally {
      setRunning(false);
    }
  }, []);

  const lessons = state?.lessons ?? [];

  return (
    <BentoCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <BrainCircuit className="h-4 w-4 text-violet-neon" aria-hidden />
          <span className="label-tech">Verdict core // deep-learn from gate reasons</span>
          <LiveDot tone="violet" />
        </div>
        <div className="flex items-center gap-2">
          <NeonBadge tone="violet">{state?.runs ?? 0} CYCLES</NeonBadge>
          <Button
            size="sm"
            variant="outline"
            onClick={runNow}
            disabled={running}
            className="h-7 border-violet-neon/40 px-2.5 font-terminal text-[10px] tracking-[0.12em] text-violet-neon hover:bg-violet-neon/10"
            aria-label="Run a verdict-core learning cycle now"
          >
            {running ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <RefreshCw className="size-3" aria-hidden />}
            {running ? "STUDYING…" : "LEARN NOW"}
          </Button>
        </div>
      </div>

      {!loaded ? (
        <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-violet-neon/25 font-terminal text-[10px] text-ink-3">connecting to verdict-core…</div>
      ) : (
        <div className="space-y-3">
          {/* last answer — the core's own digest of the decision border */}
          <div className="rounded-lg border border-violet-neon/25 bg-violet-neon/[0.04] p-3">
            <div className="mb-1.5 flex items-center justify-between font-terminal text-[9px] uppercase tracking-[0.14em] text-violet-neon">
              <span>core digest · last study</span>
              <span className="text-ink-3">{ago(state?.lastRunAt ?? null)}</span>
            </div>
            {state?.lastAnswer ? (
              <p className="font-terminal text-[11px] leading-relaxed text-ink-2">{state.lastAnswer}</p>
            ) : (
              <p className="py-2 text-center font-terminal text-[10px] text-ink-3">
                no cycle yet — the gate journal (confirm/reject reasons, threshold surcharges, hard blocks) streams to the core automatically every ~30min, or force a cycle with LEARN NOW
              </p>
            )}
          </div>

          {/* lessons ledger */}
          <div>
            <div className="mb-1.5 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">lessons ledger · newest first</div>
            {lessons.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/10 py-4 text-center font-terminal text-[10px] text-ink-3">journal too thin — verdicts accrue on every engine evaluation + shadow sweep</div>
            ) : (
              <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                {lessons.map((l, i) => (
                  <div key={`${l.at}-${i}`} className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2">
                    <div className="flex items-center gap-2 font-terminal text-[9px] uppercase tracking-[0.12em]">
                      <span className={l.label === "MODEL" ? "text-violet-neon" : "text-cyan-neon"}>{l.label}</span>
                      <span className="text-ink-3">· conf {l.confidence}% · {ago(l.at)}</span>
                    </div>
                    <div className="mt-1 font-terminal text-[10px] leading-relaxed text-ink">{l.pattern}</div>
                    <div className="mt-0.5 font-terminal text-[10px] leading-relaxed text-ink-2">→ {l.action}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="font-terminal text-[9px] leading-relaxed tracking-wide text-ink-3">
            source: .data/gate-journal.jsonl — every threshold verdict (score vs dynamic MIN_SCORE + regime/spill/chase/MTF/liq-heat modifiers), hard gate block and deployment. Outcomes for REJECTED candidates stay OBSERVING (no shadow-outcome tracker yet) — the core studies reason pressure, never invented win rates.
          </p>
        </div>
      )}
    </BentoCard>
  );
}
