// ── FlowRadar Neo v8.1 professional telegram artwork renderer (server-only) ─
// Operator round 2026-09-09: «آیا میشه ساخت تصاویر رو ارتقا داد تا گرافیکی‌تر
// و حرفه‌ای‌تر باشه؟ مثل نماد لوگو ارزها، برای وین گاو خشمگین و برای استاپ
// خرس خشمگین». This module is the YES: sharp (already a dependency) rasterizes
// design-grade SVG templates on top of AI-generated artwork, with real
// typography (DejaVu), live per-signal data, fetched coin logos, glow filters
// and stat cards. Every number drawn comes from the REAL signal/digest rows —
// the artwork is presentation, never invention.
//
// Fallback chain (wired in notify.ts):
//   renderSignalBannerV2 (this) → operator JPG art → renderStatusBanner (pixel)
//   renderDailyPoster (this)    → DAILY.jpg        → plain text caption

import sharp from "sharp";
import { BRAND_TERMINAL } from "./brand";
import fs from "node:fs/promises";
import path from "node:path";
import type { BannerStatus } from "./telegram-image";
import type { DailyDigest } from "./dailyReport";
import { dailySkin, type DailySkin } from "./daily-skin";

const W = 1280;
const H = 720;
const ASSETS_DIR = path.join(process.cwd(), "assets", "telegram");
const COINS_DIR = path.join(process.cwd(), "assets", "coins");

// ── palette (matches the v6.3 terminal identity) ──
const INK = "#e8f0ec";
const MUTED = "#8aa094";
const DIM = "#5a6e66";
const MINT = "#00ffa3";
const DANGER = "#ff4d5e";
const AMBER = "#ffb347";
const VIOLET = "#b26bff";
const GOLD = "#ffd700";
const PANEL_BG = "rgba(10,14,22,0.62)";
const PANEL_STROKE = "rgba(138,160,148,0.22)";

const STATUS_TEXT: Record<BannerStatus, string> = {
  WIN: "WIN", STOP: "STOPPED", EXPIRED: "EXPIRED",
  NEW: "NEW SIGNAL", SHORT: "SHORT SIGNAL", TTL_EXT: "TTL EXTENDED", FULL: "FULL TARGET",
  AFTERLIFE: "AFTERLIFE",
};
const SPECTRAL = "#DB60FF"; // spectral magenta — EXPIRED FOLLOW-UP verdicts
const STATUS_COLOR: Record<BannerStatus, string> = {
  WIN: MINT, STOP: DANGER, EXPIRED: AMBER, NEW: MINT, SHORT: DANGER, TTL_EXT: VIOLET, FULL: GOLD,
  AFTERLIFE: SPECTRAL,
};

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── AI artwork loading (art-{KIND}.png, generated once via scripts/gen-telegram-art.sh) ──
const artCache = new Map<string, Buffer | null>();

async function loadArt(kind: string): Promise<Buffer | null> {
  if (artCache.has(kind)) return artCache.get(kind) ?? null;
  try {
    const buf = await fs.readFile(path.join(ASSETS_DIR, `art-${kind}.png`));
    artCache.set(kind, buf);
    return buf;
  } catch {
    artCache.set(kind, null);
    return null;
  }
}

// ── v9.4 SKIN-CYCLE backdrop (skin-{KEY}.png, scripts/gen-skin-art.sh) ──
// The 7-skin cycle drives REAL AI generation: one visual style per day
// (BLUEPRINT · MOVIE · CYBERPUNK · ANIME · POP ART · VECTOR · CLAY), same
// subject scene across all seven. Negative results are cached for only 60s
// so backdrops generated while the server is live are picked up on the next
// render — the report must never wait on generation, but it must not need a
// restart to start wearing the new skin either.
const SKIN_NEG_TTL = 60_000;
const skinCache = new Map<string, { buf: Buffer | null; at: number }>();

export async function loadSkinArt(key: string): Promise<Buffer | null> {
  const hit = skinCache.get(key);
  if (hit && (hit.buf || Date.now() - hit.at < SKIN_NEG_TTL)) return hit.buf;
  let buf: Buffer | null = null;
  try {
    buf = await fs.readFile(path.join(ASSETS_DIR, `skin-${key}.png`));
  } catch {
    buf = null;
  }
  skinCache.set(key, { buf, at: Date.now() });
  return buf;
}

// ── v9.5 KIND-AWARE SKIN ART (operator mandate: every card wears artwork
// matching ITS OWN meaning — new LONG, SHORT, TP, STOP, … — inside the day's
// style). Files: skin-{key}-{KIND}.png by scripts/gen-skin-art.sh.
export type SkinKind = "LONG" | "SHORT" | "TP" | "STOP" | "EXPIRED";

/** BannerStatus → skin art kind. FULL target-hit shares the TP piece,
 * AFTERLIFE/TTL_EXT share the EXPIRED piece (headline color tells them apart). */
export function kindForStatus(status: BannerStatus): SkinKind {
  switch (status) {
    case "NEW": return "LONG";
    case "SHORT": return "SHORT";
    case "WIN":
    case "FULL": return "TP";
    case "STOP": return "STOP";
    case "EXPIRED":
    case "AFTERLIFE":
    case "TTL_EXT": return "EXPIRED";
  }
}

