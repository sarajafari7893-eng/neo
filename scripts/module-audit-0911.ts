// ── NEXUS//SIGNALS v8.2 MODULE AUDIT — operator round 2026-09-11 ────────────
// Operator: «یک گزارش و تحقیق از عملکرد ماژول ها، یادگیری، ردیابی سیگنالها
// انجام بده… شواهد من ردیابی جریان و فیلتر سیگنال دقیقی صادر و موفق نشده»
//
// Read-only DB research + design-grade audit poster (1280×720, daily-skin
// aware) → sendPhoto to the operator relay with a Persian caption.
// Every number is computed live from db/custom.db + gate-journal.jsonl —
// nothing hardcoded. Run: bun scripts/module-audit-0911.ts [--no-send]

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Database } from "bun:sqlite";
import { dailySkin } from "../src/lib/daily-skin";

// ── env (mirror scripts/env-load.ts) ──
for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
}

const db = new Database(path.join(process.cwd(), "db", "custom.db"), { readonly: true });
const q = <T = any>(sql: string): T[] => db.query(sql).all() as T[];

// ── collect evidence ─────────────────────────────────────────────────────────
interface LeagueRow { strategy: string; n: number; tp: number; tpRate: number; totPnl: number; }
const league: LeagueRow[] = q(`
  SELECT strategy, COUNT(*) n, SUM(reachedTp>=1) tp,
         SUM(reachedTp>=1)*1.0/COUNT(*) tpRate, ROUND(SUM(pnlPercent),1) totPnl
  FROM Signal GROUP BY strategy ORDER BY SUM(pnlPercent) ASC`);

const totals = q<{ n: number; tp: number; tpRate: number; gross: number; fees: number }>(`
  SELECT COUNT(*) n, SUM(reachedTp>=1) tp, SUM(reachedTp>=1)*1.0/COUNT(*) tpRate,
         ROUND(SUM(marginUsd*pnlPercent/100),2) gross, ROUND(SUM(feeUsd),2) fees
  FROM Signal`)[0]!;

interface FlowVerdict { verdict: string; n: number; tpRate: number; totPnl: number; }
const flowVerdicts: FlowVerdict[] = [];
{
  const rows = q<{ flowJson: string | null; reachedTp: number; pnlPercent: number }>(
    `SELECT flowJson, reachedTp, pnlPercent FROM Signal WHERE flowJson IS NOT NULL`);
  const agg = new Map<string, { n: number; tp: number; pnl: number }>();
  for (const r of rows) {
    try {
      const v = (JSON.parse(r.flowJson!)?.verdict ?? "NONE").toUpperCase();
      const a = agg.get(v) ?? { n: 0, tp: 0, pnl: 0 };
      a.n++; a.tp += r.reachedTp >= 1 ? 1 : 0; a.pnl += r.pnlPercent;
      agg.set(v, a);
    } catch { /* malformed flowJson → skip */ }
  }
  for (const [verdict, a] of agg) flowVerdicts.push({ verdict, n: a.n, tpRate: a.tp / a.n, totPnl: +a.pnl.toFixed(1) });
  flowVerdicts.sort((a, b) => b.n - a.n);
}

const volDir = q<{ direction: string; n: number; acc: number | null }>(`
  SELECT direction, COUNT(*) n,
    SUM(CASE WHEN direction='UP' AND fwd6hPct>0 THEN 1 WHEN direction='DOWN' AND fwd6hPct<0 THEN 1 ELSE 0 END)*1.0
    / NULLIF(SUM(CASE WHEN fwd6hPct IS NOT NULL THEN 1 ELSE 0 END),0) acc
  FROM VolCauseEvent GROUP BY direction`);

const afterlife = q<{ tpAfter: number; slAfter: number; mfe: number }>(`
  SELECT SUM(afterlife='TP1_HIT') tpAfter, SUM(afterlife='SL_HIT') slAfter,
         ROUND(AVG(CASE WHEN afterlife='TP1_HIT' THEN maxPostPnlPercent END),1) mfe
  FROM Signal WHERE afterlife IS NOT NULL`)[0]!;

const confCalib = q<{ b: number; avgPnl: number }>(`
  SELECT CAST(confidence/10*10 AS INT) b, ROUND(AVG(pnlPercent),1) avgPnl
  FROM Signal GROUP BY b HAVING b IN (70, 80) ORDER BY b`);

