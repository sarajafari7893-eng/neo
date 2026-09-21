// ── FlowRadar Neo — shared Recharts theme constants & glass tooltip ──
// Palette is restricted to the neon set + ink tones. Never blue/indigo.
// NOTE: SVG/Recharts props can't resolve CSS vars — chart series that should
// follow the operator accent use the useNeon() hook (hex) instead of var().
import { createElement, type ReactElement } from "react";
import { accentDef, type AccentId } from "@/lib/accent";
import { useAlerts } from "@/store/alerts";

/** Neon palette — order: mint, violet, magenta, amber, cyan, danger */
export const NEON_PALETTE = ["#00ffa3", "#b26bff", "#ff4ecd", "#ffb347", "#45f0df", "#ff4d5e"] as const;

export const NEON = NEON_PALETTE[0];
export const VIOLET = NEON_PALETTE[1];
export const MAGENTA = NEON_PALETTE[2];
export const AMBER = NEON_PALETTE[3];
export const CYAN = NEON_PALETTE[4];
export const DANGER = NEON_PALETTE[5];

/**
 * Accent-following neon hex for SVG/Recharts props.
 * Re-renders when the operator switches accent (zustand selector).
 */
export function useNeon(): string {
  const accent = useAlerts((s) => s.accent);
  return accentDef(accent).hex;
}

/* ══ Per-accent chart palettes ═════════════════════════════ */

/** Accent-aware series palette — keeps the whole chart family in harmony
 *  when the operator switches identity. Semantic constants (DANGER, heat
 *  amber zones) intentionally stay fixed regardless of accent. */
export interface ChartPalette {
  /** the operator accent itself (WINS, primary lines, LONG) */
  primary: string;
  /** supporting hue — conviction bars, secondary fills */
  secondary: string;
  /** warm counterpoint — conviction win-rate line */
  tertiary: string;
  /** cool counterpoint — deployment-count bars */
  quaternary: string;
  /** opposing-direction hue (SHORT vs LONG duality) */
  opposing: string;
}

const CHART_PALETTES: Record<AccentId, ChartPalette> = {
  mint:    { primary: "#00ffa3", secondary: "#b26bff", tertiary: "#ffb347", quaternary: "#45f0df", opposing: "#ff4ecd" },
  cyan:    { primary: "#45f0df", secondary: "#b26bff", tertiary: "#ffb347", quaternary: "#00ffa3", opposing: "#ff4ecd" },
  violet:  { primary: "#b26bff", secondary: "#ff4ecd", tertiary: "#ffb347", quaternary: "#45f0df", opposing: "#45f0df" },
  magenta: { primary: "#ff4ecd", secondary: "#b26bff", tertiary: "#ffb347", quaternary: "#45f0df", opposing: "#b26bff" },
  amber:   { primary: "#ffb347", secondary: "#b26bff", tertiary: "#ff4ecd", quaternary: "#45f0df", opposing: "#b26bff" },
};

/** Accent-aware full series palette for Recharts (re-renders on accent switch). */
export function useChartPalette(): ChartPalette {
  const accent = useAlerts((s) => s.accent);
  return CHART_PALETTES[accent] ?? CHART_PALETTES.mint;
}

/** Shared axis tick style (dim terminal mono) */
export const AXIS_TICK = {
  fill: "#5c6f66",
  fontSize: 10,
  fontFamily: "var(--font-terminal)",
} as const;

/** Shared grid + axis line strokes */
export const GRID_STROKE = "rgba(159,180,171,0.08)";
export const AXIS_LINE_STROKE = "rgba(159,180,171,0.12)";
/** Dashed reference/zero lines */
export const MUTED_LINE = "rgba(159,180,171,0.25)";

/* ══ Custom glass tooltip ═══════════════════════════════════ */

export interface TooltipEntry {
  name?: string | number;
  value?: string | number;
  color?: string;
  dataKey?: string | number;
}

export interface NexusTooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  /** global unit suffix, e.g. "%" */
  unit?: string;
  /** global value prefix, e.g. "$" */
  prefix?: string;
  /** optional per-series override keyed by dataKey, e.g. { winRate: "%" } */
  units?: Record<string, string>;
  /** optional per-series prefix override, e.g. { estPnlPct: "" } to drop the "$" */
  prefixes?: Record<string, string>;
}

