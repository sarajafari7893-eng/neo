// ── FlowRadar Neo — canonical brand + version registry ──────────────────────
// Operator mandate 2026-09-15: rename the program to «FlowRadar Neo» across ALL
// components (dashboard theme respected) and surface the LATEST project version
// in the UI. Every branding surface (header, footer, metadata, Telegram copy,
// posters) imports from this single module so the name/version can never drift.

export const APP_NAME = "FlowRadar Neo";

/** Terminal-styled brand parts, rendered as FLOWRADAR//NEO with neon separator. */
export const BRAND_TERMINAL = { head: "FLOWRADAR", sep: "//", tail: "NEO" } as const;

/** Latest engineering version (v10.0.0 — the operator FOUR-MODULE package:
 * R1 Risk Governor + R2 Time Governor + R5 UI-Canary + R6 Daily Senior-Review,
 * all shadow-first; plus the FlowRadar Neo rename itself). Numeric order
 * continues the v9.6.x lineage forward. */
export const APP_VERSION = "10.0.0";
export const APP_VERSION_LABEL = `v${APP_VERSION}`;

/** Release codename shown next to the version in header/footer. */
export const APP_STAGE = "NEO";

/** Header subtitle — mirrors the terminal theme. */
export const APP_TAGLINE = `AI TRADING COMMAND ${APP_VERSION_LABEL} — FULL AUTONOMY`;

/** Footer engine line. */
export const APP_ENGINE_LINE = `FLOWRADAR-NEO ${APP_VERSION_LABEL} — AUTONOMOUS`;

/** Document titles. */
export const APP_TITLE = `${APP_NAME} — AI Trading Command Terminal`;
export const APP_OG_TITLE = `${BRAND_TERMINAL.head}${BRAND_TERMINAL.sep}${BRAND_TERMINAL.tail}`;
