// ── RAWCAL CADENCE WATCHDOG v3 (persistent, freeze-honest) ─────────────────
// v10.21 — evolves the one-shot 3h watcher (scripts/rawcal-watchdog.ts) into
// the permanent operator contract after incident 2026-09-22:
//   the 9h59m heartbeat gap (23:19Z→09:18Z) proved the sandbox VM itself
//   suspends/reboots; the old watchdog could not distinguish "engine not
//   issuing" from "machine frozen" and even false-alerted on a stale deadline
//   after resume. v3 reads the VM boot time (btime) and the RAWCAL heartbeat
//   age every cycle and only alerts on HONEST conditions:
//     · REBOOT/RESUME  — btime changed → Telegram note; baseline resets; the
//       engine gets 20min to self-warm (instrumentation v10.21 arms it) —
//       never a drought alarm on a fresh boot.
//     · ENGINE COLD    — VM up ≥20min AND heartbeat age >15min ⇒ engine not
//       ticking without a browser → self-heal ping (/api/pulse) → still cold
//       on the next cycle → Telegram alert (2h throttle).
//     · SCANNER DROUGHT — VM continuously up ≥3h, heartbeat fresh, run armed,
//       and lastIssueAt older than 3h ⇒ the original operator promise
//       («سراغ اسکنر بروید») fires — 6h throttle.
//     · ALIVE PING     — every 12h a one-line status to Telegram so silence
//       never means death.
// Cadence: 15min. Single-instance pid guard; verdict file per cycle; secrets
// never logged. Restarted automatically after reboots by dev-up.sh (v10.21).

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";

const APP = "http://127.0.0.1:3000";
const PID_FILE = ".data/cadence-watchdog.pid";
const VERDICT_FILE = ".data/cadence-watchdog-last.json";
const HB_FILE = ".data/rawcal-run-heartbeat.txt";
const POLL_MS = 15 * 60_000;
const VM_WARM_GRACE_MIN = 20; // after boot: engine warm-up grace
const HB_STALE_MIN = 45; // heartbeat older than this while VM up ⇒ engine cold.
// MUST exceed the 30min steady-state throttle (rawcal-heartbeat.ts) — v10.21.1:
// 15 was INSIDE the write cadence, so every quiet cycle false-tripped the cold
// path (10:24Z self-heal ping on a perfectly alive engine). 45 = 1.5× cadence.
const DROUGHT_WINDOW_MIN = 180; // no issuance for 3h while alive ⇒ scanner alert
const REBOOT_ALERT_THROTTLE_MS = 2 * 3_600_000;
const DROUGHT_ALERT_THROTTLE_MS = 6 * 3_600_000;
const ALIVE_PING_MS = 12 * 3_600_000;

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
const log = (...a: unknown[]) => console.log(`[${stamp()}]`, ...a);

// ── env (names verified present; values never logged) ──────────────────────
const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);
const TOKEN = env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT = env.TELEGRAM_CHAT_ID ?? "";
if (!TOKEN || !CHAT) {
  console.error(`[${stamp()}] FATAL: TELEGRAM_* absent — cannot report`);
  process.exit(1);
}

// ── single instance ──────────────────────────────────────────────────────────
if (existsSync(PID_FILE)) {
  const old = Number(readFileSync(PID_FILE, "utf8").trim());
  try {
    process.kill(old, 0);
    console.error(`[${stamp()}] another cadence watchdog alive (pid ${old}) — exit`);
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
    const j = (await res.json()) as { ok?: boolean; result?: { message_id?: number } };
    log(`telegram ok=${j.ok ?? false}${j.result?.message_id ? ` msg=${j.result.message_id}` : ""}`);
    return !!j.ok;
  } catch (e) {
    log("telegram send failed:", e instanceof Error ? e.message.slice(0, 100) : e);
    return false;
  }
}

interface RawcalView {
  armed?: boolean;
  issued?: number;
  lastIssueAt?: string | null;
  lastIssueSerial?: number | null;
}

function vmBootMs(): number | null {
  try {
    const m = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
    return m ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  }
}

function hbAgeMin(): number | null {
  try {
    const lines = readFileSync(HB_FILE, "utf8").trim().split("\n").filter(Boolean);
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})Z/.exec(lines[lines.length - 1] ?? "");
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return Number.isFinite(t) ? Math.round((Date.now() - t) / 60_000) : null;
  } catch {
    return null;
  }
}

async function pollRawcal(): Promise<RawcalView | null> {
  try {
    // 30s — /api/rawcal is the heaviest GET (pace + sparkline + milestones);
    // after a restart its cold compile + compute blew the old 10s budget
    // (first-cycle false "API-DOWN", 10:07Z).
    const res = await fetch(`${APP}/api/rawcal`, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "cadence-watchdog/3.0" } });
    if (!res.ok) return null;
    return (await res.json()) as RawcalView;
  } catch {
    return null;
  }
}

const verdict = (file: Record<string, unknown>) =>
  writeFileSync(VERDICT_FILE, JSON.stringify({ at: new Date().toISOString(), ...file }, null, 1));

