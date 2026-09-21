"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeftRight, Bookmark, BookmarkPlus, Calculator, ChevronDown, Download, LayoutGrid, Loader2, Radar, Rows3, Save, Search, SlidersHorizontal, Star, Trash2, TrendingDown, TrendingUp, X } from "lucide-react";

import type { SignalDTO } from "@/lib/api-types";
import { fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LiveDot, NeonBadge, SectionHeader } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePulse, useNow } from "@/hooks/usePulse";
import { useToast } from "@/hooks/use-toast";
import { useUi } from "@/store/ui";
import { useAlerts, FILTER_PRESET_CAP, type FilterPreset, type SignalViewMode } from "@/store/alerts";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SignalCard from "@/components/signals/SignalCard";
import SignalDetailDialog from "@/components/signals/SignalDetailDialog";
import SignalsTable from "@/components/signals/SignalsTable";
import RiskCalculator from "@/components/signals/RiskCalculator";

/* ── filter contracts ──────────────────────────────────────── */
type StatusFilter = "ALL" | "OPEN" | "TP_WIN" | "SL" | "EXPIRED";
type DirectionFilter = "ALL" | "LONG" | "SHORT";
type StrategyFilter = string; // "ALL" | live strategy id
type SortKey = "NEWEST" | "PNL" | "CONFIDENCE" | "TTL";

const STATUS_TABS: Array<{ id: StatusFilter; label: string }> = [
  { id: "ALL", label: "ALL" },
  { id: "OPEN", label: "OPEN" },
  { id: "TP_WIN", label: "TP WIN" },
  { id: "SL", label: "SL" },
  { id: "EXPIRED", label: "EXPIRED" },
];

/** OPEN = status in ACTIVE|TP1|TP2 (deployment still running). */
const OPEN_STATUSES = new Set<string>(["ACTIVE", "TP1", "TP2"]);
const WIN_STATUSES = new Set<string>(["TP1", "TP2", "TP3"]);
const PAGE_SIZE = 9;

/* ── CSV column groups (operator-selectable, persisted in store v6) ── */
type CsvGroupId = "CORE" | "LEVELS" | "RISK" | "META" | "DATES" | "JOURNAL";
const CSV_GROUPS: Array<{
  id: CsvGroupId;
  label: string;
  hint: string;
  cols: Array<{ key: string; get: (s: SignalDTO) => string | number }>;
}> = [
  {
    id: "CORE",
    label: "CORE",
    hint: "id · symbol · side · status",
    cols: [
      { key: "id", get: (s) => s.id },
      { key: "symbol", get: (s) => s.symbol },
      { key: "direction", get: (s) => s.direction },
      { key: "status", get: (s) => s.status },
    ],
  },
  {
    id: "LEVELS",
    label: "LEVELS",
    hint: "entry · zone · tp1-3 · stop",
    cols: [
      { key: "entryPrice", get: (s) => s.entryPrice },
      { key: "entryZoneLow", get: (s) => s.entryZoneLow },
      { key: "entryZoneHigh", get: (s) => s.entryZoneHigh },
      { key: "tp1", get: (s) => s.tp1 },
      { key: "tp2", get: (s) => s.tp2 },
      { key: "tp3", get: (s) => s.tp3 },
      { key: "stopLoss", get: (s) => s.stopLoss },
    ],
  },
  {
    id: "RISK",
    label: "RISK",
    hint: "leverage · margin · rr · conviction",
    cols: [
      { key: "leverage", get: (s) => s.leverage },
      { key: "marginUsd", get: (s) => s.marginUsd },
      { key: "riskReward", get: (s) => s.riskReward },
      { key: "confidence", get: (s) => s.confidence },
    ],
  },
  {
    id: "META",
    label: "META",
    hint: "tf · strategy · tags · pnl · ttl",
    cols: [
      { key: "timeframe", get: (s) => s.timeframe },
      { key: "strategy", get: (s) => s.strategy },
      { key: "tags", get: (s) => (s.tags ?? []).join(" ") },
      { key: "pnlPercent", get: (s) => s.pnlPercent },
      { key: "maxPnlPercent", get: (s) => s.maxPnlPercent },
      { key: "ttlMinutes", get: (s) => s.ttlMinutes },
    ],
  },
  {
    id: "DATES",
    label: "DATES",
    hint: "created · expires · closed",
    cols: [
      { key: "createdAt", get: (s) => s.createdAt },
      { key: "expiresAt", get: (s) => s.expiresAt },
      { key: "closedAt", get: (s) => s.closedAt ?? "" },
    ],
  },
  {
    id: "JOURNAL",
    label: "JOURNAL",
    hint: "notes · updated-at",
    cols: [
      { key: "operatorNotes", get: (s) => (s.operatorNotes ?? "").replace(/\r?\n/g, " ⏎ ") },
      { key: "notesUpdatedAt", get: (s) => s.notesUpdatedAt ?? "" },
    ],
  },
];

