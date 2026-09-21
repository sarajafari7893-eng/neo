// AFTERLIFE banner proof — operator request 2026-09-11 20:54 +08:
// «برای گزارش Expired follow up هم تصویر صادر شود»
// (also export an image for the EXPIRED FOLLOW-UP report)
//
// Renders REAL afterlife rows from db/custom.db through the EXACT spec shape
// buildCard() produces for AFTERLIFE relay events (notify.ts), then ships them
// via sendPhotoDirect. Read-only DB access; no engine state is touched.
import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs/promises";
import { renderSignalBannerV2 } from "../src/lib/telegram-art";
import { sendPhotoDirect } from "../src/lib/notify";

interface Row {
  serial: number;
  symbol: string;
  direction: string;
  status: string;
  afterlife: string;
  maxPostPnlPercent: number;
  pnlPercent: number;
  reachedTp: number;
  ttlMinutes: number;
}

function tehranStamp(): string {
  return `${new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date()).replace(",", "")} TEHRAN`;
}

const db = new Database(path.join(process.cwd(), "db", "custom.db"), { readonly: true });
const rows = db.query(
  `SELECT serial, symbol, direction, status, afterlife, maxPostPnlPercent, pnlPercent, reachedTp, ttlMinutes
   FROM Signal WHERE afterlife IS NOT NULL AND afterlife NOT IN ('', 'TRACKING')
   ORDER BY afterlifeAt DESC LIMIT 12`,
).all() as Row[];

// one banner per verdict flavor — latest TP1_HIT (win-after-expiry) + latest SL_HIT
const tp = rows.find((r) => r.afterlife === "TP1_HIT");
const sl = rows.find((r) => r.afterlife === "SL_HIT");
const picks = [tp, sl].filter((r): r is Row => Boolean(r)).filter(
  (r, i, arr) => arr.findIndex((x) => x.serial === r.serial) === i,
);

if (picks.length === 0) {
  console.error("no confirmed afterlife rows found — nothing to prove");
  process.exit(1);
}

const results: string[] = [];
for (const r of picks) {
  const serial = `NX-${String(r.serial).padStart(4, "0")}`;
  const pnl = r.pnlPercent ?? 0;
  const mfe = r.maxPostPnlPercent ?? 0;
  // EXACT buildCard AFTERLIFE spec shape (notify.ts line2 branch)
  const spec = {
    status: "AFTERLIFE" as const,
    title: `${r.symbol} ${r.direction}`,
    line1: `${serial} · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}% NET`,
    line2: `POST-EXPIRY ${r.afterlife.replace(/_/g, " ")} · MFE ${mfe >= 0 ? "+" : ""}${mfe.toFixed(1)}%`,
    ts: tehranStamp(),
  };
  const png = await renderSignalBannerV2(spec);
  const file = `download/AFTERLIFE-proof-${serial}.png`;
  await fs.writeFile(file, png);
  const caption =
    `🔮 تصویر گزارش EXPIRED FOLLOW-UP — از این به بعد رویدادهای afterlife هم با بنر تصویری ارسال می‌شوند.\n` +
    `نمونه از ردیف واقعی ${serial} (${r.symbol} ${r.direction} → ${r.afterlife.replace(/_/g, " ")} · MFE ${mfe >= 0 ? "+" : ""}${mfe.toFixed(1)}%)`;
  const sent = await sendPhotoDirect(caption, png, `afterlife-${serial}.png`);
  const line = `${file} (${Math.round(png.length / 1024)}KB) → sendPhoto ok:${sent.ok}${sent.ok ? "" : ` err:${sent.error}`}`;
  console.log(line);
  results.push(line);
}

if (results.some((l) => l.includes("ok:false"))) process.exit(2);
process.exit(0);
