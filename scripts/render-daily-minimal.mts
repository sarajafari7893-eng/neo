// ── PREVIEW: "دیتامحور مینیمال" (minimal data-driven) DAILY poster ──────────
// Operator round 2026-09-09: «مدل دیتامحور مینیمال رو بفرست تا ببینم».
// Standalone preview only — does NOT touch the live relay, the v8.1 artwork
// pipeline, or the DB (read-only queries). Every number comes from the REAL
// digest rows via buildDailyDigest(); the sparkline is the cumulative
// SETTLED net PNL through the 24h window (start $0.00 → end = realizedUsd).
//
// Run:  cd /home/z/my-project && bun scripts/render-daily-minimal.mts

import { buildDailyDigest } from "../src/lib/dailyReport";
import { db } from "../src/lib/db";
import { ACCOUNT_START_USD } from "../src/lib/accounting";
import sharp from "sharp";
import fs from "node:fs/promises";

const W = 1280;
const H = 720;

// minimal data-ink palette — grayscale + two semantic colors only
const BG = "#0A0D12";
const INK = "#E8EDF2";
const MUTED = "#6B7683";
const DIM = "#454F5B";
const HAIR = "rgba(232,237,242,0.10)";
const UP = "#2EE6A8";
const DOWN = "#FF5262";
const AMBER = "#FFB347";
const GRAY = "#39424E";

const MONO = "DejaVu Sans Mono";
const SANS = "DejaVu Sans";

const money = (v: number) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function tehranStamp(d: Date): string {
  return `${new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year: "numeric", month: "short", day: "2-digit",
  }).format(d)} · ${new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d)} TEHRAN`;
}

// ── settled net-PNL curve through the window (real rows only) ───────────────
async function settledCurve(): Promise<{ pts: Array<{ t: number; v: number }>; note: string | null }> {
  const since = Date.now() - 24 * 3600_000;
  const settled = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];
  const inWin = await db.signal.findMany({
    where: { closedAt: { gte: new Date(since) }, status: { in: settled } },
    select: { closedAt: true, marginUsd: true, pnlPercent: true },
    orderBy: { closedAt: "asc" },
  });
  const pts: Array<{ t: number; v: number }> = [{ t: since, v: 0 }];
  let cum = 0;
  for (const s of inWin) {
    cum += (s.marginUsd * s.pnlPercent) / 100;
    pts.push({ t: s.closedAt!.getTime(), v: cum });
  }
  pts.push({ t: Date.now(), v: cum });
  return { pts, note: inWin.length === 0 ? "NO SETTLED TRADES IN THIS WINDOW" : null };
}

// disjoint final-status counts for the outcomes bar (proven-TP wins in the
// digest can overlap with final SL — a TP1-then-SL trade counts as both, so
// the stacked bar must partition by FINAL status instead)
async function finalStatusCounts(since: number): Promise<{ tp: number; sl: number; exp: number; other: number }> {
  const rows = await db.signal.findMany({
    where: { closedAt: { gte: new Date(since) }, status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
    select: { status: true },
  });
  const c = { tp: 0, sl: 0, exp: 0, other: 0 };
  for (const r of rows) {
    if (r.status === "TP1" || r.status === "TP2" || r.status === "TP3") c.tp++;
    else if (r.status === "SL") c.sl++;
    else if (r.status === "EXPIRED") c.exp++;
    else c.other++;
  }
  return c;
}

// life realized before window → baseline equity check (kept for footer honesty)
async function lifeRealizedBefore(since: number): Promise<number> {
  const settled = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];
  const rows = await db.signal.findMany({
    where: { closedAt: { lt: new Date(since) }, status: { in: settled } },
    select: { marginUsd: true, pnlPercent: true },
  });
  return rows.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
}

