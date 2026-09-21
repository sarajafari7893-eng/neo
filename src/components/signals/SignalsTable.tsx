"use client";

import { useMemo } from "react";
import { ArrowDown, ArrowUp, Star, TrendingDown, TrendingUp } from "lucide-react";

import type { SignalDTO } from "@/lib/api-types";
import { STATUS_META, fmtCountdown, fmtPct, fmtPrice, timeAgo, ttlRemainingMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAlerts } from "@/store/alerts";
import { useNow } from "@/hooks/usePulse";

/**
 * SignalsTable — dense terminal-table presentation of the signal matrix
 * (persisted GRID|TABLE viewMode, store v8). Live TTL countdowns with
 * depletion bars, outcome freeze for resolved rows, clickable sortable
 * headers wired to the same store-backed sortMode as the toolbar Select,
 * per-row star toggle and row-click → detail dialog. Horizontal scroll
 * on narrow viewports; zebra rows + accent hover keep rows scannable.
 */

type SortKey = "NEWEST" | "PNL" | "CONFIDENCE" | "TTL";

const OPEN_STATUSES = new Set<string>(["ACTIVE", "TP1", "TP2"]);
const WIN_RANK: Record<string, number> = { TP1: 1, TP2: 2, TP3: 3 };

/** short outcome text for resolved rows */
function outcomeLabel(s: SignalDTO): string {
  if (WIN_RANK[s.status]) return `TP${WIN_RANK[s.status]} HIT`;
  if (s.status === "SL") return "STOPPED";
  if (s.status === "EXPIRED") return "EXPIRED";
  return "CLOSED";
}

function outcomeTone(s: SignalDTO): string {
  if (WIN_RANK[s.status]) return "text-cyan-neon";
  if (s.status === "SL") return "text-danger-neon";
  if (s.status === "EXPIRED") return "text-amber-neon";
  return "text-ink-3";
}

function statusTone(s: SignalDTO): string {
  if (OPEN_STATUSES.has(s.status)) return "text-neon";
  if (WIN_RANK[s.status]) return "text-cyan-neon";
  if (s.status === "SL") return "text-danger-neon";
  if (s.status === "EXPIRED") return "text-amber-neon";
  return "text-ink-3";
}

