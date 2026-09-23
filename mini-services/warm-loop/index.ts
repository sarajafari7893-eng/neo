// ── NEXUS-LIVE HEADLESS WARM-LOOP v1.0 — operator round 2026-09-23 ──────
// Operator: «داشبورد وابسته به مرورگر است ، داشبورد را بدون مرورگر گرم و زنده
// نگه دار» — the dashboard depends on the browser; keep it warm and ALIVE
// without one.
//
// ROOT CAUSE (verified in code, src/app/api/pulse/route.ts): the engine tick
// is driven by GET /api/pulse — "The client polls this; the engine tick is
// throttled server-side." EVERYTHING rides it:
//   · engine tick (sweeps / spawn lines / price series)
//   · v10.22 FUTURES sampler + fwd-return settlement (rides the tick)
//   · vol-cause capture · P0-watchdog self-arm · bridge self-heal
//   · env-guard (.env self-heal) · daily-scheduler (Tehran-day DAILY + SRE)
// Without an open browser only scripts/watchdog.sh probes pulse — every 60s
// (≈15× slower than the 4s engine cadence) and only while that watchdog
// itself lives. This service closes the gap: a headless client that pulses
// at engine cadence, forever.
//
// v1.0 contract:
//   · PULSE every 5s (sequential — never parallel, no pileup; 14s abort)
//     → engine runs at ~full headless speed, same as an open dashboard tab.
//   · WARM GET / every 5min → the page stays compiled in the dev server
//     (dev-up.sh's one-shot self-warm only covered the minutes after boot).
//   · CHIPS GET /api/rawcal + /api/ai/shadow-veto/telemetry every 60s → the
//     dashboard's other poll targets stay warm too.
//   · BACKOFF 5s→15s while the app is down/recompiling (fail-quiet — the two
//     P0 watchdog layers own app-down escalation; we never double-page).
//   · SINGLETON lockfile (mini-services were double-started by the platform
//     spawner on 2026-09-23 boot — duplicated pollers burn exchange
//     weight-limits; this loop must never join that class).
//   · /health on :3012 (last codes, counters) for probing — LOG-ONLY role,
//     no restart authority (same doctrine as liq/price-ws sidecars).
import fs from "node:fs";
import path from "node:path";

const ROOT = "/home/z/my-project";
const APP = "http://127.0.0.1:3000";
const PORT = 3012;
const PULSE_MS = 5_000;
const WARM_PAGE_MS = 5 * 60_000;
const CHIPS_MS = 60_000;
const ABORT_MS = 14_000;
const MAX_BACKOFF_MS = 15_000;

// ── singleton guard (pid lockfile; bun --hot keeps same pid across reloads) ──
const LOCK = path.join(import.meta.dir, "state", "warm-loop.pid");
fs.mkdirSync(path.dirname(LOCK), { recursive: true });
try {
  const prev = Number(fs.readFileSync(LOCK, "utf8").trim());
  if (prev && prev !== process.pid) {
    try {
      process.kill(prev, 0);
      console.error(`[warm-loop] another instance is alive (pid ${prev}) — exiting`);
      process.exit(0);
    } catch { /* stale lock — take over */ }
  }
} catch { /* no lock yet */ }
fs.writeFileSync(LOCK, String(process.pid));

// ── state ──
const t0 = Date.now();
let lastPulseCode = 0;
let lastPulseAt = 0;
let lastPageCode = 0;
let lastChipCode = 0;
let pulseOk = 0;
let pulseFail = 0;
let consecutiveFails = 0;

async function hit(url: string, timeoutMs = ABORT_MS): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "nexus-warm-loop/1.0" } });
    await res.arrayBuffer().catch(() => undefined); // drain — keep the socket reusable
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

async function pulse(): Promise<void> {
  const code = await hit(`${APP}/api/pulse`);
  lastPulseCode = code;
  lastPulseAt = Date.now();
  if (code === 200) {
    pulseOk++;
    if (consecutiveFails >= 3) console.log(`[warm-loop] app recovered after ${consecutiveFails} failed pulses`);
    consecutiveFails = 0;
  } else {
    pulseFail++;
    consecutiveFails++;
    if (consecutiveFails === 3 || consecutiveFails % 60 === 0) {
      console.warn(`[warm-loop] app not answering (code ${code}, ${consecutiveFails} consecutive) — backing off (watchdogs own escalation)`);
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── health surface :3012 (probes only — no restart authority) ──
Bun.serve({
  port: PORT,
  fetch(): Response {
    return new Response(JSON.stringify({
      ok: true, service: "warm-loop", uptimeS: Math.round((Date.now() - t0) / 1000),
      appDown: consecutiveFails >= 3,
      lastPulse: { code: lastPulseCode, agoS: lastPulseAt ? Math.round((Date.now() - lastPulseAt) / 1000) : null },
      lastPageWarm: { code: lastPageCode }, lastChipsWarm: { code: lastChipCode },
      counters: { pulseOk, pulseFail },
    }), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  },
});

console.log(`[warm-loop] v1.0 on :${PORT} — pulse ${PULSE_MS / 1000}s · page-warm ${WARM_PAGE_MS / 60_000}min · chips ${CHIPS_MS / 1000}s (headless engine driver)`);

// ── main loop: sequential pulse, chip + page warm interleaved by deadline ──
let lastChipAt = 0;
let lastPageAt = 0;
let lastSummaryAt = Date.now();
let backoff = PULSE_MS;

for (;;) {
  await pulse();
  const now = Date.now();
  if (now - lastChipAt >= CHIPS_MS) {
    lastChipAt = now;
    lastChipCode = await hit(`${APP}/api/rawcal`, 10_000);
    await hit(`${APP}/api/ai/shadow-veto/telemetry`, 10_000);
  }
  if (now - lastPageAt >= WARM_PAGE_MS) {
    lastPageAt = now;
    lastPageCode = await hit(`${APP}/`, 90_000); // dev cold-compile can take ~11s+; 90s headroom
    console.log(`[warm-loop] page-warm GET / → ${lastPageCode || "unreachable"}`);
  }
  if (now - lastSummaryAt >= 10 * 60_000) {
    lastSummaryAt = now;
    console.log(`[warm-loop] 10min — pulse ok=${pulseOk} fail=${pulseFail} lastCode=${lastPulseCode} page=${lastPageCode} chips=${lastChipCode}`);
  }
  backoff = consecutiveFails >= 3 ? Math.min(MAX_BACKOFF_MS, PULSE_MS * (consecutiveFails >= 10 ? 3 : 2)) : PULSE_MS;
  await sleep(backoff);
}