// ── sparkline (flat, honest, no glow) ───────────────────────────────────────
function sparkline(pts: Array<{ t: number; v: number }>, x0: number, x1: number, y0: number, y1: number, col: string): string {
  const t0 = pts[0]!.t, t1 = pts[pts.length - 1]!.t;
  const vs = pts.map((p) => p.v);
  let lo = Math.min(0, ...vs), hi = Math.max(0, ...vs);
  if (hi - lo < 0.5) { lo -= 0.5; hi += 0.5; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const X = (t: number) => x0 + ((t - t0) / Math.max(1, t1 - t0)) * (x1 - x0);
  const Y = (v: number) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L ${X(t1).toFixed(1)} ${Y(lo).toFixed(1)} L ${X(t0).toFixed(1)} ${Y(lo).toFixed(1)} Z`;
  const zeroY = Y(0).toFixed(1);
  const end = pts[pts.length - 1]!;
  return `
  <line x1="${x0}" y1="${zeroY}" x2="${x1}" y2="${zeroY}" stroke="${HAIR}" stroke-width="1" stroke-dasharray="3 5"/>
  <path d="${area}" fill="${col}" opacity="0.07"/>
  <path d="${line}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${X(end.t).toFixed(1)}" cy="${Y(end.v).toFixed(1)}" r="4" fill="${col}"/>`;
}

// ── poster ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const d = await buildDailyDigest();
  const since = Date.now() - 24 * 3600_000;
  const [{ pts, note }, lifeBefore] = await Promise.all([settledCurve(), lifeRealizedBefore(since)]);

  const netCol = d.realizedUsd >= 0 ? UP : DOWN;
  const wrCol = d.winRatePct === null ? MUTED : d.winRatePct >= 50 ? UP : d.winRatePct >= 35 ? AMBER : DOWN;
  const stamp = tehranStamp(new Date());

  // outcomes stacked bar — DISJOINT final-status buckets
  const closed = d.closed;
  const fc = await finalStatusCounts(since);
  const others = fc.other;
  const bx0 = 940, bx1 = 1232, by = 396, bh = 12;
  const seg = (n: number) => (closed > 0 ? (n / closed) * (bx1 - bx0) : 0);
  let cx = bx0;
  const segRect = (n: number, col: string): string => {
    const w = seg(n);
    if (w <= 0) return "";
    const r = `<rect x="${cx.toFixed(1)}" y="${by}" width="${w.toFixed(1)}" height="${bh}" fill="${col}"/>`;
    cx += w;
    return r;
  };
  const stacked =
    closed === 0
      ? `<rect x="${bx0}" y="${by}" width="${bx1 - bx0}" height="${bh}" fill="${GRAY}"/>`
      : segRect(fc.tp, UP) + segRect(fc.sl, DOWN) + segRect(fc.exp, AMBER) + segRect(fc.other, GRAY);

  // legend counts
  const legend = [
    { n: fc.tp, col: UP, tag: "W" },
    { n: fc.sl, col: DOWN, tag: "L" },
    { n: fc.exp, col: AMBER, tag: "E" },
    { n: fc.other, col: MUTED, tag: "C" },
  ].filter((l) => l.n > 0)
    .map((l, i) => {
      const x = bx0 + i * 74;
      return `<rect x="${x}" y="424" width="9" height="9" fill="${l.col}"/><text x="${x + 16}" y="433" font-family="${MONO}" font-size="15" fill="${MUTED}">${l.n}${l.tag}</text>`;
    })
    .join("");

  // bottom trade bars
  const trades = d.trades.slice(0, 5);
  const maxAbs = Math.max(0.5, ...trades.map((t) => Math.abs(t.pnl)));
  const tradeRows = trades
    .map((t, i) => {
      const y = 578 + i * 21;
      const w = Math.max(4, (Math.abs(t.pnl) / maxAbs) * 780);
      const col = t.pnl >= 0 ? UP : DOWN;
      return `
    <text x="48" y="${y + 5}" font-family="${MONO}" font-size="16" fill="${INK}">${esc(t.symbol)}</text>
    <rect x="260" y="${y - 4}" width="${w.toFixed(0)}" height="8" fill="${col}" opacity="0.9"/>
    <text x="1232" y="${y + 5}" font-family="${MONO}" font-size="16" fill="${col}" text-anchor="end">${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(1)}%</text>`;
    })
    .join("");
  const tradesBlock =
    trades.length === 0
      ? `<text x="48" y="590" font-family="${MONO}" font-size="16" fill="${MUTED}" letter-spacing="2">NO CLOSED TRADES IN THIS WINDOW</text>`
      : tradeRows;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect x="0" y="0" width="${W}" height="3" fill="${netCol}"/>

  <!-- header -->
  <text x="48" y="70" font-family="${SANS}" font-size="19" font-weight="700" fill="${MUTED}" letter-spacing="7">NEXUS//SIGNALS</text>
  <text x="1232" y="70" font-family="${MONO}" font-size="17" fill="${DIM}" text-anchor="end" letter-spacing="1">${esc(stamp)}</text>

  <!-- hero: net pnl -->
  <text x="48" y="152" font-family="${MONO}" font-size="17" fill="${MUTED}" letter-spacing="4">NET PNL · LAST 24 HOURS</text>
  <text x="44" y="272" font-family="${SANS}" font-size="124" font-weight="700" fill="${netCol}" letter-spacing="0">${esc(money(d.realizedUsd))}</text>
  <text x="48" y="308" font-family="${MONO}" font-size="18" fill="${DIM}" letter-spacing="1">WINDOW ${esc(d.windowLabel.toUpperCase())}</text>

  <!-- hero right: equity -->
  <text x="1232" y="152" font-family="${MONO}" font-size="17" fill="${MUTED}" text-anchor="end" letter-spacing="4">EQUITY · LIVE</text>
  <text x="1232" y="240" font-family="${SANS}" font-size="64" font-weight="700" fill="${INK}" text-anchor="end">$${d.equityUsd.toFixed(2)}</text>
  <text x="1232" y="276" font-family="${MONO}" font-size="18" fill="${d.unrealizedUsd >= 0 ? UP : DOWN}" text-anchor="end">OPEN PNL ${esc(money(d.unrealizedUsd))}</text>
  <text x="1232" y="304" font-family="${MONO}" font-size="17" fill="${DIM}" text-anchor="end">FEES −$${d.feesUsd.toFixed(2)}</text>

  <line x1="48" y1="338" x2="1232" y2="338" stroke="${HAIR}" stroke-width="1"/>

  <!-- mid-left: settled pnl curve -->
  <text x="48" y="368" font-family="${MONO}" font-size="15" fill="${MUTED}" letter-spacing="3">NET PNL THROUGH WINDOW · SETTLED ROWS</text>
  ${note
      ? `<line x1="48" y1="440" x2="660" y2="440" stroke="${GRAY}" stroke-width="2" stroke-dasharray="6 6"/>
         <text x="48" y="470" font-family="${MONO}" font-size="15" fill="${DIM}" letter-spacing="1">${note}</text>`
      : sparkline(pts, 48, 660, 386, 470, netCol)}
  <text x="660" y="492" font-family="${MONO}" font-size="15" fill="${netCol}" text-anchor="end">${esc(money(d.realizedUsd))} SETTLED</text>
  <text x="48" y="492" font-family="${MONO}" font-size="14" fill="${DIM}">$0.00 START</text>

  <!-- mid-right: outcomes -->
  <text x="720" y="368" font-family="${MONO}" font-size="15" fill="${MUTED}" letter-spacing="3">OUTCOMES · CLOSED 24H</text>
  <text x="720" y="452" font-family="${SANS}" font-size="58" font-weight="700" fill="${wrCol}">${d.winRatePct === null ? "—" : `${d.winRatePct}%`}</text>
  <text x="720" y="478" font-family="${MONO}" font-size="13" fill="${DIM}" letter-spacing="2">WIN RATE · PROVEN TP · ${d.wins}/${closed}</text>
  ${stacked}
  ${legend}
  <text x="720" y="510" font-family="${MONO}" font-size="15" fill="${MUTED}">DEPLOYED ${d.opened} · CLOSED ${closed} · ACTIVE ${d.active}</text>

  <line x1="48" y1="532" x2="1232" y2="532" stroke="${HAIR}" stroke-width="1"/>

  <!-- bottom: top-5 trades -->
  <text x="48" y="560" font-family="${MONO}" font-size="15" fill="${MUTED}" letter-spacing="3">CLOSED TRADES · TOP 5 BY |NET %|</text>
  ${tradesBlock}
  ${d.best ? `<text x="1232" y="560" font-family="${MONO}" font-size="15" fill="${UP}" text-anchor="end" letter-spacing="1">BEST ${esc(d.best.symbol)} +${d.best.pnl.toFixed(1)}%</text>` : ""}

  <!-- footer -->
  <line x1="48" y1="668" x2="1232" y2="668" stroke="${HAIR}" stroke-width="1"/>
  <text x="48" y="696" font-family="${MONO}" font-size="14" fill="${DIM}" letter-spacing="2">NEXUS-AI LIVE ENGINE · HONEST NUMBERS FROM SETTLED ROWS</text>
  <text x="1232" y="696" font-family="${MONO}" font-size="14" fill="${DIM}" text-anchor="end">v8.0 · BASE $${ACCOUNT_START_USD.toFixed(0)}</text>
</svg>`;

  const out = "/home/z/my-project/download/DAILY-minimal-preview.png";
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
  console.log("RENDERED", out);
  console.log("DIGEST", JSON.stringify({
    realizedUsd: d.realizedUsd, equityUsd: d.equityUsd, unrealizedUsd: d.unrealizedUsd,
    feesUsd: d.feesUsd, opened: d.opened, closed: d.closed, wins: d.wins, stops: d.stops,
    expired: d.expired, winRatePct: d.winRatePct, active: d.active, trades: d.trades.length,
  }));
  const meta = await fs.stat(out);
  console.log("SIZE", meta.size, "bytes");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("RENDER FAILED:", e);
    process.exit(1);
  });
