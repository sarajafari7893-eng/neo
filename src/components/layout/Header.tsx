"use client";

import { LogoMark } from "@/components/brand/Logo";
import { LiveDot } from "@/components/shared/primitives";
import { NotificationCenter } from "@/components/layout/NotificationCenter";
import { useUi, type ViewId } from "@/store/ui";
import { useAlerts } from "@/store/alerts";
import { usePulse, useDeviceNow, clockDriftMs, useMounted } from "@/hooks/usePulse";
import { fmtClockLocal, localTzLabel } from "@/lib/format";
import { primeAudio, playConfirmChirp } from "@/lib/sounds";
import { cn } from "@/lib/utils";
import { fmtUsd } from "@/lib/format";
import { motion } from "framer-motion";
import { LayoutDashboard, Radar, LineChart, TerminalSquare, Sparkles, Menu, X, Zap, Wallet, Command as CommandIcon, Volume2, VolumeX, Keyboard, Palette } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACCENTS, ACCENT_ORDER, type AccentId } from "@/lib/accent";
import { BRAND_TERMINAL, APP_TAGLINE } from "@/lib/brand";

const NAV: Array<{ id: ViewId; label: string; icon: React.ComponentType<{ size?: number | string; className?: string }> }> = [
  { id: "dashboard", label: "DASHBOARD", icon: LayoutDashboard },
  { id: "signals", label: "SIGNALS", icon: Radar },
  { id: "analytics", label: "ANALYTICS", icon: LineChart },
  { id: "terminal", label: "TERMINAL", icon: TerminalSquare },
  { id: "ai", label: "AI CORE", icon: Sparkles },
];