async function loadSkinFile(file: string): Promise<Buffer | null> {
  const hit = skinCache.get(file);
  if (hit && (hit.buf || Date.now() - hit.at < SKIN_NEG_TTL)) return hit.buf;
  let buf: Buffer | null = null;
  try {
    buf = await fs.readFile(path.join(ASSETS_DIR, file));
  } catch {
    buf = null;
  }
  skinCache.set(file, { buf, at: Date.now() });
  return buf;
}

/** Kind art for a skin: skin-{key}-{KIND}.png → skin-{key}.png → null.
 * Negative results cache 60s so freshly generated kind files are picked up
 * live, exactly like the generic skin pieces. */
export async function loadSkinKindArt(key: string, kind: SkinKind): Promise<Buffer | null> {
  return (await loadSkinFile(`skin-${key}-${kind}.png`)) ?? (await loadSkinFile(`skin-${key}.png`));
}

/** Shared composite: style backdrop + modulation tuned per skin (v9.4 — the
 * style identity is never hue-rotated; brightness/saturation keep the overlay
 * text readable). v10.21: the modulated 1280×720 backdrop is cached per art
 * file — an animation burst re-renders the SAME backdrop 14× and only the
 * overlay changes, so re-modulating every frame was 60%+ of the burst cost
 * (688ms/frame → the cache removes the resize+modulate from frames 2..14). */
const bgCache = new Map<string, Buffer>(); // art cacheKey → modulated 1280×720 bg

async function modulatedBackdrop(art: Buffer, skin: DailySkin, cacheKey: string): Promise<Buffer> {
  const hit = bgCache.get(cacheKey);
  if (hit) return hit;
  const bg = await sharp(art)
    .resize(W, H, { fit: "cover" })
    .modulate({ brightness: skin.tune.brightness, saturation: skin.tune.saturation, hue: skin.hueShift })
    .toBuffer();
  if (bgCache.size >= 6) bgCache.delete(bgCache.keys().next().value!);
  bgCache.set(cacheKey, bg);
  return bg;
}

async function withBackdrop(
  art: Buffer,
  skin: DailySkin,
  overlay: Buffer,
  extra: sharp.OverlayOptions[] = [],
  cacheKey = "poster",
): Promise<Buffer> {
  const bg = await modulatedBackdrop(art, skin, cacheKey);
  return sharp(bg).composite([{ input: overlay }, ...extra]).png({ compressionLevel: 8 }).toBuffer();
}

// ── coin logos: jsdelivr cryptocurrency-icons (spothq), cached on disk ──
// https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/{base}.svg
const logoCache = new Map<string, Buffer | null>(); // base → rasterized 160px PNG

export function baseAsset(symbol: string): string {
  const s = symbol.toUpperCase();
  for (const quote of ["USDT", "USDC", "BUSD", "FDUSD", "USD"]) {
    if (s.endsWith(quote) && s.length > quote.length) return s.slice(0, s.length - quote.length);
  }
  return s;
}

