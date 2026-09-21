"use client";

import { useEffect, useState } from "react";
import { Flame } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import type { LiqHeatBoardDTO, LiqHeatDTO, OiFundBoardDTO, OiFundRowDTO } from "@/lib/api-types";

/* ── v8.1 P1 LIQ DEPTH RADAR — OI/funding board + liquidation heatmap ──
 * Operator mandate «P1 و P2 رو کامل اجرا کن». Two feeds, 45s poll:
 *   · /api/oi-funding — OI Δ15m/1h/4h + funding carry per symbol
 *   · /api/liq-heat   — VOLUME-MAPPED ESTIMATE clusters scaled by real OI
 * The heatmap stays honestly labeled ESTIMATE — no exchange publishes
 * leveraged-position maps; we project recent volume through the popular
 * leverage tiers and scale by real OI when the board has it. */

function fmtUsdM(v: number | null): string {
  if (v === null) return "—";
  return v >= 1000 ? `$${(v / 1000).toFixed(1)}B` : `$${v.toFixed(1)}M`;
}

function pct(v: number | null, digits = 1): string {
  return v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function ClusterRow({ side, c, maxAbs }: { side: "above" | "below"; c: LiqHeatDTO["nearestBelow"]; maxAbs: number }) {
  return (
    <div className="flex items-center gap-2 font-terminal text-[10px] leading-tight">
      <span className={`w-12 shrink-0 text-right tabular-nums ${side === "above" ? "text-neon" : "text-danger-neon"}`}>
        {side === "above" ? "↑" : "↓"} {c ? `${Math.abs(c.distPct).toFixed(2)}%` : "—"}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
        <div
          className={`h-full rounded-full ${side === "above" ? "bg-neon" : "bg-danger-neon"}`}
          style={{ width: c ? `${Math.max(6, (Math.abs(c.distPct) / maxAbs) * 100)}%` : "0%", boxShadow: "0 0 6px currentColor", opacity: 0.8 }}
        />
      </div>
      <span className={`w-24 shrink-0 tabular-nums ${side === "above" ? "text-neon" : "text-danger-neon"}`}>
        {c ? `${fmtUsdM(c.estUsdM)} ${side === "above" ? "shorts" : "longs"}` : "no cluster"}
      </span>
    </div>
  );
}

function ClusterBar({ h }: { h: LiqHeatDTO }) {
  // nearest clusters above/below with distance bars — magnet visualization
  const maxAbs = Math.max(
    h.nearestBelow ? Math.abs(h.nearestBelow.distPct) : 0.01,
    h.nearestAbove ? Math.abs(h.nearestAbove.distPct) : 0.01,
    0.01,
  );
  return (
    <div className="space-y-1">
      <ClusterRow side="above" c={h.nearestAbove} maxAbs={maxAbs} />
      <ClusterRow side="below" c={h.nearestBelow} maxAbs={maxAbs} />
    </div>
  );
}

function HeatRow({ h }: { h: LiqHeatDTO }) {
  const sym = h.symbol.replace("USDT", "");
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.015] px-2.5 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-terminal text-[11px] font-bold text-ink">{sym}</span>
        <span className="font-terminal text-[9px] text-ink-3">
          OI {fmtUsdM(h.oiUsdM)} {h.oiScaled ? "" : "· UNSCALED"}
        </span>
      </div>
      <ClusterBar h={h} />
    </div>
  );
}

function OiRow({ r }: { r: OiFundRowDTO }) {
  const d1h = r.oiDelta1h;
  const up = d1h !== null && d1h >= 0;
  const fundHot = r.funding8h !== null && Math.abs(r.funding8h) >= 0.05;
  return (
    <div className="grid grid-cols-[76px_58px_58px_66px_52px] items-center gap-1.5 px-1 py-1 font-terminal text-[10px] tabular-nums transition hover:bg-white/[0.03]">
      <span className="truncate font-bold text-ink">{r.symbol.replace("USDT", "")}</span>
      <span className={d1h === null ? "text-ink-3" : up ? "text-neon" : "text-danger-neon"} title="OI Δ 15m">
        {pct(r.oiDelta15m)}
      </span>
      <span className={d1h === null ? "text-ink-3" : up ? "text-neon" : "text-danger-neon"} title="OI Δ 1h">
        {pct(d1h)}
      </span>
      <span className={d1h === null ? "text-ink-3" : up ? "text-neon" : "text-danger-neon"} title="OI Δ 4h">
        {pct(r.oiDelta4h)}
      </span>
      <span className={r.funding8h === null ? "text-ink-3" : fundHot ? (r.funding8h > 0 ? "text-amber-neon" : "text-cyan-neon") : "text-ink-2"} title={`funding ${r.funding8h === null ? "n/a" : `${r.funding8h.toFixed(4)}%/8h`} — |≥0.05%| marks a crowded side`}>
        {r.funding8h === null ? "—" : `${r.funding8h >= 0 ? "+" : ""}${r.funding8h.toFixed(3)}`}
      </span>
    </div>
  );
}