export default function SignalsTable({
  signals,
  priceMap,
  onOpen,
}: {
  signals: SignalDTO[];
  priceMap: Map<string, number>;
  onOpen: (id: string) => void;
}) {
  const now = useNow(1000);
  const sort = useAlerts((s) => s.sortMode) as SortKey;
  const setSort = useAlerts((s) => s.setSortMode);
  const watchlist = useAlerts((s) => s.watchlist);
  const toggleWatch = useAlerts((s) => s.toggleWatch);

  /* urgency mirror of the section pipeline — powers the TTL header sort */
  const ttlUrgency = useMemo(
    () =>
      new Map(
        signals.map(
          (s) =>
            [
              s.id,
              OPEN_STATUSES.has(s.status) && !s.closedAt ? new Date(s.expiresAt).getTime() : Number.POSITIVE_INFINITY,
            ] as const
        )
      ),
    [signals]
  );

  /* sortable header buttons — same keys as the toolbar sort Select */
  const SORT_COLS: Array<{ key: SortKey; label: string; aria: string }> = [
    { key: "NEWEST", label: "CREATED", aria: "Sort by creation time" },
    { key: "PNL", label: "PNL", aria: "Sort by PnL" },
    { key: "CONFIDENCE", label: "CONF", aria: "Sort by confidence" },
    { key: "TTL", label: "TTL", aria: "Sort by TTL urgency" },
  ];

  return (
    <div className="glass mt-4 overflow-hidden rounded-xl" role="region" aria-label="Signal matrix table view">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] border-collapse font-terminal">
          <thead>
            <tr className="border-b border-white/8 bg-[rgba(5,8,10,0.55)]">
              <th scope="col" className="label-tech px-3 py-2.5 text-left">
                SYMBOL
              </th>
              <th scope="col" className="label-tech px-2 py-2.5 text-left">
                STATUS
              </th>
              <th scope="col" className="label-tech px-2 py-2.5 text-right">
                ENTRY
              </th>
              <th scope="col" className="label-tech px-2 py-2.5 text-right">
                NOW
              </th>
              <th scope="col" className="label-tech px-2 py-2.5 text-left">
                STRATEGY
              </th>
              {SORT_COLS.map((c) => {
                const active = sort === c.key;
                /* desc sorts (newest/best-first) arrow down; TTL is asc (soonest first) */
                const Arrow = active && c.key === "TTL" ? ArrowUp : ArrowDown;
                return (
                  <th key={c.key} scope="col" className="px-2 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => setSort(c.key)}
                      aria-label={c.aria}
                      aria-pressed={active}
                      title={c.aria}
                      className={cn(
                        "label-tech inline-flex items-center gap-1 rounded px-1.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--neon-rgb)/0.6)]",
                        active ? "text-neon" : "text-ink-3 hover:text-ink-2"
                      )}
                    >
                      {c.label}
                      {active && <Arrow size={10} aria-hidden />}
                    </button>
                  </th>
                );
              })}
              <th scope="col" className="w-10 px-2 py-2.5 text-right">
                <span className="sr-only">Watchlist star</span>
                <Star size={10} aria-hidden className="ml-auto text-ink-3" />
              </th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s, i) => {
              const long = s.direction === "LONG";
              const isOpen = !s.closedAt && OPEN_STATUSES.has(s.status);
              const live = priceMap.get(s.symbol);
              const cur = live ?? s.entryPrice;
              const starred = watchlist.includes(s.symbol);
              const totalMs = Math.max(1, s.ttlMinutes * 60_000);
              const remaining = now === 0 ? totalMs : ttlRemainingMs(s.expiresAt, now);
              const ttlFrac = Math.max(0, Math.min(1, remaining / totalMs));
              const rowTtl = isOpen ? (now === 0 ? "--:--:--" : fmtCountdown(s.expiresAt, now)) : null;
              return (
                <tr
                  key={s.id}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open ${s.symbol} ${s.direction} detail`}
                  onClick={() => onOpen(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpen(s.id);
                    }
                  }}
                  className={cn(
                    "group cursor-pointer border-b border-white/5 transition-colors last:border-0",
                    "hover:bg-[rgb(var(--neon-rgb)/0.05)] focus-visible:bg-[rgb(var(--neon-rgb)/0.07)] focus-visible:outline-none",
                    i % 2 === 1 && "bg-white/[0.015]"
                  )}
                >
                  {/* symbol + side */}
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded",
                          long ? "bg-[rgb(var(--neon-rgb)/0.1)] text-neon" : "bg-[rgba(255,78,205,0.12)] text-magenta-neon"
                        )}
                      >
                        {long ? <TrendingUp size={12} strokeWidth={2.5} /> : <TrendingDown size={12} strokeWidth={2.5} />}
                      </span>
                      <span className="text-xs font-bold tracking-[0.1em] text-ink">{s.symbol}</span>
                      <span className={cn("text-[9px] font-bold tracking-[0.16em]", long ? "text-neon" : "text-magenta-neon")}>
                        {s.direction}
                      </span>
                      <span className="text-[9px] tabular-nums tracking-[0.08em] text-ink-3">×{s.leverage}</span>
                    </span>
                  </td>
                  {/* status */}
                  <td className="px-2 py-2.5">
                    <span className={cn("text-[10px] font-bold tracking-[0.14em]", statusTone(s))}>
                      {STATUS_META[s.status]?.label ?? s.status}
                    </span>
                  </td>
                  {/* entry / now */}
                  <td className="px-2 py-2.5 text-right text-xs tabular-nums text-ink-2">{fmtPrice(s.entryPrice)}</td>
                  <td className="px-2 py-2.5 text-right text-xs font-bold tabular-nums text-ink">{fmtPrice(cur)}</td>
                  {/* strategy */}
                  <td className="max-w-[150px] truncate px-2 py-2.5 text-left text-[10px] tracking-[0.1em] text-ink-3">
                    {s.strategy.replace(/-/g, " ").toUpperCase()}
                  </td>
                  {/* created */}
                  <td className="px-2 py-2.5 text-right text-[10px] tabular-nums text-ink-3">
                    {now === 0 ? "--" : timeAgo(s.createdAt, now)}
                  </td>
                  {/* pnl */}
                  <td
                    className={cn(
                      "px-2 py-2.5 text-right text-xs font-bold tabular-nums",
                      s.pnlPercent >= 0 ? "text-neon" : "text-danger-neon"
                    )}
                  >
                    {fmtPct(s.pnlPercent)}
                  </td>
                  {/* conf */}
                  <td className="px-2 py-2.5 text-right text-[11px] tabular-nums text-ink-2">{Math.round(s.confidence)}%</td>
                  {/* ttl */}
                  <td className="px-2 py-2.5 text-right">
                    {isOpen ? (
                      <span className="inline-flex flex-col items-end gap-1">
                        <span
                          className={cn(
                            "text-[11px] font-bold tabular-nums",
                            remaining < 60_000 ? "text-danger-neon" : remaining < 300_000 ? "text-amber-neon" : "text-ink-2"
                          )}
                        >
                          {rowTtl}
                        </span>
                        <span aria-hidden className="h-0.5 w-14 overflow-hidden rounded-full bg-white/8">
                          <span
                            className={cn(
                              "block h-full rounded-full",
                              remaining < 60_000 ? "bg-danger-neon" : remaining < 300_000 ? "bg-amber-neon" : "bg-neon/70"
                            )}
                            style={{ width: `${ttlFrac * 100}%` }}
                          />
                        </span>
                      </span>
                    ) : (
                      <span className={cn("text-[10px] font-bold tracking-[0.12em]", outcomeTone(s))}>{outcomeLabel(s)}</span>
                    )}
                  </td>
                  {/* star */}
                  <td className="px-2 py-2.5 text-right">
                    <button
                      type="button"
                      aria-label={starred ? `Remove ${s.symbol} from watchlist` : `Add ${s.symbol} to watchlist`}
                      aria-pressed={starred}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleWatch(s.symbol);
                      }}
                      className={cn(
                        "inline-flex h-8 w-8 items-center justify-center rounded transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
                        starred
                          ? "text-amber-neon hover:bg-[rgba(255,179,71,0.12)]"
                          : "text-ink-3 opacity-0 hover:text-amber-neon focus-visible:opacity-100 group-hover:opacity-100"
                      )}
                    >
                      <Star size={13} className={cn(starred && "fill-amber-neon")} strokeWidth={2.5} aria-hidden />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-white/8 bg-[rgba(5,8,10,0.55)] px-3 py-2">
        <span className="label-tech text-ink-3">TABLE VIEW · {signals.length} SHOWN</span>
        <span className="label-tech hidden text-ink-3 sm:block">CLICK ROW FOR DETAIL · HEADERS SORT</span>
      </div>
    </div>
  );
}