export async function loadCoinLogo(symbol: string): Promise<Buffer | null> {
  const base = baseAsset(symbol);
  if (logoCache.has(base)) return logoCache.get(base) ?? null;
  let result: Buffer | null = null;
  // 1) disk cache
  const diskPath = path.join(COINS_DIR, `${base}.svg`);
  try {
    const svg = await fs.readFile(diskPath);
    result = await rasterizeLogo(svg);
  } catch {
    // 2) remote fetch (3s cap — relay is fire-and-forget, never stall the tick)
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/${base.toLowerCase()}.svg`, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      if (res.ok) {
        const svg = Buffer.from(await res.arrayBuffer());
        result = await rasterizeLogo(svg);
        if (result) {
          await fs.mkdir(COINS_DIR, { recursive: true }).catch(() => undefined);
          await fs.writeFile(diskPath, svg).catch(() => undefined);
        }
      }
    } catch { /* offline / unknown coin → letter badge */ }
  }
  logoCache.set(base, result);
  return result;
}

async function rasterizeLogo(svg: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(svg, { density: 300 }).resize(160, 160).png().toBuffer();
  } catch {
    return null;
  }
}

// ── shared SVG fragments ──
// v10.20: DejaVu Sans Mono advance ≈ 0.602em — width estimates keep the three
// footer zones collision-free (the old fixed x=W/2 center collided with the
// brand line whenever the center text ran long — seen live on WIN cards:
// «LIVE ENGINEDONEST NUMBERS…», letter-spacing was the hidden multiplier).
const MONO_EM = 0.602;

function monoW(text: string, size: number, ls = 0): number {
  if (!text) return 0;
  return text.length * (size * MONO_EM + ls) - ls; // trailing letter-spacing is not drawn
}

/** v10.20 top-right timestamp chip — a dark scrim pill so the stamp stays
 * readable when the skin art behind it is bright (gold coins, neon halos). */
function tsChip(ts: string, baseline: number, size: number, ls = 2): string {
  if (!ts) return "";
  const w = monoW(ts, size, ls) + 26;
  const h = size + 18;
  return `<rect x="${(W - 40 - w).toFixed(0)}" y="${(baseline - size - 6).toFixed(0)}" width="${w.toFixed(0)}" height="${h}" rx="10" ry="10" fill="rgba(6,9,16,0.62)" stroke="rgba(138,160,148,0.2)" stroke-width="1"/>
  <text x="${W - 40 - 13}" y="${baseline}" font-family="DejaVu Sans Mono" font-size="${size}" fill="${INK}" text-anchor="end" letter-spacing="${ls}">${escXml(ts)}</text>`;
}

function hudTicks(accent: string): string {
  const t = 26, o = 20, len = 26, sw = 3;
  const corner = (x: number, y: number, dx: number, dy: number) =>
    `<path d="M ${x + dx * len} ${y} L ${x} ${y} L ${x} ${y + dy * len}" stroke="${accent}" stroke-width="${sw}" fill="none" opacity="0.85"/>`;
  return corner(o, t, 1, 1) + corner(W - o, t, -1, 1) + corner(o, H - t, 1, -1) + corner(W - o, H - t, -1, -1);
}

function footerBar(ts: string, center: string): string {
  const y = H - 62;
  const left = "FLOWRADAR-NEO LIVE ENGINE";
  const L = 40 + monoW(left, 21, 2) + 30;          // usable span for the center text
  const R = W - 40 - monoW(ts, 21) - 30;
  let shown = "";
  if (center) {
    shown = center;
    if (monoW(shown, 21, 2) > R - L) {
      // v10.20 auto-fit: truncate with ellipsis instead of colliding with the brand line
      while (shown.length > 4 && monoW(`${shown}…`, 21, 2) > R - L) shown = shown.slice(0, -1);
      shown = `${shown.trimEnd()}…`;
    }
  }
  const cx = Math.round((L + R) / 2);
  return `
  <rect x="0" y="${y}" width="${W}" height="62" fill="rgba(6,9,16,0.88)"/>
  <rect x="0" y="${y}" width="${W}" height="2" fill="${PANEL_STROKE}"/>
  <text x="40" y="${y + 39}" font-family="DejaVu Sans Mono" font-size="21" fill="${VIOLET}" letter-spacing="2">${left}</text>
  ${shown ? `<text x="${cx}" y="${y + 39}" font-family="DejaVu Sans Mono" font-size="21" fill="${MUTED}" text-anchor="middle" letter-spacing="2">${escXml(shown)}</text>` : ""}
  <text x="${W - 40}" y="${y + 39}" font-family="DejaVu Sans Mono" font-size="21" fill="${DIM}" text-anchor="end">${escXml(ts)}</text>`;
}

function gridPattern(): string {
  const lines: string[] = [];
  for (let x = 64; x < W; x += 64) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="rgba(138,160,148,0.05)" stroke-width="1"/>`);
  for (let y = 64; y < H; y += 64) lines.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(138,160,148,0.05)" stroke-width="1"/>`);
  return lines.join("");
}

function defs(status: BannerStatus, skin?: DailySkin, pulse = 0): string {
  const accent = STATUS_COLOR[status];
  const deep1 = skin?.deep1 ?? "#0b101c";
  const deep2 = skin?.deep2 ?? "#070a12";
  const haloAccent = skin?.accent ?? accent;
  const haloCx = skin ? [0.22, 0.78, 0.5][skin.geometry] : 0.22;
  const haloCy = skin ? [0.42, 0.35, 0.62][skin.geometry] : 0.42;
  return `<defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="rgba(6,9,16,0.94)"/>
      <stop offset="0.45" stop-color="rgba(6,9,16,0.82)"/>
      <stop offset="0.78" stop-color="rgba(6,9,16,0.30)"/>
      <stop offset="1" stop-color="rgba(6,9,16,0.12)"/>
    </linearGradient>
    <linearGradient id="topbar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${accent}"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bgdeep" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${deep1}"/>
      <stop offset="1" stop-color="${deep2}"/>
    </linearGradient>
    <radialGradient id="bghalo" cx="${haloCx}" cy="${haloCy}" r="0.85">
      <stop offset="0" stop-color="${haloAccent}" stop-opacity="0.18"/>
      <stop offset="1" stop-color="${haloAccent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="${(7 + 9 * pulse).toFixed(1)}" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="softglow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <linearGradient id="sweepbeam" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.26"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>`;
}

/** v10.21 MOTION LAYER — animated-card-only elements (phase 0..1 loop).
 * v10.20 shipped a pulse so faint it read as a static GIF (operator:
 * «هیچ موشنی ندارد») — the only deltas were blur 8→13 behind the headline
 * and a 3px bar's opacity. The fix is motion you cannot miss:
 *   · sonar rings — pings expanding from the coin badge (under text)
 *   · sweep beam — a diagonal light pass crossing the whole card (over all)
 *   · headline glow — 2.5× stronger breathing (7→16 blur)
 *   · bottom traveler — a bright segment physically crossing the footer
 * Traveling elements key off `phase` (monotonic 0→1) so the loop is
 * seamless: the sweep and traveler are fully off-canvas at both ends,
 * rings fade to zero opacity before restarting. Static cards never draw
 * this layer (phase undefined). Split under/over: rings sit behind the
 * typography, the sweep + traveler must land AFTER footerBar (the footer
 * rect would otherwise cover them). */