export default function SignalsSection() {
  const { data } = usePulse(5000);
  const now = useNow(1000);
  const qc = useQueryClient();
  const { toast } = useToast();
  const calcOpen = useUi((s) => s.calcOpen);
  const setCalcOpen = useUi((s) => s.setCalcOpen);

  /* ── filter state ── */
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [direction, setDirection] = useState<DirectionFilter>("ALL");
  const [strategy, setStrategy] = useState<StrategyFilter>("ALL");
  const [symbol, setSymbol] = useState("ALL");
  /* sort — persisted operator preference (store v5) */
  const sort = useAlerts((s) => s.sortMode) as SortKey;
  const setSort = useAlerts((s) => s.setSortMode);
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /* watchlist-only filter — persisted operator preference */
  const watchlist = useAlerts((s) => s.watchlist);
  const watchOnly = useAlerts((s) => s.watchOnly);
  const setWatchOnly = useAlerts((s) => s.setWatchOnly);
  const watchlistEmpty = watchlist.length === 0;

  /* saved filter presets — persisted operator toolbelt (store v7) */
  const filterPresets = useAlerts((s) => s.filterPresets);
  const addFilterPreset = useAlerts((s) => s.addFilterPreset);
  const removeFilterPreset = useAlerts((s) => s.removeFilterPreset);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetFullWarn, setPresetFullWarn] = useState(false);

  /* CSV column-group selection — persisted operator preference (store v6) */
  const csvFields = useAlerts((s) => s.csvFields);
  const toggleCsvField = useAlerts((s) => s.toggleCsvField);
  const setCsvFields = useAlerts((s) => s.setCsvFields);

  /* matrix presentation — cards grid | dense table (persisted, store v8) */
  const viewMode = useAlerts((s) => s.viewMode);
  const setViewMode = useAlerts((s) => s.setViewMode);
  const csvGroups = useMemo(
    () => CSV_GROUPS.filter((g) => csvFields.includes(g.id)),
    [csvFields]
  );

  const signals = useMemo(() => data?.signals ?? [], [data]);

  /* symbol options from live market */
  const symbols = useMemo(() => (data?.market ?? []).map((m) => m.symbol).sort(), [data?.market]);

  /* current price map */
  const priceMap = useMemo(
    () => new Map((data?.market ?? []).map((m) => [m.symbol, m.price] as const)),
    [data?.market]
  );

  /* sparkline map for card price context */
  const sparkMap = useMemo(
    () => new Map((data?.market ?? []).map((m) => [m.symbol, m.sparkline] as const)),
    [data?.market]
  );

  /* strategy options from live signals (most-deployed first) */
  const strategies = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of signals) counts.set(s.strategy, (counts.get(s.strategy) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [signals]);

  /* reset pagination when filters change (adjust-during-render pattern —
     no setState-in-effect cascade) */
  const filterKey = `${status}|${direction}|${strategy}|${symbol}|${sort}|${query}|${watchOnly}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setVisible(PAGE_SIZE);
  }

  /* ── filter + sort pipeline ── */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = signals.filter((s) => {
      if (status === "OPEN" && !OPEN_STATUSES.has(s.status)) return false;
      if (status === "TP_WIN" && !WIN_STATUSES.has(s.status)) return false;
      if (status === "SL" && s.status !== "SL") return false;
      if (status === "EXPIRED" && s.status !== "EXPIRED") return false;
      if (direction !== "ALL" && s.direction !== direction) return false;
      if (strategy !== "ALL" && s.strategy !== strategy) return false;
      if (watchOnly && !watchlist.includes(s.symbol)) return false;
      if (symbol !== "ALL" && s.symbol !== symbol) return false;
      if (q) {
        const hay = `${s.symbol} ${s.strategy} ${s.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const urgency = (s: SignalDTO) =>
      OPEN_STATUSES.has(s.status) && !s.closedAt ? new Date(s.expiresAt).getTime() : Number.POSITIVE_INFINITY;

    return list.sort((a, b) => {
      switch (sort) {
        case "PNL":
          return b.pnlPercent - a.pnlPercent;
        case "CONFIDENCE":
          return b.confidence - a.confidence;
        case "TTL":
          return urgency(a) - urgency(b);
        case "NEWEST":
        default:
          return b.createdAt.localeCompare(a.createdAt);
      }
    });
  }, [signals, status, direction, strategy, symbol, sort, query, watchOnly, watchlist]);

  const visibleSignals = filtered.slice(0, visible);

  /* ── CSV export of the current filtered selection, honoring column groups ── */
  function exportCsv() {
    if (csvGroups.length === 0) return;
    const activeCols = csvGroups.flatMap((g) => g.cols);
    const header = activeCols.map((c) => c.key).join(",");
    const rows = filtered.map((s) =>
      activeCols
        .map((c) => `"${String(c.get(s)).replace(/"/g, '""')}"`)
        .join(",")
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flowradar-signals-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast({
      title: "EXPORT READY",
      description: `${filtered.length} signals × ${activeCols.length} columns (${csvGroups.map((g) => g.label).join("+")}) exported.`,
    });
  }
  const selected = signals.find((s) => s.id === selectedId) ?? null;

  const openCount = useMemo(() => signals.filter((s) => OPEN_STATUSES.has(s.status)).length, [signals]);
  const resolved24h = useMemo(() => {
    if (now === 0) return null;
    const cutoff = now - 86_400_000;
    return signals.filter((s) => s.closedAt && new Date(s.closedAt).getTime() >= cutoff).length;
  }, [signals, now]);

  /* ── v6.0 TOTAL AUTONOMY: manual close removed — exits are engine-managed
     (TP1/TP2/TP3 ladder, stop, TTL); no operator lifecycle control. ── */

  function resetFilters() {
    setStatus("ALL");
    setDirection("ALL");
    setStrategy("ALL");
    setSymbol("ALL");
    setSort("NEWEST");
    setQuery("");
    setWatchOnly(false);
  }

  /* ── filter presets ───────────────────────────────────── */
  const currentFilters = useMemo(
    () => ({ status, direction, strategy, symbol, sort, query: query.trim(), watchOnly }),
    [status, direction, strategy, symbol, sort, query, watchOnly]
  );

  /* deep-match: does the current filter state equal a saved preset? */
  const activePreset = useMemo(
    () =>
      filterPresets.find((p) => {
        const f = p.filters;
        return (
          f.status === currentFilters.status &&
          f.direction === currentFilters.direction &&
          f.strategy === currentFilters.strategy &&
          f.symbol === currentFilters.symbol &&
          f.sort === currentFilters.sort &&
          (f.query ?? "") === currentFilters.query &&
          f.watchOnly === currentFilters.watchOnly
        );
      }) ?? null,
    [filterPresets, currentFilters]
  );

  function applyPreset(p: FilterPreset) {
    const f = p.filters;
    setStatus((f.status as StatusFilter) ?? "ALL");
    setDirection((f.direction as DirectionFilter) ?? "ALL");
    setStrategy(f.strategy ?? "ALL");
    setSymbol(f.symbol ?? "ALL");
    setSort((f.sort as SortKey) ?? "NEWEST");
    setQuery(f.query ?? "");
    setWatchOnly(!!f.watchOnly);
    setPresetMenuOpen(false);
    toast({
      title: "PRESET APPLIED",
      description: `“${p.name}” — matrix re-tuned in one tap.`,
    });
  }

  function handleSavePreset() {
    const name = presetName.trim();
    if (!name) return;
    if (filterPresets.length >= FILTER_PRESET_CAP) {
      setPresetFullWarn(true);
      return;
    }
    addFilterPreset(name, currentFilters);
    setSavePresetOpen(false);
    setPresetName("");
    setPresetFullWarn(false);
    toast({
      title: "PRESET SAVED",
      description: `“${name.slice(0, 24)}” pinned to the presets rack (cap ${FILTER_PRESET_CAP}).`,
    });
  }

  function handleDeletePreset(p: FilterPreset) {
    removeFilterPreset(p.id);
    toast({ title: "PRESET REMOVED", description: `“${p.name}” dropped from the rack.` });
  }

  /* active-filter chips (non-default filters) — tap ✕ to drop one */
  const activeFilters = useMemo(() => {
    const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];
    if (status !== "ALL") chips.push({ key: "status", label: `STATUS: ${STATUS_TABS.find((t) => t.id === status)?.label ?? status}`, onRemove: () => setStatus("ALL") });
    if (direction !== "ALL") chips.push({ key: "dir", label: direction, onRemove: () => setDirection("ALL") });
    if (strategy !== "ALL") chips.push({ key: "strategy", label: strategy, onRemove: () => setStrategy("ALL") });
    if (watchOnly) chips.push({ key: "watch", label: `STARRED (${watchlist.length})`, onRemove: () => setWatchOnly(false) });
    if (symbol !== "ALL") chips.push({ key: "symbol", label: symbol, onRemove: () => setSymbol("ALL") });
    if (sort !== "NEWEST") chips.push({ key: "sort", label: `SORT: ${sort}`, onRemove: () => setSort("NEWEST") });
    if (query.trim()) chips.push({ key: "query", label: `“${query.trim()}”`, onRemove: () => setQuery("") });
    return chips;
  }, [status, direction, strategy, watchOnly, watchlist.length, symbol, sort, query, setStatus, setDirection, setStrategy, setWatchOnly, setSymbol, setSort, setQuery]);

  const toolbarClass =
    "h-11 rounded-lg border border-[rgba(159,180,171,0.14)] bg-[rgba(12,18,23,0.45)] font-terminal text-xs text-ink";

  return (
    <section aria-label="Signal matrix" className="w-full">
      <SectionHeader
        index="02"
        title="SIGNAL MATRIX"
        subtitle="Live engine deployments — entries, targets, invalidations & TTL countdowns"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <NeonBadge tone="neon" glow className="h-7 px-2.5 text-[11px]">
              <LiveDot />
              {openCount} OPEN
            </NeonBadge>
            <NeonBadge tone="cyan" className="h-7 px-2.5 text-[11px]">
              {resolved24h ?? "–"} RESOLVED 24H
            </NeonBadge>
            {/* grid | table presentation toggle — persisted (store v8) */}
            <div
              role="group"
              aria-label="Matrix view mode"
              className="flex overflow-hidden rounded-md border border-[rgba(159,180,171,0.2)] bg-[rgba(12,18,23,0.45)]"
            >
              {(
                [
                  { id: "GRID", label: "GRID", icon: LayoutGrid },
                  { id: "TABLE", label: "TABLE", icon: Rows3 },
                ] as const satisfies ReadonlyArray<{ id: SignalViewMode; label: string; icon: typeof LayoutGrid }>
              ).map((m) => {
                const active = viewMode === m.id;
                const Icon = m.icon;
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={active}
                    aria-label={`${m.label.toLowerCase()} view`}
                    onClick={() => setViewMode(m.id)}
                    className={cn(
                      "flex h-7 items-center gap-1 px-2 font-terminal text-[10px] font-bold tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
                      active
                        ? "bg-[rgb(var(--neon-rgb)/0.12)] text-neon"
                        : "text-ink-3 hover:bg-white/[0.04] hover:text-ink-2"
                    )}
                  >
                    <Icon size={11} aria-hidden />
                    {m.label}
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => setCalcOpen(true)}
              aria-label="Open risk calculator"
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[rgba(255,179,71,0.35)] bg-[rgba(255,179,71,0.06)] px-2.5 font-terminal text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-neon transition-all hover:bg-[rgba(255,179,71,0.14)] hover:shadow-[0_0_14px_-4px_rgba(255,179,71,0.8)]"
            >
              <Calculator size={11} aria-hidden />
              RISK
            </button>
            <DropdownMenu open={presetMenuOpen} onOpenChange={setPresetMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Saved filter presets"
                  title="Filter presets"
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-md border px-2.5 font-terminal text-[10px] font-semibold uppercase tracking-[0.14em] transition-all",
                    activePreset
                      ? "border-[rgba(178,107,255,0.55)] bg-[rgba(178,107,255,0.12)] text-violet-neon shadow-[0_0_14px_-4px_rgba(178,107,255,0.9)]"
                      : "border-[rgba(159,180,171,0.2)] bg-[rgba(12,18,23,0.45)] text-ink-2 hover:border-[rgba(178,107,255,0.4)] hover:text-violet-neon"
                  )}
                >
                  <Bookmark className={cn("h-3 w-3", activePreset && "fill-violet-neon")} aria-hidden />
                  PRESETS {filterPresets.length}/{FILTER_PRESET_CAP}
                  {activePreset && <span className="hidden max-w-[90px] truncate text-violet-neon sm:inline">· {activePreset.name}</span>}
                  <ChevronDown size={10} aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="max-w-[calc(100vw-1.5rem)] min-w-[240px] border-[rgba(178,107,255,0.18)] bg-[rgba(8,13,16,0.97)] font-terminal"
              >
                <DropdownMenuLabel className="label-tech text-[9px] tracking-[0.2em]">
                  FILTER PRESETS
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-white/8" />
                {filterPresets.length === 0 && (
                  <p className="whitespace-normal px-3 py-3 text-[10px] leading-relaxed tracking-[0.08em] text-ink-3">
                    NO PRESETS YET — TUNE THE MATRIX FILTERS, THEN SAVE THE COMBO FOR ONE-TAP RECALL.
                  </p>
                )}
                {filterPresets.map((p) => {
                  const f = p.filters;
                  const hint = [
                    f.status !== "ALL" ? (f.status === "TP_WIN" ? "TP" : f.status) : null,
                    f.direction !== "ALL" ? f.direction : null,
                    f.strategy !== "ALL" ? f.strategy.split("-")[0].toUpperCase() : null,
                    f.symbol !== "ALL" ? f.symbol.replace("USDT", "") : null,
                    f.watchOnly ? "★" : null,
                    f.query ? `“${f.query}”` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  const isActive = activePreset?.id === p.id;
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onSelect={() => applyPreset(p)}
                      className={cn(
                        "group flex items-center gap-2 rounded px-2 py-2 text-[11px] text-ink-2 focus:bg-white/5 data-[highlighted]:text-ink",
                        isActive && "text-violet-neon"
                      )}
                    >
                      <Bookmark className={cn("h-3 w-3 shrink-0", isActive ? "fill-violet-neon text-violet-neon" : "text-ink-3")} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-bold tracking-[0.1em]">{p.name}</span>
                        <span className="block truncate text-[9px] tracking-[0.08em] text-ink-3">{hint || "ALL SIGNALS"}</span>
                      </span>
                      {isActive && <span className="shrink-0 text-[8px] tracking-[0.2em] text-violet-neon">LIT</span>}
                      <button
                        type="button"
                        aria-label={`Delete preset ${p.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeletePreset(p);
                        }}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-white/10 hover:text-danger-neon focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
                      >
                        <Trash2 size={13} aria-hidden />
                      </button>
                    </DropdownMenuItem>
                  );
                })}
                <DropdownMenuSeparator className="bg-white/8" />
                <DropdownMenuItem
                  onSelect={() => {
                    setPresetMenuOpen(false);
                    setPresetName("");
                    setPresetFullWarn(false);
                    setSavePresetOpen(true);
                  }}
                  disabled={filterPresets.length >= FILTER_PRESET_CAP}
                  className="gap-2 rounded px-2 py-2 text-[11px] font-bold tracking-[0.12em] text-violet-neon focus:bg-[rgba(178,107,255,0.1)]"
                >
                  <BookmarkPlus size={13} aria-hidden />
                  SAVE CURRENT FILTERS…
                  {filterPresets.length >= FILTER_PRESET_CAP && (
                    <span className="text-[9px] font-normal text-ink-3">RACK FULL</span>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem className="sr-only">close</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Choose CSV column groups"
                  title="CSV columns"
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-md border px-2.5 font-terminal text-[10px] font-semibold uppercase tracking-[0.14em] transition-all",
                    csvGroups.length === 0
                      ? "border-[rgba(255,77,94,0.45)] bg-[rgba(255,77,94,0.06)] text-danger-neon"
                      : "border-[rgba(159,180,171,0.2)] bg-[rgba(12,18,23,0.45)] text-ink-2 hover:border-[rgba(69,240,223,0.35)] hover:text-cyan-neon"
                  )}
                >
                  <SlidersHorizontal size={11} aria-hidden />
                  COLS {csvGroups.length}/{CSV_GROUPS.length}
                  <ChevronDown size={10} aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="border-[rgb(var(--neon-rgb)/0.18)] bg-[rgba(8,13,16,0.97)] font-terminal"
              >
                <DropdownMenuLabel className="label-tech text-[9px] tracking-[0.2em]">
                  CSV COLUMN GROUPS
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-white/8" />
                {CSV_GROUPS.map((g) => (
                  <DropdownMenuCheckboxItem
                    key={g.id}
                    checked={csvFields.includes(g.id)}
                    onCheckedChange={() => toggleCsvField(g.id)}
                    onSelect={(e) => e.preventDefault()}
                    className="gap-2 rounded px-2 py-2 text-[11px] text-ink-2 focus:bg-white/5 data-[highlighted]:text-ink"
                  >
                    <span className="font-bold tracking-[0.12em] text-ink">{g.label}</span>
                    <span className="text-[9px] tracking-[0.08em] text-ink-3">{g.hint}</span>
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator className="bg-white/8" />
                <div className="flex items-center gap-1.5 px-1.5 pb-1 pt-0.5">
                  <button
                    type="button"
                    onClick={() => setCsvFields(CSV_GROUPS.map((g) => g.id))}
                    className="flex-1 rounded border border-white/10 px-2 py-1.5 font-terminal text-[9px] font-bold tracking-[0.14em] text-ink-2 transition-colors hover:border-[rgb(var(--neon-rgb)/0.4)] hover:text-neon"
                  >
                    ALL
                  </button>
                  <button
                    type="button"
                    onClick={() => setCsvFields([])}
                    className="flex-1 rounded border border-white/10 px-2 py-1.5 font-terminal text-[9px] font-bold tracking-[0.14em] text-ink-2 transition-colors hover:border-[rgba(255,77,94,0.4)] hover:text-danger-neon"
                  >
                    NONE
                  </button>
                </div>
                <DropdownMenuItem className="sr-only">close</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              onClick={exportCsv}
              disabled={filtered.length === 0 || csvGroups.length === 0}
              aria-label="Export filtered signals to CSV"
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[rgba(69,240,223,0.35)] bg-[rgba(69,240,223,0.06)] px-2.5 font-terminal text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-neon transition-all hover:bg-[rgba(69,240,223,0.14)] hover:shadow-[0_0_14px_-4px_rgba(69,240,223,0.8)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download size={11} aria-hidden />
              CSV
            </button>
          </div>
        }
      />

      {/* ── Filter toolbar ── */}
      <div className="glass-soft flex flex-wrap items-center gap-2 rounded-xl p-3">
        {/* status */}
        <Tabs value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <TabsList className="h-11 rounded-lg border border-[rgba(159,180,171,0.14)] bg-[rgba(12,18,23,0.45)] p-1">
            {STATUS_TABS.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="h-9 rounded-md px-2.5 font-terminal text-[10px] font-bold uppercase tracking-[0.14em] text-ink-3 data-[state=active]:border-[rgb(var(--neon-rgb)/0.3)] data-[state=active]:bg-[rgb(var(--neon-rgb)/0.1)] data-[state=active]:text-neon data-[state=active]:shadow-none sm:px-3"
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* direction */}
        <div
          role="group"
          aria-label="Direction filter"
          className="flex overflow-hidden rounded-lg border border-[rgba(159,180,171,0.14)] bg-[rgba(12,18,23,0.45)]"
        >
          {(
            [
              { id: "ALL", label: "ALL", icon: ArrowLeftRight },
              { id: "LONG", label: "LONG", icon: TrendingUp },
              { id: "SHORT", label: "SHORT", icon: TrendingDown },
            ] as const
          ).map((d) => {
            const active = direction === d.id;
            const Icon = d.icon;
            return (
              <button
                key={d.id}
                type="button"
                aria-pressed={active}
                onClick={() => setDirection(d.id)}
                className={cn(
                  "flex h-11 min-w-[44px] items-center justify-center gap-1 px-2.5 font-terminal text-[10px] font-bold tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:px-3",
                  active && d.id === "LONG" && "bg-[rgb(var(--neon-rgb)/0.12)] text-neon",
                  active && d.id === "SHORT" && "bg-[rgba(255,78,205,0.14)] text-magenta-neon",
                  active && d.id === "ALL" && "bg-white/[0.06] text-ink",
                  !active && "text-ink-3 hover:bg-white/[0.04] hover:text-ink-2"
                )}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={2.5} />
                {d.label}
              </button>
            );
          })}
        </div>

        {/* strategy */}
        <Select value={strategy} onValueChange={setStrategy}>
          <SelectTrigger aria-label="Filter by strategy" className={cn(toolbarClass, "min-w-[142px]")}>
            <SelectValue placeholder="STRATEGY" />
          </SelectTrigger>
          <SelectContent className="border-[rgb(var(--neon-rgb)/0.16)] bg-[rgba(8,13,16,0.97)] font-terminal text-xs">
            <SelectItem value="ALL" className="text-xs">ALL STRATEGIES</SelectItem>
            {strategies.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {s.replace(/-/g, " ").toUpperCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* watchlist-only — persisted operator preference */}
        <button
          type="button"
          aria-pressed={watchOnly}
          aria-label="Show watchlist signals only"
          title={watchlistEmpty ? "Star symbols in the market matrix first" : "Show starred symbols only"}
          disabled={watchlistEmpty && !watchOnly}
          onClick={() => setWatchOnly(!watchOnly)}
          className={cn(
            "flex h-11 items-center gap-1.5 rounded-lg border px-3 font-terminal text-[10px] font-bold tracking-[0.14em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            watchOnly
              ? "border-[rgba(255,179,71,0.55)] bg-[rgba(255,179,71,0.12)] text-amber-neon shadow-[0_0_14px_-4px_rgba(255,179,71,0.8)]"
              : "border-[rgba(159,180,171,0.14)] bg-[rgba(12,18,23,0.45)] text-ink-3 hover:border-[rgba(255,179,71,0.3)] hover:text-amber-neon/90",
            watchlistEmpty && !watchOnly && "cursor-not-allowed opacity-40 hover:border-[rgba(159,180,171,0.14)] hover:text-ink-3"
          )}
        >
          <Star className={cn("h-3.5 w-3.5", watchOnly && "fill-amber-neon")} strokeWidth={2.5} />
          STARRED
        </button>

        {/* symbol */}
        <Select value={symbol} onValueChange={setSymbol}>
          <SelectTrigger aria-label="Filter by symbol" className={cn(toolbarClass, "min-w-[118px]")}>
            <SelectValue placeholder="SYMBOL" />
          </SelectTrigger>
          <SelectContent className="border-[rgb(var(--neon-rgb)/0.16)] bg-[rgba(8,13,16,0.97)] font-terminal text-xs">
            <SelectItem value="ALL" className="text-xs">ALL SYMBOLS</SelectItem>
            {symbols.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* sort */}
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger aria-label="Sort signals" className={cn(toolbarClass, "min-w-[150px]")}>
            <SelectValue placeholder="SORT" />
          </SelectTrigger>
          <SelectContent className="border-[rgb(var(--neon-rgb)/0.16)] bg-[rgba(8,13,16,0.97)] font-terminal text-xs">
            <SelectItem value="NEWEST" className="text-xs">NEWEST</SelectItem>
            <SelectItem value="PNL" className="text-xs">HIGHEST PNL</SelectItem>
            <SelectItem value="CONFIDENCE" className="text-xs">CONFIDENCE</SelectItem>
            <SelectItem value="TTL" className="text-xs">TTL URGENCY</SelectItem>
          </SelectContent>
        </Select>

        {/* search */}
        <div className="relative w-full sm:ml-auto sm:w-48">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="SEARCH SYMBOL / STRATEGY / TAG…"
            aria-label="Search signals"
            className={cn(toolbarClass, "pl-8 pr-3 placeholder:text-ink-3")}
          />
        </div>
      </div>

      {/* ── Active filter chips — tap ✕ to drop one ── */}
      <AnimatePresence>
        {activeFilters.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="label-tech inline-flex items-center gap-1 text-ink-3">
                <Search size={10} aria-hidden /> FILTERS {activeFilters.length}
              </span>
              {activeFilters.map((f) => (
                <motion.span
                  key={f.key}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.15 }}
                  className="glass-soft group inline-flex max-w-[220px] items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1 font-terminal text-[9px] font-bold uppercase tracking-[0.12em] text-ink-2 transition-all hover:border-[rgb(var(--neon-rgb)/0.4)] hover:text-ink"
                >
                  <span className="truncate">{f.label}</span>
                  <button
                    type="button"
                    onClick={f.onRemove}
                    aria-label={`Remove ${f.label} filter`}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-white/10 hover:text-danger-neon focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--neon-rgb)/0.6)]"
                  >
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </motion.span>
              ))}
              <button
                type="button"
                onClick={resetFilters}
                className="ml-1 font-terminal text-[9px] font-bold uppercase tracking-[0.14em] text-danger-neon/80 underline-offset-2 transition-colors hover:text-danger-neon hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 rounded px-1"
              >
                CLEAR ALL
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Matrix body — cards grid or dense table (persisted view mode) ── */}
      {!data ? (
        viewMode === "TABLE" ? (
          <Skeleton className="mt-4 h-72 rounded-xl bg-white/[0.04]" />
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-72 rounded-lg bg-white/[0.04]" />
            ))}
          </div>
        )
      ) : filtered.length === 0 ? (
        <div className="glass mt-4 flex flex-col items-center justify-center gap-3 rounded-xl p-10 text-center">
          <Radar className="h-8 w-8 text-ink-3 anim-spin-slow" strokeWidth={1.5} />
          <p className="font-terminal text-sm font-bold uppercase tracking-[0.2em] text-ink-2">
            NO SIGNALS MATCH
          </p>
          <p className="font-terminal text-[11px] tracking-[0.14em] text-ink-3">ADJUST FILTERS TO RE-SCAN THE MATRIX</p>
          <Button
            type="button"
            variant="outline"
            onClick={resetFilters}
            className="h-11 mt-1 border-[rgb(var(--neon-rgb)/0.25)] bg-transparent font-terminal text-[11px] tracking-[0.2em] text-neon hover:bg-[rgb(var(--neon-rgb)/0.08)] hover:text-neon"
          >
            RESET FILTERS
          </Button>
        </div>
      ) : viewMode === "TABLE" ? (
        <SignalsTable signals={visibleSignals} priceMap={priceMap} onOpen={setSelectedId} />
      ) : (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <AnimatePresence mode="popLayout" initial={false}>
              {visibleSignals.map((s, i) => (
                <motion.div
                  key={s.id}
                  layout
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                >
                  <SignalCard
                    signal={s}
                    price={priceMap.get(s.symbol)}
                    sparkline={sparkMap.get(s.symbol)}
                    index={i}
                    onClick={() => setSelectedId(s.id)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {visible < filtered.length && (
            <div className="mt-5 flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => setVisible((v) => v + PAGE_SIZE)}
                className="h-11 px-6 border-[rgb(var(--neon-rgb)/0.25)] bg-transparent font-terminal text-[11px] font-bold tracking-[0.2em] text-neon hover:bg-[rgb(var(--neon-rgb)/0.08)] hover:text-neon"
              >
                LOAD MORE · {filtered.length - visible} IN QUEUE
              </Button>
            </div>
          )}
        </>
      )}

      {/* ── Detail dialog ── */}
      <SignalDetailDialog signal={selected} open={selected !== null} onOpenChange={(v) => !v && setSelectedId(null)} />

      {/* ── Save filter preset naming dialog ── */}
      <Dialog open={savePresetOpen} onOpenChange={setSavePresetOpen}>
        <DialogContent className="max-h-[92vh] gap-0 overflow-hidden rounded-xl border-[rgba(178,107,255,0.25)] bg-[rgba(7,11,14,0.97)] p-0 backdrop-blur-2xl sm:max-w-md">
          <DialogDescription className="sr-only">
            Name and save the current signal matrix filter combo as a reusable preset.
          </DialogDescription>
          <div className="p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <BookmarkPlus className="h-4 w-4 text-violet-neon" aria-hidden />
              <DialogTitle className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">
                SAVE FILTER PRESET
              </DialogTitle>
            </div>
            <p className="mt-1.5 text-xs text-ink-2">
              Snapshots every active filter — status, side, strategy, symbol, sort, search &amp; starred.
            </p>
            <div className="mt-4 glass-soft rounded-lg p-3 font-terminal text-[10px] leading-relaxed tracking-[0.1em] text-ink-2">
              {[
                currentFilters.status !== "ALL" ? `STATUS ${currentFilters.status === "TP_WIN" ? "TP WIN" : currentFilters.status}` : null,
                currentFilters.direction !== "ALL" ? currentFilters.direction : null,
                currentFilters.strategy !== "ALL" ? currentFilters.strategy.replace(/-/g, " ").toUpperCase() : null,
                currentFilters.symbol !== "ALL" ? currentFilters.symbol : null,
                `SORT ${currentFilters.sort}`,
                currentFilters.query ? `QUERY “${currentFilters.query}”` : null,
                currentFilters.watchOnly ? "STARRED ONLY" : null,
              ]
                .filter(Boolean)
                .map((line) => (
                  <div key={line} className="whitespace-nowrap">▸ {line}</div>
                ))}
              {currentFilters.status === "ALL" &&
                currentFilters.direction === "ALL" &&
                currentFilters.strategy === "ALL" &&
                currentFilters.symbol === "ALL" &&
                !currentFilters.query &&
                !currentFilters.watchOnly && <div className="text-violet-neon">▸ BROAD SCAN — ALL SIGNALS</div>}
            </div>
            <div className="relative mt-4">
              <Input
                autoFocus
                value={presetName}
                onChange={(e) => {
                  setPresetName(e.target.value.slice(0, 24));
                  setPresetFullWarn(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSavePreset();
                }}
                placeholder="E.G. SCALP SHORTS"
                aria-label="Preset name"
                maxLength={24}
                className="h-11 pr-12 font-terminal text-xs uppercase tracking-[0.12em] placeholder:text-ink-3 focus-visible:ring-[rgba(178,107,255,0.5)]"
              />
              <span
                className={cn(
                  "absolute right-3 top-1/2 -translate-y-1/2 font-terminal text-[9px] tabular-nums",
                  presetName.length > 20 ? "text-amber-neon" : "text-ink-3"
                )}
              >
                {presetName.length}/24
              </span>
            </div>
            {presetFullWarn && (
              <p className="mt-2 font-terminal text-[10px] tracking-[0.12em] text-danger-neon">
                RACK FULL ({FILTER_PRESET_CAP}/{FILTER_PRESET_CAP}) — REMOVE A PRESET FIRST.
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-[rgba(178,107,255,0.12)] bg-[rgba(5,8,10,0.6)] p-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setSavePresetOpen(false)}
              className="h-11 border-white/10 bg-transparent font-terminal text-[11px] tracking-[0.16em] text-ink-2 hover:bg-white/5"
            >
              <X className="h-4 w-4" />
              CANCEL
            </Button>
            <Button
              type="button"
              onClick={handleSavePreset}
              disabled={!presetName.trim() || presetFullWarn}
              className="h-11 min-w-[120px] border border-[rgba(178,107,255,0.4)] bg-[rgba(178,107,255,0.14)] font-terminal text-[11px] font-bold tracking-[0.2em] text-violet-neon hover:bg-[rgba(178,107,255,0.24)]"
            >
              <Save className="h-4 w-4" />
              SAVE
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Risk calculator ── */}
      <RiskCalculator
        open={calcOpen}
        onOpenChange={setCalcOpen}
        signal={signals.find((s) => OPEN_STATUSES.has(s.status) && (symbol === "ALL" || s.symbol === symbol)) ?? null}
      />
    </section>
  );
}
