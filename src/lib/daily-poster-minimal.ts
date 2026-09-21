// ── FlowRadar Neo MINIMAL / DATA-DRIVEN daily poster (server-only) ─────────
// Operator round 2026-09-09: «مدل دیتامحور مینیمال رو بفرست تا ببینم».
// Design language: typography-first terminal ledger. NO AI art, NO glow, NO
// card boxes — pure hairlines, one hero number, a dense closed-trade ledger
// with real coin logos and vector raging-bull (proven-TP win) / raging-bear
// (stopped) outcome marks. Every drawn number comes from buildDailyDigest()
// REAL rows — the artwork is presentation, never invention.

import sharp from "sharp";
import { loadCoinLogo, baseAsset } from "./telegram-art";
import type { DailyDigest } from "./dailyReport";
import { dailySkin } from "./daily-skin";
import { BRAND_TERMINAL } from "./brand";

const W = 1080;
const H = 1350;
const MX = 64;
const RIGHT = W - MX;
const CW = RIGHT - MX;

// ── palette (same terminal identity, stripped down) ──
const BG = "#0b0e14";
const INK = "#e8f0ec";
const MUTED = "#8aa094";
const DIM = "#5f7268";
const MINT = "#00ffa3";
const DANGER = "#ff4d5e";
const AMBER = "#ffb347";
const VIOLET = "#b26bff";
const HAIR = "rgba(138,160,148,0.16)";
const HAIR_SOFT = "rgba(138,160,148,0.10)";

const MONO = "DejaVu Sans Mono";
const SANS = "DejaVu Sans";

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtUsd(v: number): string {
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
}

// ── vector outcome marks (48×48 viewBox, stroke-only minimal line icons) ──
type Outcome = "BULL" | "BEAR" | "NEUTRAL";

