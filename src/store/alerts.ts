"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_ACCENT, type AccentId } from "@/lib/accent";

/**
 * Persisted alert / watchlist preferences.
 * - watchlist: starred market symbols
 * - alertsMuted: silence live event toast alerts
 * - soundEnabled: WebAudio blips for live engine events
 * - soundVolume: 0..1 master volume for the event sound engine
 * - accent: operator accent identity (drives --neon CSS vars)
 * - lastSeenEventAt: epoch ms of newest event acknowledged in the notification inbox
 * - heatHistory: rolling portfolio-heat samples (throttled ~20s, cap 120 ≈ 40min)
 *   powering the RiskDesk trend sparkline; survives reloads
 * - heatTimeline: same samples as {t,v} pairs (cap 240 ≈ 80min) powering the
 *   analytics SESSION HEAT chart — timestamped so axes stay honest across reloads
 * - watchOnly: signals-view "watchlist only" filter (persisted preference)
 * - ttlWarnEnabled: fire the T-5min TTL WARN tier (CRIT final-60s tier always on)
 * - sortMode: signals-view sort preference (persisted across sessions)
 * - csvFields: signals-CSV column-group selection (CORE/LEVELS/RISK/META/DATES/JOURNAL)
 * - filterPresets: named signals-filter snapshots (status/direction/strategy/symbol/
 *   sort/query/watchOnly) — one-tap re-apply from the matrix toolbar, cap 8
 * - viewMode: signal-matrix presentation — "GRID" cards | "TABLE" dense terminal rows
 */

/** signal-matrix presentation mode */
export type SignalViewMode = "GRID" | "TABLE";

export interface HeatSample {
  t: number; // epoch ms
  v: number; // 0..100
}

/** a named snapshot of the signal-matrix filter state */
export interface FilterPreset {
  id: string;
  name: string;
  createdAt: number;
  filters: {
    status: string;
    direction: string;
    strategy: string;
    symbol: string;
    sort: string;
    query: string;
    watchOnly: boolean;
  };
}

interface AlertsState {
  watchlist: string[];
  toggleWatch: (symbol: string) => void;
  removeWatch: (symbol: string) => void;

  watchOnly: boolean;
  setWatchOnly: (v: boolean) => void;

  alertsMuted: boolean;
  setAlertsMuted: (v: boolean) => void;

  soundEnabled: boolean;
  setSoundEnabled: (v: boolean) => void;

  soundVolume: number; // 0..1
  setSoundVolume: (v: number) => void;

  accent: AccentId;
  setAccent: (a: AccentId) => void;

  lastSeenEventAt: number;
  setLastSeenEventAt: (ts: number) => void;

  heatHistory: number[];
  pushHeatSample: (v: number) => void;

  heatTimeline: HeatSample[];
  pushHeatTimeline: (sample: HeatSample) => void;
  clearHeatTimeline: () => void;

  ttlWarnEnabled: boolean;
  setTtlWarnEnabled: (v: boolean) => void;

  sortMode: string; // SortKey of the signals view: NEWEST | PNL | CONFIDENCE | TTL
  setSortMode: (v: string) => void;

  csvFields: string[]; // selected signals-CSV column groups
  toggleCsvField: (id: string) => void;
  setCsvFields: (ids: string[]) => void;

  filterPresets: FilterPreset[];
  addFilterPreset: (name: string, filters: FilterPreset["filters"]) => void;
  removeFilterPreset: (id: string) => void;

  viewMode: SignalViewMode;
  setViewMode: (v: SignalViewMode) => void;
}

/** max samples kept in the rolling heat trend (sparkline) */
export const HEAT_HISTORY_CAP = 120;
/** max timestamped samples kept for the analytics heat chart (~80min @ ~20s) */
export const HEAT_TIMELINE_CAP = 240;
/** max saved filter presets */
export const FILTER_PRESET_CAP = 8;

