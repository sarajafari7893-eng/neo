"use client";

import { create } from "zustand";

export type ViewId = "dashboard" | "signals" | "analytics" | "terminal" | "ai";

interface UiState {
  view: ViewId;
  setView: (v: ViewId) => void;
  activeSymbol: string | null;
  setActiveSymbol: (s: string | null) => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  calcOpen: boolean;
  setCalcOpen: (v: boolean) => void;
  /** symbol spotlight drill-down dialog (market matrix / watchlist / palette) */
  spotlightSymbol: string | null;
  setSpotlightSymbol: (s: string | null) => void;
  /** keyboard shortcuts legend overlay (?) */
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
  /** epoch ms of the last "export analytics PNG" request (⌘K) — section reacts on mount/tick */
  analyticsExportAt: number;
  requestAnalyticsExport: () => void;
  /** epoch ms of the last "export analytics CSV" request (⌘K) — section reacts on mount/tick */
  analyticsCsvAt: number;
  requestAnalyticsCsv: () => void;
  /** epoch ms of the last "open operator log" request (⌘K) — analytics scrolls+flashes the journal card */
  operatorLogJumpAt: number;
  requestOperatorLog: () => void;
  /** global signal-detail dialog — openable from anywhere (terminal links, operator log…) */
  openSignalId: string | null;
  setOpenSignal: (id: string | null) => void;
  /** per-card AI SCAN handoff — serial the dialog should auto-scan on open (R17) */
  signalAutoScanSerial: number | null;
  setSignalAutoScanSerial: (serial: number | null) => void;
}

export const useUi = create<UiState>((set) => ({
  view: "dashboard",
  setView: (view) => set({ view }),
  activeSymbol: null,
  setActiveSymbol: (activeSymbol) => set({ activeSymbol }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  calcOpen: false,
  setCalcOpen: (calcOpen) => set({ calcOpen }),
  spotlightSymbol: null,
  setSpotlightSymbol: (spotlightSymbol) => set({ spotlightSymbol }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  analyticsExportAt: 0,
  requestAnalyticsExport: () => set({ analyticsExportAt: Date.now() }),
  analyticsCsvAt: 0,
  requestAnalyticsCsv: () => set({ analyticsCsvAt: Date.now() }),
  operatorLogJumpAt: 0,
  requestOperatorLog: () => set({ operatorLogJumpAt: Date.now() }),
  openSignalId: null,
  setOpenSignal: (openSignalId) => set({ openSignalId }),
  signalAutoScanSerial: null,
  setSignalAutoScanSerial: (signalAutoScanSerial) => set({ signalAutoScanSerial }),
}));
