"use client";

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import type { RiskStateDTO, VolBoardDTO, VolForecastDTO } from "@/lib/api-types";

/* ── v8.1 P2 VOL REGIME + RISK OVERLAY card ──
 * Two feeds, 45s poll:
 *   · /api/vol-forecast — EWMA(λ=0.94) + HAR-lite on closed 15m bars; regime =
 *     percentile vs the symbol's OWN trailing distribution (LOW/NORMAL/ELEVATED/EXTREME)
 *   · /api/risk — portfolio overlay: union-merge correlation clusters (|ρ|≥0.65),
 *     drawdown sizing (≥3% ×0.75 · ≥7% ×0.5), verdict OK/THROTTLE/BLOCK
 * Engine contract: regime scales stop ×0.9..×1.15 + RR ±0.2R (VOL-REGIME-* tags);
 * a new deployment joining a same-direction cluster ≥35% of equity is refused
 * on the auto path (RISK-CLUSTER BLOCK), operator-forced deploys half-size. */

const REGIME_CLS: Record<VolForecastDTO["regime"], string> = {
  LOW: "text-cyan-neon",
  NORMAL: "text-ink-2",
  ELEVATED: "text-amber-neon",
  EXTREME: "text-danger-neon",
};

const REGIME_BAR: Record<VolForecastDTO["regime"], string> = {
  LOW: "bg-cyan-neon",
  NORMAL: "bg-white/40",
  ELEVATED: "bg-amber-neon",
  EXTREME: "bg-danger-neon",
};

function VolRow({ r }: { r: VolForecastDTO }) {
  return (
    <div className="grid grid-cols-[76px_54px_58px_1fr] items-center gap-1.5 px-1 py-1 font-terminal text-[10px] tabular-nums transition hover:bg-white/[0.03]">
      <span className="truncate font-bold text-ink">{r.symbol.replace("USDT", "")}</span>
      <span className="text-ink-2" title={`EWMA(λ=0.94) forecast ${r.ewmaBarPct.toFixed(3)}%/15m`}>
        {r.ewma1hPct.toFixed(2)}%
      </span>
      <span className="text-ink-3" title={`HAR-lite 6h blend ${r.har6hPct.toFixed(3)}%/15m`}>
        {r.har6hPct.toFixed(2)}%
      </span>
      <div className="flex items-center gap-1.5">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/5">
          <div className={`h-full rounded-full ${REGIME_BAR[r.regime]}`} style={{ width: `${Math.max(4, r.percentile)}%`, opacity: 0.85 }} />
        </div>
        <span className={`w-[86px] text-right font-bold ${REGIME_CLS[r.regime]}`} title={`ATR15m ${r.atr15mPct.toFixed(2)}% · self-pct ${r.percentile}% vs own trailing distribution`}>
          {r.regime} {r.percentile}%
        </span>
      </div>
    </div>
  );
}

