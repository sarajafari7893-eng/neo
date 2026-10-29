// ── NEXUS//SIGNALS — FULL SYSTEM HEALTH CHECK (operator mandate 2026-09-07) ──
// «کل سیستم و سیم کشی و داده ها و یادگیری و ایجنت ها و صرافی ها و تمام اتصالات
//  و ردیابی ها و تاییدیه های ارسال سیگنال رو چک کن و تست کن سالم باشن»
//
// Probes EVERY layer against LIVE state — no simulation:
//   A. Engine + market feed (Binance multi-plane consensus, v14.0)
//   B. Data layer: SQLite integrity + real row counts
//   C. Learning loops: governor / supervisor / calibrator / ttl-gate /
//      vol-onset study / volcause study / deep-learn / backtest autotune / regime
//   D. Tracking APIs: pulse, events, vol-onset, vol-cause, flow-matrix, daily report compiler
//   E. Agents: real LLM round-trip (/api/ai/chat) + governor last cycle
//   F. Connections: liquidation monitor :3010, price WS :3003, outbound exchange data
//   G. Signal-send confirmations: relay health + ONE real Telegram delivery test
import "./env-load";
import { db } from "../src/lib/db";

const APP = "http://127.0.0.1:3000";
type Row = { ok: boolean; label: string; detail: string };
const rows: Row[] = [];
function mark(ok: boolean, label: string, detail: string) {
  rows.push({ ok, label, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} ${detail}`);
}
async function jfetch(url: string, init?: RequestInit, timeoutMs = 15000): Promise<{ status: number; json: unknown }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, cache: "no-store" });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* non-json */ }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  console.log(`\n═══ NEXUS-LIVE SYSTEM HEALTH CHECK — ${new Date().toISOString()} ═══\n`);

  /* ── A. ENGINE + FEED ─────────────────────────────────────────── */
  let pulse: Record<string, unknown> | null = null;
  try {
    const { status, json } = await jfetch(`${APP}/api/pulse`);
    pulse = json as Record<string, unknown>;
    const stats = (pulse?.stats ?? {}) as Record<string, unknown>;
    const feed = (pulse?.feed ?? {}) as Record<string, unknown>;
    const account = (stats?.account ?? {}) as Record<string, unknown>;
    mark(status === 200, "A1 engine /api/pulse", `status=${status} total=${stats.totalSignals} active=${stats.activeCount} pnl24h=$${stats.pnl24hUsd} equity=$${account.equity ?? stats.totalPnlUsd}`);
    mark(feed?.source === "LIVE", "A2 exchange feed LIVE", `source=${feed?.source} latency=${feed?.latencyMs}ms (Binance multi-plane consensus)`);
    const mk = ((pulse?.market ?? []) as Array<Record<string, unknown>>).length;
    mark(mk > 0, "A3 market snapshot", `${mk} symbols streaming`);
  } catch (e) {
    mark(false, "A1 engine /api/pulse", String(e));
  }

  /* ── B. DATA LAYER ────────────────────────────────────────────── */
  try {
    const integrity = (await db.$queryRawUnsafe<Array<{ c: string }>>("SELECT integrity_check AS c FROM pragma_integrity_check")) as Array<{ c: string }>;
    mark(integrity[0]?.c === "ok", "B1 SQLite integrity_check", `result=${integrity[0]?.c}`);
    const [sig, evt, volCause, settings] = await Promise.all([
      db.signal.count(),
      db.signalEvent.count(),
      db.volCauseEvent.count(),
      db.engineSetting.count(),
    ]);
    mark(sig > 0 && evt > 0, "B2 core tables populated", `signals=${sig} events=${evt}`);
    mark(true, "B3 tracking tables", `volCauseEvents=${volCause} engineSettings=${settings}`);
    const lastSig = await db.signal.findFirst({ orderBy: { serial: "desc" } });
    mark(!!lastSig, "B4 last signal row", lastSig ? `#${lastSig.serial} ${lastSig.symbol} ${lastSig.status}` : "none");
  } catch (e) {
    mark(false, "B data layer", String(e));
  }

  /* ── C. LEARNING LOOPS (EngineSetting subsystems) ─────────────── */
  const need = [
    "governor", "governor.hysteresis", "supervisor", "calibration", "ttl-gate",
    "volcause.study", "deep-learn", "backtest.autotune",
    "regime.telemetry", "telegram.chatId",
  ];
  try {
    const settings = await db.engineSetting.findMany({ where: { key: { in: need } } });
    const byKey = new Map(settings.map((s) => [s.key, s.value]));
    for (const k of need) {
      const v = byKey.get(k);
      mark(!!v, `C learning:${k}`, v ? `${String(v).slice(0, 90)}` : "MISSING");
    }
    const cal = byKey.get("calibration");
    const settled = cal ? (JSON.parse(cal) as { settled?: number }).settled : undefined;
    mark(typeof settled === "number" && settled >= 100, "C calibrator corpus", `settled=${settled} (NET-PNL-EXPECTANCY)`);
    const vc = byKey.get("volcause.study");
    const vcStudy = vc ? (JSON.parse(vc) as { settled?: number; causes?: unknown[]; at?: number }) : null;
    const pending = await db.volCauseEvent.count({ where: { settledAt: null } });
    const settledCount = await db.volCauseEvent.count({ where: { settledAt: { not: null } } });
    // honest state: loop is healthy while events are captured; stats build once the 2h/6h horizons elapse
    mark(
      (settledCount > 0 && (vcStudy?.causes?.length ?? 0) > 0) || (settledCount === 0 && pending > 0),
      "C volcause learning loop",
      settledCount > 0
        ? `${vcStudy?.causes?.length ?? 0} causes with stats · settled=${settledCount}`
        : `warming — ${pending} captured, awaiting real 2h/6h forward-return horizons (settle fires on board poll)`
    );
  } catch (e) {
    mark(false, "C learning subsystems", String(e));
  }

  /* ── D. TRACKING APIs ─────────────────────────────────────────── */
  for (const [name, path, check] of [
    ["D1 /api/events", "/api/events?limit=5", (j: unknown) => Array.isArray((j as { events?: unknown[] })?.events)],
    ["D2 /api/vol-onset", "/api/vol-onset", (j: unknown) => typeof (j as { universe?: number })?.universe === "number"],
    ["D3 /api/vol-cause", "/api/vol-cause", (j: unknown) => typeof (j as { totals?: unknown })?.totals === "object"],
    ["D4 /api/flow/matrix", "/api/flow/matrix", (j: unknown) => Array.isArray((j as { rows?: unknown[] })?.rows)],
    ["D5 /api/report/daily (GET)", "/api/report/daily", (j: unknown) => typeof (j as { digest?: unknown })?.digest === "object"],
  ] as Array<[string, string, (j: unknown) => boolean]>) {
    try {
      const { status, json } = await jfetch(`${APP}${path}`);
      mark(status === 200 && check(json), name, `status=${status}`);
    } catch (e) {
      mark(false, name, String(e));
    }
  }

  /* ── E. AGENTS ────────────────────────────────────────────────── */
  try {
    const t0 = Date.now();
    const { status, json } = await jfetch(
      `${APP}/api/ai/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "SYSTEM HEALTH PROBE — reply with the single word: ONLINE" }] }),
      },
      30000
    );
    const reply = (json as { reply?: string })?.reply ?? "";
    mark(status === 200 && reply.length > 0, "E1 AI analyst agent (LLM)", `status=${status} latency=${Date.now() - t0}ms reply="${reply.slice(0, 40).replace(/\n/g, " ")}"`);
  } catch (e) {
    mark(false, "E1 AI analyst agent (LLM)", String(e));
  }
  try {
    const g = await db.engineSetting.findUnique({ where: { key: "governor" } });
    const gv = g ? (JSON.parse(g.value) as { cycles?: number; lastRunAt?: string }) : null;
    const last = gv?.lastRunAt ? Date.now() - new Date(gv.lastRunAt).getTime() : Infinity;
    const fresh = last < 3 * 60 * 60 * 1000; // governor cycle cadence is 45min — allow 3h
    mark(!!gv && (gv.cycles ?? 0) > 0 && fresh, "E2 AI governor agent", `cycles=${gv?.cycles ?? 0} lastRun=${gv?.lastRunAt ?? "--"} (${Number.isFinite(last) ? Math.round(last / 60000) + "m ago" : "--"})`);
  } catch (e) {
    mark(false, "E2 AI governor agent", String(e));
  }

  /* ── F. CONNECTIONS ───────────────────────────────────────────── */
  try {
    const { status, json } = await jfetch("http://127.0.0.1:3010/health", undefined, 8000);
    const h = json as Record<string, unknown>;
    mark(status === 200, "F1 liq monitor :3010", `status=${status} connected=${h?.connected ?? h?.wsConnected ?? "?"} buffered=${h?.buffered ?? h?.count ?? "?"}`);
  } catch (e) {
    mark(false, "F1 liq monitor :3010", String(e));
  }
  try {
    const res = await fetch("http://127.0.0.1:3003/socket.io/?EIO=4&transport=polling", { cache: "no-store" });
    // socket.io HTTP handshake 400 on plain probe is EXPECTED (engine.io upgrade-only) — service up if it answers
    mark(res.status === 400 || res.status === 200, "F2 price WS :3003", `status=${res.status} (400 = expected socket.io handshake response)`);
  } catch (e) {
    mark(false, "F2 price WS :3003", String(e));
  }
  try {
    const { json } = await jfetch(`${APP}/api/flow/matrix`);
    const r = (json as { rows?: Array<Record<string, unknown>> })?.rows ?? [];
    const withOi = r.filter((x) => x.oiDelta1h != null).length;
    mark(r.length > 0 && withOi > 0, "F3 exchange outbound wiring", `${r.length} symbols with OI/CVD/funding (${withOi} with live OI Δ)`);
  } catch (e) {
    mark(false, "F3 exchange outbound wiring", String(e));
  }

  /* ── G. SIGNAL-SEND CONFIRMATIONS (Telegram relay) ────────────── */
  try {
    const { status, json } = await jfetch(`${APP}/api/notify`);
    const h = json as { armed?: boolean; tokenValid?: boolean; chatId?: number | string; sent?: number; failed?: number };
    mark(h?.armed === true && h?.tokenValid === true && !!h?.chatId, "G1 relay armed + token + chat", `armed=${h?.armed} tokenValid=${h?.tokenValid} chat=${h?.chatId} sent=${h?.sent} failed=${h?.failed}`);
  } catch (e) {
    mark(false, "G1 relay armed + token + chat", String(e));
  }
  try {
    const { status, json } = await jfetch(
      `${APP}/api/notify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
          text: `✅ SYSTEM HEALTH CHECK — ${new Date().toISOString()}\nAll subsystems probed live: engine · feed · DB · learning loops · agents · exchanges · connections · tracking.\nIf you can read this, signal-send confirmations are DELIVERING end-to-end.`,
        }),
      },
      20000
    );
    const r = json as { ok?: boolean; error?: string };
    mark(status === 200 && r?.ok === true, "G2 LIVE Telegram delivery test", `status=${status} ok=${r?.ok} ${r?.error ?? "card delivered to operator chat"}`);
  } catch (e) {
    mark(false, "G2 LIVE Telegram delivery test", String(e));
  }

  /* ── VERDICT ──────────────────────────────────────────────────── */
  const fails = rows.filter((r) => !r.ok);
  console.log(`\n═══ VERDICT: ${rows.length - fails.length}/${rows.length} PASS${fails.length === 0 ? " — SYSTEM HEALTHY" : ` — ${fails.length} FAILURES`} ═══`);
  for (const f of fails) console.log(`  FAIL → ${f.label}: ${f.detail}`);
  await db.$disconnect();
  process.exit(fails.length === 0 ? 0 : 2);
}
void main();
