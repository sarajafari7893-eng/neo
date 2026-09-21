// ── PREVIEW: "دیتامحور مینیمال" SIGNAL banners ──────────────────────────────
// Operator round 2026-09-09: «نمونه برای سیگنال هم بفرست».
// Companion to the minimal daily poster — same design language (flat ink,
// hairlines, mono data grid, real price-proportion ladder). Renders TWO real
// signal rows from the live DB: the latest TP* win and the latest SL stop.
// Read-only — does NOT touch the relay, cron, or the v8.1 art pipeline.
//
// Run:  cd /home/z/my-project && bun scripts/render-signal-minimal.mts

import { db } from "../src/lib/db";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";

const W = 1280;
const H = 720;

const BG = "#0A0D12";
const INK = "#E8EDF2";
const MUTED = "#6B7683";
const DIM = "#454F5B";
const HAIR = "rgba(232,237,242,0.10)";
const UP = "#2EE6A8";
const DOWN = "#FF5262";
const AMBER = "#FFB347";
const COINS_DIR = path.join(process.cwd(), "assets", "coins");

const MONO = "DejaVu Sans Mono";
const SANS = "DejaVu Sans";

type Row = {
  symbol: string; direction: string; entryPrice: number; entryZoneLow: number; entryZoneHigh: number;
  tp1: number; tp2: number; tp3: number; stopLoss: number; initialStopLoss: number | null;
  leverage: number; marginUsd: number; confidence: number; riskReward: number; timeframe: string;
  strategy: string; status: string; reachedTp: number; pnlPercent: number; serial: number;
  createdAt: Date; closedAt: Date | null;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const baseAsset = (symbol: string) => {
  const s = symbol.toUpperCase();
  for (const q of ["USDT", "USDC", "USD"]) if (s.endsWith(q) && s.length > q.length) return s.slice(0, -q.length);
  return s;
};
const fmtPrice = (p: number) => (p >= 100 ? p.toFixed(2) : p.toFixed(p >= 1 ? 4 : 6));
const money = (v: number) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;

function tehranStamp(d: Date): string {
  return `${new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", month: "short", day: "2-digit",
  }).format(d)} · ${new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d)}`;
}

function outcome(row: Row): { headline: string; col: string; suffix: string } {
  if (row.status === "TP1" || row.status === "TP2" || row.status === "TP3")
    return { headline: `${row.status} BANKED`, col: UP, suffix: "" };
  if (row.status === "SL") return { headline: "STOPPED", col: DOWN, suffix: "" };
  if (row.status === "EXPIRED" && row.reachedTp >= 1)
    return { headline: `TP${row.reachedTp} PROVEN`, col: UP, suffix: "· EXPIRED (TTL)" };
  if (row.status === "EXPIRED") return { headline: "EXPIRED", col: AMBER, suffix: "" };
  return { headline: row.status.toUpperCase(), col: INK, suffix: "" };
}

// price ladder positioned by REAL price proportions (works for LONG & SHORT —
// monotonic mapping riskAnchor→0, tp3→1). riskAnchor = the ORIGINAL stop
// (initialStopLoss) — the live stop often rides at breakeven after TP1, which
// would collapse the ladder onto the entry.
function ladder(row: Row, col: string, provedCol: string): string {
  const y = 545, x0 = 80, x1 = 1200;
  const anchor = row.initialStopLoss ?? row.stopLoss;
  const lo = Math.min(anchor, row.tp3);
  const hi = Math.max(anchor, row.tp3);
  const P = (price: number) => x0 + ((price - lo) / (hi - lo)) * (x1 - x0);
  const proved = row.reachedTp;
  const tps = [row.tp1, row.tp2, row.tp3];

  // proven-progress shading: entry → furthest proven TP (win) or stop (loss)
  let shade = "";
  if (proved >= 1) {
    const a = Math.min(P(row.entryPrice), P(tps[proved - 1]!));
    const b = Math.max(P(row.entryPrice), P(tps[proved - 1]!));
    shade = `<rect x="${a.toFixed(1)}" y="${y - 2}" width="${(b - a).toFixed(1)}" height="4" fill="${provedCol}" opacity="0.9"/>`;
  } else if (row.status === "SL") {
    const a = Math.min(P(row.entryPrice), P(anchor));
    const b = Math.max(P(row.entryPrice), P(anchor));
    shade = `<rect x="${a.toFixed(1)}" y="${y - 2}" width="${(b - a).toFixed(1)}" height="4" fill="${DOWN}" opacity="0.9"/>`;
  }

  const clampX = (x: number) => Math.max(70, Math.min(x, 1214));
  const tpTicks = tps
    .map((p, i) => {
      const x = clampX(P(p));
      const filled = i + 1 <= proved;
      const ly = y - (i === 1 ? 46 : 22); // stagger middle rung to avoid right-edge collisions
      return `
    <circle cx="${x.toFixed(1)}" cy="${y}" r="8" fill="${filled ? provedCol : BG}" stroke="${provedCol}" stroke-width="2.5"/>
    <text x="${x.toFixed(1)}" y="${ly}" font-family="${MONO}" font-size="15" fill="${filled ? provedCol : MUTED}" text-anchor="middle">TP${i + 1} ${fmtPrice(p)}</text>`;
    })
    .join("");

  // live stop marker (amber ring) — only when it differs from the anchor
  const beMoved = Math.abs(row.stopLoss - anchor) > (hi - lo) * 0.01;
  const beTick = beMoved
    ? `
    <circle cx="${clampX(P(row.stopLoss)).toFixed(1)}" cy="${y}" r="7" fill="BG" stroke="${AMBER}" stroke-width="2.5"/>
    <text x="${clampX(P(row.stopLoss)).toFixed(1)}" y="${y + 34}" font-family="${MONO}" font-size="14" fill="${AMBER}" text-anchor="middle">STOP NOW ${fmtPrice(row.stopLoss)}</text>`
    : "";

  return `
  <text x="48" y="470" font-family="${MONO}" font-size="15" fill="${MUTED}" letter-spacing="3">PRICE LADDER · STOP → TP3 · REAL PROPORTIONS</text>
  <text x="1232" y="470" font-family="${MONO}" font-size="15" fill="${col}" text-anchor="end" letter-spacing="1">NET ${row.pnlPercent >= 0 ? "+" : ""}${row.pnlPercent.toFixed(1)}%${proved >= 1 ? ` · ${proved}/3 RUNGS` : ""}</text>
  <line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${HAIR}" stroke-width="2"/>
  ${shade}
  ${tpTicks}
  <circle cx="${clampX(P(anchor)).toFixed(1)}" cy="${y}" r="7" fill="${DOWN}"/>
  <text x="${clampX(P(anchor)).toFixed(1)}" y="${y + 34}" font-family="${MONO}" font-size="15" fill="${DOWN}" text-anchor="middle">STOP ${fmtPrice(anchor)}</text>
  ${beTick}
  <circle cx="${clampX(P(row.entryPrice)).toFixed(1)}" cy="${y}" r="6" fill="${INK}"/>
  <text x="${clampX(P(row.entryPrice)).toFixed(1)}" y="${y - 22}" font-family="${MONO}" font-size="15" fill="${INK}" text-anchor="middle">ENTRY ${fmtPrice(row.entryPrice)}</text>`;
}

async function bannerSvg(row: Row, logoPath: string | null): Promise<string> {
  const { headline, col, suffix } = outcome(row);
  const dirCol = row.direction === "SHORT" ? DOWN : UP;
  const base = baseAsset(row.symbol);
  const serial = `NX-${String(row.serial).padStart(4, "0")}`;

  const stopVal = row.initialStopLoss !== null && Math.abs(row.initialStopLoss - row.stopLoss) > 1e-9
    ? `$${fmtPrice(row.stopLoss)} · init $${fmtPrice(row.initialStopLoss)}`
    : `$${fmtPrice(row.stopLoss)}`;
  const rungs = [1, 2, 3].map((i) => `TP${i} ${i <= row.reachedTp ? "✓" : "—"}`).join("  ");
  const rows: Array<[string, string, string]> = [
    ["ENTRY", `$${fmtPrice(row.entryPrice)}`, INK],
    ["ZONE", `$${fmtPrice(row.entryZoneLow)} – $${fmtPrice(row.entryZoneHigh)}`, INK],
    ["STOP", stopVal, DOWN],
    ["RISK", `1:${row.riskReward.toFixed(1)} · ${row.leverage}x · $${row.marginUsd.toFixed(0)}`, INK],
    ["NET", `${row.pnlPercent >= 0 ? "+" : "−"}${Math.abs(row.pnlPercent).toFixed(1)}% (${money((row.marginUsd * row.pnlPercent) / 100)})`, col],
    ["LADDER", rungs, row.reachedTp >= 1 ? UP : MUTED],
  ];
  const grid = rows
    .map(([label, value, vcol], i) => {
      const y = 150 + i * 42;
      return `
    <text x="700" y="${y}" font-family="${MONO}" font-size="15" fill="${DIM}" letter-spacing="3">${label}</text>
    <text x="1232" y="${y + 1}" font-family="${MONO}" font-size="21" fill="${vcol}" text-anchor="end">${esc(value)}</text>
    ${i < rows.length - 1 ? `<line x1="700" y1="${y + 20}" x2="1232" y2="${y + 20}" stroke="rgba(232,237,242,0.05)" stroke-width="1"/>` : ""}`;
    })
    .join("");

  const logoSvg = logoPath
    ? ""
    : `<circle cx="80" cy="160" r="32" fill="rgba(255,255,255,0.03)" stroke="${HAIR}" stroke-width="1.5"/>
       <text x="80" y="168" font-family="${SANS}" font-size="22" font-weight="700" fill="${INK}" text-anchor="middle">${esc(base.slice(0, 4))}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect x="0" y="0" width="${W}" height="3" fill="${col}"/>

  <text x="48" y="70" font-family="${SANS}" font-size="19" font-weight="700" fill="${MUTED}" letter-spacing="7">NEXUS//SIGNALS</text>
  <text x="1232" y="70" font-family="${MONO}" font-size="17" fill="${DIM}" text-anchor="end" letter-spacing="1">${esc(serial)} · ${esc(tehranStamp(row.closedAt ?? row.createdAt))} TEHRAN</text>

  <!-- identity -->
  ${logoSvg}
  <text x="136" y="176" font-family="${SANS}" font-size="54" font-weight="700" fill="${INK}">${esc(row.symbol)}</text>
  <rect x="136" y="198" width="156" height="34" fill="${dirCol}" opacity="0.14"/>
  <text x="214" y="221" font-family="${MONO}" font-size="18" font-weight="700" fill="${dirCol}" text-anchor="middle" letter-spacing="2">${row.direction === "SHORT" ? "▼" : "▲"} ${esc(row.direction)}</text>

  <text x="48" y="338" font-family="${SANS}" font-size="80" font-weight="700" fill="${col}" letter-spacing="1">${esc(headline)}</text>
  <text x="48" y="380" font-family="${MONO}" font-size="18" fill="${MUTED}" letter-spacing="2">${esc(row.strategy.toUpperCase())} · ${esc(row.timeframe.toUpperCase())} · CONF ${row.confidence}% · MARGIN $${row.marginUsd.toFixed(0)}${suffix ? ` ${esc(suffix)}` : ""}</text>

  <!-- data grid -->
  ${grid}

  <!-- price ladder -->
  ${ladder(row, col, UP)}

  <line x1="48" y1="668" x2="1232" y2="668" stroke="${HAIR}" stroke-width="1"/>
  <text x="48" y="696" font-family="${MONO}" font-size="14" fill="${DIM}" letter-spacing="2">NEXUS-AI LIVE ENGINE · HONEST NUMBERS FROM SETTLED ROWS</text>
  <text x="1232" y="696" font-family="${MONO}" font-size="14" fill="${DIM}" text-anchor="end">v8.0 · ${esc(row.direction)} · RR 1:${row.riskReward.toFixed(1)}</text>
</svg>`;
}

async function renderOne(row: Row, out: string): Promise<void> {
  const base = baseAsset(row.symbol);
  let logoPath: string | null = null;
  try {
    await fs.access(path.join(COINS_DIR, `${base}.svg`));
    logoPath = path.join(COINS_DIR, `${base}.svg`);
  } catch { /* letter badge fallback */ }

  const svg = Buffer.from(await bannerSvg(row, logoPath));
  const composites: sharp.OverlayOptions[] = [];
  if (logoPath) {
    const logo = await sharp(logoPath, { density: 300 }).resize(64, 64).png().toBuffer();
    composites.push({ input: logo, left: 80 - 32, top: 160 - 32 });
  }
  await sharp(svg).composite(composites).png({ compressionLevel: 9 }).toFile(out);
  console.log("RENDERED", out, `→ ${row.symbol} ${row.direction} ${row.status} NET ${row.pnlPercent.toFixed(1)}%`);
}

async function main(): Promise<void> {
  // engine "win" = proven-TP rung (reachedTp>=1) — final status is often
  // EXPIRED/SL (ladder banked, then TTL). Prefer a clean TP* row, else the
  // best proven-TP row by NET%.
  const win =
    (await db.signal.findFirst({ where: { status: { in: ["TP1", "TP2", "TP3"] } }, orderBy: { closedAt: "desc" } })) ??
    (await db.signal.findFirst({ where: { reachedTp: { gte: 1 } }, orderBy: [{ pnlPercent: "desc" }, { closedAt: "desc" }] }));
  const stop = await db.signal.findFirst({ where: { status: "SL" }, orderBy: { closedAt: "desc" } });

  if (win) await renderOne(win as unknown as Row, "/home/z/my-project/download/SIGNAL-minimal-win.png");
  else console.log("no proven-TP row found — skipped win banner");

  if (stop) await renderOne(stop as unknown as Row, "/home/z/my-project/download/SIGNAL-minimal-stop.png");
  else console.log("no SL row found — skipped stop banner");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("RENDER FAILED:", e);
    process.exit(1);
  });
