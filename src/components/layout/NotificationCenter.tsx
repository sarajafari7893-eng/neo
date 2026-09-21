"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellOff, CheckCheck, ExternalLink, Hourglass, Volume2, VolumeX } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { usePulse, useNow } from "@/hooks/usePulse";
import { useAlerts } from "@/store/alerts";
import { useUi } from "@/store/ui";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Header notification inbox: bell + unread badge + glass dropdown of the
 * latest engine events. Opening the panel marks everything as read.
 * Persisted mute + read state via useAlerts (localStorage).
 */

const LEVEL_COLOR: Record<string, string> = {
  ai: "#b26bff",
  success: "var(--neon)",
  warn: "#ffb347",
  error: "#ff4d5e",
  info: "#45f0df",
};

export function NotificationCenter() {
  const { data } = usePulse(5000);
  const now = useNow(10_000);
  const setView = useUi((s) => s.setView);
  const { lastSeenEventAt, setLastSeenEventAt, alertsMuted, setAlertsMuted, soundEnabled, soundVolume, setSoundVolume, ttlWarnEnabled, setTtlWarnEnabled } = useAlerts();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const events = useMemo(() => {
    const list = [...(data?.events ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return list.slice(0, 15);
  }, [data?.events]);

  const unread = useMemo(() => {
    if (!lastSeenEventAt) return 0;
    return (data?.events ?? []).filter((e) => new Date(e.createdAt).getTime() > lastSeenEventAt).length;
  }, [data?.events, lastSeenEventAt]);

  /* close on outside pointer / Escape */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      const newest = Math.max(
        lastSeenEventAt,
        ...(data?.events ?? []).map((e) => new Date(e.createdAt).getTime()),
        Date.now()
      );
      setLastSeenEventAt(newest);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={`Event inbox${unread ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60",
          open
            ? "border-[rgb(var(--neon-rgb)/0.4)] bg-[rgb(var(--neon-rgb)/0.08)] text-neon"
            : "border-white/10 bg-white/[0.03] text-ink-2 hover:border-[rgb(var(--neon-rgb)/0.3)] hover:text-neon"
        )}
      >
        <Bell size={14} className={cn(alertsMuted && "opacity-50")} />
        {unread > 0 && !alertsMuted && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-black/60 bg-magenta-neon px-1 font-terminal text-[8px] font-bold text-black shadow-[0_0_10px_rgba(255,78,205,0.9)]">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
        {unread > 0 && !alertsMuted && (
          <span className="absolute inset-0 -z-10 rounded-lg anim-pulse-glow" aria-hidden />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Engine event inbox"
          style={{
            background:
              "linear-gradient(150deg, rgba(13,20,26,0.97), rgba(7,11,14,0.95))",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.05), 0 24px 60px -20px rgba(0,0,0,0.9), 0 0 0 1px rgb(var(--neon-rgb)/0.14), 0 0 32px -12px rgb(var(--neon-rgb)/0.25)",
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
          }}
          className="absolute right-0 top-full z-[60] mt-2 w-[min(92vw,360px)] overflow-hidden rounded-xl"
        >
          {/* header */}
          <div className="flex items-center gap-2 border-b border-white/8 px-3.5 py-2.5">
            <span className="label-tech">EVENT INBOX</span>
            <NeonCount n={events.length} />
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => setAlertsMuted(!alertsMuted)}
                aria-pressed={alertsMuted}
                aria-label={alertsMuted ? "Unmute live alerts" : "Mute live alerts"}
                title={alertsMuted ? "Alerts muted" : "Alerts live"}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60",
                  alertsMuted
                    ? "border-[rgba(255,179,71,0.4)] text-amber-neon"
                    : "border-white/10 text-ink-2 hover:text-neon"
                )}
              >
                {alertsMuted ? <BellOff size={13} /> : <Bell size={13} />}
              </button>
              <button
                type="button"
                onClick={() =>
                  setLastSeenEventAt(
                    Math.max(Date.now(), ...(data?.events ?? []).map((e) => new Date(e.createdAt).getTime()))
                  )
                }
                aria-label="Mark all as read"
                title="Mark all read"
                className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 text-ink-2 transition-colors hover:text-neon focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60"
              >
                <CheckCheck size={13} />
              </button>
            </div>
          </div>

          {/* list */}
          <ul className="max-h-[320px] overflow-y-auto" aria-live="polite">
            {events.length === 0 && (
              <li className="px-3.5 py-6 text-center font-terminal text-[10px] uppercase tracking-[0.2em] text-ink-3">
                awaiting engine events…
              </li>
            )}
            {events.map((ev) => {
              const color = LEVEL_COLOR[ev.level] ?? LEVEL_COLOR.info;
              const isNew = lastSeenEventAt ? new Date(ev.createdAt).getTime() > lastSeenEventAt - 30_000 : false;
              return (
                <li
                  key={ev.id}
                  className={cn(
                    "flex items-start gap-2.5 border-b border-white/5 px-3.5 py-2.5 transition-colors last:border-0 hover:bg-white/[0.03]",
                    isNew && "bg-[rgb(var(--neon-rgb)/0.03)]"
                  )}
                >
                  <span
                    className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {ev.symbol && (
                        <span className="rounded border border-white/10 bg-white/[0.04] px-1 py-px font-terminal text-[9px] font-bold tracking-[0.1em] text-ink">
                          {ev.symbol}
                        </span>
                      )}
                      <span
                        className="font-terminal text-[9px] font-bold uppercase tracking-[0.16em]"
                        style={{ color }}
                      >
                        {ev.type}
                      </span>
                      <span className="ml-auto shrink-0 font-terminal text-[9px] tabular-nums text-ink-3">
                        {now === 0 ? "··" : timeAgo(ev.createdAt, now)}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-2">{ev.message}</p>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* footer: volume + TTL warn tier + terminal link */}
          <div className="border-t border-white/8 bg-[rgb(var(--neon-rgb)/0.03)] px-3.5 py-2.5">
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded",
                  soundEnabled && soundVolume > 0 ? "text-cyan-neon" : "text-ink-3"
                )}
                aria-hidden
              >
                {soundEnabled && soundVolume > 0 ? <Volume2 size={12} /> : <VolumeX size={12} />}
              </span>
              <Slider
                aria-label="Event sound volume"
                value={[Math.round(soundVolume * 100)]}
                min={0}
                max={100}
                step={5}
                onValueChange={(v) => setSoundVolume((v[0] ?? 0) / 100)}
                className="flex-1"
              />
              <span className="w-9 shrink-0 text-right font-terminal text-[10px] font-bold tabular-nums text-ink-2">
                {Math.round(soundVolume * 100)}%
              </span>
            </div>
            <div className="mt-2.5 flex items-center gap-2.5">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded",
                  ttlWarnEnabled ? "text-amber-neon" : "text-ink-3"
                )}
                aria-hidden
              >
                <Hourglass size={12} />
              </span>
              <label
                htmlFor="ttl-warn-toggle"
                className="min-w-0 flex-1 cursor-pointer font-terminal text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-2"
              >
                5M TTL WARN
                <span className="ml-1.5 text-ink-3/80 normal-case tracking-normal">
                  {ttlWarnEnabled ? "heads-up on · final 60s always on" : "only final-60s critical"}
                </span>
              </label>
              <Switch
                id="ttl-warn-toggle"
                aria-label="Toggle 5-minute TTL warning tier"
                checked={ttlWarnEnabled}
                onCheckedChange={setTtlWarnEnabled}
                className="data-[state=checked]:bg-[rgba(255,179,71,0.55)] data-[state=checked]:shadow-[0_0_12px_-2px_rgba(255,179,71,0.8)]"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setView("terminal");
              setOpen(false);
            }}
            className="flex w-full items-center justify-center gap-1.5 border-t border-white/8 bg-[rgb(var(--neon-rgb)/0.04)] px-3.5 py-2.5 font-terminal text-[10px] font-bold uppercase tracking-[0.2em] text-neon transition-colors hover:bg-[rgb(var(--neon-rgb)/0.1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neon/60"
          >
            <ExternalLink size={11} aria-hidden />
            open engine terminal
          </button>
        </div>
      )}
    </div>
  );
}

function NeonCount({ n }: { n: number }) {
  return (
    <span className="rounded border border-[rgb(var(--neon-rgb)/0.3)] bg-[rgb(var(--neon-rgb)/0.08)] px-1.5 py-px font-terminal text-[9px] font-bold text-neon">
      {n}
    </span>
  );
}
