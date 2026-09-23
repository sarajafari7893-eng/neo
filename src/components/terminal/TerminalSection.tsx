"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Activity, Eraser, Gauge, Link2, MousePointerClick, Pause, Play, Radio, Waves } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge, SectionHeader } from "@/components/shared/primitives";
import FlowScannerCard from "@/components/terminal/FlowScannerCard";
import LiqDepthRadarCard from "@/components/terminal/LiqDepthRadarCard";
import VolRiskCard from "@/components/terminal/VolRiskCard";
import GateGaugeCard from "@/components/terminal/GateGaugeCard";
import ShadowVetoCard from "@/components/terminal/ShadowVetoCard";
import FuturesRadarCard from "@/components/terminal/FuturesRadarCard";
import RawCalCard from "@/components/terminal/RawCalCard";
import { useMounted, useNow, useDeviceNow, usePulse } from "@/hooks/usePulse";
import { fmtClockLocal, localTzLabel } from "@/lib/format";
import type { EventLevel, SignalEventDTO } from "@/lib/api-types";
import { useUi } from "@/store/ui";
import { cn } from "@/lib/utils";

/* ── config ─────────────────────────────────────────────────────────── */

type LevelFilter = "ALL" | "AI" | "TP" | "STOPS" | "SYSTEM";

const FILTERS: ReadonlyArray<{ id: LevelFilter; label: string }> = [
  { id: "ALL", label: "ALL" },
  { id: "AI", label: "AI" },
  { id: "TP", label: "TP HITS" },
  { id: "STOPS", label: "STOPS" },
  { id: "SYSTEM", label: "SYSTEM" },
];

const LEVEL_META: Record<EventLevel, { tag: string; cls: string }> = {
  ai: { tag: "◈ AI", cls: "text-violet-neon" },
  success: { tag: "✓", cls: "text-neon" },
  warn: { tag: "▲", cls: "text-amber-neon" },
  error: { tag: "✕", cls: "text-danger-neon" },
  info: { tag: "·", cls: "text-cyan-neon" },
};

const STAT_TYPES: ReadonlyArray<{ type: string; bar: string }> = [
  { type: "CREATED", bar: "bg-cyan-neon text-cyan-neon" },
  { type: "TP1", bar: "bg-neon text-neon" },
  { type: "TP2", bar: "bg-neon text-neon" },
  { type: "TP3", bar: "bg-neon text-neon" },
  { type: "SL", bar: "bg-danger-neon text-danger-neon" },
  { type: "TTL_EXPIRED", bar: "bg-amber-neon text-amber-neon" },
  { type: "TTL_EXTENDED", bar: "bg-cyan-neon text-cyan-neon" },
  { type: "BE_TRAIL", bar: "bg-cyan-neon text-cyan-neon" },
  { type: "AFTERLIFE", bar: "bg-violet-neon text-violet-neon" },
  { type: "TTL_EXT", bar: "bg-amber-neon text-amber-neon" },
];

const PROMPT_STATUS: ReadonlyArray<string> = [
  "monitoring liquidity pools…",
  "scanning orderflow…",
  "engine tick 5s",
];

/* v5.0 trigger-hierarchy display config */
const LAYER_CELLS: ReadonlyArray<{ key: string; label: string; tip: string; borderCls: string; textCls: string }> = [
  { key: "L1_TAKER_SWEEP", label: "L1 SWEEP", tip: "Aggressive taker burst (aggTrades) — the fastest trigger", borderCls: "border-[rgb(var(--neon-rgb)/0.35)] bg-[rgb(var(--neon-rgb)/0.05)]", textCls: "text-neon" },
  { key: "L15_OBI_IMBALANCE", label: "L1.5 OBI", tip: "Order-book imbalance, spoof-guarded across 2 snapshots", borderCls: "border-[rgba(69,240,223,0.35)] bg-[rgba(69,240,223,0.05)]", textCls: "text-cyan-neon" },
  { key: "L2_VACUUM", label: "L2 VACUUM", tip: "Liquidity vacuum / wall within ±2% depth map", borderCls: "border-[rgba(255,179,71,0.35)] bg-[rgba(255,179,71,0.05)]", textCls: "text-amber-neon" },
  { key: "L3_LIQ_CASCADE", label: "L3 CASCADE", tip: "REAL forceOrder liquidation cascade — anti-cascade veto armed", borderCls: "border-[rgba(255,77,94,0.35)] bg-[rgba(255,77,94,0.05)]", textCls: "text-danger-neon" },
  { key: "L3P_LIQ_PRE", label: "L3P PRE", tip: "v8.1 predictive pre-cascade: price near a dense liq-heat cluster + OI still piling — the magnet warning BEFORE the cascade", borderCls: "border-[rgba(255,140,66,0.4)] bg-[rgba(255,140,66,0.06)]", textCls: "text-orange-400" },
  { key: "L35_CROWD_JUMP", label: "L3.5 CROWD", tip: "Leverage crowding: funding extreme + OI jump — size cut armed", borderCls: "border-[rgba(255,78,205,0.35)] bg-[rgba(255,78,205,0.05)]", textCls: "text-magenta-neon" },
  { key: "L4_MACRO", label: "L4 MACRO", tip: "Macro flows — honest data gap: OBSERVING, never fabricated", borderCls: "border-white/10 bg-white/[0.02]", textCls: "text-ink-2" },
];

