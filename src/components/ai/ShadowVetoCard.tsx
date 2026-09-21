"use client";

// ── NEXUS//SHADOW JUDGE — veto-arm evidence board (OP-SJ-GROUND-0909) ──────
// The AI second-opinion layer: every auto-deployment is reviewed by the model
// (arm A) and the deterministic comparator (arm B). Verdicts are ADVISORY
// until the Wilson-LB 30/30 evidence gate promotes them — the gate strip is
// the honest status, not a promise. Every record shows its GROUNDED cell:
// CLEAN (numbers trace to the evidence bundle), SUSPECT, or VIOLATION
// (unfounded output — the heuristic verdict was substituted).

import { useCallback, useEffect, useState } from "react";
import { Scale, ShieldCheck, ShieldAlert, Gavel } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";

type Audit = "CLEAN" | "SUSPECT" | "VIOLATION";

interface ShadowRecordView {
  id: string;
  t: number;
  symbol: string;
  verdict: "ALLOW" | "VETO" | "ADVISORY-VETO";
  arm: "A" | "B";
  label: "MODEL" | "HEURISTIC";
  audit: Audit;
  confidence: number;
  reasons: string[];
}

interface ShadowState {
  total: number;
  folded: number;
  byArm: Record<"A" | "B", { n: number; allow: number; veto: number; wins: number; losses: number; winRate: number | null; wilsonLb: number | null }>;
  audits: Record<Audit, number>;
  gate: { policy: string; aSamples: number; bSamples: number; aiAuthorized: boolean; reason: string };
  settled: ShadowState | null;
  recent: ShadowRecordView[];
}

const AUDIT_STYLE: Record<Audit, string> = {
  CLEAN: "border-neon/40 text-neon",
  SUSPECT: "border-amber-400/40 text-amber-300",
  VIOLATION: "border-red-400/50 text-red-300",
};

export default function ShadowVetoCard() {
  const [state, setState] = useState<ShadowState | null>(null);
  const [fetching, setFetching] = useState(true);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/shadow-veto", { cache: "no-store" });
      if (res.ok) setState((await res.json()) as ShadowState);
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
  const arm = s?.settled?.byArm ?? s?.byArm;

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.09}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Scale className="size-4 text-violet-neon" aria-hidden />
        <div>
          <h3 className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">SHADOW JUDGE</h3>
          <p className="label-tech mt-0.5">AI second opinion · advisory until evidence-promoted (OP-SJ-GROUND-0909)</p>
        </div>
        {s && (
          <div className="ml-auto">
            {s.gate.aiAuthorized ? (
              <NeonBadge tone="neon" glow>
                <ShieldCheck className="size-3" aria-hidden /> VETO AUTHORIZED
              </NeonBadge>
            ) : (
              <NeonBadge tone="violet" glow>
                <Gavel className="size-3" aria-hidden /> ADVISORY
              </NeonBadge>
            )}
          </div>
        )}
      </div>

      {fetching && !s && <p className="font-terminal text-[11px] text-ink-3">— hydrating shadow journal… —</p>}

      {s && (
        <>
          {/* evidence gate strip */}
          <div className={cn("mb-3 rounded-lg border px-3 py-2 font-terminal text-[10px] leading-relaxed", s.gate.aiAuthorized ? "border-neon/30 bg-neon/[0.04] text-neon" : "border-violet-neon/25 bg-violet-neon/[0.04] text-violet-neon")}>
            {s.gate.policy} — {s.gate.reason}
          </div>

          {/* A/B arms */}
          <div className="grid grid-cols-2 gap-2">
            {(["A", "B"] as const).map((k) => {
              const a = arm?.[k];
              const settledN = a ? a.wins + a.losses : 0;
              return (
                <div key={k} className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
                  <p className="label-tech flex items-center gap-1.5">
                    ARM {k} · {k === "A" ? "MODEL" : "HEURISTIC"}
                    {k === "A" && s.audits.VIOLATION > 0 && <ShieldAlert className="size-3 text-red-300" aria-hidden />}
                  </p>
                  <p className="mt-1 font-terminal text-sm font-bold text-ink">
                    {a ? `${a.allow} allow · ${a.veto} veto` : "0 allow · 0 veto"}
                  </p>
                  <p className="label-tech mt-0.5 text-ink-3">
                    {settledN > 0 && a?.winRate !== null && a?.wilsonLb !== null
                      ? `settled ${settledN} · WR ${(a!.winRate! * 100).toFixed(0)}% · Wilson-LB ${(a!.wilsonLb! * 100).toFixed(1)}%`
                      : `settled ${settledN}/${s.gate.policy.match(/\d+\/\d+/)?.[0]?.split("/")[0] ?? 30} — collecting evidence`}
                  </p>
                </div>
              );
            })}
          </div>

          <p className="label-tech mt-2 text-ink-3">
            audits — CLEAN <span className="text-neon">{s.audits.CLEAN}</span> · SUSPECT <span className="text-amber-300">{s.audits.SUSPECT}</span> · VIOLATION <span className="text-red-300">{s.audits.VIOLATION}</span>
            {s.folded > 0 && <> · dedupe folded {s.folded}</>}
          </p>

          {/* recent adjudications with GROUNDED cell */}
          {s.recent.length > 0 ? (
            <div className="mt-3 max-h-56 space-y-1.5 overflow-y-auto pr-1" aria-label="Shadow adjudications">
              {s.recent.slice(0, 10).map((r) => (
                <div key={`${r.id}-${r.t}-${r.arm}`} className="flex items-start gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2">
                  <span className="shrink-0 rounded border border-white/10 px-1 py-0.5 font-terminal text-[9px] font-bold text-ink-3">{r.id}</span>
                  <span className="shrink-0 font-terminal text-[10px] font-bold text-ink">{r.symbol}</span>
                  <span className={cn("shrink-0 rounded border px-1 py-0.5 font-terminal text-[9px] font-bold", r.verdict === "ALLOW" ? "border-neon/40 text-neon" : "border-magenta-neon/40 text-magenta-neon")}>{r.verdict}</span>
                  <span className={cn("shrink-0 rounded border px-1 py-0.5 font-terminal text-[9px] font-bold", AUDIT_STYLE[r.audit])}>GROUNDED {r.audit}</span>
                  <span className="min-w-0 flex-1 truncate font-terminal text-[9px] text-ink-3" title={r.reasons.join(" · ")}>
                    {r.reasons[0] ?? "—"}
                  </span>
                  <span className="shrink-0 font-terminal text-[9px] text-ink-3">{new Date(r.t).toISOString().slice(11, 16)}Z</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 font-terminal text-[11px] leading-relaxed text-ink-3">
              No adjudications yet — the shadow judge records its first verdicts on the next autonomous deployments. Model arm settles against real signal outcomes; the 30/30 Wilson gate promotes it to real veto authority only on proven evidence.
            </p>
          )}
        </>
      )}
    </BentoCard>
  );
}
