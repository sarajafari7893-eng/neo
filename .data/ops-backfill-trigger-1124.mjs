// SENTINEL-20261124-DATA-HISTORY — FuturesSnapshot hole backfill trigger
// The 11-12..11-18 + 11-22 outage holes left the 1h BACKFILL grid stale
// (state frozen at 2026-09-23). POST /api/futures {action:"backfill"} calls
// ensureBackfill(true) — ban-aware, resume-safe. If fapi is currently banned
// it returns null → we clear futures.backfillState so the in-app sampler's
// ensureBackfill() (10-min retry, ban-aware) self-heals as soon as a ban
// window lifts. No code changes; uses the system's own backfill doctrine.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

try {
  const bans = JSON.parse(readFileSync(".data/fapi-gate/bans.json", "utf8"));
  console.log("fapi bans ledger:", JSON.stringify(bans).slice(0, 400));
} catch { console.log("fapi bans ledger: unreadable"); }

let forced = null;
try {
  const res = await fetch("http://localhost:3000/api/futures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "backfill" }),
    signal: AbortSignal.timeout(90_000),
  });
  const j = await res.json().catch(() => ({}));
  forced = j?.backfill ?? null;
  console.log("POST /api/futures backfill →", JSON.stringify(j).slice(0, 300));
} catch (e) {
  console.log("POST backfill failed:", String(e).slice(0, 120));
}

if (!forced) {
  console.log("forced run did not land (ban window / empty payload) — arming sampler self-heal");
  const db = new Database("db/custom.db");
  const row = db.query("SELECT value FROM EngineSetting WHERE key='futures.backfillState'").get();
  console.log("stale backfillState:", String(row?.value ?? "—").slice(0, 200));
  const del = db.query("DELETE FROM EngineSetting WHERE key='futures.backfillState'").run();
  db.close();
  console.log("futures.backfillState cleared, changes=", del.changes, "— sampler ensureBackfill() now retries every 10min (ban-aware) until both anchors land");
} else {
  console.log("backfill landed in-process:", JSON.stringify(forced).slice(0, 200));
}
