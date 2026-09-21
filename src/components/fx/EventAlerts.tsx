"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { usePulse } from "@/hooks/usePulse";
import { useAlerts } from "@/store/alerts";
import { playEventSound } from "@/lib/sounds";
import { cn } from "@/lib/utils";
import { AlertTriangle, BellRing, CheckCircle2, History, Rocket, ShieldCheck, TimerOff, XCircle } from "lucide-react";
import type { SignalEventDTO } from "@/lib/api-types";

/**
 * Headless bridge: watches the pulse feed and raises a styled sonner toast
 * for every NEW engine event (signal created, TP hit, SL, TTL expiry).
 * Mounted once in the app shell — renders nothing.
 */

const LEVEL_STYLE: Record<string, { border: string; bg: string; text: string; Icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  CREATED: { border: "rgba(178,107,255,0.55)", bg: "rgba(178,107,255,0.10)", text: "#b26bff", Icon: Rocket },
  TP1: { border: "rgb(var(--neon-rgb)/0.55)", bg: "rgb(var(--neon-rgb)/0.10)", text: "var(--neon)", Icon: CheckCircle2 },
  TP2: { border: "rgb(var(--neon-rgb)/0.55)", bg: "rgb(var(--neon-rgb)/0.10)", text: "var(--neon)", Icon: CheckCircle2 },
  TP3: { border: "rgba(69,240,223,0.6)", bg: "rgba(69,240,223,0.10)", text: "#45f0df", Icon: CheckCircle2 },
  SL: { border: "rgba(255,77,94,0.55)", bg: "rgba(255,77,94,0.10)", text: "#ff4d5e", Icon: XCircle },
  TTL_EXPIRED: { border: "rgba(255,179,71,0.55)", bg: "rgba(255,179,71,0.10)", text: "#ffb347", Icon: TimerOff },
  // v6.1.1: dynamic expiry gate GRANTS now alert the operator (were silent ENGINE events)
  TTL_EXTENDED: { border: "rgba(69,240,223,0.55)", bg: "rgba(69,240,223,0.10)", text: "#45f0df", Icon: History },
  // v6.5: mid-ladder breakeven arm is operator-visible (perf-forensics fix — round-trip stops)
  BE_TRAIL: { border: "rgba(69,240,223,0.5)", bg: "rgba(69,240,223,0.08)", text: "#45f0df", Icon: ShieldCheck },
  // v6.1: post-expiry follow-up reports now alert the operator too (previously bell-inbox only)
  AFTERLIFE: { border: "rgba(69,240,223,0.5)", bg: "rgba(69,240,223,0.08)", text: "#45f0df", Icon: BellRing },
};

const ALERTABLE = new Set(Object.keys(LEVEL_STYLE));

export function EventAlerts() {
  const { data } = usePulse(5000);
  const baselineRef = useRef<number | null>(null);

  useEffect(() => {
    if (!data?.events?.length) return;
    const events = data.events;
    const newest = Math.max(...events.map((e) => new Date(e.createdAt).getTime()));

    // first load → just set baseline, no toast storm
    if (baselineRef.current === null) {
      baselineRef.current = newest;
      return;
    }

    const fresh = events
      .filter((e) => ALERTABLE.has(e.type) && new Date(e.createdAt).getTime() > baselineRef.current!)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (baselineRef.current !== newest) baselineRef.current = newest;
    if (fresh.length === 0) return;

    const state = useAlerts.getState();
    const playSound = !state.alertsMuted && state.soundEnabled;

    // cap burst to 3 most recent per tick
    for (const ev of fresh.slice(-3) as SignalEventDTO[]) {
      const style = LEVEL_STYLE[ev.type];
      if (!style) continue;
      if (playSound) playEventSound(ev.type);
      if (state.alertsMuted) continue;
      const { Icon } = style;
      toast.custom(
        () => (
          <button
            type="button"
            aria-label={`Alert: ${ev.message}`}
            onClick={() => toast.dismiss()}
            className={cn(
              "pointer-events-auto flex w-[min(92vw,380px)] cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 text-left backdrop-blur-xl",
              "shadow-[0_8px_32px_-8px_rgba(0,0,0,0.85)] transition-transform hover:scale-[1.015]"
            )}
            style={{
              borderColor: style.border,
              background: `linear-gradient(135deg, ${style.bg}, rgba(7,11,14,0.96) 55%)`,
            }}
          >
            <span
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
              style={{ borderColor: style.border, color: style.text, background: style.bg }}
            >
              <Icon size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span
                  className="font-terminal text-[10px] font-bold uppercase tracking-[0.2em]"
                  style={{ color: style.text }}
                >
                  {ev.type === "CREATED" ? "NEW SIGNAL" : ev.type === "TTL_EXPIRED" ? "TTL EXPIRED" : ev.type === "TTL_EXTENDED" ? "EXPIRY GATE — TTL EXTENDED" : ev.type === "BE_TRAIL" ? "BREAKEVEN ARMED — RISK OFF" : ev.type === "AFTERLIFE" ? "EXPIRY FOLLOW-UP" : ev.type}
                </span>
                {ev.symbol && (
                  <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-px font-terminal text-[9px] font-bold tracking-[0.14em] text-ink">
                    {ev.symbol}
                  </span>
                )}
              </span>
              <span className="mt-1 line-clamp-2 block text-[11px] leading-snug text-ink-2">{ev.message}</span>
            </span>
            <span className="anim-pulse-dot mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: style.text }} />
          </button>
        ),
        { duration: 5600 }
      );
    }
  }, [data]);

  return null;
}