const LAYER_SHORT: Record<string, string> = {
  L1_TAKER_SWEEP: "L1",
  L15_OBI_IMBALANCE: "L1.5",
  L2_VACUUM: "L2",
  L3_LIQ_CASCADE: "L3",
  L3P_LIQ_PRE: "L3P",
  L35_CROWD_JUMP: "L3.5",
  L4_MACRO: "L4",
};

const REGIME_CLS: Record<string, string> = {
  TREND_UP: "border-[rgb(var(--neon-rgb)/0.45)] text-neon",
  TREND_DOWN: "border-[rgba(255,78,205,0.45)] text-magenta-neon",
  CHOP: "border-[rgba(159,180,171,0.3)] text-ink-2",
  VOLATILE: "border-[rgba(255,179,71,0.45)] text-amber-neon",
};

const REGIME_BAR: Record<string, string> = {
  TREND_UP: "bg-neon text-neon",
  TREND_DOWN: "bg-magenta-neon text-magenta-neon",
  CHOP: "bg-white/30 text-white/30",
  VOLATILE: "bg-amber-neon text-amber-neon",
};

interface EventsResponse {
  events: SignalEventDTO[];
  /** newest events carrying a signalId — drives Signal Links (Bug 4 fix) */
  linked: SignalEventDTO[];
}