function ringsLayer(status: BannerStatus, phase: number): string {
  const accent = STATUS_COLOR[status];
  const ringR = (36 + phase * 264).toFixed(0);
  const ringOp = (0.5 * (1 - phase)).toFixed(3);
  return `
  <circle cx="108" cy="214" r="${ringR}" fill="none" stroke="${accent}" stroke-width="${(1 + 2.2 * (1 - phase)).toFixed(2)}" opacity="${ringOp}"/>
  <circle cx="108" cy="214" r="${(Number(ringR) * 0.62).toFixed(0)}" fill="none" stroke="${accent}" stroke-width="1.4" opacity="${(0.3 * (1 - phase)).toFixed(3)}"/>`;
}

function shineLayer(status: BannerStatus, phase: number): string {
  const accent = STATUS_COLOR[status];
  // sweep beam: rotate(-14°) rect traveling left→right, 240px wide,
  // taller than the card so the rotation never exposes corners
  const sweepX = -720 + phase * (W + 1440) - 120;
  const sweep = `
  <g transform="rotate(-14 ${W / 2} ${H / 2})">
    <rect x="${sweepX.toFixed(0)}" y="-240" width="240" height="${H + 480}" fill="url(#sweepbeam)"/>
  </g>`;
  // bottom traveler: bright segment crossing the footer bar, off-canvas at both ends
  const segX = -300 + phase * (W + 600);
  const traveler = `<rect x="${segX.toFixed(0)}" y="${H - 8}" width="300" height="3" fill="${accent}" opacity="0.9"/>`;
  return `${sweep}${traveler}`;
}

// ── v10.20 PRICE-LADDER STRIP (P1 upgrade) ─────────────────────────
// Structural trade anatomy drawn from the REAL signal row: SL / ENTRY / TP1-3
// with banked rungs rendered in gold. Deliberately NO live MARK on the
// artwork: the engine's coherent price lives in memory and marketAsset.price
// in the DB lags (Task 68 lesson) — a stale MARK on a rendered card would
// violate the honesty doctrine. reachedTp + the NET% line already tell the
// operator where the trade stands.
export interface LadderSpec {
  direction: "LONG" | "SHORT";
  entry: number;
  tp1: number;
  tp2: number;
  tp3: number;
  sl: number;
  reachedTp: number;
}

function fmtLadderPrice(p: number): string {
  return p >= 100 ? p.toFixed(2) : p.toFixed(p >= 1 ? 4 : 6);
}

function ladderStrip(l: LadderSpec): string {
  const vals = [l.sl, l.entry, l.tp1, l.tp2, l.tp3];
  if (vals.some((v) => !Number.isFinite(v) || v <= 0)) return "";
  // monotone guard — inverted/crossed ladders are skipped, never redrawn "fixed"
  const ok = l.direction === "LONG"
    ? l.sl < l.entry && l.entry < l.tp1 && l.tp1 < l.tp2 && l.tp2 < l.tp3
    : l.sl > l.entry && l.entry > l.tp1 && l.tp1 > l.tp2 && l.tp2 > l.tp3;
  if (!ok) return "";
  const x0 = 76, x1 = 590, railY = 592;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const X = (p: number) => x0 + ((p - lo) / span) * (x1 - x0);
  const levels: Array<{ p: number; name: string; col: string; banked: boolean; kind: "sl" | "entry" | "tp" }> = [
    { p: l.sl, name: "SL", col: DANGER, banked: false, kind: "sl" },
    { p: l.entry, name: "ENTRY", col: INK, banked: false, kind: "entry" },
    { p: l.tp1, name: "TP1", col: MINT, banked: l.reachedTp >= 1, kind: "tp" },
    { p: l.tp2, name: "TP2", col: MINT, banked: l.reachedTp >= 2, kind: "tp" },
    { p: l.tp3, name: "TP3", col: GOLD, banked: l.reachedTp >= 3, kind: "tp" },
  ];
  // label stagger — two rows keep close levels readable (mark near a rung, tight ladders)
  const sorted = [...levels].sort((a, b) => X(a.p) - X(b.p));
  const rowOf = new Map<string, number>();
  let lastX = -999, lastRow = 0;
  for (const lv of sorted) {
    const x = X(lv.p);
    const row = x - lastX < 64 ? (lastRow + 1) % 2 : 0;
    rowOf.set(lv.name, row);
    lastX = x;
    lastRow = row;
  }
  const bankedTp = l.reachedTp >= 3 ? l.tp3 : l.reachedTp >= 2 ? l.tp2 : l.reachedTp >= 1 ? l.tp1 : null;
  const seg = (a: number, b: number, col: string, wdt: number, op: number) =>
    a === b ? "" : `<line x1="${X(Math.min(a, b)).toFixed(1)}" y1="${railY}" x2="${X(Math.max(a, b)).toFixed(1)}" y2="${railY}" stroke="${col}" stroke-width="${wdt}" opacity="${op}" stroke-linecap="round"/>`;
  const segments = seg(l.entry, l.sl, DANGER, 5, 0.3) + seg(l.entry, l.tp3, MINT, 5, 0.22) + (bankedTp !== null ? seg(l.entry, bankedTp, GOLD, 6, 0.9) : "");
  const ticks = levels.map((lv) => {
    const x = X(lv.p);
    const xs = x.toFixed(1);
    const row = rowOf.get(lv.name) ?? 0;
    const nameY = railY - 16 - row * 16;
    const priceY = railY + 26 + row * 17;
    const mark = lv.kind === "entry"
      ? `<rect x="${(x - 5).toFixed(1)}" y="${railY - 5}" width="10" height="10" fill="${lv.col}" transform="rotate(45 ${xs} ${railY})" stroke="rgba(6,9,16,0.8)" stroke-width="1.5"/>`
      : lv.banked
        ? `<circle cx="${xs}" cy="${railY}" r="7" fill="${GOLD}" filter="url(#softglow)"/><path d="M ${(x - 3).toFixed(1)} ${railY} l 2.4 2.8 l 4 -5.4" stroke="#0b101c" stroke-width="1.8" fill="none" stroke-linecap="round"/>`
        : `<circle cx="${xs}" cy="${railY}" r="5" fill="rgba(6,9,16,0.85)" stroke="${lv.col}" stroke-width="2.2"/>`;
    return `<line x1="${xs}" y1="${railY - 9}" x2="${xs}" y2="${railY + 9}" stroke="${lv.col}" stroke-width="1.4" opacity="0.55"/>
    <text x="${xs}" y="${nameY}" font-family="DejaVu Sans Mono" font-size="14" fill="${lv.banked ? GOLD : lv.col}" text-anchor="middle" letter-spacing="1" font-weight="${lv.banked ? 700 : 400}">${lv.name}</text>
    <text x="${xs}" y="${priceY}" font-family="DejaVu Sans Mono" font-size="14.5" fill="${lv.banked ? GOLD : MUTED}" text-anchor="middle">${fmtLadderPrice(lv.p)}</text>
    ${mark}`;
  }).join("");
  return `
  <text x="40" y="552" font-family="DejaVu Sans Mono" font-size="15" fill="${MUTED}" letter-spacing="3">PRICE LADDER — BANKED IN GOLD</text>
  ${segments}
  <line x1="${x0 - 14}" y1="${railY}" x2="${x1 + 14}" y2="${railY}" stroke="rgba(138,160,148,0.3)" stroke-width="1"/>
  ${ticks}`;
}

