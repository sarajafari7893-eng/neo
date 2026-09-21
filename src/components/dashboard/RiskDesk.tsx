"use client";

import { useEffect, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import { Flame, ShieldAlert, Crosshair, Layers, ChevronRight, Activity } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { usePulse } from "@/hooks/usePulse";
import { useAlerts } from "@/store/alerts";
import { useNeon } from "@/components/analytics/chart-theme";
import { fmtPrice, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MarketAssetDTO, SignalDTO } from "@/lib/api-types";

/**
 * RiskDesk — portfolio heat engine:
 * ① semicircular HEAT gauge (account risk = Σ stop-out risk / equity, blended
 *    with stop-proximity of live positions) and ② a per-position risk table
 *    sorted hottest-first. Pure client-side math over the pulse snapshot —
 *    identical formulas to the resolution engine (pnl% = move × lev × 100).
 */

const OPEN_STATUSES = new Set(["ACTIVE", "TP1", "TP2"]);

interface PositionRisk {
  signal: SignalDTO;
  price: number;
  pnlPct: number;
  slDistPct: number; // entry→SL distance in price %
  distToSlPct: number; // current price→SL distance in price %
  riskUsd: number; // loss if stopped from current leverage
  proximity: number; // 0 at entry → 1 at SL
  heat: number; // 0..100 blended
}

function buildRisks(signals: SignalDTO[], market: MarketAssetDTO[]): PositionRisk[] {
  const priceMap = new Map(market.map((m) => [m.symbol, m.price]));
  const rows: PositionRisk[] = [];

  for (const s of signals) {
    if (!OPEN_STATUSES.has(s.status) || s.closedAt) continue;
    const price = priceMap.get(s.symbol);
    if (!price) continue;

    const dirMult = s.direction === "LONG" ? 1 : -1;
    const move = ((price - s.entryPrice) / s.entryPrice) * dirMult;
    const pnlPct = move * s.leverage * 100;

    const slDistPct = (Math.abs(s.entryPrice - s.stopLoss) / s.entryPrice) * 100;
    const distToSlPct = (Math.abs(price - s.stopLoss) / price) * 100;
    const riskUsd = (s.marginUsd * slDistPct) / 100 * s.leverage;

    const proximity = slDistPct > 0
      ? Math.min(1, Math.max(0, 1 - distToSlPct / slDistPct))
      : 0;

    // position heat: closer to stop = hotter, leverage-sized
    const heat = Math.min(100, proximity * 72 + Math.min(28, (s.leverage / 30) * 28));

    rows.push({ signal: s, price, pnlPct, slDistPct, distToSlPct, riskUsd, proximity, heat });
  }

  return rows.sort((a, b) => b.heat - a.heat);
}

/** min ms between heat samples (pulse ticks ~3.5s — throttle to ~20s ≈ 40min window) */
const SAMPLE_THROTTLE_MS = 20_000;

function heatZone(heat: number, coolColor = "#00ffa3"): { label: string; color: string; tone: "neon" | "amber" | "danger" } {
  if (heat < 35) return { label: "COOL", color: coolColor, tone: "neon" };
  if (heat < 62) return { label: "WARM", color: "#ffb347", tone: "amber" };
  if (heat < 82) return { label: "HOT", color: "#ff7a45", tone: "danger" };
  return { label: "CRITICAL", color: "#ff4d5e", tone: "danger" };
}

/* ── Semicircular gauge ───────────────────────────────────── */

function HeatGauge({ heat, zone, coolColor }: { heat: number; zone: ReturnType<typeof heatZone>; coolColor: string }) {
  const W = 236;
  const H = 138;
  const cx = W / 2;
  const cy = H - 10;
  const R = 104;

  // polar helper: angle 180° (heat 0) → 0° (heat 100)
  const pt = (h: number, radius: number) => {
    const a = (Math.PI * (180 - h * 1.8)) / 180;
    return [cx + radius * Math.cos(a), cy - radius * Math.sin(a)] as const;
  };
  const arc = (from: number, to: number, radius: number) => {
    const [x1, y1] = pt(from, radius);
    const [x2, y2] = pt(to, radius);
    return `M${x1.toFixed(1)},${y1.toFixed(1)} A${radius},${radius} 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)}`;
  };

  const zones: Array<{ upTo: number; color: string }> = [
    { upTo: 35, color: coolColor },
    { upTo: 62, color: "#ffb347" },
    { upTo: 82, color: "#ff7a45" },
    { upTo: 100, color: "#ff4d5e" },
  ];

  let from = 0;
  const segments = zones.map((z) => {
    const seg = { from, to: z.upTo, color: z.color };
    from = z.upTo;
    return seg;
  });

  const [nx, ny] = pt(heat, R - 14);
  const [dotX, dotY] = pt(heat, R + 10);

  return (
    <div className="relative" role="img" aria-label={`Portfolio heat ${Math.round(heat)} of 100 — ${zone.label}`}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="mx-auto overflow-visible">
        {/* zone tracks */}
        {segments.map((s) => (
          <path
            key={s.color}
            d={arc(s.from, s.to, R)}
            stroke={s.color}
            strokeWidth={9}
            fill="none"
            strokeLinecap="butt"
            opacity={0.22}
          />
        ))}
        {/* active value arc */}
        <motion.path
          d={arc(0, Math.max(0.6, heat), R)}
          stroke={zone.color}
          strokeWidth={9}
          fill="none"
          strokeLinecap="round"
          initial={{ opacity: 0.4 }}
          animate={{ opacity: 1 }}
          style={{ filter: `drop-shadow(0 0 7px ${zone.color})` }}
        />
        {/* ticks */}
        {Array.from({ length: 11 }).map((_, i) => {
          const h = i * 10;
          const [x1, y1] = pt(h, R - 8);
          const [x2, y2] = pt(h, R - 13);
          return (
            <line
              key={i}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={h <= heat ? zone.color : "rgba(159,180,171,0.3)"}
              strokeWidth={i % 5 === 0 ? 2 : 1}
            />
          );
        })}
        {/* needle */}
        <motion.g
          initial={false}
          animate={{ rotate: -90 + heat * 1.8 }}
          transition={{ type: "spring", stiffness: 42, damping: 11 }}
          style={{ transformOrigin: `${cx}px ${cy}px` }}
        >
          <line x1={cx} y1={cy} x2={cx} y2={cy - (R - 22)} stroke={zone.color} strokeWidth={2.4} strokeLinecap="round" style={{ filter: `drop-shadow(0 0 4px ${zone.color})` }} />
          <circle cx={nx} cy={ny} r={3.4} fill={zone.color} />
        </motion.g>
        <circle cx={cx} cy={cy} r={6} fill="#0a0f13" stroke={zone.color} strokeWidth={2} />
        {/* heat marker dot on outer band */}
        <motion.circle
          cx={dotX}
          cy={dotY}
          r={3}
          fill={zone.color}
          animate={{ opacity: [1, 0.25, 1] }}
          transition={{ duration: 1.6, repeat: Infinity }}
        />
        {/* scale labels */}
        <text x={16} y={H - 0.5} fill="#5c6f66" fontSize={9} fontFamily="var(--font-terminal), monospace">0</text>
        <text x={W - 22} y={H - 0.5} fill="#5c6f66" fontSize={9} fontFamily="var(--font-terminal), monospace">100</text>
      </svg>

      {/* center readout */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[18px] flex flex-col items-center">
        <span className="font-terminal text-3xl font-extrabold tabular-nums leading-none" style={{ color: zone.color, textShadow: `0 0 18px ${zone.color}66` }}>
          {Math.round(heat)}
        </span>
        <span className="label-tech mt-1" style={{ color: zone.color }}>{zone.label}</span>
      </div>
    </div>
  );
}

/* ── Heat trend sparkline (rolling session history, accent-aware) ── */

function HeatTrend({ history, color, height = 44 }: { history: number[]; color: string; height?: number }) {
  const W = 300;
  const H = height;
  const pad = 3;

  const pts = useMemo(() => {
    if (history.length < 2) return [];
    return history.map((v, i) => {
      const x = pad + (i / (history.length - 1)) * (W - pad * 2);
      const y = H - pad - (v / 100) * (H - pad * 2);
      return [x, y] as const;
    });
  }, [history, H]);

  if (pts.length === 0) {
    return (
      <div className="flex h-[44px] items-center justify-center rounded-lg border border-dashed border-white/8 font-terminal text-[9px] tracking-[0.18em] text-ink-3">
        SAMPLING HEAT — TREND IN ~40s
      </div>
    );
  }

  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1]![0].toFixed(1)},${H - pad} L${pts[0]![0].toFixed(1)},${H - pad} Z`;
  const [lx, ly] = pts[pts.length - 1]!;
  const min = Math.min(...history);
  const max = Math.max(...history);

  return (
    <div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Heat trend, ${history.length} samples, current ${Math.round(history[history.length - 1]!)}`}>
        {/* WARM / HOT thresholds */}
        <line x1={0} y1={H - pad - 0.35 * (H - pad * 2)} x2={W} y2={H - pad - 0.35 * (H - pad * 2)} stroke="rgba(255,179,71,0.22)" strokeDasharray="3 5" strokeWidth={1} />
        <line x1={0} y1={H - pad - 0.62 * (H - pad * 2)} x2={W} y2={H - pad - 0.62 * (H - pad * 2)} stroke="rgba(255,122,69,0.22)" strokeDasharray="3 5" strokeWidth={1} />
        <path d={area} fill={`${color}14`} />
        <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 4px ${color}88)` }} />
        <circle cx={lx} cy={ly} r={2.6} fill={color} className="anim-pulse-dot" />
      </svg>
      <div className="mt-1 flex items-center justify-between font-terminal text-[8px] tracking-[0.16em] text-ink-3">
        <span>LO {Math.round(min)}</span>
        <span>{history.length} SAMPLES · ~20s APART</span>
        <span>HI {Math.round(max)}</span>
      </div>
    </div>
  );
}

/* ── Position risk row ────────────────────────────────────── */

function RiskRow({ r, delay, coolColor }: { r: PositionRisk; delay: number; coolColor: string }) {
  const z = heatZone(r.heat, coolColor);
  const win = r.pnlPct >= 0;
  return (
    <motion.li
      initial={{ opacity: 0, x: -14 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.4, delay }}
      className="group rounded-lg border border-white/6 bg-white/[0.02] px-3 py-2.5 transition-colors hover:border-white/12 hover:bg-white/[0.04]"
    >
      <div className="flex items-center gap-2.5">
        {/* symbol + direction */}
        <div className="flex min-w-0 flex-[1.2] items-center gap-2">
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              r.proximity > 0.66 ? "bg-danger-neon anim-pulse-dot" : r.proximity > 0.33 ? "bg-amber-neon" : "bg-neon"
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="truncate font-terminal text-[11px] font-bold tracking-[0.1em] text-ink">{r.signal.symbol}</div>
            <div className="flex items-center gap-1.5">
              <span className={cn("font-terminal text-[9px] font-bold tracking-[0.14em]", r.signal.direction === "LONG" ? "text-neon" : "text-magenta-neon")}>
                {r.signal.direction}
              </span>
              <span className="font-terminal text-[9px] tracking-[0.1em] text-ink-3">{r.signal.timeframe} · {r.signal.leverage}×</span>
            </div>
          </div>
        </div>

        {/* live pnl */}
        <div className="flex-1 text-right">
          <div className={cn("font-terminal text-[11px] font-bold tabular-nums", win ? "text-neon" : "text-danger-neon")}>
            {win ? "+" : ""}{r.pnlPct.toFixed(1)}%
          </div>
          <div className="font-terminal text-[9px] tabular-nums text-ink-3">{fmtPrice(r.price)}</div>
        </div>

        {/* distance to stop */}
        <div className="hidden flex-1 text-right sm:block">
          <div className="font-terminal text-[11px] font-bold tabular-nums text-ink-2">{r.distToSlPct.toFixed(2)}%</div>
          <div className="font-terminal text-[9px] tracking-[0.1em] text-ink-3">TO STOP</div>
        </div>

        {/* risk at stake */}
        <div className="hidden flex-1 text-right md:block">
          <div className="font-terminal text-[11px] font-bold tabular-nums text-amber-neon">-{fmtUsd(r.riskUsd, false)}</div>
          <div className="font-terminal text-[9px] tracking-[0.1em] text-ink-3">IF STOPPED</div>
        </div>

        {/* heat bar */}
        <div className="flex w-[86px] shrink-0 items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
            <motion.div
              className="h-full rounded-full"
              style={{ background: `linear-gradient(90deg, ${coolColor}, #ffb347 55%, ${r.proximity > 0.6 ? "#ff4d5e" : "#ffb347"})`, boxShadow: `0 0 6px ${z.color}55` }}
              initial={{ width: 0 }}
              animate={{ width: `${r.heat}%` }}
              transition={{ duration: 0.9, delay, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <span className="w-6 font-terminal text-[9px] font-bold tabular-nums" style={{ color: z.color }}>{Math.round(r.heat)}</span>
        </div>
      </div>
    </motion.li>
  );
}

/* ── Desk assembly ────────────────────────────────────────── */

export function RiskDesk() {
  const { data } = usePulse();
  const NEON = useNeon(); // accent-following COOL-zone color
  const heatHistory = useAlerts((s) => s.heatHistory);
  const pushHeatSample = useAlerts((s) => s.pushHeatSample);
  const pushHeatTimeline = useAlerts((s) => s.pushHeatTimeline);
  const lastSampleRef = useRef(0);
  const risks = useMemo(() => (data ? buildRisks(data.signals, data.market) : []), [data]);

  /* sample the rolling heat trend — throttled to one point / ~20s, persisted
     (numbers → RiskDesk sparkline, timestamped → analytics SESSION HEAT) */
  useEffect(() => {
    if (!data) return;
    const rs = buildRisks(data.signals, data.market);
    const eq = data.stats.account.equity || 1;
    const totalRisk = rs.reduce((a, r) => a + r.riskUsd, 0);
    const riskPct = (totalRisk / eq) * 100;
    const avgProx = rs.length ? rs.reduce((a, r) => a + r.proximity, 0) / rs.length : 0;
    const h = Math.min(100, Math.min(1, riskPct / 25) * 70 + avgProx * 30);
    const t = Date.now();
    if (t - lastSampleRef.current >= SAMPLE_THROTTLE_MS) {
      lastSampleRef.current = t;
      pushHeatSample(h);
      pushHeatTimeline({ t, v: h });
    }
  }, [data, pushHeatSample, pushHeatTimeline]);

  if (!data) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="bento h-[330px] animate-pulse lg:col-span-4" />
        <div className="bento h-[330px] animate-pulse lg:col-span-8" />
      </div>
    );
  }

  const equity = data.stats.account.equity || 1;
  const totalRiskUsd = risks.reduce((a, r) => a + r.riskUsd, 0);
  const riskPctOfEquity = (totalRiskUsd / equity) * 100;
  const avgProx = risks.length ? risks.reduce((a, r) => a + r.proximity, 0) / risks.length : 0;
  const heat = Math.min(100, Math.min(1, riskPctOfEquity / 25) * 70 + avgProx * 30);
  const zone = heatZone(heat, NEON);
  const marginPct = data.stats.account.marginUsedPct;
  const worst = risks[0];
  const trendPrev = heatHistory.length > 1 ? heatHistory[heatHistory.length - 2] : heatHistory[0];
  const trendNow = heatHistory.length ? heatHistory[heatHistory.length - 1] : undefined;
  const trendDelta = trendNow !== undefined && trendPrev !== undefined ? trendNow - trendPrev : undefined;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      {/* ① heat gauge */}
      <BentoCard tone={zone.tone === "danger" ? "magenta" : "neon"} className="lg:col-span-4" delay={0.02}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <Flame size={15} className="text-amber-neon" aria-hidden />
            <span className="label-tech">Portfolio heat</span>
            <LiveDot tone={zone.tone === "danger" ? "danger" : "neon"} />
          </div>
          <NeonBadge tone={zone.tone} glow={heat > 62}>
            {risks.length} LIVE
          </NeonBadge>
        </div>

        <HeatGauge heat={heat} zone={zone} coolColor={NEON} />

        {/* zone legend */}
        <div className="mt-1 flex items-center justify-center gap-3" aria-hidden>
          {["COOL", "WARM", "HOT", "CRIT"].map((label, i) => {
            const c = [NEON, "#ffb347", "#ff7a45", "#ff4d5e"][i];
            const active = zone.label === label || (label === "CRIT" && zone.label === "CRITICAL");
            return (
              <span
                key={label}
                className={cn(
                  "inline-flex items-center gap-1 font-terminal text-[8px] font-bold tracking-[0.16em] transition-opacity",
                  active ? "opacity-100" : "opacity-35"
                )}
                style={{ color: c }}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: c, boxShadow: active ? `0 0 6px ${c}` : "none" }} />
                {label}
              </span>
            );
          })}
        </div>

        {/* rolling heat trend */}
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="label-tech inline-flex items-center gap-1.5">
              <Activity size={10} className="text-neon" aria-hidden /> HEAT TREND // SESSION
            </span>
            {trendDelta !== undefined && (
              <span
                className={cn(
                  "font-terminal text-[9px] font-bold tabular-nums",
                  trendDelta > 0.05 ? "text-danger-neon" : trendDelta < -0.05 ? "text-neon" : "text-ink-3"
                )}
              >
                {trendDelta > 0.05 ? "▲" : trendDelta < -0.05 ? "▼" : "—"} {Math.abs(trendDelta).toFixed(1)}
              </span>
            )}
          </div>
          <HeatTrend history={heatHistory} color={NEON} />
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-white/6 bg-white/[0.02] px-2.5 py-2 text-center">
            <div className="font-terminal text-[13px] font-bold tabular-nums text-amber-neon">{riskPctOfEquity.toFixed(1)}%</div>
            <div className="label-tech mt-0.5 text-[8px]">RISK / EQUITY</div>
          </div>
          <div className="rounded-lg border border-white/6 bg-white/[0.02] px-2.5 py-2 text-center">
            <div className="font-terminal text-[13px] font-bold tabular-nums text-violet-neon">{marginPct.toFixed(1)}%</div>
            <div className="label-tech mt-0.5 text-[8px]">MARGIN USED</div>
          </div>
          <div className="rounded-lg border border-white/6 bg-white/[0.02] px-2.5 py-2 text-center">
            <div className="font-terminal text-[13px] font-bold tabular-nums text-cyan-neon">{fmtUsd(totalRiskUsd)}</div>
            <div className="label-tech mt-0.5 text-[8px]">AT STAKE</div>
          </div>
        </div>

        {zone.label === "CRITICAL" && (
          <p className="mt-2.5 flex items-center gap-1.5 rounded-md border border-[rgba(255,77,94,0.3)] bg-[rgba(255,77,94,0.07)] px-2 py-1.5 font-terminal text-[9px] font-bold tracking-[0.14em] text-danger-neon anim-pulse-glow">
            <ShieldAlert size={11} aria-hidden /> RISK LIMIT BREACH — CONSIDER TRIMMING
          </p>
        )}
      </BentoCard>

      {/* ② position risk table */}
      <BentoCard className="lg:col-span-8" delay={0.08}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <Crosshair size={15} className="text-neon" aria-hidden />
            <span className="label-tech">Position risk // live</span>
            <LiveDot />
          </div>
          <div className="flex items-center gap-2">
            {worst && (
              <NeonBadge tone={heatZone(worst.heat).tone}>
                HOTTEST {worst.signal.symbol} {Math.round(worst.heat)}
              </NeonBadge>
            )}
            <span className="hidden items-center gap-1 font-terminal text-[9px] tracking-[0.14em] text-ink-3 sm:flex">
              SORTED BY HEAT <ChevronRight size={10} aria-hidden />
            </span>
          </div>
        </div>

        {/* column header */}
        <div className="mb-2 flex items-center gap-2.5 border-b border-white/6 px-3 pb-1.5 font-terminal text-[8px] font-bold uppercase tracking-[0.18em] text-ink-3">
          <span className="flex-[1.2]">POSITION</span>
          <span className="flex-1 text-right">PNL / PRICE</span>
          <span className="hidden flex-1 text-right sm:block">STOP DIST</span>
          <span className="hidden flex-1 text-right md:block">RISK $</span>
          <span className="w-[86px] shrink-0 text-right">HEAT</span>
        </div>

        {risks.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-neon/20">
            <Layers size={18} className="text-ink-3" aria-hidden />
            <span className="label-tech">FLAT — NO OPEN RISK ON THE BOOK</span>
          </div>
        ) : (
          <ul className="max-h-[248px] space-y-1.5 overflow-y-auto pr-0.5">
            {risks.map((r, i) => (
              <RiskRow key={r.signal.id} r={r} delay={0.05 + i * 0.05} coolColor={NEON} />
            ))}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/6 pt-2.5 font-terminal text-[9px] tracking-[0.12em] text-ink-3">
          <span>Σ STAKE {fmtUsd(totalRiskUsd, false)} · {riskPctOfEquity.toFixed(1)}% OF EQUITY</span>
          <span>ASSUMES FULL STOP-OUT · LEVERAGE INCLUDED</span>
        </div>
      </BentoCard>
    </div>
  );
}