function matchesFilter(e: SignalEventDTO, f: LevelFilter): boolean {
  switch (f) {
    case "ALL":
      return true;
    case "AI":
      return e.level === "ai";
    case "TP":
      return e.type.startsWith("TP");
    case "STOPS":
      return e.type === "SL" || e.type === "TTL_EXPIRED";
    case "SYSTEM":
      return e.type === "SYSTEM" || e.type === "ENGINE" || e.type === "TTL_EXTENDED" || e.type === "BE_TRAIL";
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/* ── main section ───────────────────────────────────────────────────── */

export default function TerminalSection() {
  const mounted = useMounted();
  const setOpenSignal = useUi((s) => s.setOpenSignal);
  const now = useNow(1000);
  const deviceNow = useDeviceNow(1000);
  const { data: pulse } = usePulse(5000);

  const [filter, setFilter] = useState<LevelFilter>("ALL");
  const [paused, setPaused] = useState(false);
  const [stick, setStick] = useState(true);
  const [clearAt, setClearAt] = useState(0);
  const [statusIdx, setStatusIdx] = useState(0);
  /* session boot timestamp — never rendered pre-mount, so SSR/client delta is invisible */
  const [bootTs] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /* deep event feed — newest N events, polled */
  const { data } = useQuery<EventsResponse>({
    queryKey: ["events"],
    queryFn: async () => {
      const res = await fetch("/api/events?limit=120", { cache: "no-store" });
      if (!res.ok) throw new Error(`events ${res.status}`);
      return (await res.json()) as EventsResponse;
    },
    refetchInterval: 5000,
  });

  /* rotating fake prompt status — deterministic cycle */
  useEffect(() => {
    const id = setInterval(() => setStatusIdx((i) => (i + 1) % PROMPT_STATUS.length), 3200);
    return () => clearInterval(id);
  }, []);

  /* ascending order — newest line renders at the bottom */
  const sorted = useMemo(() => {
    const evts = data?.events ?? [];
    return [...evts].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
  }, [data]);

  const visible = useMemo(
    () => sorted.filter((e) => (clearAt ? new Date(e.createdAt).getTime() > clearAt : true)),
    [sorted, clearAt]
  );

  const filtered = useMemo(() => visible.filter((e) => matchesFilter(e, filter)), [visible, filter]);

  /* autoscroll: stick to bottom unless user scrolled up or paused */
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setStick(nearBottom);
  }, []);

  const lastId = filtered.length > 0 ? filtered[filtered.length - 1]!.id : "";
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || paused || !stick) return;
    el.scrollTop = el.scrollHeight;
  }, [lastId, stick, paused]);

  const resume = useCallback(() => {
    setStick(true);
    setPaused(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const clearScreen = useCallback(() => {
    setClearAt(Date.now());
    setStick(true);
  }, []);

  /* ── session stats: counts by type — stream buffer ∪ authoritative pulse stats
     (v5.2 accuracy fix: rows now read the ENGINE's own lifetime aggregates —
     CREATED = all signals ever · TP1/TP2/TP3 = lifetime rung hits incl. post-expiry
     afterlife · SL/EXPIRED = settled outcomes · AFTERLIFE = live post-expiry
     trackers. No more undercounting from current-status-only snapshots.)
     v9.0 LIFECYCLE AUDIT (operator request 2026-09-12): BE_TRAIL / TTL_EXTENDED
     rows previously read ONLY the 120-event terminal window — ENGINE chatter
     (16k+ rows) flushed them out within minutes and the counters collapsed to 0.
     They now carry lifetime DB counts from stats.lifecycle; AFTERLIFE now shows
     tracking + RESOLVED outcomes, not just the currently-tracking slice. */
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of STAT_TYPES) map.set(t.type, 0);
    for (const e of visible) if (map.has(e.type)) map.set(e.type, (map.get(e.type) ?? 0) + 1);

    const s = pulse?.stats;
    const sigs = pulse?.signals ?? [];
    if (s) {
      // v10.3 TRUE-LIFETIME: CREATED/TP rungs/SL/EXPIRED read straight DB aggregates
      // over ALL rows (stats.lifecycle, 30s memo) — the old 7-day stats window +
      // 60-signal pulse slice dropped older activity and the rows went stale.
      map.set("CREATED", Math.max(map.get("CREATED") ?? 0, s.lifecycle.lifetimeSignals, s.totalSignals));
      map.set("SL", Math.max(map.get("SL") ?? 0, s.lifecycle.slLifetime, s.losses));
      map.set("TTL_EXPIRED", Math.max(map.get("TTL_EXPIRED") ?? 0, s.lifecycle.expiredLifetime, s.expired));
      map.set("TP1", Math.max(map.get("TP1") ?? 0, s.lifecycle.tp1HitsLifetime));
      map.set("TP2", Math.max(map.get("TP2") ?? 0, s.lifecycle.tp2HitsLifetime));
      map.set("TP3", Math.max(map.get("TP3") ?? 0, s.lifecycle.tp3HitsLifetime));
      // v9.0: lifetime AFTERLIFE = 48h trackers still running + resolved outcomes
      map.set("AFTERLIFE", Math.max(map.get("AFTERLIFE") ?? 0, s.lifecycle.afterlifeTotal));
      // v9.0: BE_TRAIL — lifetime breakeven arms straight from SignalEvent
      map.set("BE_TRAIL", Math.max(map.get("BE_TRAIL") ?? 0, s.lifecycle.beTrail));
      // v9.0: TTL_EXTENDED — lifetime grants (events); TTL_EXT keeps distinct signals
      map.set("TTL_EXTENDED", Math.max(map.get("TTL_EXTENDED") ?? 0, s.lifecycle.ttlExtendedEvents));
      map.set("TTL_EXT", Math.max(map.get("TTL_EXT") ?? 0, s.lifecycle.ttlSignalsWithExt, s.pnlLedger.totals.ttlExtended));
      // lifetime TP rung hits from the live pulse slice — window can only RAISE the
      // DB aggregate when a rung landed within the last 30s memo horizon.
      const hit = (pred: (afterlife: string) => boolean, rungs: string[]) =>
        sigs.filter((x) => rungs.includes(x.status) || (x.afterlife ? pred(x.afterlife) : false)).length;
      map.set("TP1", Math.max(map.get("TP1") ?? 0, hit((a) => a.includes("TP1"), ["TP1", "TP2", "TP3"])));
      map.set("TP2", Math.max(map.get("TP2") ?? 0, hit((a) => a === "TP2_HIT" || a === "TP3_HIT", ["TP2", "TP3"])));
      map.set("TP3", Math.max(map.get("TP3") ?? 0, hit((a) => a === "TP3_HIT", ["TP3"])));
    }
    return map;
  }, [visible, pulse]);

  const maxCount = useMemo(() => {
    let m = 1;
    for (const v of counts.values()) if (v > m) m = v;
    return m;
  }, [counts]);

  /* EPOCH-2 zero-state: ledger genuinely empty (no signals since reset) →
     the panel shows an explicit clean-state note instead of silent zeros */
  const epochClean = (pulse?.stats?.totalSignals ?? 0) === 0 && (pulse?.signals ?? []).length === 0;

  /* v9.0 PUMP/DUMP RADAR — gate + tracks from the pulse feed (15s server memo) */
  const pump = pulse?.feed?.pump ?? null;

  /* ── stream health — REAL engine/feed telemetry (Bug 3 fix: honest liq feed row) ── */
  const health = useMemo(() => {
    if (sorted.length < 2) return null;
    const newest = new Date(sorted[sorted.length - 1]!.createdAt).getTime();
    const oldest = new Date(sorted[0]!.createdAt).getTime();
    const spanMin = Math.max((newest - oldest) / 60_000, 0.5);
    return { perMin: sorted.length / spanMin };
  }, [sorted]);

  const feed = pulse?.feed ?? null;
  const liq = feed?.liq ?? null;
  const liqState: { label: string; cls: string; tip: string } = !liq
    ? { label: "OFFLINE", cls: "text-ink-3", tip: "liq-service :3010 unreachable — derived OI probe in use, no invented data" }
    : liq.dataStalled
      ? { label: "NO DATA", cls: "text-amber-neon", tip: "exchange frames blocked from this host — watchdog honest state; derived probe in use" }
      : liq.connected
        ? { label: `CONNECTED ${liq.buffered}`, cls: "text-neon", tip: "!forceOrder@arr streaming" }
        : { label: "RECONNECTING", cls: "text-amber-neon", tip: "auto-reconnect 5s" };
  const flowCovered = feed?.flow.covered ?? 0;
  const triggers = feed?.triggers ?? null;
  const regimes = feed?.regimes ?? [];

  const uptime = mounted && now >= bootTs ? fmtUptime(now - bootTs) : "--:--:--";

  const linked = useMemo(() => {
    // Bug 4 fix: prefer the dedicated linked-events query (any signal-attached event in DB),
    // fall back to scanning the visible buffer, then to recent signals from pulse.
    const fromApi = (data?.linked ?? []).slice(0, 5);
    if (fromApi.length > 0) return fromApi;
    const fromBuffer = sorted.filter((e) => e.signalId).slice(-5).reverse();
    if (fromBuffer.length > 0) return fromBuffer;
    return [];
  }, [data, sorted]);

  const totalEvents = data?.events.length ?? 0;

  return (
    <section aria-label="Engine terminal">
      <SectionHeader
        index="04"
        title="ENGINE TERMINAL"
        subtitle="CRT event feed — filter, freeze and stream the signal engine live"
        right={<NeonBadge tone="violet">POLL 5S</NeonBadge>}
      />

      <div className="grid gap-4 xl:grid-cols-3">
        {/* ── CRT log panel ── */}
        <BentoCard corners className="overflow-hidden p-0 sm:p-0 xl:col-span-2">
          {/* titlebar */}
          <div className="flex items-center gap-2 border-b border-white/5 bg-[rgba(255,255,255,0.02)] px-4 py-3">
            <span className="size-3 shrink-0 rounded-full bg-[#ff4d5e] shadow-[0_0_8px_rgba(255,77,94,0.6)]" aria-hidden />
            <span className="size-3 shrink-0 rounded-full bg-[#ffb347] shadow-[0_0_8px_rgba(255,179,71,0.5)]" aria-hidden />
            <span className="size-3 shrink-0 rounded-full bg-neon shadow-[0_0_8px_rgb(var(--neon-rgb)/0.6)]" aria-hidden />
            <span className="ml-2 truncate font-terminal text-xs text-ink-2">flowradar@core:~ — engine.log</span>
            <span className="ml-auto font-terminal text-[10px] uppercase tracking-[0.18em] text-ink-3">
              {String(totalEvents).padStart(3, "0")} EV
            </span>
            {paused ? (
              <NeonBadge tone="amber">
                <LiveDot tone="amber" /> PAUSED
              </NeonBadge>
            ) : (
              <NeonBadge tone="neon" glow>
                <LiveDot /> LIVE
              </NeonBadge>
            )}
          </div>

          {/* control strip */}
          <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Log level filters">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                  className={cn(
                    "min-h-11 rounded border px-3 font-terminal text-[10px] font-bold uppercase tracking-[0.14em] transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60",
                    filter === f.id
                      ? "border-neon/50 bg-neon/10 text-neon"
                      : "border-white/10 text-ink-3 hover:border-neon/30 hover:text-ink-2"
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPaused((p) => !p)}
                aria-pressed={paused}
                aria-label={paused ? "Resume autoscroll" : "Pause autoscroll"}
                className={cn(
                  "grid size-11 place-items-center rounded border transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60",
                  paused
                    ? "border-amber-neon/50 bg-amber-neon/10 text-amber-neon"
                    : "border-white/10 text-ink-2 hover:border-neon/40 hover:text-neon"
                )}
              >
                {paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
              </button>
              <button
                type="button"
                onClick={clearScreen}
                aria-label="Clear log buffer (local only)"
                title="Clear screen (local)"
                className={cn(
                  "grid size-11 place-items-center rounded border border-white/10 text-ink-2 transition-colors",
                  "hover:border-danger-neon/50 hover:text-danger-neon",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-neon/60"
                )}
              >
                <Eraser className="size-4" aria-hidden />
              </button>
            </div>
          </div>

          {/* log viewport */}
          <div className="relative">
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              role="log"
              aria-live="polite"
              aria-label="Engine event log"
              className="grid-bg-fine relative h-[62vh] overflow-y-auto px-4 py-3 font-terminal text-[12px] leading-relaxed"
            >
              {filtered.length === 0 && (
                <p className="text-ink-3">
                  {clearAt ? "── buffer flushed — awaiting new events ──" : "awaiting engine telemetry…"}
                </p>
              )}
              {filtered.map((e) => {
                const meta = LEVEL_META[e.level];
                return (
                  <motion.div
                    key={e.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                    className="flex items-start gap-2 py-[3px]"
                  >
                    <span className="shrink-0 tabular-nums text-ink-3">
                      [{mounted ? fmtClockLocal(new Date(e.createdAt).getTime()) : "--:--:--"}]
                    </span>
                    <span className={cn("w-10 shrink-0 font-bold", meta.cls)}>{meta.tag}</span>
                    {e.symbol && (
                      <span className="shrink-0 rounded border border-[rgba(255,78,205,0.35)] px-1 font-bold leading-5 text-magenta-neon">
                        {e.symbol}
                      </span>
                    )}
                    <span className={cn("min-w-0 flex-1 break-words", e.level === "ai" ? "text-violet-neon/90" : "text-ink-2")}>
                      {e.message}
                    </span>
                  </motion.div>
                );
              })}
            </div>
            {/* inner scanline + CRT top shade */}
            <div
              className="pointer-events-none absolute inset-0"
              aria-hidden
              style={{
                background:
                  "repeating-linear-gradient(0deg, rgba(255,255,255,0.024) 0px, rgba(255,255,255,0.024) 1px, transparent 1px, transparent 3px)",
              }}
            />
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-[rgba(0,0,0,0.4)] to-transparent"
              aria-hidden
            />
            {/* detached autoscroll pill */}
            {(!stick || paused) && filtered.length > 0 && (
              <button
                type="button"
                onClick={resume}
                className={cn(
                  "absolute bottom-3 right-4 z-10 flex min-h-11 items-center gap-1.5 rounded-full border border-neon/60 bg-[rgb(var(--neon-rgb)/0.14)] px-4",
                  "font-terminal text-[10px] font-bold uppercase tracking-[0.18em] text-neon backdrop-blur-sm transition-colors hover:bg-[rgb(var(--neon-rgb)/0.24)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/70"
                )}
              >
                <Play className="size-3" aria-hidden /> RESUME
              </button>
            )}
          </div>

          {/* prompt line */}
          <div className="flex items-center gap-2 border-t border-white/5 bg-[rgba(0,0,0,0.35)] px-4 py-2.5 font-terminal text-xs">
            <span className="shrink-0 font-bold text-neon">flowradar@core:~$</span>
            <span className="min-w-0 truncate text-ink-3">{mounted ? PROMPT_STATUS[statusIdx] : "booting engine…"}</span>
            <span className="anim-caret ml-0.5 inline-block h-3.5 w-[7px] shrink-0 bg-neon" aria-hidden />
          </div>
        </BentoCard>

        {/* ── right rail ── */}
        <div className="flex flex-col gap-4">
          {/* session stats — v8.1: rows are ENGINE LIFETIME aggregates (v5.2 doctrine);
              badge + epoch zero-state added after the operator's "داده های اشتباه" report:
              an all-zero panel is now explicitly labeled EPOCH-CLEAN instead of looking broken,
              and monotonic telemetry can no longer inject phantom counts (stats.ts hardening) */}
          <BentoCard className="p-4 sm:p-4" delay={0.05}>
            <div className="mb-3 flex items-center gap-2">
              <Activity className="size-3.5 text-neon" aria-hidden />
              <span className="label-tech">Session Stats</span>
              <NeonBadge tone="muted" className="ml-auto">
                LIFETIME
              </NeonBadge>
            </div>
            <div className="space-y-2.5">
              {STAT_TYPES.map((t) => {
                const c = counts.get(t.type) ?? 0;
                return (
                  <div key={t.type}>
                    <div className="flex items-center justify-between font-terminal text-[10px]">
                      <span className="uppercase tracking-[0.16em] text-ink-3">{t.type}</span>
                      <span className="font-bold tabular-nums text-ink">{String(c).padStart(2, "0")}</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/5">
                      <div
                        className={cn("h-full rounded-full transition-[width] duration-700", t.bar)}
                        style={{ width: `${(c / maxCount) * 100}%`, boxShadow: "0 0 6px currentColor" }}
                      />
                    </div>
                  </div>
                );
              })}
              {epochClean && (
                <p className="border-t border-white/5 pt-2 font-terminal text-[10px] leading-relaxed tracking-[0.08em] text-ink-3">
                  EPOCH-2 CLEAN — counters seed from the first deployed signal
                </p>
              )}
            </div>
          </BentoCard>

          {/* ── v9.0 PUMP/DUMP RADAR — independent flow-tracking engine ──
              operator mandate 2026-09-12: detect + track pump/dump flows;
              signals stay FORBIDDEN until 5 tracks resolve SUCCESS, then
              deploys carry the dedicated PUMP/DUMP card cohorts. */}
          <BentoCard className="p-4 sm:p-4" delay={0.08}>
            <div className="mb-3 flex items-center gap-2">
              <Waves className="size-3.5 text-magenta-neon" aria-hidden />
              <span className="label-tech">Pump/Dump Radar</span>
              {pump && (
                <NeonBadge tone={pump.gate.unlocked ? "neon" : "amber"} className="ml-auto" glow={pump.gate.unlocked}>
                  {pump.gate.unlocked ? "UNLOCKED" : `LOCKED ${pump.gate.successful}/${pump.gate.required}`}
                </NeonBadge>
              )}
            </div>
            <div className="space-y-2 font-terminal text-[11px]">
              <div className="flex items-center justify-between">
                <span className="label-tech">learning gate</span>
                <span className={cn("font-bold tabular-nums", pump?.gate.unlocked ? "text-neon" : "text-amber-neon")}>
                  {pump ? `${pump.gate.successful}✓ / ${pump.gate.failed}✕ of ${pump.gate.total} tracks` : "--"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="label-tech">signal authority</span>
                <span className={cn("font-bold uppercase tracking-[0.14em]", pump?.authority === "direct" ? "text-magenta-neon" : pump?.gate.unlocked ? "text-neon" : "text-ink-3")}>
                  {pump?.authority === "direct" ? "DIRECT (evidence ≥78)" : pump?.gate.unlocked ? "PUMP/DUMP CARDS ARMED" : "FORBIDDEN UNTIL 5 SUCCESSES"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="label-tech">tape</span>
                <span className="font-bold tabular-nums text-ink">
                  {pump ? `${pump.tapeSymbols} symbols ${pump.warm ? "· warm" : "· warming"}` : "--"}
                </span>
              </div>
              {(pump?.active.length ?? 0) > 0 && (
                <div className="space-y-1 border-t border-white/5 pt-2">
                  <span className="label-tech">active tracks</span>
                  {pump!.active.map((t) => (
                    <div key={t.id} className="flex items-center justify-between gap-2">
                      <span className={cn("shrink-0 rounded border px-1 font-bold", t.kind === "PUMP" ? "border-magenta-neon/40 text-magenta-neon" : "border-danger-neon/40 text-danger-neon")}>
                        {t.kind}
                      </span>
                      <span className="truncate font-bold text-ink">{t.symbol}</span>
                      <span className="shrink-0 text-ink-3">{t.phase.toLowerCase()}</span>
                      <span className={cn("shrink-0 font-bold tabular-nums", t.mfePct >= 0 ? "text-neon" : "text-danger-neon")}>
                        {t.mfePct >= 0 ? "+" : ""}{t.mfePct.toFixed(1)}%
                      </span>
                      <span className="shrink-0 text-ink-3">s{t.score}</span>
                    </div>
                  ))}
                </div>
              )}
              {(pump?.recent.length ?? 0) > 0 && (
                <div className="space-y-1 border-t border-white/5 pt-2">
                  <span className="label-tech">recent resolutions</span>
                  {pump!.recent.slice(0, 4).map((t) => (
                    <div key={t.id} className="flex items-center justify-between gap-2">
                      <span className={cn("shrink-0 font-bold", t.outcome === "SUCCESS" ? "text-neon" : "text-danger-neon")}>
                        {t.outcome === "SUCCESS" ? "✓" : "✕"} {t.kind}
                      </span>
                      <span className="truncate font-bold text-ink">{t.symbol}</span>
                      <span className="shrink-0 tabular-nums text-ink-3">
                        MFE {t.mfePct >= 0 ? "+" : ""}{t.mfePct.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </BentoCard>

          {/* ── v9.1 RAW-CAL CAPTURE MODE — operator mandate 2026-09-13 ──
              unfiltered signal issuance for data capture only, feeding the
              engine-memory book toward the AI CALIBRATION bar (100 settled);
              auto-cancels at the target, then the new calibration commands. */}
          <RawCalCard />

          {/* event stream health — REAL feed telemetry (v4.8) */}
          <BentoCard className="p-4 sm:p-4" delay={0.1}>
            <div className="mb-3 flex items-center gap-2">
              <Gauge className="size-3.5 text-cyan-neon" aria-hidden />
              <span className="label-tech">Event Stream Health</span>
              {feed && (
                <NeonBadge tone={feed.source === "LIVE" ? "neon" : "amber"} className="ml-auto">
                  {feed.source === "LIVE" ? `LIVE ${feed.latencyMs ?? "--"}MS` : feed.source === "STALE" ? "CACHED" : "SIM"}
                </NeonBadge>
              )}
            </div>
            <div className="space-y-2 font-terminal text-[11px]">
              <div className="flex items-center justify-between">
                <span className="label-tech">events / min</span>
                <span className="font-bold tabular-nums text-neon">{health ? health.perMin.toFixed(1) : "--"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="label-tech">binance feed</span>
                <span className="font-bold tabular-nums text-cyan-neon">
                  {feed?.host ? `${feed.host.replace("https://", "")}` : "--"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="label-tech">4-ex consensus</span>
                <span className="flex items-center gap-1 font-bold tabular-nums text-cyan-neon">
                  {(feed?.exchanges ?? []).filter((v) => v.ok).length}/4
                  <LiveDot tone={(feed?.exchanges ?? []).filter((v) => v.ok).length >= 3 ? "neon" : "amber"} />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="label-tech">flow data</span>
                <span className={cn("flex items-center gap-1.5 font-bold uppercase tracking-[0.14em]", flowCovered > 0 ? "text-neon" : "text-amber-neon")}>
                  {flowCovered > 0 ? (
                    <>
                      <LiveDot /> {flowCovered} SYMBOLS
                    </>
                  ) : (
                    "WARMING"
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between" title={liqState.tip}>
                <span className="label-tech">liq feed</span>
                <span className={cn("flex items-center gap-1.5 font-bold uppercase tracking-[0.14em]", liqState.cls)}>
                  {liq && !liq.dataStalled && liq.connected ? <LiveDot /> : <LiveDot tone="amber" />} {liqState.label}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="label-tech">session uptime</span>
                <span className="font-bold tabular-nums text-ink">{uptime}</span>
              </div>
              {/* operator request 2026-09-07 «ساعت در داشبورد رو با ساعت سیستم یکی کن»:
                  every wall-clock surface follows the operator's DEVICE system clock */}
              <div className="flex items-center justify-between" title="your device system clock — matches the OS taskbar">
                <span className="label-tech">system clock</span>
                <span className="font-bold tabular-nums text-ink">
                  {mounted ? `${fmtClockLocal(deviceNow)} ${localTzLabel()}` : "--:--:--"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="label-tech">feed status</span>
                <span className="flex items-center gap-1.5 font-bold uppercase tracking-[0.16em] text-neon">
                  <LiveDot /> streaming
                </span>
              </div>
            </div>
          </BentoCard>

          {/* TRIGGER BUS — event-driven engine telemetry (v5.0 trigger hierarchy) */}
          <BentoCard className="p-4 sm:p-4" delay={0.12}>
            <div className="mb-3 flex items-center gap-2">
              <Radio className="size-3.5 text-violet-neon" aria-hidden />
              <span className="label-tech">Trigger Bus</span>
              {triggers && triggers.lastCycleAt && Date.now() - triggers.lastCycleAt < 10 * 60_000 ? (
                <NeonBadge tone="violet" glow className="ml-auto">
                  <LiveDot tone="violet" /> EVENT-DRIVEN
                </NeonBadge>
              ) : (
                <NeonBadge tone="muted" className="ml-auto">
                  WARMING
                </NeonBadge>
              )}
            </div>
            {!triggers || triggers.last.length === 0 ? (
              <p className="font-terminal text-[11px] leading-relaxed text-ink-3">
                Bus rotating through the universe — taker sweeps, OBI extremes, vacuums and cascades fire as THEY happen, not on a scan schedule.
              </p>
            ) : (
              <>
                {/* layer counters */}
                <div className="mb-2.5 grid grid-cols-3 gap-1.5">
                  {LAYER_CELLS.map((l) => {
                    const n = triggers.counts[l.key] ?? 0;
                    return (
                      <div key={l.key} title={l.tip} className={cn("rounded-lg border px-2 py-1.5", n > 0 ? l.borderCls : "border-white/8 bg-white/[0.02]")}>
                        <div className={cn("font-terminal text-[9px] font-bold uppercase tracking-[0.1em]", n > 0 ? l.textCls : "text-ink-3")}>{l.label}</div>
                        <div className={cn("font-terminal text-base font-bold tabular-nums", n > 0 ? l.textCls : "text-ink-3")}>{String(n).padStart(2, "0")}</div>
                      </div>
                    );
                  })}
                </div>
                {/* recent trigger events */}
                <ul className="max-h-40 space-y-1 overflow-y-auto pr-1" aria-label="Recent trigger events">
                  {triggers.last.slice(0, 8).map((t, i) => (
                    <li key={`${t.at}-${t.layer}-${i}`} className="flex items-start gap-1.5 font-terminal text-[10px] leading-relaxed">
                      <span className={cn("shrink-0 rounded border px-1 font-bold leading-5", t.acted ? "border-[rgb(var(--neon-rgb)/0.5)] text-neon" : "border-white/10 text-ink-3")}>
                        {LAYER_SHORT[t.layer] ?? t.layer}
                      </span>
                      {t.symbol !== "—" && <span className="shrink-0 font-bold text-ink">{t.symbol.replace("USDT", "")}</span>}
                      {t.side !== "NEUTRAL" && <span className={cn("shrink-0 font-bold", t.side === "LONG" ? "text-neon" : "text-magenta-neon")}>{t.side}</span>}
                      <span className="min-w-0 flex-1 text-ink-3">{t.detail}</span>
                    </li>
                  ))}
                </ul>
                {(triggers.suppressed.length > 0 || triggers.crowdCut.length > 0) && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {triggers.suppressed.map((s) => (
                      <span key={`sup-${s}`} title="L3 anti-cascade suppression window" className="rounded border border-danger-neon/40 px-1.5 py-0.5 font-terminal text-[9px] font-bold tracking-[0.08em] text-danger-neon">CASCADE-VETO {s.replace("USDT", "")}</span>
                    ))}
                    {triggers.crowdCut.map((s) => (
                      <span key={`cut-${s}`} title="L3.5 leverage-crowding size cut" className="rounded border border-amber-neon/40 px-1.5 py-0.5 font-terminal text-[9px] font-bold tracking-[0.08em] text-amber-neon">CROWD-CUT {s.replace("USDT", "")}</span>
                    ))}
                  </div>
                )}
              </>
            )}
          </BentoCard>

          {/* market regime strip — layer-0 classification per symbol (v5.0) */}
          <BentoCard className="p-4 sm:p-4" delay={0.14}>
            <div className="mb-3 flex items-center gap-2">
              <Waves className="size-3.5 text-cyan-neon" aria-hidden />
              <span className="label-tech">Market Regimes</span>
              <NeonBadge tone="cyan" className="ml-auto">
                LAYER-0 FILTER
              </NeonBadge>
            </div>
            {regimes.length === 0 ? (
              <p className="font-terminal text-[11px] text-ink-3">regime classifier warming — klines caching…</p>
            ) : (
              <div className="space-y-1">
                {regimes.slice(0, 8).map((r) => (
                  <div key={r.symbol} className="flex items-center gap-2 font-terminal text-[10px]">
                    <span className="w-14 shrink-0 font-bold tracking-[0.08em] text-ink">{r.symbol.replace("USDT", "")}</span>
                    <span className={cn("shrink-0 rounded border px-1.5 py-0.5 font-bold tracking-[0.08em]", REGIME_CLS[r.regime] ?? "border-white/10 text-ink-3")}>{r.label}</span>
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/5">
                      <div className={cn("h-full rounded-full", REGIME_BAR[r.regime] ?? "bg-white/20")} style={{ width: `${Math.round(r.strength * 100)}%`, boxShadow: "0 0 6px currentColor" }} />
                    </div>
                    <span className="w-8 shrink-0 text-right tabular-nums text-ink-3">{Math.round(r.strength * 100)}%</span>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 font-terminal text-[9px] leading-relaxed text-ink-3">
              TREND vetoes counter-trend mean-revert · CHOP penalizes breakouts · VOLATILE cuts size ×0.6, widens stops ×1.3
            </p>
          </BentoCard>

          {/* signal links — always data-backed (Bug 4 fix): recent signals from pulse with serial identity */}
          <BentoCard className="p-4 sm:p-4" delay={0.15}>
            <div className="mb-3 flex items-center gap-2">
              <Link2 className="size-3.5 text-magenta-neon" aria-hidden />
              <span className="label-tech">Signal Links</span>
              <NeonBadge tone="muted" className="ml-auto">
                last 5
              </NeonBadge>
            </div>
            {(() => {
              const recentSignals = (pulse?.signals ?? []).slice(0, 5);
              const showEvents = recentSignals.length === 0;
              if (showEvents && linked.length === 0) {
                return <p className="font-terminal text-[11px] text-ink-3">— awaiting first deployments —</p>;
              }
              if (showEvents) {
                return (
                  <ul className="space-y-1">
                    {linked.map((e) => (
                      <li key={e.id}>
                        <button
                          type="button"
                          onClick={() => e.signalId && setOpenSignal(e.signalId)}
                          disabled={!e.signalId}
                          aria-label={`Open signal detail for ${e.symbol ?? "event"} ${e.type}`}
                          className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left font-terminal text-[11px] transition-colors hover:bg-[rgb(var(--neon-rgb)/0.06)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--neon-rgb)/0.5)] disabled:cursor-default disabled:hover:bg-transparent"
                        >
                          <span className="shrink-0 tabular-nums text-ink-3">{mounted ? fmtClockLocal(new Date(e.createdAt).getTime()) : "--:--:--"}</span>
                          {e.symbol && (
                            <span className="shrink-0 rounded border border-[rgba(255,78,205,0.35)] px-1 font-bold leading-5 text-magenta-neon transition-all group-hover:border-[rgb(var(--neon-rgb)/0.45)] group-hover:text-neon">
                              {e.symbol}
                            </span>
                          )}
                          <span className="min-w-0 truncate uppercase tracking-[0.1em] text-ink-2 transition-colors group-hover:text-ink">{e.type}</span>
                          <MousePointerClick size={11} aria-hidden className="ml-auto shrink-0 text-ink-3 opacity-0 transition-all duration-200 group-hover:text-neon group-hover:opacity-100" />
                        </button>
                      </li>
                    ))}
                  </ul>
                );
              }
              return (
                <ul className="space-y-1">
                  {recentSignals.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setOpenSignal(s.id)}
                        aria-label={`Open signal detail for ${s.symbol} NX-${s.serial}`}
                        title="Open signal detail"
                        className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left font-terminal text-[11px] transition-colors hover:bg-[rgb(var(--neon-rgb)/0.06)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--neon-rgb)/0.5)]"
                      >
                        <span className="shrink-0 rounded border border-[rgba(178,107,255,0.35)] px-1 font-bold leading-5 tabular-nums text-violet-neon">
                          NX-{String(s.serial).padStart(4, "0")}
                        </span>
                        <span className="shrink-0 font-bold tracking-[0.08em] text-ink">{s.symbol.replace("USDT", "")}</span>
                        <span className={cn("shrink-0 font-bold", s.direction === "LONG" ? "text-neon" : "text-magenta-neon")}>{s.direction}</span>
                        <span
                          className={cn(
                            "ml-auto shrink-0 font-bold uppercase tracking-[0.1em]",
                            s.status === "ACTIVE" ? "text-cyan-neon" : ["TP1", "TP2", "TP3"].includes(s.status) ? "text-neon" : s.status === "SL" ? "text-danger-neon" : s.status === "EXPIRED" ? "text-amber-neon" : "text-ink-3"
                          )}
                        >
                          {s.status}
                        </span>
                        <MousePointerClick size={11} aria-hidden className="ml-1 shrink-0 text-ink-3 opacity-0 transition-all duration-200 group-hover:text-neon group-hover:opacity-100" />
                      </button>
                    </li>
                  ))}
                </ul>
              );
            })()}
          </BentoCard>
        </div>
      </div>

      {/* ── GATE GAUGE — decision layer (2026-09-08 operator mandate: live view of
          verdicts approaching the confirm/reject boundary + the reason journal
          that streams to the central AI core for deep learning) ── */}
      <div className="mt-6 flex items-center gap-3" aria-hidden>
        <span className="label-tech whitespace-nowrap">gate gauge // decision layer</span>
        <span className="h-px flex-1 bg-gradient-to-r from-neon/40 to-transparent" />
        <NeonBadge tone="violet">LIVE AUDIT</NeonBadge>
      </div>
      <div className="flex flex-col gap-4">
        <GateGaugeCard />
        {/* ── SHADOW-VETO — AI core phase 0 (2026-09-09 operator mandate: «قدم بعدی
            پیشنهادی رو کامل و مهندسی انجام بده») — the tiered-authority second
            opinion at the gate fence: shadow adjudication, would-have-won paper
            ledger, Wilson-LB A/B evidence, evidence-gated veto power ── */}
        <ShadowVetoCard />
      </div>

      {/* ── SENSOR MATRIX — module bus (2026-09-08 operator order: flow/liq/vol cards
          relocated from COMMAND DECK into the terminal so the engine log and its
          sensor feeds live on one screen) ── */}
      <div className="mt-6 flex items-center gap-3" aria-hidden>
        <span className="label-tech whitespace-nowrap">sensor matrix // module bus</span>
        <span className="h-px flex-1 bg-gradient-to-r from-violet-neon/40 to-transparent" />
        <NeonBadge tone="violet">3 MODULES LIVE</NeonBadge>
      </div>
      <div className="flex flex-col gap-4">
        {/* ── FUTURES TAXONOMY — five-family signal engine (Task 20-b: store → learn
            → best filter; family D OI×Price quadrant grid + edge leaderboard) ── */}
        <FuturesRadarCard />
        <FlowScannerCard />
        <LiqDepthRadarCard />
        <VolRiskCard />
      </div>
    </section>
  );
}
