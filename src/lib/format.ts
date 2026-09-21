// ── FlowRadar Neo formatting helpers (client-safe) ──

import type { SignalDTO } from "./api-types";
import { APP_NAME } from "./brand";

export function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 10) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  return p.toFixed(4);
}

export function fmtUsd(v: number, compact = true): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (compact) {
    if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  }
  return `${sign}$${abs.toFixed(2)}`;
}

export function fmtPct(v: number, withSign = true): string {
  const sign = withSign && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

export function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

/** HH:MM:SS remaining until ISO timestamp */
export function fmtCountdown(iso: string, now: number): string {
  const diff = Math.max(0, new Date(iso).getTime() - now);
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function ttlRemainingMs(iso: string, now: number): number {
  return Math.max(0, new Date(iso).getTime() - now);
}

export function timeAgo(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** HH:MM:SS in UTC — deterministic across server/client (hydration-safe).
 * Returns placeholder for the pre-mount snapshot (0) to avoid TZ-dependent SSR text. */
export function fmtClock(ts: number): string {
  if (!ts || ts <= 0) return "--:--:--";
  return new Date(ts).toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" });
}

/** Wall-clock in the OPERATOR'S SYSTEM timezone (device clock — matches the
 * OS taskbar exactly). Operator request 2026-09-07: «ساعت در داشبورد رو با
 * ساعت سیستم یکی کن». Hydration-safe: 0/negative → dashes (pre-mount). */
export function fmtClockLocal(ts: number): string {
  if (!ts || ts <= 0) return "--:--:--";
  return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

/** Device timezone offset label, e.g. "GMT+03:30" (Tehran) — pairs with
 * fmtClockLocal so the operator can see WHICH system clock is shown. */
export function localTzLabel(): string {
  const min = -new Date().getTimezoneOffset();
  const sign = min >= 0 ? "+" : "−";
  const abs = Math.abs(min);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `GMT${sign}${hh}:${mm}`;
}

/** IANA timezone name of the device ("Asia/Tehran" etc.), best-effort. */
export function localTzName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || localTzLabel();
  } catch {
    return localTzLabel();
  }
}

/** Entry → TP3 / SL range progress: 0 = at SL, 0.5 = entry, 1 = TP3 */
export function levelProgress(price: number, entry: number, stopLoss: number, tp3: number): number {
  if (entry === stopLoss || entry === tp3) return 0.5;
  const t = (price - stopLoss) / (tp3 - stopLoss);
  return Math.min(1, Math.max(0, t));
}

/** % distance from current price to a target level */
export function distPct(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

export const STATUS_META: Record<string, { label: string; tone: "live" | "win" | "loss" | "warn" | "muted" }> = {
  ACTIVE: { label: "LIVE", tone: "live" },
  TP1: { label: "TP1 HIT", tone: "win" },
  TP2: { label: "TP2 HIT", tone: "win" },
  TP3: { label: "TP3 FULL", tone: "win" },
  SL: { label: "SL HIT", tone: "loss" },
  EXPIRED: { label: "TTL END", tone: "warn" },
  CLOSED: { label: "CLOSED", tone: "muted" },
};

/**
 * Terminal-style plaintext brief for sharing a signal (clipboard, chat…).
 * Includes everything an operator needs to mirror the deployment manually.
 */
export function signalBrief(s: SignalDTO, price?: number): string {
  const meta = STATUS_META[s.status] ?? { label: s.status };
  const lines = [
    `◆ ${APP_NAME} — ${s.symbol} ${s.direction}`,
    `STRATEGY   ${s.strategy} · ${s.timeframe} · ${s.engine}`,
    `STATUS     ${meta.label} · CONF ${Math.round(s.confidence)}% · R:R 1:${s.riskReward.toFixed(1)}`,
    `ENTRY      ${fmtPrice(s.entryPrice)}  (zone ${fmtPrice(s.entryZoneLow)}–${fmtPrice(s.entryZoneHigh)})`,
    `TP1 / TP2 / TP3   ${fmtPrice(s.tp1)} / ${fmtPrice(s.tp2)} / ${fmtPrice(s.tp3)}`,
    `STOP-LOSS  ${fmtPrice(s.stopLoss)}`,
    `SIZE       ${s.leverage}× lev · margin ${fmtUsd(s.marginUsd, false)} · notional ${fmtUsd(s.marginUsd * s.leverage)}`,
    `TTL        ${s.ttlMinutes}m · expires ${new Date(s.expiresAt).toISOString().slice(11, 16)}Z`,
  ];
  if (typeof price === "number" && price > 0) lines.push(`MARKET     ${fmtPrice(price)} now`);
  if (s.operatorNotes?.trim()) {
    lines.push(`JOURNAL    ${s.operatorNotes.trim().replace(/\s+/g, " ").slice(0, 160)}${s.operatorNotes.trim().length > 160 ? "…" : ""}`);
  }
  lines.push(`SIG-${s.id.slice(-4).toUpperCase()} · ${s.tags.map((t) => `#${t}`).join(" ")}`);
  return lines.join("\n");
}
