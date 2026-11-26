"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Check, Copy, FlaskConical, Ghost, NotebookPen, Sparkles, SquareTerminal, TrendingDown, TrendingUp, Waves, X } from "lucide-react";

import type { SignalDTO } from "@/lib/api-types";
import {
  STATUS_META,
  distPct,
  fmtCountdown,
  fmtPct,
  fmtPrice,
  fmtUsd,
  levelProgress,
  signalBrief,
  ttlRemainingMs,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { BentoCard, ConfidenceBar, CountdownRing, LiveDot, NeonBadge, Sparkline } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/usePulse";
import { useToast } from "@/hooks/use-toast";
import { useUi } from "@/store/ui";

/** Signal card. v6.0: no manual close — exits are engine-managed (total autonomy). */
const OPEN_STATUSES = new Set<string>(["ACTIVE", "TP1", "TP2"]);
/** TP resolution cascade rank — TP3 implies TP1+TP2 hit. */
const STATUS_RANK: Record<string, number> = {
  ACTIVE: 0, TP1: 1, TP2: 2, TP3: 3, SL: 0, EXPIRED: 0, CLOSED: 0,
};
/** STATUS_META.tone → NeonBadge tone mapping. */
const TONE_TO_BADGE = {
  live: "neon", win: "cyan", loss: "danger", warn: "amber", muted: "muted",
} as const;
/** Ladder row label (label-tech look, overridable color). */
const LVL_LABEL = "w-8 shrink-0 font-terminal text-[10px] font-semibold uppercase tracking-[0.2em]";

export default function SignalCard({
  signal,
  price,
  sparkline,
  onClick,
  index = 0,
}: {
  signal: SignalDTO;
  price?: number;
  sparkline?: number[];
  onClick?: () => void;
  index?: number;
}) {
  const now = useNow(1000);
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const setOpenSignal = useUi((s) => s.setOpenSignal);
  const setSignalAutoScanSerial = useUi((s) => s.setSignalAutoScanSerial);

  /* copy a shareable plaintext brief to the clipboard */
  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation(); // don't trigger the card's detail dialog
    try {
      await navigator.clipboard.writeText(signalBrief(signal, price));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      toast({
        title: "SIGNAL COPIED",
        description: `${signal.symbol} ${signal.direction} brief on the clipboard — paste anywhere.`,
      });
    } catch {
      toast({
        title: "COPY BLOCKED",
        description: "Clipboard access denied by the browser.",
        variant: "destructive",
      });
    }
  }

  const isOpen = !signal.closedAt && OPEN_STATUSES.has(signal.status);
  const long = signal.direction === "LONG";
  const cur = price ?? signal.entryPrice;

  /* v9.0 DEDICATED PUMP/DUMP CARD — radar-spawned cohort (tags PUMP / DUMP) */
  const isPumpFlow = signal.tags.includes("PUMP");
  const isDumpFlow = signal.tags.includes("DUMP");
  /* v9.1 RAW-CAL CAPTURE cohort — unfiltered calibration record */
  const isRawCal = signal.tags.includes("RAW-CAL");

  /* ── TTL countdown ─────────────────────────────────────── */
  const ttlTotalMs = Math.max(1, signal.ttlMinutes * 60_000);
  const remaining = now === 0 ? ttlTotalMs : ttlRemainingMs(signal.expiresAt, now);
  const ttlExpired = now !== 0 && remaining <= 0 && isOpen;
  const ttlProgress = Math.max(0, Math.min(1, remaining / ttlTotalMs));
  /* final-minute urgency: amber panic ring + FINAL chip */
  const ttlFinal = isOpen && now !== 0 && remaining > 0 && remaining <= 60_000;
  let ttlLabel = "--:--";
  if (now !== 0) {
    const cd = fmtCountdown(signal.expiresAt, now); // HH:MM:SS
    ttlLabel = remaining >= 3_600_000 ? cd.slice(0, 5) : cd.slice(3); // HH:MM | MM:SS
  }

  /* ── Level hit states ──────────────────────────────────── */
  const rank = STATUS_RANK[signal.status] ?? 0;

  /* resolved deployments freeze the ring into an OUTCOME state — a dead
     signal must never show a live ticking countdown (expiresAt can sit in
     the future when the engine resolved early via TP/SL) */
  const resolvedRing = !isOpen
    ? rank >= 1
      ? { label: signal.status, sub: "HIT", progress: 1, tone: "cyan" as const, aria: `${signal.status} target hit — deployment resolved` }
      : signal.status === "SL"
        ? { label: "STOP", sub: "OUT", progress: 0, tone: "danger" as const, aria: "Stopped out — deployment resolved" }
        : signal.status === "EXPIRED"
          ? { label: "0:00", sub: "TTL END", progress: 0, tone: "amber" as const, aria: "TTL expired — deployment resolved" }
          : { label: "END", sub: "CLOSED", progress: 0, tone: "muted" as const, aria: "Manually closed — deployment resolved" }
    : null;

  const crossTp = (level: number) => (long ? cur >= level : cur <= level);
  const tpHit = (n: 1 | 2 | 3, level: number) => rank >= n || (isOpen && crossTp(level));
  const slStopped = signal.status === "SL" || (isOpen && (long ? cur <= signal.stopLoss : cur >= signal.stopLoss));

  const riskUsd =
    signal.marginUsd * (Math.abs(signal.entryPrice - signal.stopLoss) / signal.entryPrice) * signal.leverage;

  const prog = levelProgress(cur, signal.entryPrice, signal.stopLoss, signal.tp3);
  const entryPos = levelProgress(signal.entryPrice, signal.entryPrice, signal.stopLoss, signal.tp3);

  const statusMeta = STATUS_META[signal.status] ?? { label: signal.status, tone: "muted" as const };
  const statusBadgeTone = TONE_TO_BADGE[statusMeta.tone] ?? "muted";
  const pnl = signal.pnlPercent;

  /* per-card AI SCAN — opens the detail dialog and auto-runs the serial-grounded brief */
  function handleAiScan(e: React.MouseEvent) {
    e.stopPropagation();
    setSignalAutoScanSerial(signal.serial);
    setOpenSignal(signal.id);
  }

  return (
    <BentoCard
      tone={long ? "neon" : "magenta"}
      corners={isOpen}
      delay={Math.min(index * 0.06, 0.48)}
      className={cn("flex flex-col", (isPumpFlow || isDumpFlow) && "border-magenta-neon/50 shadow-[0_0_18px_rgba(255,78,205,0.22)]")}
      onClick={onClick}
      ariaLabel={`Open ${signal.symbol} ${signal.direction} signal details`}
    >
      {/* ── Header: symbol + badges | TTL ring ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-terminal text-lg font-bold uppercase tracking-[0.12em] text-ink">
            {signal.symbol}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <NeonBadge tone="violet">{signal.strategy}</NeonBadge>
            <NeonBadge tone="cyan">{signal.timeframe}</NeonBadge>
            <NeonBadge tone={long ? "neon" : "magenta"} glow>
              {long ? <TrendingUp className="h-3 w-3" strokeWidth={2.5} /> : <TrendingDown className="h-3 w-3" strokeWidth={2.5} />}
              {signal.direction}
            </NeonBadge>
            <NeonBadge tone={statusBadgeTone} glow={statusMeta.tone === "live"}>
              {statusMeta.label}
            </NeonBadge>
            {/* v9.0 DEDICATED PUMP/DUMP CARD (operator mandate 2026-09-12):
                radar-spawned signals carry the PUMP/DUMP cohort tag and render
                a distinctive glowing engine badge — instantly recognizable. */}
            {isPumpFlow && (
              <NeonBadge tone="magenta" glow>
                <Waves className="h-3 w-3" strokeWidth={2.5} />
                PUMP ENGINE
              </NeonBadge>
            )}
            {isDumpFlow && (
              <NeonBadge tone="danger" glow>
                <Waves className="h-3 w-3" strokeWidth={2.5} />
                DUMP ENGINE
              </NeonBadge>
            )}
            {/* v9.1 RAW-CAL CAPTURE badge — unfiltered calibration record
                (operator mandate 2026-09-13): instantly distinguishable from
                a filtered trade signal. */}
            {isRawCal && (
              <NeonBadge tone="amber">
                <FlaskConical className="h-3 w-3" strokeWidth={2.5} />
                RAW·CAL
              </NeonBadge>
            )}
            {ttlFinal && (
              <NeonBadge tone="amber" glow>FINAL 60S</NeonBadge>
            )}
          </div>
        </div>
        <div className={cn("shrink-0 rounded-full", ttlFinal && "ttl-final")}>
          <CountdownRing
            size={60}
            progress={resolvedRing ? resolvedRing.progress : ttlProgress}
            label={resolvedRing ? resolvedRing.label : ttlLabel}
            sub={resolvedRing ? resolvedRing.sub : ttlExpired ? "EXPIRING" : "TTL"}
            tone={resolvedRing ? resolvedRing.tone : ttlFinal ? "amber" : undefined}
            urgent={ttlExpired}
            ariaLabel={resolvedRing?.aria}
          />
        </div>
      </div>

      {/* ── Live price / entry zone ── */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="glass-soft rounded-lg px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <span className="label-tech">NOW</span>
            <LiveDot tone={long ? "neon" : "violet"} />
          </div>
          <div className="mt-0.5 font-terminal text-sm font-bold tabular-nums text-ink">{fmtPrice(cur)}</div>
        </div>
        <div className="glass-soft rounded-lg px-2.5 py-2">
          <span className="label-tech">ENTRY</span>
          <div className="mt-0.5 font-terminal text-sm font-bold tabular-nums text-ink-2">
            {fmtPrice(signal.entryPrice)}
          </div>
          <div className="font-terminal text-[9px] tabular-nums text-ink-3">
            ZONE {fmtPrice(signal.entryZoneLow)}–{fmtPrice(signal.entryZoneHigh)}
          </div>
        </div>
      </div>

      {/* ── PnL + live price trace + leverage ── */}
      <div className="mt-3 flex items-end justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="label-tech">PNL</span>
          <motion.span
            key={pnl.toFixed(2)}
            initial={{ opacity: 0.45, y: -5, filter: "brightness(2.2)" }}
            animate={{ opacity: 1, y: 0, filter: "brightness(1)" }}
            transition={{ duration: 0.55, ease: "easeOut" }}
            className={cn(
              "font-terminal text-2xl font-bold tabular-nums",
              pnl >= 0 ? "text-neon neon-text" : "text-danger-neon neon-text-danger"
            )}
          >
            {fmtPct(pnl)}
          </motion.span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {sparkline && sparkline.length > 3 && (
            <Sparkline
              data={sparkline}
              width={62}
              height={22}
              tone={pnl >= 0 ? "neon" : "danger"}
              fill={false}
              strokeWidth={1.25}
              className="hidden sm:block"
            />
          )}
          <NeonBadge tone="amber">×{signal.leverage} LEV</NeonBadge>
        </div>
      </div>

      {/* ── TP / SL ladder ── */}
      <div className="mt-3 space-y-1">
        {([1, 2, 3] as const).map((n) => {
          const level = n === 1 ? signal.tp1 : n === 2 ? signal.tp2 : signal.tp3;
          const hit = tpHit(n, level);
          return (
            <div
              key={n}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors duration-300",
                hit
                  ? "border-[rgb(var(--neon-rgb)/0.22)] bg-[rgb(var(--neon-rgb)/0.06)] shadow-[0_0_14px_-5px_rgb(var(--neon-rgb)/0.65)]"
                  : "border-transparent"
              )}
            >
              <span className={cn(LVL_LABEL, hit ? "text-neon/80" : "text-ink-3")}>TP{n}</span>
              <span
                className={cn(
                  "font-terminal text-xs font-bold tabular-nums",
                  hit ? "text-neon neon-text line-through decoration-[1.5px]" : "text-ink"
                )}
              >
                {fmtPrice(level)}
              </span>
              <span className="ml-auto font-terminal text-[10px] tabular-nums text-ink-3">
                {fmtPct(distPct(cur, level))}
              </span>
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {hit && <Check className="h-3.5 w-3.5 text-neon" strokeWidth={3} />}
              </span>
            </div>
          );
        })}

        {/* STOP-LOSS row */}
        <div
          className={cn(
            "flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors duration-300",
            slStopped
              ? "border-[rgba(255,77,94,0.3)] bg-[rgba(255,77,94,0.07)] shadow-[0_0_14px_-5px_rgba(255,77,94,0.7)]"
              : "border-transparent"
          )}
        >
          <span className={cn(LVL_LABEL, slStopped ? "text-danger-neon/90" : "text-ink-3")}>SL</span>
          <span
            className={cn(
              "font-terminal text-xs font-bold tabular-nums",
              slStopped ? "text-danger-neon neon-text-danger line-through decoration-[1.5px]" : "text-ink-2"
            )}
          >
            {fmtPrice(signal.stopLoss)}
          </span>
          <span className="ml-auto font-terminal text-[10px] tabular-nums text-ink-3">
            {fmtPct(distPct(cur, signal.stopLoss))}
          </span>
          <span className="font-terminal text-[9px] uppercase tracking-[0.1em] text-danger-neon/80">
            -{fmtUsd(riskUsd)}
          </span>
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {slStopped && <X className="h-3.5 w-3.5 text-danger-neon" strokeWidth={3} />}
          </span>
        </div>
      </div>

      {/* ── SL ── ENTRY ── TP3 range progress ── */}
      <div className="mt-3">
        <div className="relative h-1.5 rounded-full bg-[linear-gradient(90deg,rgba(255,77,94,0.55),rgba(255,179,71,0.5),rgb(var(--neon-rgb)/0.55))]">
          {/* entry tick */}
          <span
            className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-ink-3/80"
            style={{ left: `${entryPos * 100}%` }}
            aria-hidden
          />
          {/* live position marker */}
          <motion.span
            initial={false}
            animate={{ left: `${prog * 100}%` }}
            transition={{ type: "spring", stiffness: 120, damping: 20 }}
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/50 bg-ink shadow-[0_0_10px_rgba(232,245,239,0.85)]"
          />
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="label-tech">SL {fmtPrice(signal.stopLoss)}</span>
          <span className="label-tech">TP3 {fmtPrice(signal.tp3)}</span>
        </div>
      </div>

      {/* ── Confidence / R:R / margin ── */}
      <div className="mt-3 flex items-center gap-2">
        <ConfidenceBar value={signal.confidence} className="min-w-0 flex-1" />
        <NeonBadge tone="cyan" className="shrink-0">R:R {signal.riskReward.toFixed(1)}</NeonBadge>
        <NeonBadge tone="muted" className="shrink-0">MARGIN {fmtUsd(signal.marginUsd)}</NeonBadge>
      </div>

      {/* ── v5.4 TP-proven ladder chips — banked levels stay visible forever ── */}
      {(signal.reachedTp ?? 0) > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" title="TP-proven ledger — banked levels count as wins in analytics even if the trade resolves later">
          <span className="font-terminal text-[9px] font-bold tracking-[0.16em] text-cyan-neon">TP-PROVEN</span>
          {(["TP1", "TP2", "TP3"] as const).map((lvl, i) => (
            <span
              key={lvl}
              className={cn(
                "rounded px-1.5 py-0.5 font-terminal text-[9px] font-bold tracking-[0.12em]",
                (signal.reachedTp ?? 0) > i
                  ? "border border-[rgb(var(--neon-rgb)/0.45)] bg-[rgb(var(--neon-rgb)/0.1)] text-neon"
                  : "border border-white/8 bg-white/[0.02] text-ink-3"
              )}
            >
              {lvl}{(signal.reachedTp ?? 0) > i ? " ✓" : ""}
            </span>
          ))}
          {["SL", "EXPIRED"].includes(signal.status) && (
            <span className="font-terminal text-[9px] tracking-[0.1em] text-ink-3">· WIN BANKED, {signal.status} AFTER</span>
          )}
        </div>
      )}

      {/* ── Tags + serial identity ── */}
      {(signal.tags.length > 0 || signal.id) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="rounded border border-[rgba(178,107,255,0.4)] bg-[rgba(178,107,255,0.08)] px-1.5 py-0.5 font-terminal text-[9px] font-bold tracking-[0.14em] text-violet-neon" title={`serial identity · ${signal.id}`}>
            NX-{String(signal.serial ?? 0).padStart(4, "0")}
          </span>
          {(signal.ttlExtensions ?? 0) > 0 && (
            <span
              className="rounded border border-[rgba(255,179,71,0.4)] bg-[rgba(255,179,71,0.08)] px-1.5 py-0.5 font-terminal text-[9px] font-bold tracking-[0.14em] text-amber-neon"
              title="DYNAMIC EXPIRY GATE — the engine granted this signal TTL extensions near its targets"
            >
              TTL +{signal.ttlExtensions}×
            </span>
          )}
          {signal.tags.slice(0, 3).map((tag, tagIdx) => (
            <span
              key={`${tag}-${tagIdx}`}
              className="rounded border border-[rgba(159,180,171,0.18)] bg-white/[0.02] px-1.5 py-0.5 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* ── EXPIRED afterlife tracking (Bug 5 fix — شفافیت چرخه عمر) ── */}
      {signal.status === "EXPIRED" && (
        <div
          className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-[rgba(255,179,71,0.3)] bg-[rgba(255,179,71,0.05)] px-2.5 py-1.5"
          title="EXPIRED lifecycle: 48h post-expiry tracking — would the trade have reached a target after TTL?"
        >
          <Ghost className="size-3.5 shrink-0 text-amber-neon" aria-hidden />
          <span className="font-terminal text-[10px] font-bold tracking-[0.14em] text-amber-neon">AFTERLIFE:</span>
          <span
            className={cn(
              "font-terminal text-[10px] font-bold tracking-[0.1em]",
              signal.afterlife === "SL_HIT" ? "text-danger-neon" : ["TP1_HIT", "TP2_HIT", "TP3_HIT"].includes(signal.afterlife ?? "") ? "text-neon" : "text-ink-2"
            )}
          >
            {signal.afterlife === "TRACKING" ? "TRACKING 48H…" : signal.afterlife === "FLAT" ? "WINDOW CLOSED — NO RE-TEST" : (signal.afterlife ?? "TRACKING").replace("_", " ")}
          </span>
          <span className="ml-auto font-terminal text-[10px] tabular-nums text-ink-3" title="best levered NET pnl after TTL (post-expiry MFE)">
            post-MFE {signal.maxPostPnlPercent >= 0 ? "+" : ""}{signal.maxPostPnlPercent.toFixed(1)}%
          </span>
        </div>
      )}

      {/* ── Footer actions ── */}
      <div className="mt-3 flex items-center gap-2 border-t border-white/5 pt-3">
        <Button
          type="button"
          variant="outline"
          onClick={handleAiScan}
          aria-label={`AI scan ${signal.symbol} card NX-${String(signal.serial ?? 0).padStart(4, "0")}`}
          title={`AI SCAN — scan THIS card (NX-${String(signal.serial ?? 0).padStart(4, "0")})`}
          className="h-11 flex-1 border-[rgba(178,107,255,0.35)] bg-transparent font-terminal text-[11px] font-semibold tracking-[0.2em] text-violet-neon hover:bg-[rgba(178,107,255,0.1)] hover:text-violet-neon"
        >
          <Sparkles className="h-3.5 w-3.5" />
          AI SCAN
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onClick}
          className="h-11 flex-1 border-[rgb(var(--neon-rgb)/0.25)] bg-transparent font-terminal text-[11px] font-semibold tracking-[0.2em] text-neon hover:bg-[rgb(var(--neon-rgb)/0.08)] hover:text-neon"
        >
          <SquareTerminal className="h-3.5 w-3.5" />
          DETAILS
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleCopy}
          aria-label={`Copy ${signal.symbol} ${signal.direction} signal brief to clipboard`}
          title="Copy signal brief"
          className={cn(
            "h-11 w-11 shrink-0 border-white/10 bg-transparent p-0 text-ink-3 transition-all hover:border-[rgba(69,240,223,0.4)] hover:bg-[rgba(69,240,223,0.08)] hover:text-cyan-neon hover:shadow-[0_0_14px_-4px_rgba(69,240,223,0.8)]",
            copied && "border-[rgba(69,240,223,0.5)] text-cyan-neon"
          )}
        >
          {copied ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <Copy className="h-4 w-4" />}
        </Button>
        {signal.operatorNotes?.trim() && (
          <span
            title="Operator journal entry — open details to read"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-[rgba(69,240,223,0.25)] bg-[rgba(69,240,223,0.05)] text-cyan-neon shadow-[0_0_10px_-4px_rgba(69,240,223,0.7)]"
            aria-label="Has operator journal entry"
          >
            <NotebookPen className="h-4 w-4" aria-hidden />
          </span>
        )}
        {isOpen && (
          <span className="font-terminal text-[10px] tracking-[0.14em] text-ink-3" title="Exits are engine-managed — TP ladder · stop · TTL">
            ENGINE-MANAGED EXIT
          </span>
        )}
      </div>
    </BentoCard>
  );
}