export const useAlerts = create<AlertsState>()(
  persist(
    (set) => ({
      watchlist: [],
      toggleWatch: (symbol) =>
        set((s) => ({
          watchlist: s.watchlist.includes(symbol)
            ? s.watchlist.filter((w) => w !== symbol)
            : [...s.watchlist, symbol].slice(0, 12),
        })),
      removeWatch: (symbol) =>
        set((s) => ({ watchlist: s.watchlist.filter((w) => w !== symbol) })),

      alertsMuted: false,
      setAlertsMuted: (alertsMuted) => set({ alertsMuted }),

      soundEnabled: false,
      setSoundEnabled: (soundEnabled) => set({ soundEnabled }),

      soundVolume: 0.5,
      setSoundVolume: (soundVolume) =>
        set({ soundVolume: Math.max(0, Math.min(1, soundVolume)) }),

      accent: DEFAULT_ACCENT,
      setAccent: (accent) => set({ accent }),

      lastSeenEventAt: 0,
      setLastSeenEventAt: (lastSeenEventAt) => set({ lastSeenEventAt }),

      watchOnly: false,
      setWatchOnly: (watchOnly) => set({ watchOnly }),

      heatHistory: [],
      pushHeatSample: (v) =>
        set((s) => ({
          heatHistory: [...s.heatHistory, Math.max(0, Math.min(100, v))].slice(-HEAT_HISTORY_CAP),
        })),

      heatTimeline: [],
      pushHeatTimeline: (sample) =>
        set((s) => ({
          heatTimeline: [...s.heatTimeline, sample].slice(-HEAT_TIMELINE_CAP),
        })),
      clearHeatTimeline: () => set({ heatTimeline: [] }),

      ttlWarnEnabled: true,
      setTtlWarnEnabled: (ttlWarnEnabled) => set({ ttlWarnEnabled }),

      sortMode: "NEWEST",
      setSortMode: (sortMode) => set({ sortMode }),

      csvFields: ["CORE", "LEVELS", "RISK", "META", "DATES", "JOURNAL"],
      toggleCsvField: (id) =>
        set((s) => ({
          csvFields: s.csvFields.includes(id)
            ? s.csvFields.filter((f) => f !== id)
            : [...s.csvFields, id],
        })),
      setCsvFields: (csvFields) => set({ csvFields }),

      filterPresets: [],
      addFilterPreset: (name, filters) =>
        set((s) => {
          const clean = name.trim().slice(0, 24);
          if (!clean || s.filterPresets.length >= FILTER_PRESET_CAP) return s;
          const preset: FilterPreset = {
            id: `fp-${Date.now().toString(36)}`, // ephemeral id, uniqueness within localStorage is enough
            name: clean,
            createdAt: Date.now(),
            filters: { ...filters },
          };
          return { filterPresets: [...s.filterPresets, preset] };
        }),
      removeFilterPreset: (id) =>
        set((s) => ({ filterPresets: s.filterPresets.filter((p) => p.id !== id) })),

      viewMode: "GRID",
      setViewMode: (viewMode) => set({ viewMode }),
    }),
    {
      name: "nexus-alerts",
      version: 8,
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<AlertsState>;
        if (version < 2) {
          // v1 → v2: introduce soundVolume + accent defaults
          p.soundVolume = typeof p.soundVolume === "number" ? p.soundVolume : 0.5;
          p.accent = p.accent ?? DEFAULT_ACCENT;
        }
        if (version < 3) {
          // v2 → v3: rolling heat trend (empty until the desk samples a tick)
          p.heatHistory = Array.isArray(p.heatHistory) ? p.heatHistory : [];
        }
        if (version < 4) {
          // v3 → v4: timestamped heat timeline + watchlist-only filter
          p.heatTimeline = Array.isArray(p.heatTimeline) ? p.heatTimeline : [];
          p.watchOnly = typeof p.watchOnly === "boolean" ? p.watchOnly : false;
        }
        if (version < 5) {
          // v4 → v5: TTL warn-tier preference + signals sort persistence
          p.ttlWarnEnabled = typeof p.ttlWarnEnabled === "boolean" ? p.ttlWarnEnabled : true;
          p.sortMode = typeof p.sortMode === "string" ? p.sortMode : "NEWEST";
        }
        if (version < 6) {
          // v5 → v6: signals-CSV column-group selection (default: all groups)
          const ALL = ["CORE", "LEVELS", "RISK", "META", "DATES", "JOURNAL"];
          p.csvFields = Array.isArray(p.csvFields) ? p.csvFields.filter((f) => ALL.includes(f)) : ALL;
        }
        if (version < 7) {
          // v6 → v7: named signals-filter presets
          p.filterPresets = Array.isArray(p.filterPresets)
            ? p.filterPresets
                .filter((x): x is FilterPreset => !!x && typeof x === "object" && !!x.id && !!x.name && !!x.filters)
                .slice(0, FILTER_PRESET_CAP)
            : [];
        }
        if (version < 8) {
          // v7 → v8: signal-matrix view mode (cards grid | dense table)
          p.viewMode = p.viewMode === "TABLE" ? "TABLE" : "GRID";
        }
        return p as AlertsState;
      },
    }
  )
);