// ── signal banner: art + scrim + badge + typography + live data ──
export interface BannerV2Spec {
  status: BannerStatus;
  /** e.g. "WLDUSDT LONG" */
  title: string;
  /** e.g. "NX-0007 · +25.6% NET" */
  line1?: string;
  /** e.g. "LADDER 2/3 BANKED · RR 1:2.8" */
  line2?: string;
  footer?: string;
  /** "2026-09-09 07:20 TEHRAN" */
  ts?: string;
  /** v10.20 structural price ladder (SL/ENTRY/TP1-3 + banked rungs) */
  ladder?: LadderSpec | null;
  /** v10.20 animation pulse 0..1 — modulates glow strength (animated cards) */
  pulse?: number;
  /** v10.21 loop position 0..1 — drives the motion layer (sweep/rings/traveler).
   * Undefined on static cards → the motion layer is never drawn. */
  phase?: number;
}

function bannerOverlaySvg(spec: BannerV2Spec, hasLogo: boolean, hasArt: boolean, skin?: DailySkin): string {
  const accent = STATUS_COLOR[spec.status];
  const pulse = spec.pulse ?? 0;
  const parts = spec.title.trim().split(/\s+/);
  const symbol = escXml(parts[0] ?? "");
  const direction = /SHORT/i.test(spec.title) ? "SHORT" : "LONG";
  const dirCol = direction === "LONG" ? MINT : DANGER;
  const dirArrow = direction === "LONG" ? "▲" : "▼";
  const base = baseAsset(symbol);
  const badgeCx = 108, badgeCy = 214, badgeR = 56;

  // data rows
  const rows: Array<{ text: string; col: string }> = [];
  if (spec.line1) rows.push({ text: spec.line1, col: accent });
  if (spec.line2) rows.push({ text: spec.line2, col: INK });

  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    ${defs(spec.status, skin, pulse)}
    ${hasArt ? "" : proceduralBackdrop(spec.status, skin)}
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#scrim)"/>
    <rect x="0" y="0" width="${W}" height="6" fill="url(#topbar)"/>
    <rect x="0" y="${H - 8}" width="${W}" height="3" fill="${accent}" opacity="${(0.45 + 0.35 * pulse).toFixed(2)}"/>
    ${spec.phase !== undefined ? ringsLayer(spec.status, spec.phase) : ""}
    ${hudTicks(accent)}
    <text x="40" y="52" font-family="DejaVu Sans" font-size="24" font-weight="700" fill="${MUTED}" letter-spacing="7">${BRAND_TERMINAL.head}${BRAND_TERMINAL.sep}${BRAND_TERMINAL.tail}</text>
    ${tsChip(spec.ts ?? "", 52, 22)}

    <!-- coin badge -->
    <circle cx="${badgeCx}" cy="${badgeCy}" r="${badgeR + 6}" fill="rgba(6,9,16,0.65)" stroke="${PANEL_STROKE}" stroke-width="2"/>
    <circle cx="${badgeCx}" cy="${badgeCy}" r="${badgeR}" fill="rgba(255,255,255,0.04)" stroke="${accent}" stroke-width="3"/>
    ${hasLogo ? "" : `<text x="${badgeCx}" y="${badgeCy + 16}" font-family="DejaVu Sans" font-size="40" font-weight="700" fill="${INK}" text-anchor="middle">${escXml(base.slice(0, 3))}</text>`}

    <!-- symbol + direction -->
    <text x="196" y="200" font-family="DejaVu Sans" font-size="52" font-weight="700" fill="${INK}" letter-spacing="1">${symbol}</text>
    <rect x="196" y="222" rx="17" ry="17" width="168" height="34" fill="${dirCol}" opacity="0.16"/>
    <text x="212" y="247" font-family="DejaVu Sans Mono" font-size="24" font-weight="700" fill="${dirCol}" letter-spacing="3">${dirArrow} ${direction}</text>

    <!-- status headline -->
    <text x="38" y="372" font-family="DejaVu Sans" font-size="104" font-weight="700" fill="${accent}" filter="url(#glow)" letter-spacing="2">${escXml(STATUS_TEXT[spec.status])}</text>

    <!-- separator + data rows -->
    <rect x="40" y="410" width="560" height="2" fill="rgba(138,160,148,0.25)"/>
    ${rows.map((r, i) => `<text x="40" y="${462 + i * 48}" font-family="DejaVu Sans Mono" font-size="32" fill="${r.col}" letter-spacing="1" filter="url(#softglow)">${escXml(r.text)}</text>`).join("")}

    ${spec.ladder ? ladderStrip(spec.ladder) : ""}

    ${footerBar(spec.ts ?? "", spec.footer ?? "HONEST NUMBERS FROM THE LIVE ENGINE")}
    ${spec.phase !== undefined ? shineLayer(spec.status, spec.phase) : ""}
  </svg>`;
}

function proceduralBackdrop(status: BannerStatus, skin?: DailySkin): string {
  const accent = STATUS_COLOR[status];
  const halo = skin?.accent ?? accent;
  const gx = skin ? [W - 240, 240, W / 2][skin.geometry] : W - 240;
  const gy = skin ? [H / 2 - 60, H / 2 + 40, H / 2][skin.geometry] : H / 2 - 60;
  return `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#bgdeep)"/>
  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#bghalo)"/>
  ${gridPattern()}
  <circle cx="${gx}" cy="${gy}" r="230" fill="${halo}" opacity="0.06"/>
  <circle cx="${gx}" cy="${gy}" r="150" fill="${halo}" opacity="0.06"/>`;
}

/** v2 signal banner → PNG buffer (1280×720). Throws only if sharp itself
 * fails — callers keep the pixel-font banner as the final fallback.
 * v9.5 (operator mandate: the artwork must MATCH the card — new LONG, SHORT,
 * TP, STOP, …): kind-specific skin art skin-{key}-{KIND}.png is PRIMARY, then
 * the generic day skin, then the legacy status art. The kind subject carries
 * the card's meaning INSIDE the day's style; the status-colored headline and
 * accents still tell outcomes apart. */
export async function renderSignalBannerV2(spec: BannerV2Spec): Promise<Buffer> {
  const skin = dailySkin(); // v9.4 daily style rotation — the day's skin dresses every card
  const logo = await loadCoinLogo(spec.title.split(/\s+/)[0] ?? "");
  // AFTERLIFE reuses the EXPIRED artwork — post-expiry verdicts ARE expired
  // signals reporting back; the spectral headline + accents tell them apart.
  const legacyArt = await loadArt(
    spec.status === "SHORT" ? "SHORT" : spec.status === "FULL" ? "FULL" : spec.status === "AFTERLIFE" ? "EXPIRED" : spec.status,
  );
  const kind = kindForStatus(spec.status);
  const kindArt = await loadSkinKindArt(skin.key, kind);
  const skinArt = kindArt ?? (await loadSkinArt(skin.key));
  const backdrop = skinArt ?? legacyArt;
  const overlay = Buffer.from(bannerOverlaySvg(spec, Boolean(logo), Boolean(backdrop), skin));

  const composites: sharp.OverlayOptions[] = [{ input: overlay }];
  if (logo) composites.push({ input: await sharp(logo).resize(88, 88).png().toBuffer(), left: 108 - 44, top: 214 - 44 });

  if (backdrop) {
    if (skinArt) {
      // kind skin art primary — skin.tune modulation keeps the day's style identity readable
      // cacheKey = the exact art file behind skinArt (kind file or generic fallback)
      const cacheKey = `card:${skin.key}:${kindArt ? kind : "generic"}`;
      return withBackdrop(skinArt, skin, overlay, composites.slice(1), cacheKey);
    }
    const bg = await sharp(legacyArt as Buffer).resize(W, H, { fit: "cover" }).modulate({ brightness: 0.78, saturation: 0.88, hue: skin.hueShift }).toBuffer();
    return sharp(bg).composite(composites).png({ compressionLevel: 8 }).toBuffer();
  }
  return sharp(overlay).composite(composites.slice(1)).png({ compressionLevel: 8 }).toBuffer();
}

// ── daily performance poster ──
function fmtUsd(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function statCard(x: number, y: number, w: number, h: number, label: string, value: string, col: string, accentBorder = false): string {
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" ry="14" fill="${PANEL_BG}" stroke="${accentBorder ? col : PANEL_STROKE}" stroke-width="${accentBorder ? 2 : 1}"/>
  <text x="${x + 20}" y="${y + 34}" font-family="DejaVu Sans Mono" font-size="19" fill="${MUTED}" letter-spacing="3">${escXml(label)}</text>
  <text x="${x + 20}" y="${y + 78}" font-family="DejaVu Sans" font-size="36" font-weight="700" fill="${col}">${escXml(value)}</text>`;
}

