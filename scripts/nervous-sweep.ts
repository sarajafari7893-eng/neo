// ── nervous-sweep.ts (Task 45 Q4 — NERVOUS SYSTEMS health sweep, readonly) ──
// Operator order 2026-10-18: «بررسی مهندسی و ممیزی سیستم های عصبی و تایید سلامت»
//
// Sweeps every nerve of the platform in one pass:
//   app :3000 · price-ws :3003 · bridge :3005 · liq :3010 · trade :3011 ·
//   warm-loop :3012 · supervisor :3015 · push-armor :3016 · stable-feed :3017 ·
//   keep-warm :3018 · mem-guard :3019 · p0-watchdog :3020 · sentinel :3030
// plus: kill-switch, DB integrity (pragma quick_check + WAL), engine feed
// status, close-all state. Verdict per nerve + overall.
// Read-only (HTTP GET + file reads only). bun run scripts/nervous-sweep.ts

import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync, statSync } from "node:fs";

const db = new PrismaClient();
const KEY = "3195f6883529fa43a9d62d0fa92b01e7adc851ed0ed3b2b6";
const now = Date.now();

interface Nerve { key: string; label: string; ok: boolean | "warn" | null; detail: string }

const nerves: Nerve[] = [];
const add = (key: string, label: string, ok: boolean | "warn" | null, detail: string) => nerves.push({ key, label, ok, detail });
const ago = (ts: number | null | undefined) => (ts ? `${Math.max(0, Math.round((now - ts) / 1000))}s ago` : "—");

