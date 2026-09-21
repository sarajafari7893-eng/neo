"use client";

// ── GOVERNOR COHORTS card (v9.6.2) — oversight for PKG-GUARD / Time-Governor /
// Risk-Governor (operator 2026-09-14: «ایا نظارتی بر عملکردشان وجود دارد؟»).
// READ-ONLY: reads /api/ai/gauge → governors (knob snapshot + measured trim
// cohorts). The governors TRIM margin/leverage instead of vetoing, so their
// footprint lives in the signal audit tags (HOUR-TRIM / DL-TRIM / CHOP-RISK /
// LEV-CAP) — this card turns those tags into live PnL evidence.

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { BentoCard, NeonBadge } from "@/components/shared/primitives";
import type { GovernorsDTO } from "@/lib/api-types";

const TAG_TONE: Record<string, string> = {
  "HOUR-TRIM": "text-amber-neon",
  "DL-TRIM": "text-violet-neon",
  "CHOP-RISK": "text-amber-neon",
  "LEV-CAP": "text-cyan-neon",
};

function knobLine(g: GovernorsDTO["knobs"]): string {
  const band = g.confBandSkipLo > 0 || g.confBandSkipHi > 0 ? `${g.confBandSkipLo}–${g.confBandSkipHi}` : "off";
  const dead = g.hourBlockTehran || "off";
  const trim = g.hourTrimTehran || "off";
  const lev = g.maxLevCap > 0 ? `${g.maxLevCap}×` : "20×";
  const chop = g.chopRiskMult !== 1 ? `×${g.chopRiskMult}` : "off";
  const dl = g.dlConfFloor > 0 ? `≥${g.dlConfFloor}` : "off";
  return `BAND ${band} · DEAD ${dead} · TRIM ${trim} · LEV ≤${lev} · CHOP ${chop} · DL ${dl}`;
}

export default function GovernorCohortsCard() {
  const [gov, setGov] = useState<GovernorsDTO | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/ai/gauge", { cache: "no-store" });
        if (!res.ok) throw new Error(`gauge ${res.status}`);
        const data = (await res.json()) as { governors?: GovernorsDTO };
        setGov(data.governors ?? null);
        setErr(false);
      } catch {
        setErr(true);
      }
    };
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.1}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-4 text-violet-neon" aria-hidden />
        <span className="label-tech">GOVERNOR OVERSIGHT</span>
        <NeonBadge tone="violet" className="ml-auto">
          v9.6 · LIVE 30S
        </NeonBadge>
      </div>

      {err ? (
        <p className="font-terminal text-[11px] text-danger-neon">— gauge feed unreachable —</p>
      ) : !gov ? (
        <p className="font-terminal text-[11px] text-ink-3">— loading governor telemetry… —</p>
      ) : (
        <div className="space-y-3">
          {/* knob snapshot */}
          <div className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="font-terminal text-[10px] font-bold tracking-[0.12em] text-ink-2">ACTIVE KNOBS</span>
              <NeonBadge tone={gov.pkgBlocks > 0 ? "violet" : "muted"} className="ml-auto">
                PKG-GUARD ×{gov.pkgBlocks}
              </NeonBadge>
            </div>
            <p className="mt-1.5 font-terminal text-[10px] leading-relaxed tracking-[0.04em] text-ink">{knobLine(gov.knobs)}</p>
            {gov.pkgLastReason && (
              <p className="mt-1 line-clamp-2 font-terminal text-[9px] leading-relaxed text-ink-3" title={gov.pkgLastReason}>
                last veto: {gov.pkgLastReason}
              </p>
            )}
          </div>

          {/* trim cohorts — measured PnL of tagged deploys */}
          <div>
            <p className="mb-1.5 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">
              trim cohorts — measured NET (tagged deploys)
            </p>
            <div className="overflow-hidden rounded-lg border border-white/8">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-white/[0.03]">
                    <th className="px-2.5 py-1.5 text-left font-terminal text-[9px] font-bold tracking-[0.1em] text-ink-3">TAG</th>
                    <th className="px-2.5 py-1.5 text-right font-terminal text-[9px] font-bold tracking-[0.1em] text-ink-3">DEPLOY</th>
                    <th className="px-2.5 py-1.5 text-right font-terminal text-[9px] font-bold tracking-[0.1em] text-ink-3">WR</th>
                    <th className="px-2.5 py-1.5 text-right font-terminal text-[9px] font-bold tracking-[0.1em] text-ink-3">NET $</th>
                    <th className="px-2.5 py-1.5 text-right font-terminal text-[9px] font-bold tracking-[0.1em] text-ink-3">AVG %</th>
                  </tr>
                </thead>
                <tbody>
                  {gov.cohorts.map((c) => {
                    const wr = c.closed ? Math.round((c.wins / c.closed) * 100) : null;
                    const netTone = c.netUsd > 0 ? "text-neon" : c.netUsd < 0 ? "text-danger-neon" : "text-ink-3";
                    return (
                      <tr key={c.tag} className="border-t border-white/5" title={c.label}>
                        <td className={`px-2.5 py-1.5 font-terminal text-[10px] font-bold ${TAG_TONE[c.tag] ?? "text-ink-2"}`}>{c.tag}</td>
                        <td className="px-2.5 py-1.5 text-right font-terminal text-[10px] tabular-nums text-ink-2">
                          {c.deployed}
                          <span className="text-[8px] text-ink-3">/{c.closed}cl</span>
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-terminal text-[10px] tabular-nums text-ink-2">{wr === null ? "—" : `${wr}%`}</td>
                        <td className={`px-2.5 py-1.5 text-right font-terminal text-[10px] font-bold tabular-nums ${netTone}`}>
                          {c.netUsd > 0 ? "+" : ""}
                          {c.netUsd.toFixed(2)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-terminal text-[10px] tabular-nums text-ink-2">
                          {c.closed ? `${c.avgPct > 0 ? "+" : ""}${c.avgPct.toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <p className="font-terminal text-[9px] leading-relaxed tracking-[0.04em] text-ink-3">
            Governors trim risk instead of vetoing: trimmed deploys carry their audit tag, so the cohorts above are the
            live counterfactual — if a trimmed cohort outperforms the book, the trim is protective; if it underperforms,
            the governor is over-tightening and the advisor can retune it inside its clamps.
          </p>
        </div>
      )}
    </BentoCard>
  );
}