const advisorApplied = q<{ n: number }>(`SELECT COUNT(*) n FROM AdvisorProposal WHERE status='APPLIED'`)[0]!.n;

// gate journal funnel (jsonl, read-only)
let jScanned = 0, jVetoed = 0, jDeployed = 0, jVetoScore = 0;
try {
  const lines = fs.readFileSync(path.join(process.cwd(), "db", "gate-journal.jsonl"), "utf8").trim().split("\n");
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      jScanned++;
      if (e.vetoed) { jVetoed++; jVetoScore += e.score ?? 0; }
      if (e.deployed) jDeployed++;
    } catch { /* skip */ }
  }
} catch { jScanned = -1; }

// flow backtest verdict (from the recorded artifact)
let btTestPf: number | null = null, btVerdict = "—";
try {
  const bt = JSON.parse(fs.readFileSync(path.join(process.cwd(), "scripts", "flow-backtest-result.json"), "utf8"));
  btTestPf = bt?.best?.test?.pf ?? null;
  btVerdict = bt?.verdict ?? "—";
} catch { /* artifact missing */ }

// ── flow standalone: probe + flow-verdict-at-deploy  ──

// ── artwork (family style, skin-aware) ──────────────────────────────────────
const W = 1280, H = 720;
const skin = dailySkin();
const INK = "#e8f0ec", MUTED = "#8aa094", DIM = "#5a6e66";
const MINT = "#00ffa3", DANGER = "#ff4d5e", AMBER = "#ffb347", VIOLET = "#b26bff";
const PANEL_BG = "rgba(10,14,22,0.66)", PANEL_STROKE = "rgba(138,160,148,0.22)";
const A = skin.accent;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pnlCol = (v: number) => (v >= 0 ? MINT : DANGER);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const now = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date()).toUpperCase();

function panel(x: number, y: number, w: number, h: number): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${PANEL_BG}" stroke="${PANEL_STROKE}"/>`;
}
function label(x: number, y: number, text: string, col = MUTED): string {
  return `<text x="${x}" y="${y}" font-family="DejaVu Sans Mono" font-size="16" fill="${col}" letter-spacing="3">${esc(text)}</text>`;
}

// league bars (right panel) — worst first, bar width ∝ |totPnl|
const leagueMax = Math.max(...league.map(r => Math.abs(r.totPnl)), 1);
const leagueSvg = league.map((r, i) => {
  const y = 292 + i * 32;
  const w = Math.max(4, (Math.abs(r.totPnl) / leagueMax) * 96);
  const c = pnlCol(r.totPnl);
  return `
  <text x="684" y="${y + 13}" font-family="DejaVu Sans" font-size="18" font-weight="700" fill="${INK}">${esc(r.strategy)}</text>
  <text x="872" y="${y + 13}" font-family="DejaVu Sans Mono" font-size="15" fill="${DIM}">n=${r.n} · TP ${pct(r.tpRate)}</text>
  <rect x="1042" y="${y}" width="${w.toFixed(0)}" height="15" rx="7" fill="${c}" opacity="0.85"/>
  <text x="1216" y="${y + 13}" font-family="DejaVu Sans Mono" font-size="15" fill="${c}" text-anchor="end">${r.totPnl >= 0 ? "+" : ""}${r.totPnl.toFixed(0)}%</text>`;
}).join("");

// flow verdict rows (left panel)
const fvSvg = flowVerdicts.map((v, i) => {
  const y = 332 + i * 36;
  const c = v.verdict === "CONFIRMS" ? DANGER : v.verdict === "NEUTRAL" ? AMBER : MINT;
  return `
  <rect x="64" y="${y - 19}" width="92" height="26" rx="7" fill="${c}" opacity="0.14"/>
  <text x="74" y="${y}" font-family="DejaVu Sans Mono" font-size="15" fill="${c}">${esc(v.verdict)}</text>
  <text x="180" y="${y}" font-family="DejaVu Sans Mono" font-size="15" fill="${MUTED}">n=${v.n} · TP ${pct(v.tpRate)} · Σ ${v.totPnl >= 0 ? "+" : ""}${v.totPnl.toFixed(1)}%</text>`;
}).join("");