export function Header() {
  const { view, setView, setPaletteOpen, setShortcutsOpen } = useUi();
  const { data, stale } = usePulse();
  const deviceNow = useDeviceNow(1000);
  const mounted = useMounted();
  const [open, setOpen] = useState(false);
  const soundEnabled = useAlerts((s) => s.soundEnabled);
  const setSoundEnabled = useAlerts((s) => s.setSoundEnabled);
  const accent = useAlerts((s) => s.accent);
  const setAccent = useAlerts((s) => s.setAccent);
  const [accentOpen, setAccentOpen] = useState(false);
  const accentRef = useRef<HTMLDivElement>(null);

  const activeCount = data?.stats.activeCount ?? 0;

  function toggleSound() {
    const next = !soundEnabled;
    setSoundEnabled(next);
    if (next) {
      primeAudio(); // user gesture unlocks the AudioContext
      playConfirmChirp();
    }
  }

  /* close accent popover on outside pointer / Escape */
  useEffect(() => {
    if (!accentOpen) return;
    const onDown = (e: PointerEvent) => {
      if (accentRef.current && !accentRef.current.contains(e.target as Node)) setAccentOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAccentOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [accentOpen]);

  return (
    <header className="sticky top-0 z-50 w-full">
      <div className="glass border-x-0 border-t-0">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between gap-3 px-4 sm:px-6">
          {/* brand */}
          <button
            onClick={() => setView("dashboard")}
            className="flex items-center gap-3 outline-none"
            aria-label="FlowRadar Neo home"
          >
            <LogoMark size={34} />
            <div className="hidden leading-none sm:block">
              <div className="font-terminal text-[15px] font-bold tracking-[0.16em]">
                {BRAND_TERMINAL.head}<span className="text-neon neon-text">{BRAND_TERMINAL.sep}</span>{BRAND_TERMINAL.tail}
              </div>
              <div className="label-tech mt-1 hidden md:block">{APP_TAGLINE}</div>
            </div>
          </button>

          {/* desktop nav */}
          <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 font-terminal text-[11px] font-semibold tracking-[0.16em] transition-all duration-300",
                    active
                      ? "text-neon"
                      : "text-ink-2 hover:text-foreground"
                  )}
                >
                  <Icon size={14} className={cn("transition-transform duration-300", active && "scale-110")} />
                  {item.label}
                  {active && (
                    <motion.span
                      layoutId="nav-pill"
                      className="absolute inset-0 -z-10 rounded-lg border border-[rgb(var(--neon-rgb)/0.3)] bg-[rgb(var(--neon-rgb)/0.07)]"
                      transition={{ type: "spring", bounce: 0.25, duration: 0.55 }}
                    />
                  )}
                </button>
              );
            })}
          </nav>

          {/* status cluster */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* event sound toggle */}
            <button
              type="button"
              onClick={toggleSound}
              aria-pressed={soundEnabled}
              aria-label={soundEnabled ? "Disable event sounds" : "Enable event sounds"}
              title={soundEnabled ? "Event sounds ON" : "Event sounds OFF"}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60",
                soundEnabled
                  ? "border-[rgba(69,240,223,0.4)] bg-[rgba(69,240,223,0.08)] text-cyan-neon"
                  : "border-white/10 bg-white/[0.03] text-ink-2 hover:border-[rgba(69,240,223,0.3)] hover:text-cyan-neon"
              )}
            >
              {soundEnabled ? <Volume2 size={14} style={{ filter: "drop-shadow(0 0 5px rgba(69,240,223,0.8))" }} /> : <VolumeX size={14} className="opacity-70" />}
            </button>

            <NotificationCenter />

            {/* accent identity switcher */}
            <div ref={accentRef} className="relative">
              <button
                type="button"
                onClick={() => setAccentOpen((v) => !v)}
                aria-expanded={accentOpen}
                aria-haspopup="menu"
                aria-label={`Accent identity: ${ACCENTS[accent].label}`}
                title={`Accent: ${ACCENTS[accent].label}`}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-ink-2 transition-colors hover:border-[rgb(var(--neon-rgb)/0.3)] hover:text-neon focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60"
              >
                <Palette size={14} style={{ color: ACCENTS[accent].hex, filter: `drop-shadow(0 0 5px ${ACCENTS[accent].hex}99)` }} />
              </button>
              {accentOpen && (
                <div
                  role="menu"
                  aria-label="Accent identity"
                  className="absolute right-0 top-full z-[60] mt-2 w-[min(92vw,220px)] overflow-hidden rounded-xl border border-[rgb(var(--neon-rgb)/0.2)] bg-[linear-gradient(150deg,rgba(13,20,26,0.97),rgba(7,11,14,0.96))] shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)]"
                >
                  <div className="border-b border-white/8 px-3.5 py-2.5">
                    <span className="label-tech">TERMINAL IDENTITY</span>
                  </div>
                  <div className="p-1.5">
                    {ACCENT_ORDER.map((id: AccentId) => {
                      const active = id === accent;
                      return (
                        <button
                          key={id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => {
                            setAccent(id);
                            setAccentOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 font-terminal text-[11px] font-bold tracking-[0.16em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60",
                            active ? "bg-white/[0.05] text-ink" : "text-ink-2 hover:bg-white/[0.03]"
                          )}
                        >
                          <span
                            aria-hidden
                            className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-black/50"
                            style={{
                              background: ACCENTS[id].hex,
                              boxShadow: active ? `0 0 10px ${ACCENTS[id].hex}` : `0 0 6px ${ACCENTS[id].hex}55`,
                            }}
                          />
                          {ACCENTS[id].label}
                          {active && <span className="ml-auto font-terminal text-[9px] tracking-[0.18em] text-neon">ACTIVE</span>}
                        </button>
                      );
                    })}
                  </div>
                  <div className="border-t border-white/8 px-3.5 py-2 font-terminal text-[9px] tracking-[0.14em] text-ink-3">
                    CYCLE ANYTIME WITH <kbd className="kbd ml-0.5">A</kbd>
                  </div>
                </div>
              )}
            </div>

            {/* keyboard shortcuts */}
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              className="hidden h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-ink-2 transition-colors hover:border-[rgb(var(--neon-rgb)/0.3)] hover:text-neon focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60 md:flex"
            >
              <Keyboard size={14} />
            </button>

            {/* paper equity chip */}
            {data?.stats.account && (
              <div className="hidden items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 xl:flex">
                <Wallet size={11} className="text-neon" aria-hidden />
                <span className="label-tech">EQUITY</span>
                <span className="font-terminal text-xs font-bold tabular-nums text-neon">
                  {fmtUsd(data.stats.account.equity)}
                </span>
                <span className={cn("font-terminal text-[10px] tabular-nums", data.stats.account.unrealizedPnl >= 0 ? "text-neon/70" : "text-danger-neon")}>
                  {data.stats.account.unrealizedPnl >= 0 ? "+" : ""}{data.stats.account.unrealizedPnl.toFixed(0)}
                </span>
              </div>
            )}

            {/* command palette trigger */}
            <button
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="hidden items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 font-terminal text-[10px] text-ink-2 transition-colors hover:border-[rgb(var(--neon-rgb)/0.3)] hover:text-neon md:flex"
            >
              <CommandIcon size={11} />
              <span className="tracking-[0.12em]">⌘K</span>
            </button>

            {/* engine feed badge — live Binance + 4-ex consensus (v5.4: STALE state visible) */}
            <div
              className={cn(
                "hidden items-center gap-2 rounded-lg border px-3 py-1.5 md:flex",
                stale ? "border-[rgba(255,77,94,0.45)] bg-[rgba(255,77,94,0.08)]" : "border-[rgb(var(--neon-rgb)/0.2)] bg-[rgb(var(--neon-rgb)/0.05)]"
              )}
              role="status"
              aria-live="polite"
            >
              {stale ? (
                <>
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-danger-neon anim-pulse-dot" aria-hidden />
                  <span className="font-terminal text-[10px] font-bold tracking-[0.14em] text-danger-neon">STALE FEED — RECONNECTING</span>
                </>
              ) : (
                <>
                  <LiveDot />
                  <span className="font-terminal text-[10px] font-bold tracking-[0.14em] text-neon">
                    {data?.feed ? (data.feed.source === "LIVE" ? `4X LIVE ${data.feed.latencyMs ?? "--"}MS` : data.feed.source === "STALE" ? "CACHED FEED" : "SIM FEED") : "ENGINE LIVE"}
                  </span>
                  <span className="font-terminal text-[10px] text-ink-2">·</span>
                  <span className="flex items-center gap-1 font-terminal text-[10px] text-ink-2">
                    <Zap size={10} className="text-amber-neon" />
                    {activeCount} OPEN
                  </span>
                </>
              )}
            </div>
            {/* SYSTEM clock — operator request 2026-09-07:
                «ساعت در داشبورد رو با ساعت سیستم یکی کن» — the dashboard clock now
                shows the OPERATOR'S DEVICE system clock in the device timezone, so it
                matches the OS taskbar exactly. TTL countdowns remain engine-anchored
                (useNow/serverNow); the SYNC badge still reports client↔engine drift. */}
            <div className="hidden rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 font-terminal text-xs font-semibold tabular-nums text-ink-2 sm:flex items-center gap-2">
              {fmtClockLocal(deviceNow)} <span className="text-neon/60">{mounted ? localTzLabel() : "SYS"}</span>
              {mounted && Math.abs(clockDriftMs()) >= 2000 && (
                <span
                  className="rounded border border-amber-neon/30 bg-amber-neon/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-neon"
                  title={`device ↔ engine clock drift: ${clockDriftMs() > 0 ? "+" : ""}${(clockDriftMs() / 1000).toFixed(1)}s — this wall clock follows YOUR system clock; countdowns are engine-anchored`}
                >
                  SYNC {clockDriftMs() > 0 ? "+" : ""}{(clockDriftMs() / 1000).toFixed(1)}s
                </span>
              )}
            </div>

            {/* mobile menu toggle */}
            <button
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-ink-2 lg:hidden"
              onClick={() => setOpen((v) => !v)}
              aria-label="Toggle navigation"
              aria-expanded={open}
            >
              {open ? <X size={16} /> : <Menu size={16} />}
            </button>
          </div>
        </div>

        {/* mobile nav */}
        {open && (
          <nav className="border-t border-white/5 px-4 py-3 lg:hidden" aria-label="Mobile">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {NAV.map((item) => {
                const Icon = item.icon;
                const active = view === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      setView(item.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-3 py-2.5 font-terminal text-[11px] font-semibold tracking-[0.14em]",
                      active
                        ? "border-[rgb(var(--neon-rgb)/0.35)] bg-[rgb(var(--neon-rgb)/0.08)] text-neon"
                        : "border-white/8 text-ink-2"
                    )}
                  >
                    <Icon size={14} />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </nav>
        )}
      </div>
    </header>
  );
}