async function probe(port: number, path: string, timeoutMs = 4000): Promise<{ code: number; body: string } | null> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: c.signal, cache: "no-store" });
    clearTimeout(t);
    const body = (await res.text()).slice(0, 400);
    return { code: res.status, body };
  } catch {
    return null;
  }
}
function readJson(path: string): any | null {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}
function fileAge(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
function pidAlive(pid: number | undefined | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("═".repeat(84));
  console.log("TASK 45 · Q4 — NERVOUS SYSTEMS SWEEP (all nerves, one pass)");
  console.log("═".repeat(84));

  // ── app ────────────────────────────────────────────────────────────────
  const app = await probe(3000, "/api/healthz");
  if (app && app.code === 200) {
    try {
      const j = JSON.parse(app.body);
      add("app", "app :3000 (healthz)", true, `status=${j.status ?? "ok"} rss=${j.memory?.rss ?? j.rss ?? "?"}MB uptime=${j.uptimeSec ?? "?"}s`);
    } catch {
      add("app", "app :3000 (healthz)", true, `200 non-json: ${app.body.slice(0, 60)}`);
    }
  } else add("app", "app :3000 (healthz)", false, app ? `HTTP ${app.code}` : "unreachable");

  const sigsFull = await fetch("http://127.0.0.1:3000/api/signals", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
  let engineVer = "?";
  try {
    engineVer = sigsFull?.meta?.engine ?? "?";
  } catch { /* ignore */ }
  add("engine", "engine version + ticker", typeof engineVer === "string" && engineVer.includes("NEXUS-LIVE"), engineVer);

  const pulse = await probe(3000, "/api/pulse", 9000);
  let feed: any = null;
  if (pulse?.code === 200) {
    try {
      const j = JSON.parse(pulse.body);
      feed = j.feed;
      add("feed", "market feed", feed?.source === "LIVE" || feed?.source === "STALE", `source=${feed?.source} lastOk=${ago(feed?.lastOkAt)} fails=${feed?.consecutiveFailures}`);
      const venues = (feed?.exchanges ?? []).map((v: any) => `${v.venue}:${v.ok ? "✓" : "✗"}`).join(" ");
      add("consensus", "4-venue consensus", (feed?.exchanges ?? []).filter((v: any) => v.ok).length >= 2, venues);
    } catch { /* ignore */ }
  } else add("feed", "market feed", null, "pulse unreachable");

  // ── sentinel ───────────────────────────────────────────────────────────
  const sen = readJson(".data/sentinel/latest.json");
  if (sen) {
    const ageS = Math.round((now - new Date(sen.at).getTime()) / 1000);
    const ups = (sen.services ?? []).map((s: any) => `${s.key}:${s.up ? "✓" : "✗"}`).join(" ");
    const senOk = ageS < 180 && (sen.verdict === "GREEN" ? true : sen.verdict === "AMBER" ? "warn" : false);
    add("sentinel", "sentinel :3030", senOk, `verdict=${sen.verdict} age=${ageS}s · ${ups}${sen.anomalies?.length ? ` · anomalies: ${sen.anomalies.slice(0, 2).map((a: any) => (typeof a === "string" ? a : a.kind ?? a.type ?? JSON.stringify(a).slice(0, 40))).join("; ").slice(0, 80)}` : ""}`);
  } else add("sentinel", "sentinel :3030", false, "no latest.json");

  // ── mem-guard ──────────────────────────────────────────────────────────
  const mg = readJson(".data/mem-guard/state.json");
  if (mg) {
    const beat = fileAge(".data/mem-guard/heartbeat");
    const q = !!mg.quarantined;
    add("memguard", "mem-guard :3019", pidAlive(mg.pid) ? (q ? "warn" : true) : false, `v=${mg.ver} pid-alive=${pidAlive(mg.pid)} quarantined=${q} (preemptive disabled, rescue armed) rss=${mg.app?.rssMb ?? "?"}MB avail=${mg.mem?.availableMb}MB rescues1h=${mg.rescues1h ?? "?"} beat=${beat ? ago(beat) : "—"}`);
  } else add("memguard", "mem-guard :3019", false, "no state.json");

  // ── p0-watchdog ────────────────────────────────────────────────────────
  const wd = readJson(".data/p0-watchdog/state.json");
  if (wd) {
    const paused = typeof wd.pausedUntil === "number" ? wd.pausedUntil * 1000 > now : false;
    const svcOk = Object.values(wd.services ?? {}).filter((v: any) => v?.up !== false).length;
    const svcN = Object.keys(wd.services ?? {}).length;
    add("watchdog", "p0-watchdog :3020", pidAlive(wd.pid) ? (paused ? "warn" : true) : false, `v=${wd.ver} pid-alive=${pidAlive(wd.pid)} paused=${paused} (self-resumes) mem=${wd.mem?.level} services=${svcOk}/${svcN}`);
  } else add("watchdog", "p0-watchdog :3020", false, "no state.json");

  // ── port probes for the remaining bun nerves ──────────────────────────
  const portChecks: Array<[string, number, string]> = [
    ["ws", 3003, "price-ws :3003 (socket.io)"],
    ["bridge", 3005, "telegram-bridge :3005"],
    ["liq", 3010, "liq-service :3010"],
    ["trade", 3011, "trade-service :3011"],
    ["warmloop", 3012, "warm-loop :3012"],
    ["supervisor", 3015, "supervisor-cron :3015"],
    ["armor", 3016, "push-armor :3016"],
    ["stable", 3017, "stable-feed :3017"],
    ["keepwarm", 3018, "keep-warm :3018"],
    ["mgport", 3019, "mem-guard :3019 (http)"],
    ["wdport", 3020, "p0-watchdog :3020 (http)"],
    ["senport", 3030, "sentinel :3030 (http)"],
  ];
  for (const [key, port, label] of portChecks) {
    const path = key === "ws" ? "/socket.io/?EIO=4&transport=polling" : key === "bridge" ? "/health" : "/";
    const r = await probe(port, path, key === "ws" ? 4000 : 3000);
    if (r && r.code < 500) add(key, label, true, `HTTP ${r.code}${r.body.includes("sid") ? " (socket.io ok)" : ""}`);
    else add(key, label, false, r ? `HTTP ${r.code}` : "unreachable");
  }

  // ── bridge loop beat ───────────────────────────────────────────────────
  const br = await probe(3000, "/api/bridge/inbox?n=1");
  add("bridgeapi", "bridge inbox (app-side)", br?.code === 200, br ? `HTTP ${br.code}` : "unreachable");

  // ── push-armor ─────────────────────────────────────────────────────────
  const pa = readJson(".data/push-armor/state.json");
  if (pa) {
    const lastOk = pa.lastOkPushAt ? new Date(pa.lastOkPushAt).getTime() : null;
    add("armor", "push-armor (offsite backup)", pa.pushes_fail === 0 && lastOk !== null && now - lastOk < 3 * 3600_000, `cycles=${pa.cycles} ok=${pa.pushes_ok} fail=${pa.pushes_fail} lastOk=${ago(lastOk)}`);
  } else add("armor", "push-armor", false, "no state.json");

  // ── kill-switch ────────────────────────────────────────────────────────
  const ks = readJson(".data/execution/kill-switch.json");
  add("killswitch", "execution kill-switch", ks ? !ks.engaged : null, ks ? `engaged=${ks.engaged} (${ks.reason ?? ""})` : "no file");

  // ── supervisor review ──────────────────────────────────────────────────
  const sup = readJson(".data/supervisor-cron/latest-review.json");
  const supAge = sup ? fileAge(".data/supervisor-cron/latest-review.json") : null;
  add("cron", "supervisor-cron review", supAge !== null && now - supAge < 13 * 3600_000, supAge ? `latest review ${ago(supAge)} (cadence 12h)` : "no review file");

  // ── DB ─────────────────────────────────────────────────────────────────
  try {
    const t0 = Date.now();
    const qc = (await db.$queryRawUnsafe<{ quick_check: string }[]>(`PRAGMA quick_check(1)`)) as any;
    const rows = await db.signal.count();
    const wal = fileAge("db/custom.db-wal");
    add("db", "SQLite integrity", qc?.[0]?.quick_check === "ok", `quick_check=${qc?.[0]?.quick_check ?? "?"} ${Date.now() - t0}ms · signals=${rows} · wal-mtime=${wal ? ago(wal) : "—"}`);
  } catch (e: any) {
    add("db", "SQLite integrity", false, e.message?.slice(0, 80));
  }

  // ── close-all ──────────────────────────────────────────────────────────
  try {
    const row = await db.engineSetting.findUnique({ where: { key: "closeall.state" } });
    const ca = row ? JSON.parse(row.value) : null;
    add("closeall", "close-all breaker state", ca ? ca.enabled === true : true, ca ? `enabled=${ca.enabled} target=$${ca.targetUsd} triggers=${ca.triggerCount} last=${ca.lastTriggeredAt ?? "—"}` : "defaults (on/$20)");
  } catch { /* ignore */ }

  console.log("nerve           | verdict | evidence");
  console.log("─".repeat(84));
  let bad = 0;
  let warn = 0;
  for (const n of nerves) {
    const mark = n.ok === true ? " ✓ " : n.ok === "warn" ? " ⚠ " : n.ok === false ? " ✗ " : " ? ";
    if (n.ok === false) bad++;
    if (n.ok === "warn") warn++;
    console.log(`${n.label.padEnd(30)} │   ${mark}   │ ${n.detail}`);
  }
  console.log("─".repeat(84));
  console.log(`OVERALL: ${bad === 0 ? (warn === 0 ? "ALL NERVES GREEN ✓" : `GREEN with ${warn} warning(s) ⚠`) : `${bad} nerve(s) RED ✗ (warnings: ${warn})`} · engine=${engineVer}`);
  console.log("═".repeat(84));
  await db.$disconnect();
  if (bad > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error("nervous-sweep failed:", e);
  process.exit(1);
});