export default function VolRiskCard() {
  const [vol, setVol] = useState<VolBoardDTO | null>(null);
  const [risk, setRisk] = useState<RiskStateDTO | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const [vRes, rRes] = await Promise.all([fetch("/api/vol-forecast", { cache: "no-store" }), fetch("/api/risk", { cache: "no-store" })]);
        if (vRes.ok) {
          const d = (await vRes.json()) as VolBoardDTO;
          if (alive) setVol(d);
        }
        if (rRes.ok) {
          const d = (await rRes.json()) as RiskStateDTO;
          if (alive) setRisk(d);
        }
      } catch {
        /* next tick retries */
      } finally {
        if (alive) setLoaded(true);
      }
    };
    void pull();
    const id = setInterval(pull, 45_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const rows = vol?.rows.slice(0, 8) ?? [];
  const verdictTone = risk?.verdict === "BLOCK" ? "danger" : risk?.verdict === "THROTTLE" ? "amber" : "neon";
  const ddPct = risk?.drawdownPct ?? 0;
  const ddWidth = Math.min(100, (ddPct / 10) * 100); // bar saturates at 10%

  return (
    <BentoCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="h-4 w-4 text-violet-neon" aria-hidden />
          <span className="label-tech">Vol regime &amp; risk overlay // forecast + exposure</span>
          <LiveDot />
        </div>
        <NeonBadge tone="violet">P2 v8.1</NeonBadge>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* vol forecast board */}
        <div>
          <div className="mb-1.5 flex items-center justify-between px-1 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">
            <span>volatility forecast</span>
            <span>{vol?.coverage ?? 0} symbols</span>
          </div>
          <div className="mb-1 grid grid-cols-[76px_54px_58px_1fr] gap-1.5 px-1 font-terminal text-[9px] uppercase tracking-wider text-ink-3/70">
            <span>symbol</span>
            <span className="text-right">ewma 1h</span>
            <span className="text-right">har 6h</span>
            <span className="text-right">regime · self-pct</span>
          </div>
          {rows.length === 0 ? (
            <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-violet-neon/25 font-terminal text-[10px] text-ink-3">
              {!loaded ? "connecting…" : "vol board warming — flow-cache bound"}
            </div>
          ) : (
            <div className="max-h-[150px] space-y-0.5 overflow-y-auto pr-1">
              {rows.map((r) => (
                <VolRow key={r.symbol} r={r} />
              ))}
            </div>
          )}
          <p className="mt-1.5 px-1 font-terminal text-[9px] leading-relaxed text-ink-3">
            EWMA λ=0.94 + HAR-lite on closed 15m bars; regime = percentile vs the symbol&apos;s OWN trailing distribution. ELEVATED → stop ×1.05, RR −0.1R · EXTREME → ×1.15, −0.2R · LOW → ×0.9, +0.1R.
          </p>
        </div>

        {/* risk overlay */}
        <div>
          <div className="mb-1.5 flex items-center justify-between px-1 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">
            <span>risk overlay · open book</span>
            {risk && <NeonBadge tone={verdictTone}>{risk.verdict}</NeonBadge>}
          </div>
          {!risk ? (
            <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-violet-neon/25 font-terminal text-[10px] text-ink-3">
              {!loaded ? "connecting…" : "risk state warming"}
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="grid grid-cols-3 gap-1.5">
                <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="font-terminal text-[9px] uppercase tracking-wider text-ink-3">equity</div>
                  <div className="font-terminal text-sm font-bold tabular-nums text-ink">${risk.equity.toFixed(2)}</div>
                </div>
                <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="font-terminal text-[9px] uppercase tracking-wider text-ink-3">exposure</div>
                  <div className="font-terminal text-sm font-bold tabular-nums text-ink">${risk.exposureUsd.toFixed(2)}</div>
                </div>
                <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2 py-1.5">
                  <div className="font-terminal text-[9px] uppercase tracking-wider text-ink-3">size mult</div>
                  <div className={`font-terminal text-sm font-bold tabular-nums ${risk.sizeMult < 1 ? "text-amber-neon" : "text-neon"}`}>×{risk.sizeMult.toFixed(2)}</div>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between font-terminal text-[9px] uppercase tracking-wider text-ink-3">
                  <span>drawdown from peak ${risk.peakEquity.toFixed(2)}</span>
                  <span className={`tabular-nums font-bold ${ddPct >= 7 ? "text-danger-neon" : ddPct >= 3 ? "text-amber-neon" : "text-ink-2"}`}>{ddPct.toFixed(2)}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div
                    className={`h-full rounded-full ${ddPct >= 7 ? "bg-danger-neon" : ddPct >= 3 ? "bg-amber-neon" : "bg-neon"}`}
                    style={{ width: `${Math.max(2, ddWidth)}%`, boxShadow: "0 0 6px currentColor", opacity: 0.85 }}
                  />
                </div>
                <div className="mt-0.5 font-terminal text-[9px] text-ink-3">≥3% → ×0.75 · ≥7% → ×0.50 · worst correlated cluster {risk.worstClusterPct.toFixed(1)}% of equity (cap 35%)</div>
              </div>

              <div>
                <div className="mb-1 font-terminal text-[9px] uppercase tracking-wider text-ink-3">
                  correlation clusters · union-merge |ρ|≥0.65 · {risk.openCount} open
                </div>
                {risk.clusters.length === 0 ? (
                  <div className="rounded-lg border border-white/5 bg-white/[0.015] px-2 py-1.5 font-terminal text-[10px] text-ink-3">
                    no correlated open clusters — the book is structurally diversified
                  </div>
                ) : (
                  <div className="max-h-[76px] space-y-1 overflow-y-auto pr-1">
                    {risk.clusters.map((c, i) => (
                      <div key={i} className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.015] px-2 py-1 font-terminal text-[10px]">
                        <span className="truncate text-ink-2">{c.symbols.map((s) => s.replace("USDT", "")).join(" · ")}</span>
                        <span className={`shrink-0 tabular-nums font-bold ${c.equityPct >= 35 ? "text-danger-neon" : "text-ink-2"}`}>
                          {c.direction} {c.equityPct.toFixed(1)}% · ρ̄ {c.corr.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </BentoCard>
  );
}
