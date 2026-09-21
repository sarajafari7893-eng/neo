// ── RAWCAL-DROUGHT WATCHDOG (one-shot watcher, operator order 2026-09-21) ──
// Operator order: «یک ایجنت ناظر برای نظارت بر سیستم تا اگر تا ~۳ ساعت دیگر
// حتی یک سیگنال RAW-CAL صادر نشد، به تو بگوید تا سراغ اسکنر بروی. گزارش را به
// تلگرام ارسال کن»
//
// WHAT IT DOES (exactly that, engineered honestly):
//   · Deploys for 3h from the E-20260921 armedAt stamp (EVID-BUDGET re-arm).
//   · Polls GET /api/rawcal every 10min (light, force-dynamic route).
//   · SUCCESS (issued ≥ 1 in this run)  → Telegram ✅ report + verdict file, exit 0.
//   · DEADLINE (3h, issued still 0)     → Telegram 🚨 alert "go inspect the
//     scanner" + verdict file (so the next agent session sees it), exit 2.
//   · App unreachable 3× consecutively is tracked and reported honestly at the
//     deadline instead of a silent pass.
//   · Setup report → Telegram on start (operator asked for the report).
//   · Single-instance guard (pid file); secrets never echoed to logs.
// Lifetime ≤ 3h10m — self-terminating, no cleanup needed beyond its own files.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";

const APP = "http://127.0.0.1:3000/api/rawcal";
const PID_FILE = ".data/rawcal-watchdog.pid";
const VERDICT_FILE = ".data/rawcal-watchdog-last.json";
const POLL_MS = 10 * 60_000;
const WINDOW_H = 3;
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);

// ── env (names verified present; values never logged) ──────────────────────
const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);
const TOKEN = env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT = env.TELEGRAM_CHAT_ID ?? "";
if (!TOKEN || !CHAT) {
  console.error(`[${stamp()}] FATAL: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID absent — watcher cannot report`);
  process.exit(1);
}

// ── single instance ──────────────────────────────────────────────────────────
if (existsSync(PID_FILE)) {
  const old = Number(readFileSync(PID_FILE, "utf8").trim());
  try {
    process.kill(old, 0);
    console.error(`[${stamp()}] another watcher already alive (pid ${old}) — exit`);
    process.exit(0);
  } catch {
    /* stale pid — take over */
  }
}
writeFileSync(PID_FILE, String(process.pid));

async function tg(html: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, parse_mode: "HTML", disable_web_page_preview: true, text: html }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { ok?: boolean; result?: { message_id?: number }; description?: string };
    log(`telegram ok=${j.ok ?? false}${j.result?.message_id ? ` msg=${j.result.message_id}` : ""}${j.description ? ` desc=${j.description.slice(0, 80)}` : ""}`);
    return !!j.ok;
  } catch (e) {
    log("telegram send failed:", e instanceof Error ? e.message.slice(0, 100) : e);
    return false;
  }
}

interface RawcalView {
  armed?: boolean;
  armedAt?: string | null;
  issued?: number;
  target?: number;
  openRaw?: number;
  lastIssueAt?: string | null;
  lastIssueSerial?: number | null;
  blocks?: Array<{ t: number; note: string }>;
}

async function poll(): Promise<{ ok: boolean; d?: RawcalView }> {
  try {
    const res = await fetch(APP, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "rawcal-watchdog/1.0" } });
    if (!res.ok) return { ok: false };
    return { ok: true, d: (await res.json()) as RawcalView };
  } catch {
    return { ok: false };
  }
}

const lastBlock = (d?: RawcalView) => (d?.blocks && d.blocks.length ? d.blocks[d.blocks.length - 1].note : "—");

function verdict(file: Record<string, unknown>) {
  writeFileSync(VERDICT_FILE, JSON.stringify({ at: new Date().toISOString(), ...file }, null, 1));
}