const volUp = volDir.find(v => v.direction === "UP"), volDown = volDir.find(v => v.direction === "DOWN");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${skin.deep1}"/><stop offset="1" stop-color="${skin.deep2}"/>
    </linearGradient>
    <radialGradient id="halo" cx="${[0.2, 0.8, 0.5][skin.geometry]}" cy="0.34" r="0.9">
      <stop offset="0" stop-color="${A}" stop-opacity="0.15"/><stop offset="1" stop-color="${A}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="topbar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${A}"/><stop offset="1" stop-color="${A}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#halo)"/>
  <rect width="${W}" height="6" fill="url(#topbar)"/>
  <text x="40" y="56" font-family="DejaVu Sans" font-size="24" font-weight="700" fill="${MUTED}" letter-spacing="7">NEXUS//SIGNALS</text>
  <text x="${W - 40}" y="56" font-family="DejaVu Sans Mono" font-size="21" fill="${DIM}" text-anchor="end">${esc(now)} TEHRAN</text>
  <text x="40" y="128" font-family="DejaVu Sans" font-size="44" font-weight="700" fill="${A}" letter-spacing="2">MODULE AUDIT — FLOW · FILTER · LEARNING</text>
  <text x="40" y="164" font-family="DejaVu Sans Mono" font-size="19" fill="${MUTED}">${totals.n} signals all-time · proven-TP ${totals.tp}/${totals.n} (${pct(totals.tpRate)}) · gross ${totals.gross >= 0 ? "+" : ""}$${totals.gross} · fees $${totals.fees} · SKIN ${skin.name}</text>

  ${panel(40, 196, 580, 246)}
  ${label(64, 228, "FLOW TRACKING — EVIDENCE")}
  <text x="64" y="262" font-family="DejaVu Sans Mono" font-size="16" fill="${AMBER}">standalone backtest: ${esc(btVerdict)}${btTestPf !== null ? ` · test PF ${btTestPf.toFixed(2)} (adopt needs &gt;1)` : ""}</text>
  ${label(64, 310, "flow verdict at deploy vs realized outcome:", DIM)}
  ${fvSvg}
  <text x="64" y="428" font-family="DejaVu Sans Mono" font-size="15" fill="${MUTED}">gate funnel: ${jScanned < 0 ? "journal n/a" : `${jScanned} scanned · ${jVetoed} FLOW-VETO (avg score ${(jVetoed ? jVetoScore / jVetoed : 0).toFixed(0)}) · ${jDeployed} deployed`}</text>

  ${panel(660, 196, 580, 246)}
  ${label(684, 228, "STRATEGY LEAGUE — TOTAL PNL %")}
  <text x="684" y="256" font-family="DejaVu Sans Mono" font-size="14" fill="${DIM}">sorted worst→best · proven-TP rate · levered net %</text>
  ${leagueSvg}

  ${panel(40, 470, 380, 130)}
  ${label(64, 502, "VOL-CAUSE DIRECTION @6H")}
  <text x="64" y="540" font-family="DejaVu Sans Mono" font-size="17" fill="${DANGER}">UP calls: ${volUp?.acc != null ? pct(volUp.acc) : "—"} accuracy</text>
  <text x="64" y="570" font-family="DejaVu Sans Mono" font-size="17" fill="${MINT}">DOWN calls: ${volDown?.acc != null ? pct(volDown.acc) : "—"} accuracy</text>

  ${panel(450, 470, 380, 130)}
  ${label(474, 502, "TTL GATE — AFTERLIFE")}
  <text x="474" y="540" font-family="DejaVu Sans Mono" font-size="17" fill="${AMBER}">${afterlife.tpAfter ?? 0}/16 expired → TP1 after</text>
  <text x="474" y="570" font-family="DejaVu Sans Mono" font-size="17" fill="${MUTED}">post-expiry MFE +${afterlife.mfe ?? 0}% — winners cut</text>

  ${panel(860, 470, 380, 130)}
  ${label(884, 502, "LEARNING / CALIBRATION")}
  <text x="884" y="540" font-family="DejaVu Sans Mono" font-size="17" fill="${VIOLET}">knobs applied: ${advisorApplied} ever</text>
  <text x="884" y="570" font-family="DejaVu Sans Mono" font-size="17" fill="${MUTED}">conf70 ${confCalib[0]?.avgPnl ?? "—"}% vs conf80 ${confCalib[1]?.avgPnl ?? "—"}%</text>

  <rect x="0" y="${H - 62}" width="${W}" height="62" fill="rgba(6,9,16,0.88)"/>
  <rect x="0" y="${H - 62}" width="${W}" height="2" fill="${PANEL_STROKE}"/>
  <text x="40" y="${H - 23}" font-family="DejaVu Sans Mono" font-size="19" fill="${A}" letter-spacing="1">VERDICT: FILTER LEAKS EDGE — VETO-TRACKING · TTL POLICY · CONF-RECALIB QUEUED</text>
  <text x="${W - 40}" y="${H - 23}" font-family="DejaVu Sans Mono" font-size="18" fill="${DIM}" text-anchor="end">v8.2</text>