function miniStat(x: number, y: number, w: number, h: number, label: string, value: string, col: string): string {
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" ry="12" fill="${PANEL_BG}" stroke="${PANEL_STROKE}" stroke-width="1"/>
  <text x="${x + 16}" y="${y + 28}" font-family="DejaVu Sans Mono" font-size="16" fill="${MUTED}" letter-spacing="2">${escXml(label)}</text>
  <text x="${x + w - 16}" y="${y + 46}" font-family="DejaVu Sans" font-size="30" font-weight="700" fill="${col}" text-anchor="end">${escXml(value)}</text>`;
}

function winRateRing(cx: number, cy: number, r: number, pct: number | null): string {
  const C = 2 * Math.PI * r;
  const frac = pct === null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
  const col = pct === null ? MUTED : pct >= 50 ? MINT : pct >= 35 ? AMBER : DANGER;
  const label = pct === null ? "—" : `${Math.round(pct)}%`;
  return `
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(10,14,22,0.55)" stroke="${PANEL_STROKE}" stroke-width="1"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="15"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="15" stroke-linecap="round"
    stroke-dasharray="${(frac * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})" filter="url(#softglow)"/>
  <text x="${cx}" y="${cy + 6}" font-family="DejaVu Sans" font-size="40" font-weight="700" fill="${col}" text-anchor="middle">${label}</text>
  <text x="${cx}" y="${cy + 34}" font-family="DejaVu Sans Mono" font-size="15" fill="${MUTED}" text-anchor="middle" letter-spacing="2">WIN RATE</text>`;
}

export interface DailyPosterSpec {
  digest: DailyDigest;
  ts?: string;
  /** v10.20 — "weekly" re-dresses the same digest as the weekly report */
  variant?: "daily" | "weekly";
}

/** v10.20 EQUITY SPARKLINE — real 14-day realized-equity walk from the DB
 * (dailyReport.equityCurve), last point = live equity mark. Feeds the
 * top-right panel of the daily/weekly poster. */
function sparkline(curve: number[], x: number, y: number, w: number, h: number): string {
  const pts = curve.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return "";
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const span = hi - lo || Math.max(1, Math.abs(hi) * 0.02);
  const px = (i: number) => x + 14 + (i / (pts.length - 1)) * (w - 28);
  const py = (v: number) => y + h - 18 - ((v - lo) / span) * (h - 40);
  const line = pts.map((v, i) => `${i === 0 ? "M" : "L"} ${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ");
  const area = `${line} L ${px(pts.length - 1).toFixed(1)} ${(y + h - 12).toFixed(1)} L ${px(0).toFixed(1)} ${(y + h - 12).toFixed(1)} Z`;
  const up = pts[pts.length - 1]! >= pts[0]!;
  const col = up ? MINT : DANGER;
  return `
  <path d="${area}" fill="${col}" opacity="0.10"/>
  <path d="${line}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" filter="url(#softglow)"/>
  <circle cx="${px(pts.length - 1).toFixed(1)}" cy="${py(pts[pts.length - 1]!).toFixed(1)}" r="4" fill="${col}" filter="url(#softglow)"/>`;
}

function posterOverlaySvg(spec: DailyPosterSpec, hasArtBackdrop: boolean, skin?: DailySkin): string {
  const d = spec.digest;
  const netCol = d.realizedUsd >= 0 ? MINT : DANGER;
  const weekly = spec.variant === "weekly";
  const trades = (d.trades ?? []).slice(0, 5);
  const maxAbs = Math.max(0.5, ...trades.map((t) => Math.abs(t.pnl)));

  const cards: Array<[string, string, string, boolean?]> = [
    [weekly ? "NET 7D" : "NET 24H", fmtUsd(d.realizedUsd), netCol, true],
    ["EQUITY", `$${d.equityUsd.toFixed(2)}`, INK],
    ["OPEN PNL", fmtUsd(d.unrealizedUsd), d.unrealizedUsd >= 0 ? MINT : DANGER],
    ["FEES", `−$${d.feesUsd.toFixed(2)}`, MUTED],
  ];
  const cardW = 268, gap = 24, x0 = 40;
  const cardsSvg = cards.map(([label, value, col, hero], i) =>
    statCard(x0 + i * (cardW + gap), 196, cardW, 118, label, value, col, Boolean(hero))
  ).join("");

  const minis: Array<[string, string, string]> = [
    ["DEPLOYED", String(d.opened), INK],
    ["CLOSED", String(d.closed), INK],
    ["ACTIVE NOW", String(d.active), VIOLET],
    ["WINS", String(d.wins), MINT],
    ["STOPS", String(d.stops), DANGER],
    ["EXPIRED", String(d.expired), AMBER],
  ];
  const mw = 256, mg = 16, mx0 = 440;
  const minisSvg = minis.map(([label, value, col], i) => {
    const cx = mx0 + (i % 3) * (mw + mg);
    const cy = 360 + Math.floor(i / 3) * 86;
    return miniStat(cx, cy, mw, 72, label, value, col);
  }).join("");

  // trade bars (compact rows — must clear the footer bar at y=658)
  const barRows = trades.map((t, i) => {
    const y = 552 + i * 21;
    const w = Math.max(6, (Math.abs(t.pnl) / maxAbs) * 300);
    const col = t.pnl >= 0 ? MINT : DANGER;
    const sign = t.pnl >= 0 ? "+" : "";
    return `
    <text x="440" y="${y + 14}" font-family="DejaVu Sans Mono" font-size="16" fill="${MUTED}">${escXml(t.symbol)}</text>
    <rect x="580" y="${y + 2}" width="${w.toFixed(0)}" height="14" rx="7" ry="7" fill="${col}" opacity="0.85"/>
    <text x="${(580 + w + 10).toFixed(0)}" y="${y + 14}" font-family="DejaVu Sans Mono" font-size="16" fill="${col}">${sign}${t.pnl.toFixed(1)}%</text>`;
  }).join("");

  const bestLine = d.best ? `BEST ${d.best.symbol} +${d.best.pnl.toFixed(1)}%` : "NO CLOSED TRADES YET";
  const volLine = d.volCauseCaptures > 0 ? `VOL-CAUSE ${d.volCauseCaptures}${d.topCause ? ` · ${d.topCause}` : ""}` : "";

  // v10.20 equity sparkline panel — top-right, beside the headline. Panel x=864
  // clears the auto-fit headlines (daily 60px / weekly 54px — DejaVu Bold caps
  // run ≈0.72em, measured off the live render where 64px ran under the panel).
  const curve = (d.equityCurve ?? []).filter((v) => Number.isFinite(v));
  const sparkPanel = curve.length >= 2 ? `
  <rect x="864" y="76" width="380" height="100" rx="14" ry="14" fill="${PANEL_BG}" stroke="${PANEL_STROKE}" stroke-width="1"/>
  <text x="880" y="100" font-family="DejaVu Sans Mono" font-size="13" fill="${MUTED}" letter-spacing="2">EQUITY 14D · REALIZED + LIVE</text>
  <text x="1228" y="100" font-family="DejaVu Sans" font-size="16" font-weight="700" fill="${INK}" text-anchor="end">$${d.equityUsd.toFixed(2)}</text>
  ${sparkline(curve, 864, 76, 380, 100)}` : "";

  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    ${defs("WIN", skin)}
    ${hasArtBackdrop ? "" : proceduralBackdrop("WIN", skin)}
    <rect x="0" y="0" width="${W}" height="${H}" fill="rgba(6,9,16,0.90)"/>
    <rect x="0" y="0" width="${W}" height="6" fill="url(#topbar)"/>
    ${hudTicks(weekly ? VIOLET : GOLD)}
    <text x="40" y="56" font-family="DejaVu Sans" font-size="24" font-weight="700" fill="${MUTED}" letter-spacing="7">${BRAND_TERMINAL.head}${BRAND_TERMINAL.sep}${BRAND_TERMINAL.tail}</text>
    ${tsChip(spec.ts ?? "", 56, 21)}
    <text x="40" y="140" font-family="DejaVu Sans" font-size="${weekly ? 54 : 60}" font-weight="700" fill="${weekly ? VIOLET : GOLD}" filter="url(#glow)" letter-spacing="2">${weekly ? "WEEKLY PERFORMANCE" : "DAILY PERFORMANCE"}</text>
    <text x="40" y="176" font-family="DejaVu Sans Mono" font-size="22" fill="${MUTED}" letter-spacing="1">${escXml(d.windowLabel)}${skin ? `  ·  SKIN ${skin.name}` : ""}</text>
    ${sparkPanel}
    ${cardsSvg}
    ${winRateRing(230, 500, 108, d.winRatePct)}
    ${minisSvg}
    <text x="440" y="540" font-family="DejaVu Sans Mono" font-size="17" fill="${MUTED}" letter-spacing="3">CLOSED TRADES — NET %</text>
    ${barRows}
    <text x="1240" y="540" font-family="DejaVu Sans Mono" font-size="17" fill="${MINT}" text-anchor="end" letter-spacing="1">${escXml(bestLine)}</text>
    ${footerBar(spec.ts ?? "", volLine || "HONEST NUMBERS FROM THE LIVE ENGINE")}
  </svg>`;
}

/** Daily performance poster → PNG (1280×720). v9.4 7-SKIN CYCLE: the AI-
 * generated style backdrop skin-{key}.png is primary (operator mandate — the
 * skin cycle drives real image generation), then the legacy art-DAILY piece,
 * then the procedural skin gradient. Throws only on sharp failure. */
export async function renderDailyPoster(spec: DailyPosterSpec): Promise<Buffer> {
  const skin = dailySkin();
  const art = (await loadSkinArt(skin.key)) ?? (await loadArt("DAILY"));
  const svg = Buffer.from(posterOverlaySvg(spec, Boolean(art), skin));
  if (art) return withBackdrop(art, skin, svg, [], `poster:${skin.key}`);
  return sharp(svg).png({ compressionLevel: 8 }).toBuffer();
}

/** v10.20 WEEKLY PERFORMANCE POSTER — same honest digest pipeline, 7-day
 * window, violet identity. Fed by buildWeeklyDigest() via
 * /api/report/weekly (once per Iranian week, daily-scheduler driven). */
export async function renderWeeklyPoster(spec: Omit<DailyPosterSpec, "variant">): Promise<Buffer> {
  return renderDailyPoster({ ...spec, variant: "weekly" });
}