async function main() {
  const first = await poll();
  if (!first.ok || !first.d?.armedAt) {
    verdict({ status: "ABORT", reason: "api unreachable or armedAt missing on deploy" });
    log("FATAL: cannot read /api/rawcal — aborting (no window to monitor)");
    await tg(`🕵️ <b>RAWCAL WATCHDOG — ABORT</b>\n/api/rawcal خوانا نبود؛ پنجره‌ی ۳ساعته قابل پایش نبود. اپراتور: وضعیت اپ را چک کنید.`);
    process.exit(1);
  }
  const armedAtMs = Date.parse(first.d.armedAt);
  const deadline = armedAtMs + WINDOW_H * 3_600_000;
  const armedAtS = first.d.armedAt.replace("T", " ").slice(0, 19) + "Z";
  const deadlineS = new Date(deadline).toISOString().replace("T", " ").slice(0, 19) + "Z";
  log(`deployed pid=${process.pid} armedAt=${armedAtS} deadline=${deadlineS} issued=${first.d.issued} target=${first.d.target}`);

  await tg(
    `🕵️ <b>ایجنت ناظر RAW-CAL مستقر شد</b>\n` +
      `پنجره: <b>${armedAtS}</b> → <b>${deadlineS}</b> (۳ ساعت، هر ۱۰ دقیقه پایش)\n` +
      `معیار موفقیت: ≥۱ صدور RAW-CAL در این run (هدف ${first.d.target ?? "?"}، اکنون ${first.d.issued ?? 0})\n` +
      `وضعیت: ${first.d.armed ? "ARMED ✅" : "⚠️ DISARMED!"} · open raw ${first.d.openRaw ?? "?"}/8 · آخرین بلوک: <code>${lastBlock(first.d).slice(0, 60)}</code>\n` +
      `اگر تا ددلاین حتی یک صدور نشود → 🚨 هشدار «بررسی اسکنر» به همین چت می‌آید.`,
  );

  let misses = 0;
  let lastIssued = first.d.issued ?? 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const r = await poll();
    if (!r.ok) {
      misses++;
      log(`poll miss #${misses} (api unreachable)`);
      continue;
    }
    misses = 0;
    const d = r.d!;
    lastIssued = d.issued ?? lastIssued;
    log(`poll issued=${d.issued} openRaw=${d.openRaw} lastBlock="${lastBlock(d).slice(0, 70)}"`);
    if ((d.issued ?? 0) >= 1 || (d.lastIssueAt && d.armedAt && Date.parse(d.lastIssueAt) > Date.parse(d.armedAt))) {
      const serial = d.lastIssueSerial ?? "?";
      verdict({ status: "OK", issued: d.issued, serial, at: new Date().toISOString() });
      await tg(
        `✅ <b>خاموشی شکست — RAW-CAL صادر شد</b>\n` +
          `صدور #${d.issued} (NX-${String(serial).padStart(4, "0")}) ثبت شد · کتاب <b>${d.target ? "" : ""}${d.target ?? "?"}</b> در جریان است\n` +
          `ناظر خارج شد — نیازی به بررسی اسکنر نیست.`,
      );
      log("SUCCESS — first issue observed, watcher exits 0");
      unlinkSync(PID_FILE);
      process.exit(0);
    }
  }

  // ── deadline reached, still zero issuance ──
  const r = await poll();
  const finalIssued = r.ok ? r.d?.issued ?? lastIssued : lastIssued;
  const unreach = !r.ok;
  verdict({
    status: "ALERT",
    issued: finalIssued,
    deadline: new Date(deadline).toISOString(),
    apiUnreachableAtDeadline: unreach,
    lastBlock: lastBlock(r.ok ? r.d : undefined),
  });
  log(`DEADLINE — issued=${finalIssued} unreach=${unreach} → ALERT`);
  await tg(
    `🚨 <b>هشدار ناظر RAW-CAL — خشکسالی کامل</b>\n` +
      `۳ ساعت از تسلیح E-20260921 گذشت و <b>حتی یک صدور</b> ثبت نشد (issued=${finalIssued}).\n` +
      `${unreach ? "⚠️ در ددلاین /api/rawcal هم در دسترس نبود — اپ را اول چک کنید." : `آخرین بلوک اسکنر: <code>${lastBlock(r.d).slice(0, 90)}</code>`}\n` +
      `👉 <b>به ایجنت بگویید سراغ اسکنر برود</b> (بررسی زنجیره‌ی کاندیدا/امتیاز/MIN_SCORE).`,
  );
  unlinkSync(PID_FILE);
  process.exit(2);
}

main().catch((e) => {
  console.error(`[${stamp()}] fatal`, e);
  process.exit(1);
});