async function main() {
  const boot0 = vmBootMs();
  let lastBtime = boot0;
  let lastDroughtAlertAt = 0;
  let lastColdAlertAt = 0;
  let lastRebootNoteAt = 0;
  let coldHealPending = false;
  let lastAlivePing = Date.now();
  log(`cadence-watchdog v3 armed pid=${process.pid} poll=${POLL_MS / 60_000}min btime=${boot0 ? new Date(boot0).toISOString() : "?"}`);
  await tg(
    `🛰 <b>ناظر ضربان v3 مستقر شد</b> (پایدار، همه‌جانبه)\n` +
      `هر ۱۵ دقیقه: تشخیص ریبوت/تعلیق VM (btime) + تازگی heartbeat + ضرب‌آهنگ صدور.\n` +
      `تنها هشدار «بررسی اسکنر» وقتی می‌آید که ماشین <b>۳ ساعت پیوسته روشن</b> بوده و با این حال صدوری نشده باشد — دیگر هیچ هشدار کاذب بعد از فریز/ریبوت نخواهد بود.`,
  );

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const now = Date.now();
    const boot = vmBootMs();
    const upMin = boot ? Math.round((now - boot) / 60_000) : null;

    // ── reboot/resume detection ──
    if (boot && lastBtime && boot !== lastBtime) {
      lastBtime = boot;
      coldHealPending = false;
      log(`VM REBOOT detected — btime ${new Date(boot).toISOString()} (up ${upMin}min)`);
      if (now - lastRebootNoteAt > REBOOT_ALERT_THROTTLE_MS) {
        lastRebootNoteAt = now;
        await tg(
          `🔄 <b>ماشین ری‌استارت/ادامه‌ی کار شد</b>\n` +
            `بوت: <b>${new Date(boot).toISOString().slice(0, 16).replace("T", " ")}Z</b> (uptime ${upMin}min)\n` +
            `موتور تا ≤۲۰ دقیقه خودش گرم می‌شود (instrumentation v10.21) — اگر سیگنالی در همین بازه نیامد، طبیعی است؛ ناظر صبر می‌کند.`,
        );
      }
    } else if (boot) {
      lastBtime = boot;
    }

    const d = await pollRawcal();
    const ageMin = hbAgeMin();
    verdict({
      status: d ? "WATCHING" : "API-DOWN",
      vmUpMin: upMin,
      hbAgeMin: ageMin,
      armed: d?.armed ?? null,
      issued: d?.issued ?? null,
      lastIssueAt: d?.lastIssueAt ?? null,
    });

    if (!d) {
      log(`poll miss (api down) — up=${upMin}min hbAge=${ageMin}min`);
      continue; // restart ownership belongs to the p0-watchdog layers
    }

    // ── engine-cold detection (only after VM warm grace) ──
    if (upMin !== null && upMin >= VM_WARM_GRACE_MIN && ageMin !== null && ageMin > HB_STALE_MIN) {
      if (!coldHealPending) {
        coldHealPending = true;
        log(`engine cold? hbAge=${ageMin}min up=${upMin}min — self-heal ping /api/pulse`);
        await fetch(`${APP}/api/pulse`, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      } else if (now - lastColdAlertAt > REBOOT_ALERT_THROTTLE_MS) {
        lastColdAlertAt = now;
        log(`ENGINE COLD confirmed — hbAge=${ageMin}min → ALERT`);
        await tg(
          `🥶 <b>موتور بدون مرورگر سرد است</b>\n` +
            `VM روشن است (${upMin}min) ولی heartbeat ${ageMin}min کهنه است — یعنی تیک حلقه‌ی موتور نایستاده.\n` +
            `پینگ خودترمیم زده شد؛ اگر چرخه‌ی بعد هم سرد بود، لاگ dev را ببینید یا بگویید سراغ حلقه‌ی tick بروم.`,
        );
      }
    } else {
      coldHealPending = false;
    }

    // ── freeze-honest scanner drought (the operator promise) ──
    if (d.armed && upMin !== null && upMin >= DROUGHT_WINDOW_MIN && ageMin !== null && ageMin <= HB_STALE_MIN && d.lastIssueAt) {
      const sinceIssueMin = Math.round((now - Date.parse(d.lastIssueAt)) / 60_000);
      if (sinceIssueMin >= DROUGHT_WINDOW_MIN && now - lastDroughtAlertAt > DROUGHT_ALERT_THROTTLE_MS) {
        lastDroughtAlertAt = now;
        log(`SCANNER DROUGHT — up=${upMin}min, no issue for ${sinceIssueMin}min, engine alive → ALERT`);
        await tg(
          `🚨 <b>خشکسالی واقعی — موتور زنده است ولی صادر نمی‌کند</b>\n` +
            `ماشین ${upMin}min پیوسته روشن، heartbeat تازه (${ageMin}min)، ولی آخرین صدور ${sinceIssueMin}min پیش بوده (issued=${d.issued}).\n` +
            `این دیگر فریز نیست — <b>زنجیره‌ی کاندیدا/امتیاز/MIN_SCORE را بررسی کن</b>.`,
        );
      }
    }

    // ── 12h alive ping ──
    if (now - lastAlivePing > ALIVE_PING_MS) {
      lastAlivePing = now;
      await tg(`🛰 ناظر ضربان زنده است — issued=${d.issued} · VM up=${upMin ?? "?"}min · hb=${ageMin ?? "?"}min`);
    }
  }
}

process.on("SIGTERM", () => {
  try {
    // only unlink when the pidfile is OURS — never break the owner's guard
    if (existsSync(PID_FILE) && readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) unlinkSync(PID_FILE);
  } catch {
    /* pidfile hygiene is best-effort on shutdown */
  }
  process.exit(0);
});
main().catch((e) => {
  console.error(`[${stamp()}] fatal`, e);
  process.exit(1);
});
