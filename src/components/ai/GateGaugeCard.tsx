"use client";

// ── NEXUS//GATE GAUGE — decision-layer telemetry (OP-SJ-GROUND-0909) ───────
// Live window into the gate journal: tick pulse, shortlists, flow vetoes,
// deployments, and vol-cause captures. The HYDRATION chip is the honesty
// indicator — in dev Turbopack every route owns a cold module copy, so the
// gauge hydrates on read; the chip shows readPos coverage so a lagging
// journal can never masquerade as a quiet market.

import { useCallback, useEffect, useState } from "react";
import { Gauge, DatabaseBackup, ShieldAlert, Rocket, ListFilter } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";

interface GateGaugeState {
  total: number;
  ingested: number;
  folded: number;
  shortlisted: number;
  vetoed: number;
  deployed: number;
  topCauses: Array<{ cause: string; n: number }>;
  window: { captures: number; top: string | null };
  fresh: number;
  gate: { minScore: number; flowShortlist: number; flowVetoScore: number; universeSize: number } | null;
  hydration: {
    fileBytes: number | null;
    readPos: number;
    pending: number;
    records: number;
    lastAppendAt: number | null;
    hydrated: boolean;
  };
}

export default function GateGaugeCard() {
  const [state, setState] = useState<GateGaugeState | null>(null);
  const [fetching, setFetching] = useState(true);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/gauge", { cache: "no-store" });
      if (res.ok) setState((await res.json()) as GateGaugeState);
    } catch {
      /* keep last state */
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    void fetchState();
    const t = setInterval(() => void fetchState(), 20_000);
    return () => clearInterval(t);
  }, [fetchState]);

  const h = state?.hydration;
  const coverage = h && h.fileBytes && h.fileBytes > 0 ? Math.min(100, Math.round((h.readPos / h.fileBytes) * 100)) : 100;

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.08}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Gauge className="size-4 text-neon" aria-hidden />
        <div>
          <h3 className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">GATE GAUGE</h3>
          <p className="label-tech mt-0.5">decision-layer journal · grounded records only (OP-SJ-GROUND-0909)</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {h && !h.hydrated && (
            <NeonBadge tone="magenta" glow>
              <DatabaseBackup className="size-3" aria-hidden /> HYDRATING {coverage}%
            </NeonBadge>
          )}
          {h?.hydrated && (
            <NeonBadge tone="neon" glow>
              <LiveDot tone="neon" /> HYDRATED
            </NeonBadge>
          )}
        </div>
      </div>

      {fetching && !state && <p className="font-terminal text-[11px] text-ink-3">— hydrating gate journal… —</p>}

      {state && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "RECORDS", value: state.total.toLocaleString(), icon: null, tone: "text-ink" },
              { label: "SHORTLISTED", value: state.shortlisted.toLocaleString(), icon: <ListFilter className="size-3" aria-hidden />, tone: "text-ink" },
              { label: "FLOW VETOES", value: state.vetoed.toLocaleString(), icon: <ShieldAlert className="size-3" aria-hidden />, tone: "text-magenta-neon" },
              { label: "DEPLOYED", value: state.deployed.toLocaleString(), icon: <Rocket className="size-3" aria-hidden />, tone: "text-neon" },
            ].map((m) => (
              <div key={m.label} className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
                <p className={cn("font-terminal text-lg font-bold leading-tight", m.tone)}>{m.value}</p>
                <p className="label-tech mt-0.5 flex items-center gap-1">{m.icon} {m.label}</p>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2 font-terminal text-[10px] text-ink-2">
            <span>
              24h captures: <span className="text-neon">{state.window.captures}</span>
              {state.window.top ? ` · top ${state.window.top}` : " · no cause yet"}
            </span>
            <span className="text-ink-3">dedupe folded {state.folded.toLocaleString()} duplicates</span>
            {state.gate && (
              <span className="text-ink-3">
                gate: MIN_SCORE {state.gate.minScore} · shortlist {state.gate.flowShortlist} · veto {state.gate.flowVetoScore}
              </span>
            )}
          </div>

          {state.topCauses.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {state.topCauses.map((c) => (
                <span key={c.cause} className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-terminal text-[9px] text-ink-3">
                  {c.cause} <span className="text-neon">×{c.n}</span>
                </span>
              ))}
            </div>
          )}

          {h && (
            <p className="label-tech mt-2 text-ink-3">
              journal db/gate-journal.jsonl · readPos {(h.readPos / 1024).toFixed(0)}K/{h.fileBytes ? (h.fileBytes / 1024).toFixed(0) : "?"}K
              {h.pending > 0 ? ` · ${h.pending}B tail pending` : " · tail fully read"}
              {state.fresh > 0 ? ` · +${state.fresh} fresh this read` : ""}
            </p>
          )}
        </>
      )}
    </BentoCard>
  );
}