function outcomeMark(kind: Outcome, x: number, y: number, size: number, col: string): string {
  const s = (size / 48).toFixed(4);
  let body: string;
  if (kind === "BULL") {
    // raging bull — horns sweeping up behind the head, slanted angry eyes, nostrils
    body = `
    <path d="M5 9 C8 18 13 23 19 22"/>
    <path d="M43 9 C40 18 35 23 29 22"/>
    <circle cx="24" cy="29" r="12" fill="${BG}"/>
    <path d="M16 26 L22 29"/>
    <path d="M32 26 L26 29"/>
    <circle cx="19.5" cy="34" r="1.4" fill="${col}" stroke="none"/>
    <circle cx="28.5" cy="34" r="1.4" fill="${col}" stroke="none"/>`;
  } else if (kind === "BEAR") {
    // raging bear — ears tucked behind the head silhouette, slanted angry eyes, deep frown
    body = `
    <circle cx="13" cy="16.5" r="5"/>
    <circle cx="35" cy="16.5" r="5"/>
    <circle cx="24" cy="28.5" r="13" fill="${BG}"/>
    <path d="M15 25 L21 27.5"/>
    <path d="M33 25 L27 27.5"/>
    <path d="M18.5 33.5 Q24 30 29.5 33.5"/>`;
  } else {
    // neutral — rotated diamond, engine moved on
    body = `<rect x="16" y="16" width="16" height="16" rx="3" transform="rotate(45 24 24)"/><circle cx="24" cy="24" r="1.6" fill="${col}" stroke="none"/>`;
  }
  return `<g transform="translate(${x},${y}) scale(${s})" stroke="${col}" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

function rowOutcome(status: string): { kind: Outcome; text: string; col: string } {
  if (status === "TP1" || status === "TP2" || status === "TP3") return { kind: "BULL", text: `${status} BANKED`, col: MINT };
  if (status === "SL") return { kind: "BEAR", text: "STOPPED", col: DANGER };
  if (status === "EXPIRED") return { kind: "NEUTRAL", text: "EXPIRED", col: AMBER };
  return { kind: "NEUTRAL", text: status === "CLOSED" ? "CLOSED" : status.toUpperCase(), col: MUTED };
}

export interface MinimalPosterSpec {
  digest: DailyDigest;
  /** "2026-09-09 07:20 TEHRAN" */
  ts?: string;
}

function posterSvg(spec: MinimalPosterSpec, logos: Array<Buffer | null>): string {
  const d = spec.digest;
  const skin = dailySkin(); // v8.2 daily rotation — accent edge + date marker
  const netCol = d.realizedUsd >= 0 ? MINT : DANGER;
  const trades = (d.trades ?? []).slice(0, 5);
  const fees = d.feesUsd > 0 ? `after fees −$${d.feesUsd.toFixed(2)}` : "no fees booked in window";
  const eq = d.equityUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const winRate = d.winRatePct === null ? "—" : `${d.winRatePct}%`;
  const openCol = d.unrealizedUsd >= 0 ? MINT : DANGER;

  // ── stat strip ──
  const stats: Array<[string, string, string]> = [
    ["EQUITY", `$${eq}`, INK],
    ["OPEN PNL", fmtUsd(d.unrealizedUsd), openCol],
    ["WIN RATE", winRate, d.winRatePct === null ? MUTED : d.winRatePct >= 50 ? MINT : d.winRatePct >= 35 ? AMBER : DANGER],
    ["ACTIVE NOW", String(d.active), VIOLET],
  ];
  const colPitch = CW / 4;
  const statsSvg = stats
    .map(([label, value, col], i) => {
      const x = MX + i * colPitch;
      return `
      <text x="${x}" y="408" font-family="${MONO}" font-size="14" fill="${MUTED}" letter-spacing="2.5">${escXml(label)}</text>
      <text x="${x}" y="452" font-family="${SANS}" font-size="33" font-weight="700" fill="${col}">${escXml(value)}</text>`;
    })
    .join("");
  const stripDivs = [1, 2, 3]
    .map((i) => `<line x1="${(MX + i * colPitch - 12).toFixed(0)}" y1="384" x2="${(MX + i * colPitch - 12).toFixed(0)}" y2="468" stroke="${HAIR}" stroke-width="1"/>`)
    .join("");

  // ── ledger rows ──
  const rowsSvg = trades
    .map((t, i) => {
      const yTop = 628 + i * 88;
      const ymid = yTop + 44;
      const out = rowOutcome(t.status);
      const dirCol = t.direction === "SHORT" ? DANGER : MINT;
      const dirArrow = t.direction === "SHORT" ? "▼" : "▲";
      const netCol = t.pnl >= 0 ? MINT : DANGER;
      const sign = t.pnl >= 0 ? "+" : "−";
      const base = baseAsset(t.symbol);
      const hasLogo = Boolean(logos[i]);

      const logoSvg = hasLogo
        ? ""
        : `<circle cx="118" cy="${ymid}" r="24" fill="rgba(255,255,255,0.03)" stroke="${HAIR}" stroke-width="1"/>
           <text x="118" y="${ymid + 7}" font-family="${SANS}" font-size="17" font-weight="700" fill="${INK}" text-anchor="middle">${escXml(base.slice(0, 3))}</text>`;

      return `
      <text x="${MX}" y="${ymid + 5}" font-family="${MONO}" font-size="14" fill="${DIM}">${String(i + 1).padStart(2, "0")}</text>
      ${logoSvg}
      <text x="168" y="${yTop + 38}" font-family="${SANS}" font-size="26" font-weight="700" fill="${INK}">${escXml(t.symbol)}</text>
      <text x="168" y="${yTop + 64}" font-family="${MONO}" font-size="13" fill="${DIM}" letter-spacing="1.5">${escXml((t.strategy || "ENGINE").toUpperCase())}</text>
      <text x="452" y="${ymid + 5}" font-family="${MONO}" font-size="16" fill="${dirCol}">${dirArrow} ${escXml(t.direction === "SHORT" ? "SHORT" : "LONG")}</text>
      ${outcomeMark(out.kind, 583, ymid - 17, 34, out.col)}
      <text x="628" y="${ymid + 5}" font-family="${MONO}" font-size="16" fill="${out.col}" letter-spacing="1.5">${escXml(out.text)}</text>
      <text x="${RIGHT}" y="${ymid + 9}" font-family="${SANS}" font-size="27" font-weight="700" fill="${netCol}" text-anchor="end">${sign}${Math.abs(t.pnl).toFixed(1)}%</text>
      <line x1="${MX}" y1="${yTop + 88}" x2="${RIGHT}" y2="${yTop + 88}" stroke="${HAIR_SOFT}" stroke-width="1"/>`;
    })
    .join("");

  // ── outcome distribution bar (TRUE final-status partition — see statusMix) ──
  const mix = d.statusMix;
  const mixTotal = Math.max(1, mix.tp + mix.sl + mix.expired + mix.manual);
  const segs: Array<[number, string]> = [
    [mix.tp / mixTotal, MINT],
    [mix.sl / mixTotal, DANGER],
    [mix.expired / mixTotal, AMBER],
    [mix.manual / mixTotal, MUTED],
  ];
  let bx = MX;
  const barSvg = d.closed > 0
    ? segs
        .map(([frac, col]) => {
          const w = frac * CW;
          const x = bx;
          bx += w;
          return w > 1 ? `<rect x="${x.toFixed(1)}" y="1108" width="${w.toFixed(1)}" height="6" rx="3" ry="3" fill="${col}" opacity="0.9"/>` : "";
        })
        .join("")
    : "";
  const legend =
    d.closed > 0
      ? `${mix.tp} TP-EXIT${mix.tp === 1 ? "" : "S"} · ${mix.sl} STOPPED · ${mix.expired} EXPIRED${mix.manual > 0 ? ` · ${mix.manual} MANUAL` : ""}`
      : "NO CLOSED TRADES IN THIS WINDOW — ENGINE WATCHING";

  const causeLine = d.volCauseCaptures > 0 ? `${d.volCauseCaptures} VOL-CAUSE CAPTURES${d.topCause ? ` · ${d.topCause}` : ""}` : `${d.opened} DEPLOYED · ${d.closed} CLOSED`;

  const bestTxt = d.best ? `BEST ${d.best.symbol} ${d.best.pnl >= 0 ? "+" : "−"}${Math.abs(d.best.pnl).toFixed(1)}%` : "BEST —";
  const worstTxt = d.worst ? `  ·  WORST ${d.worst.symbol} ${d.worst.pnl >= 0 ? "+" : "−"}${Math.abs(d.worst.pnl).toFixed(1)}%` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <!-- v8.2 daily skin: rotating accent edge + date marker (backdrop stays minimal) -->
  <rect x="0" y="0" width="${W}" height="6" fill="${skin?.accent ?? MINT}" opacity="0.9"/>

  <!-- header -->
  <rect x="${MX}" y="66" width="10" height="10" fill="${skin?.accent ?? MINT}"/>
  <text x="84" y="76" font-family="${SANS}" font-size="21" font-weight="700" fill="${MUTED}" letter-spacing="6">${BRAND_TERMINAL.head}${BRAND_TERMINAL.sep}${BRAND_TERMINAL.tail}</text>
  <text x="${RIGHT}" y="76" font-family="${MONO}" font-size="17" fill="${DIM}" text-anchor="end">${escXml(d.windowLabel)}${skin ? ` · ${skin.name}` : ""}</text>
  <line x1="${MX}" y1="100" x2="${RIGHT}" y2="100" stroke="${HAIR}" stroke-width="1"/>

  <!-- hero: the one number that matters -->
  <text x="${MX}" y="152" font-family="${MONO}" font-size="15" fill="${MUTED}" letter-spacing="4">REALIZED NET — LAST 24H</text>
  <text x="${MX - 4}" y="286" font-family="${SANS}" font-size="128" font-weight="700" fill="${netCol}" letter-spacing="-2">${escXml(fmtUsd(d.realizedUsd))}</text>
  <text x="${MX}" y="326" font-family="${MONO}" font-size="17" fill="${DIM}" letter-spacing="1">${escXml(fees)}</text>
  <line x1="${MX}" y1="360" x2="${RIGHT}" y2="360" stroke="${HAIR}" stroke-width="1"/>

  <!-- stat strip -->
  ${statsSvg}
  ${stripDivs}
  <line x1="${MX}" y1="500" x2="${RIGHT}" y2="500" stroke="${HAIR}" stroke-width="1"/>

  <!-- ledger section -->
  <text x="${MX}" y="552" font-family="${MONO}" font-size="16" fill="${MUTED}" letter-spacing="5">CLOSED LEDGER</text>
  <text x="${RIGHT}" y="552" font-family="${MONO}" font-size="15" fill="${DIM}" text-anchor="end">${escXml(causeLine)}</text>
  <text x="168" y="596" font-family="${MONO}" font-size="13" fill="${DIM}" letter-spacing="2">ASSET</text>
  <text x="583" y="596" font-family="${MONO}" font-size="13" fill="${DIM}" letter-spacing="2">OUTCOME</text>
  <text x="${RIGHT}" y="596" font-family="${MONO}" font-size="13" fill="${DIM}" letter-spacing="2" text-anchor="end">NET %</text>
  <line x1="${MX}" y1="612" x2="${RIGHT}" y2="612" stroke="${HAIR}" stroke-width="1"/>
  ${rowsSvg}

  <!-- outcome distribution -->
  ${barSvg}
  <text x="${MX}" y="1150" font-family="${MONO}" font-size="14" fill="${DIM}" letter-spacing="1.5">${escXml(legend)}</text>
  <text x="${RIGHT}" y="1150" font-family="${MONO}" font-size="14" fill="${MUTED}" text-anchor="end" letter-spacing="1.5">${escXml(bestTxt + worstTxt)}</text>

  <!-- footer -->
  <line x1="${MX}" y1="1246" x2="${RIGHT}" y2="1246" stroke="${HAIR}" stroke-width="1"/>
  <text x="${MX}" y="1292" font-family="${MONO}" font-size="15" fill="${VIOLET}" letter-spacing="3">FLOWRADAR-NEO LIVE ENGINE</text>
  <text x="${W / 2}" y="1292" font-family="${MONO}" font-size="15" fill="${DIM}" text-anchor="middle" letter-spacing="1.5">HONEST NUMBERS · SETTLED ROWS ONLY</text>
  <text x="${RIGHT}" y="1292" font-family="${MONO}" font-size="15" fill="${DIM}" text-anchor="end">${escXml(spec.ts ?? "")}</text>
</svg>`;
}

/** MINIMAL / DATA-DRIVEN daily poster → JPEG buffer (1080×1350 portrait —
 * renders ~2× taller in the Telegram feed than the 1280×720 hologram). */
export async function renderDailyPosterMinimal(spec: MinimalPosterSpec): Promise<Buffer> {
  const trades = (spec.digest.trades ?? []).slice(0, 5);
  const logos = await Promise.all(trades.map((t) => loadCoinLogo(t.symbol)));

  const svg = Buffer.from(posterSvg(spec, logos));
  const composites: sharp.OverlayOptions[] = [];
  for (let i = 0; i < logos.length; i++) {
    const logo = logos[i];
    if (!logo) continue;
    composites.push({
      input: await sharp(logo).resize(48, 48).png().toBuffer(),
      left: 118 - 24,
      top: 628 + i * 88 + 44 - 24,
    });
  }
  return sharp(svg).composite(composites).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}
