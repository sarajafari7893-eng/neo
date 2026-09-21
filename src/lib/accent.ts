// ── FlowRadar Neo accent system ──
// 5 operator-selectable accent identities. Each accent drives the whole
// neon chrome via CSS custom properties:
//   --neon / --neon-dim  → solid hex (borders, glows, text)
//   --neon-rgb           → space-separated channels for rgb(var(--neon-rgb) / a)
// SVG attributes & Recharts props can't resolve var(), so hex is also
// exposed through the useNeon() hook (chart-theme.ts).

export interface AccentDef {
  id: AccentId;
  label: string;
  hex: string;
  dim: string;
  rgb: string;
}

export type AccentId = "mint" | "cyan" | "violet" | "magenta" | "amber";

export const ACCENTS: Record<AccentId, AccentDef> = {
  mint: { id: "mint", label: "MINT", hex: "#00ffa3", dim: "#00c47c", rgb: "0 255 163" },
  cyan: { id: "cyan", label: "CYAN", hex: "#45f0df", dim: "#1fbfae", rgb: "69 240 223" },
  violet: { id: "violet", label: "VIOLET", hex: "#b26bff", dim: "#8f42e0", rgb: "178 107 255" },
  magenta: { id: "magenta", label: "MAGENTA", hex: "#ff4ecd", dim: "#d435a8", rgb: "255 78 205" },
  amber: { id: "amber", label: "AMBER", hex: "#ffb347", dim: "#e0942a", rgb: "255 179 71" },
};

export const ACCENT_ORDER: AccentId[] = ["mint", "cyan", "violet", "magenta", "amber"];

export const DEFAULT_ACCENT: AccentId = "mint";

/** Next accent in the cycle (for the ⌘K "cycle accent" command + A hotkey). */
export function nextAccent(current: string | null | undefined): AccentId {
  const idx = ACCENT_ORDER.indexOf((current ?? DEFAULT_ACCENT) as AccentId);
  return ACCENT_ORDER[(idx + 1) % ACCENT_ORDER.length] ?? DEFAULT_ACCENT;
}

export function accentDef(id: string | null | undefined): AccentDef {
  return ACCENTS[(id ?? DEFAULT_ACCENT) as AccentId] ?? ACCENTS[DEFAULT_ACCENT];
}