function formatEntry(value: string | number, prefix?: string, unit?: string): string {
  if (typeof value === "number") {
    const sign = value < 0 ? "-" : "";
    const body = Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
    return `${sign}${prefix ?? ""}${body}${unit ?? ""}`;
  }
  return `${prefix ?? ""}${value}${unit ?? ""}`;
}

/**
 * Dark-glass tooltip content for Recharts (`<Tooltip content={<NexusTooltip prefix="$" />} />`).
 * Recharts injects active/payload/label via cloneElement at runtime.
 */
export function NexusTooltip({ active, payload, label, unit, prefix, units, prefixes }: NexusTooltipProps): ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;

  const rows = payload.map((entry, i) => {
    const resolvedUnit = units?.[String(entry.dataKey)] ?? unit;
    const resolvedPrefix = prefixes?.[String(entry.dataKey)] ?? prefix;
    return createElement(
      "div",
      { key: `row-${i}`, className: "mt-0.5 flex items-center gap-2 whitespace-nowrap" },
      createElement("span", {
        key: "dot",
        className: "inline-block h-2 w-2 shrink-0 rounded-full",
        style: { background: entry.color ?? NEON, boxShadow: `0 0 6px ${entry.color ?? NEON}` },
      }),
      entry.name !== undefined && entry.name !== null
        ? createElement("span", { key: "name", className: "text-ink-2" }, String(entry.name).toUpperCase())
        : null,
      createElement(
        "span",
        { key: "value", className: "ml-auto font-bold text-ink" },
        formatEntry(entry.value ?? 0, resolvedPrefix, resolvedUnit),
      ),
    );
  });

  return createElement(
    "div",
    {
      className:
        "rounded-lg border border-[rgb(var(--neon-rgb)/0.2)] bg-[rgba(8,12,16,0.95)] px-3 py-2 font-terminal text-xs shadow backdrop-blur",
    },
    label !== undefined && label !== null && label !== ""
      ? createElement("div", { key: "label", className: "label-tech" }, String(label).toUpperCase())
      : null,
    ...rows,
  );
}

/* ══ Equity-curve tooltip ═══════════════════════════════════ */

export interface EquityDatum {
  label: string; // "AUG 30"
  cum: number;
  daily: number;
}

/**
 * Rich glass tooltip for the equity curve — signed CUM + DAY rows with
 * neon/danger coloring and a cum-vs-peak progress rail. Recharts injects
 * active/payload/label at runtime.
 */
export function EquityTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload?: EquityDatum }>;
  label?: string | number;
}): ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0]?.payload;
  if (!d) return null;

  const cumPos = d.cum >= 0;
  const dayPos = d.daily >= 0;
  const fmt = (v: number) =>
    `${v < 0 ? "−" : "+"}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  return createElement(
    "div",
    {
      className:
        "min-w-[150px] rounded-lg border border-[rgb(var(--neon-rgb)/0.22)] bg-[rgba(8,12,16,0.96)] px-3 py-2 font-terminal text-xs shadow-[0_8px_28px_-10px_rgba(0,0,0,0.9)] backdrop-blur",
    },
    createElement(
      "div",
      { key: "head", className: "flex items-center justify-between gap-3" },
      createElement("span", { key: "d", className: "label-tech" }, String(label ?? d.label).toUpperCase()),
      createElement("span", {
        key: "dot",
        className: "h-1.5 w-1.5 rounded-full",
        style: { background: NEON, boxShadow: `0 0 8px ${NEON}` },
      })
    ),
    createElement(
      "div",
      { key: "cum", className: "mt-1.5 flex items-baseline justify-between gap-4 whitespace-nowrap" },
      createElement("span", { key: "k", className: "text-ink-2" }, "CUM EQUITY"),
      createElement(
        "span",
        {
          key: "v",
          className: `font-bold tabular-nums ${cumPos ? "text-neon" : "text-danger-neon"}`,
          style: { textShadow: cumPos ? `0 0 10px ${NEON}66` : "0 0 10px rgba(255,77,94,0.4)" },
        },
        fmt(d.cum)
      )
    ),
    createElement(
      "div",
      { key: "day", className: "mt-0.5 flex items-baseline justify-between gap-4 whitespace-nowrap" },
      createElement("span", { key: "k", className: "text-ink-2" }, "DAY PNL"),
      createElement(
        "span",
        { key: "v", className: `font-bold tabular-nums ${dayPos ? "text-neon" : "text-danger-neon"}` },
        fmt(d.daily)
      )
    )
  );
}