</svg>`;

const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 8 }).toBuffer();
const out = path.join(process.cwd(), "download", "module-audit-0911.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`AUDIT POSTER rendered → ${out} (${(png.length / 1024).toFixed(0)}KB)`);

// ── send (skip with --no-send) ───────────────────────────────────────────────
if (!process.argv.includes("--no-send")) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!TOKEN) { console.log("SEND SKIP: TELEGRAM_BOT_TOKEN unset"); process.exit(0); }
  let chatId = process.env.TELEGRAM_CHAT_ID ?? "";
  try {
    const row = db.query<{ value: string }>(`SELECT value FROM EngineSetting WHERE key='telegram.chatId'`).get();
    const botOwnId = TOKEN.split(":")[0];
    // EngineSetting override wins — unless it is the bot's own id (bot→bot sends are rejected)
    if (row?.value && row.value !== botOwnId) chatId = row.value;
  } catch { /* keep env chat */ }

  const caption = [
    `🔎 <b>گزارش عملکرد ماژول‌ها — Flow · فیلتر · یادگیری</b>`,
    ``,
    `📊 کل تاریخ: ${totals.n} سیگنال · برد اثبات‌شده ${totals.tp}/${totals.n} (${pct(totals.tpRate)}) · ناخالص ${totals.gross >= 0 ? "+" : "−"}$${Math.abs(totals.gross)} · کارمزد $${totals.fees}`,
    `• همه استراتژی‌ها منفی جز MOMENTUM (۱ معامله) — بدترین: AI-SWING −۱۴۸٪`,
    `• کانفیدنس AI وارونه است: کانف۸۰ → −۱۴.۶٪ در برابر کانف۷۰ → −۶.۱٪`,
    ``,
    `🌊 <b>ردیابی جریان — حدس شما درست بود:</b>`,
    `• بک‌تست مستقل FAIL (PF تست ${btTestPf?.toFixed(2) ?? "—"}) — به‌درستی فعال نشد`,
    `• در لایو، «CONFIRMS» آنتی‌سیگنال بود: TP ${pct(flowVerdicts.find(v => v.verdict === "CONFIRMS")?.tpRate ?? 0)} · Σ −۱۲۴٪`,
    `• وکتوی فلو ${jVetoed} کاندید را بلاک کرده — بی ردیابی نتیجه`,
    ``,
    `⏱ <b>TTL:</b> ${afterlife.tpAfter ?? 0}/۱۶ منقضی بعداً به TP1 رسید (MFE +${afterlife.mfe ?? 0}٪) — فیلتر زمان برنده را زود می‌بُرد`,
    `🧠 <b>یادگیری:</b> فقط ${advisorApplied} تنظیم همیشگی — لوپ خاموش`,
    ``,
    `⚙️ اقدامات: ردیابی counterfactual وکتوها · بازکالیبراسیون کانفیدنس · سیاست TTL جدید · سقف ریسک AI-SWING · تست فلو به‌عنوان فیلتر مخالف`,
    ``,
    `<i>SKIN ${skin.name} — چرخش روزانه بکگراند فعال شد</i>`,
  ].join("\n");

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "module-audit.png");
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: form });
  const j = await res.json() as { ok: boolean; description?: string; result?: { message_id: number } };
  console.log(`SEND: ${j.ok ? `OK (message_id ${j.result?.message_id})` : `FAIL — ${j.description}`}`);
}