export default function LiqDepthRadarCard() {
  const [oi, setOi] = useState<OiFundBoardDTO | null>(null);
  const [heat, setHeat] = useState<LiqHeatBoardDTO | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const [oiRes, heatRes] = await Promise.all([fetch("/api/oi-funding", { cache: "no-store" }), fetch("/api/liq-heat", { cache: "no-store" })]);
        if (oiRes.ok) {
          const d = (await oiRes.json()) as OiFundBoardDTO;
          if (alive) setOi(d);
        }
        if (heatRes.ok) {
          const d = (await heatRes.json()) as LiqHeatBoardDTO;
          if (alive) setHeat(d);
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

  const oiRows = oi?.rows.slice(0, 8) ?? [];
  const heatRows = heat?.rows.slice(0, 5) ?? [];

  return (
    <BentoCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <Flame className="h-4 w-4 text-amber-neon" aria-hidden />
          <span className="label-tech">Liq depth radar // OI · funding · heat</span>
          <LiveDot />
        </div>
        <NeonBadge tone="amber">P1 v8.1</NeonBadge>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* OI / funding board */}
        <div>
          <div className="mb-1.5 flex items-center justify-between px-1 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">
            <span>open interest board</span>
            <span>{oi?.coverage ?? 0} symbols</span>
          </div>
          <div className="mb-1 grid grid-cols-[76px_58px_58px_66px_52px] gap-1.5 px-1 font-terminal text-[9px] uppercase tracking-wider text-ink-3/70">
            <span>symbol</span>
            <span className="text-right">Δ15m</span>
            <span className="text-right">Δ1h</span>
            <span className="text-right">Δ4h</span>
            <span className="text-right">fund</span>
          </div>
          {oiRows.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-amber-neon/25 font-terminal text-[10px] text-ink-3">
              {!loaded ? "connecting…" : "OI board warming — first sweep ~2min"}
            </div>
          ) : (
            <div className="max-h-[190px] space-y-0.5 overflow-y-auto pr-1">
              {oiRows.map((r) => (
                <OiRow key={r.symbol} r={r} />
              ))}
            </div>
          )}
          <p className="mt-1.5 px-1 font-terminal text-[9px] leading-relaxed text-ink-3">
            ΔOI rising while price stalls = fresh leverage pressing. fund ≥|0.05%| = crowded side paying carry.
          </p>
        </div>

        {/* liquidation heatmap (ESTIMATE) */}
        <div>
          <div className="mb-1.5 flex items-center justify-between px-1 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">
            <span>liq heat · nearest clusters</span>
            <NeonBadge tone="muted">ESTIMATE</NeonBadge>
          </div>
          {heatRows.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-amber-neon/25 font-terminal text-[10px] text-ink-3">
              {!loaded ? "connecting…" : "heatmap warming — volume projection ~3min"}
            </div>
          ) : (
            <div className="max-h-[218px] space-y-1.5 overflow-y-auto pr-1">
              {heatRows.map((h) => (
                <HeatRow key={h.symbol} h={h} />
              ))}
            </div>
          )}
          <p className="mt-1.5 px-1 font-terminal text-[9px] leading-relaxed text-ink-3">
            Volume-mapped projection through 10×/25×/50× tiers, scaled by REAL OI when present. Clusters below = long-liq flush fuel (magnet ↓) · above = short-liq squeeze fuel (magnet ↑). Feeds the L3P pre-cascade trigger + deploy threshold.
          </p>
        </div>
      </div>
    </BentoCard>
  );
}
