"use client";

import { useMemo } from "react";
import type { SignalDTO } from "@/lib/api-types";
import { useNeon } from "@/components/analytics/chart-theme";

export interface HistoryPoint {
  t: string;
  price: number;
}

/**
 * LevelChart — signal price history with TP1-3 / SL overlay.
 * Pure SVG: profit zone (entry→tp3), risk zone (entry→sl), dashed level lines,
 * live price dot. Direction-aware y-scale covering all levels + price range.
 */
export function LevelChart({
  signal,
  history,
  width = 560,
  height = 190,
  livePrice,
}: {
  signal: SignalDTO;
  history: HistoryPoint[];
  width?: number;
  height?: number;
  livePrice?: number;
}) {
  const accentHex = useNeon(); // TP2/TP3 lines follow the operator accent

  // v5.4 LIVE TAIL — splice the live pulse price onto the end of the fetched
  // series so the line + dot ride every pulse instead of freezing on stale
  // history while the next 24h snapshot refetch is pending.
  const series = useMemo<HistoryPoint[]>(() => {
    const pts = [...history];
    if (livePrice && Number.isFinite(livePrice)) {
      const last = pts.length ? pts[pts.length - 1] : null;
      const eps = livePrice > 100 ? 0.02 : livePrice > 1 ? 0.0005 : 0.00002;
      if (!last || Math.abs(last.price - livePrice) > eps) {
        pts.push({ t: last ? new Date(Date.now()).toISOString() : new Date(Date.now() - 60_000).toISOString(), price: livePrice });
      }
    }
    return pts;
  }, [history, livePrice]);

  const chart = useMemo(() => {
    const prices = series.map((h) => h.price);
    const levels = [signal.entryPrice, signal.tp1, signal.tp2, signal.tp3, signal.stopLoss];
    if (livePrice) levels.push(livePrice);
    const all = [...prices, ...levels].filter((n) => Number.isFinite(n));
    if (all.length < 2) return null;

    let min = Math.min(...all);
    let max = Math.max(...all);
    const pad = (max - min) * 0.08 || max * 0.01;
    min -= pad;
    max += pad;

    const padL = 8;
    const padR = 62; // right gutter for level labels
    const padT = 10;
    const padB = 16;
    const iw = width - padL - padR;
    const ih = height - padT - padB;

    const y = (p: number) => padT + ih - ((p - min) / (max - min)) * ih;
    const x = (i: number, n: number) => padL + (i / Math.max(1, n - 1)) * iw;

    const linePts = series.map((h, i) => [x(i, series.length), y(h.price)] as const);
    const line = linePts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const areaPath = series.length
      ? `${line} L${linePts[linePts.length - 1][0].toFixed(1)},${(padT + ih).toFixed(1)} L${padL},${(padT + ih).toFixed(1)} Z`
      : "";

    const isLong = signal.direction === "LONG";
    const zoneTop = y(isLong ? signal.tp3 : signal.entryPrice);
    const zoneBottom = y(isLong ? signal.entryPrice : signal.tp3);
    const riskTop = y(isLong ? signal.entryPrice : signal.stopLoss);
    const riskBottom = y(isLong ? signal.stopLoss : signal.entryPrice);

    const levelMeta = [
      { label: "TP3", price: signal.tp3, color: accentHex, dash: "3 4" },
      { label: "TP2", price: signal.tp2, color: accentHex, dash: "3 4" },
      { label: "TP1", price: signal.tp1, color: "#45f0df", dash: "3 4" },
      { label: "ENTRY", price: signal.entryPrice, color: "#e8f5ef", dash: "6 4" },
      { label: "SL", price: signal.stopLoss, color: "#ff4d5e", dash: "3 4" },
    ].filter((l) => l.price >= min && l.price <= max);

    return { x, y, line, areaPath, min, max, padL, padR, padT, ih, iw, height, width, zoneTop, zoneBottom, riskTop, riskBottom, levelMeta };
  }, [series, signal, livePrice, width, height, accentHex]);

  if (!chart || series.length < 2) {
    return (
      <div className="flex h-[190px] items-center justify-center rounded-lg border border-white/5 bg-white/[0.015]">
        <span className="label-tech">COLLECTING PRICE HISTORY…</span>
      </div>
    );
  }

  const last = series[series.length - 1];
  const lastY = chart.y(last.price);
  const lastX = chart.x(series.length - 1, series.length);

  return (
    <div className="relative">
      <svg width="100%" viewBox={`0 0 ${chart.width} ${chart.height}`} className="block" role="img" aria-label={`${signal.symbol} price history with TP/SL levels`}>
        <defs>
          <linearGradient id="lvl-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#45f0df" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#45f0df" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* profit zone */}
        <rect
          x={chart.padL}
          y={Math.min(chart.zoneTop, chart.zoneBottom)}
          width={chart.iw}
          height={Math.abs(chart.zoneBottom - chart.zoneTop)}
          fill="rgb(var(--neon-rgb)/0.07)"
        />
        {/* risk zone */}
        <rect
          x={chart.padL}
          y={Math.min(chart.riskTop, chart.riskBottom)}
          width={chart.iw}
          height={Math.abs(chart.riskBottom - chart.riskTop)}
          fill="rgba(255,77,94,0.07)"
        />

        {/* price line */}
        <path d={chart.areaPath} fill="url(#lvl-area)" />
        <path d={chart.line} fill="none" stroke="#45f0df" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />

        {/* level lines + labels */}
        {chart.levelMeta.map((l) => {
          const ly = chart.y(l.price);
          return (
            <g key={l.label}>
              <line x1={chart.padL} y1={ly} x2={chart.padL + chart.iw} y2={ly} stroke={l.color} strokeOpacity="0.55" strokeWidth="1" strokeDasharray={l.dash} />
              <text x={chart.padL + chart.iw + 6} y={ly + 3.5} fill={l.color} fontSize="9" fontFamily="var(--font-terminal)" letterSpacing="1">
                {l.label} {l.price >= 100 ? l.price.toFixed(0) : l.price.toFixed(l.price >= 1 ? 2 : 4)}
              </text>
            </g>
          );
        })}

        {/* live dot */}
        <circle cx={lastX} cy={lastY} r="3.2" fill="#45f0df" stroke="#05070a" strokeWidth="1">
          <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />
        </circle>
      </svg>

      {/* live price tag */}
      <div
        className="pointer-events-none absolute right-0 rounded border border-[rgba(69,240,223,0.4)] bg-[rgba(69,240,223,0.08)] px-1.5 py-0.5 font-terminal text-[10px] font-bold text-cyan-neon"
        style={{ top: Math.max(0, Math.min(chart.height - 22, lastY - 10)) }}
      >
        {last.price >= 1000 ? last.price.toFixed(0) : last.price.toFixed(last.price >= 1 ? 2 : 4)}
      </div>
    </div>
  );
}
