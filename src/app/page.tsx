"use client";

import { BackgroundFX } from "@/components/fx/BackgroundFX";
import { CommandPalette } from "@/components/fx/CommandPalette";
import { EventAlerts } from "@/components/fx/EventAlerts";
import { TtlSentinel } from "@/components/fx/TtlSentinel";
import { KeyboardShortcuts } from "@/components/fx/KeyboardShortcuts";
import { SymbolSpotlight } from "@/components/shared/SymbolSpotlight";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { PriceTape } from "@/components/layout/PriceTape";
import DashboardSection from "@/components/dashboard/DashboardSection";
import SignalsSection from "@/components/signals/SignalsSection";
import AnalyticsSection from "@/components/analytics/AnalyticsSection";
import TerminalSection from "@/components/terminal/TerminalSection";
import AiCoreSection from "@/components/ai/AiCoreSection";
import { useUi, type ViewId } from "@/store/ui";
import { AnimatePresence, motion } from "framer-motion";
import { usePulse } from "@/hooks/usePulse";
import { cn } from "@/lib/utils";
import { useEffect } from "react";
import ViewErrorBoundary from "@/components/shared/ViewErrorBoundary";

const VIEWS: Record<ViewId, React.ComponentType> = {
  dashboard: DashboardSection,
  signals: SignalsSection,
  analytics: AnalyticsSection,
  terminal: TerminalSection,
  ai: AiCoreSection,
};

const VIEW_META: Record<ViewId, { path: string; label: string }> = {
  dashboard: { path: "~/dashboard", label: "COMMAND DECK" },
  signals: { path: "~/signals/matrix", label: "SIGNAL MATRIX" },
  analytics: { path: "~/analytics/intel", label: "PERFORMANCE INTEL" },
  terminal: { path: "~/core/engine.log", label: "ENGINE TERMINAL" },
  ai: { path: "~/core/neural", label: "AI CORE" },
};

export default function Home() {
  const { view } = useUi();
  const { data, stale, recovering } = usePulse();
  const Active = VIEWS[view];
  const meta = VIEW_META[view];

  // reset scroll on view change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [view]);

  return (
    <div className="relative flex min-h-screen flex-col">
      <BackgroundFX />
      <CommandPalette />
      <EventAlerts />
      <TtlSentinel />
      <KeyboardShortcuts />
      <SymbolSpotlight />

      <Header />

      {/* live price tape — sub-second WS channel with honest source badge */}
      <PriceTape />

      {/* engine tick scan bar — sweeps on every fresh pulse */}
      {data && (
        <div key={data.ts} aria-hidden className="tick-sweep-track">
          <div className="tick-sweep" />
        </div>
      )}

      {/* breadcrumb / mode line */}
      <div className="relative z-10 mx-auto w-full max-w-[1600px] px-4 pt-4 sm:px-6">
        <div className="flex items-center justify-between gap-2 font-terminal text-[10px] tracking-[0.18em] text-ink-3">
          <div className="flex items-center gap-2">
            <span className="text-neon/70">flowradar</span>
            <span className="text-ink-3">::</span>
            <span>{meta.path}</span>
            <span className="hidden sm:inline text-ink-3">{"//"}</span>
            <span className="hidden sm:inline">{meta.label}</span>
          </div>
          <div className="flex items-center gap-2">
            {!data ? (
              <span className="anim-flicker">ESTABLISHING UPLINK…</span>
            ) : stale ? (
              <>
                <span className="text-danger-neon">FEED DISRUPTED — RETRYING</span>
                {/* 2026-09-17 operator audit: one-click hard recovery for a
                    deeply frozen tab (hung fetch/service worker) — reload
                    re-establishes the uplink instead of a silent hang. */}
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="ml-1 rounded border border-danger-neon/50 px-1.5 py-0.5 font-terminal text-[10px] font-bold tracking-[0.18em] text-danger-neon transition hover:bg-danger-neon/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-neon/60"
                  title="Force page reload to re-establish the live uplink"
                >
                  RECONNECT
                </button>
              </>
            ) : recovering ? (
              <span
                className="text-amber-neon"
                title="last poll hiccuped — auto re-syncing, data still on screen"
              >
                RE-SYNCING…
              </span>
            ) : (
              <>
                <span className="hidden sm:inline">
                  TICK <span className="text-neon">#{Math.floor(data.ts / 1000) % 100000}</span>
                </span>
                <span className="text-ink-3">·</span>
                <span className={data.feed?.source === "LIVE" ? "text-neon" : "text-amber-neon"}>
                  {data.feed?.source ?? "LIVE"} <span className="text-violet-neon">{data.signals.filter((s) => s.status === "ACTIVE" || s.status === "TP1" || s.status === "TP2").length}</span> LIVE SIGNALS
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* main view */}
      <main className="relative z-10 mx-auto w-full max-w-[1600px] flex-1 px-4 py-5 sm:px-6 sm:py-6" id="main">
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 14, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className={cn("min-w-0")}
          >
            <ViewErrorBoundary key={view}>
              <Active />
            </ViewErrorBoundary>
          </motion.div>
        </AnimatePresence>
      </main>

      <Footer />
    </div>
  );
}
