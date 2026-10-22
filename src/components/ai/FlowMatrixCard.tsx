"use client";

// ── FLOW MATRIX card (R16/R17) — same inputs the deployment flow-gate reads ──
// Top-8 by |OI Δ1h| · CVD · TAKER · FUND/8H · CROWD · WGT · OI history sparkline.

import { useCallback, useEffect, useState } from "react";
import { Waves, Loader2, ScanSearch } from "lucide-react";
import { usePulse } from "@/hooks/usePulse";
import { BentoCard, LiveDot, NeonBadge, Sparkline } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";

interface FlowRow {
  symbol: string;
  price: number;
  change24h: number;
  oiDelta1h: number | null;
  oiDelta10m: number | null;
  oiValueUsd: number | null;
  cvdNetPctOfVol: number | null;
  takerRatio: number | null;
  crowdLongShort: number | null;
  funding8h: number | null;
  history: Array<{ at: number; oiDelta1h: number }>;
}

interface MatrixResponse {
  status: { covered: number };
  fundingExtreme: { symbol: string; funding8h: number } | null;
  rows: FlowRow[];
}

function fmtUsdShort(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

function signed(v: number | null, digits = 2, suffix = "%"): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}${suffix}`;
}

function cellCls(v: number | null): string {
  if (v === null || v === undefined) return "text-ink-3";
  return v > 0 ? "text-neon" : v < 0 ? "text-danger-neon" : "text-ink-2";
}

export default function FlowMatrixCard() {
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/flow/matrix", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as MatrixResponse);
    } catch {
      /* keep last */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 45_000);
    return () => clearInterval(id);
  }, [load]);

  const rows = (data?.rows ?? []).slice(0, 8);
  const { data: pulse } = usePulse(15000);
  const uni = pulse?.feed?.universe ?? null;

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.12}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Waves className="size-4 text-cyan-neon" aria-hidden />
        <div>
          <h3 className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">FLOW MATRIX</h3>
          <p className="label-tech mt-0.5">same inputs the deployment gate reads</p>
        </div>
        <NeonBadge tone={loading ? "muted" : "cyan"} className="ml-auto">
          <LiveDot tone={loading ? "amber" : "neon"} /> {loading ? "SWEEPING…" : `${data?.status.covered ?? 0} COVERED`}
        </NeonBadge>
      </div>

      {/* v5.1 SCAN DOMAIN — tracked vs the whole USDT-M futures market */}
      {uni && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-white/8 bg-white/[0.02] px-2.5 py-1.5 font-terminal text-[9px] uppercase tracking-[0.1em] text-ink-3">
          <span className="flex items-center gap-1.5 font-bold text-ink-2">
            <ScanSearch className="size-3 text-cyan-neon" aria-hidden /> scan domain
          </span>
          <span>
            <span className="font-bold tabular-nums text-neon">{uni.tracked}</span> tracked / {uni.target} target
          </span>
          <span>
            pool <span className="tabular-nums text-ink-2">{uni.poolTotal || "~"}</span> perps · liquid <span className="tabular-nums text-ink-2">{uni.liquidPool}</span>
            {uni.poolSource && uni.poolSource !== "BINANCE-FAPI" && (
              <span className={uni.poolSource === "BYBIT-MIRROR" ? "text-cyan-neon" : "text-amber-neon"}> · via {uni.poolSource}</span>
            )}
          </span>
          <span>membership follows real turnover — re-ranked every 30min</span>
        </div>
      )}

      {data?.fundingExtreme && (
        <div className="mb-2 flex items-center gap-2 rounded border border-[rgba(255,179,71,0.35)] bg-[rgba(255,179,71,0.07)] px-2.5 py-1.5 font-terminal text-[10px] font-bold tracking-[0.1em] text-amber-neon">
          ⚠ FUNDING EXTREME — {data.fundingExtreme.symbol} {signed(data.fundingExtreme.funding8h, 4, "%")}/8H · cascade risk
        </div>
      )}

      {rows.length === 0 ? (
        <p className="font-terminal text-[11px] text-ink-3">{loading ? "— flow sweep in progress… —" : "— flow data unavailable —"}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] font-terminal text-[10px]">
            <thead>
              <tr className="text-left text-ink-3">
                {["SYMBOL", "OI Δ1H", "TREND", "CVD", "TAKER B/S", "FUND/8H", "CROWD L/S", "OI$", "WGT"].map((h) => (
                  <th key={h} className={cn("px-1.5 py-1.5 font-medium tracking-[0.1em]", h === "SYMBOL" ? "" : "text-right")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const wgt = r.oiValueUsd ? Math.max(0.5, Math.min(1.2, Math.sqrt(r.oiValueUsd / 50_000_000))) : null;
                return (
                  <tr key={r.symbol} className="border-t border-white/5">
                    <td className="px-1.5 py-1.5 font-bold text-ink">{r.symbol.replace("USDT", "")}</td>
                    <td className={cn("px-1.5 py-1.5 text-right tabular-nums font-bold", cellCls(r.oiDelta1h))}>{signed(r.oiDelta1h)}</td>
                    <td className="px-1.5 py-1 text-right">
                      {r.history.length >= 3 ? (
                        <Sparkline data={r.history.map((h) => h.oiDelta1h)} width={56} height={16} tone="cyan" fill={false} strokeWidth={1.25} className="ml-auto h-4 w-14" />
                      ) : (
                        <span className="text-ink-3">···</span>
                      )}
                    </td>
                    <td className={cn("px-1.5 py-1.5 text-right tabular-nums", cellCls(r.cvdNetPctOfVol))}>{signed(r.cvdNetPctOfVol, 1)}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums text-ink-2">{r.takerRatio?.toFixed(3) ?? "—"}</td>
                    <td className={cn("px-1.5 py-1.5 text-right tabular-nums font-bold", r.funding8h !== null && Math.abs(r.funding8h) > 0.03 ? "text-amber-neon" : "text-ink-2")}>
                      {signed(r.funding8h, 4, "%")}
                    </td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums text-ink-2">{r.crowdLongShort?.toFixed(2) ?? "—"}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums text-ink-3">{r.oiValueUsd ? fmtUsdShort(r.oiValueUsd) : "—"}</td>
                    <td className={cn("px-1.5 py-1.5 text-right tabular-nums", wgt && Math.abs(wgt - 1) >= 0.15 ? "font-bold text-cyan-neon" : "text-ink-3")} title={wgt ? `flow weighted ×${wgt.toFixed(2)} by OI notional` : "oi unknown"}>
                      {wgt ? `×${wgt.toFixed(2)}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </BentoCard>
  );
}
