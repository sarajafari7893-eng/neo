// ── P0-b one-off FWD-SETTLE backfill (FWD-SETTLE-20261025) ──────────────────
// Settles the ENTIRE settleable forward-return backlog that accumulated while
// the settle loop was dead (~09-19 → 2026-10-25):
//   · VolCauseEvent  — settledAt IS NULL AND detectedAt < now−6h
//     → fwd2hPct + fwd6hPct (unlevered %, toFixed(3), horizons long passed).
//   · FuturesSnapshot — every NULL fwd field whose horizon has passed
//     (fwd15m/fwd1h/fwd4h).
// Price resolution uses the shared kit in src/lib/futures-snapshot-settle.ts:
//   sibling snapshot (egress-free) → PricePoint (the app's own WS archive)
//   → ranged kline ladder fapi(weight-gated) → SPOT-MIRROR (v14.0 Binance-only).
// Honest-failure doctrine: Binance fapi has been egress-banned on this box in
// recent weeks — every rung failure is counted (failure-reason histogram at
// the end), a row that resolves on NO rung stays pending, and the batch
// cursor advances regardless so one dead symbol can never stall the backfill.
// Run: bun scripts/backfill-fwd-settle.ts
import { db } from "@/lib/db";
import { KlineCache, resolveHorizonPrice } from "@/lib/futures-snapshot-settle";

const BATCH = 200;
const H2 = 2 * 3_600_000;
const H6 = 6 * 3_600_000;
const H15 = 15 * 60_000;
const H1 = 3_600_000;
const H4 = 4 * 3_600_000;
const AGE_BUFFER = 5 * 60_000; // horizon considered "passed" at age ≥ horizon + 5min
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

// ── VolCauseEvent pass ───────────────────────────────────────────────────────
async function backfillVolCauses(): Promise<void> {
  console.log("=== [backfill] VolCauseEvent pass (settledAt=null, detectedAt < now−6h) ===");
  const kit = new KlineCache();
  const reasons = new Map<string, number>();
  const sources = new Map<string, number>();
  let cursorTs = 0;
  let batch = 0;
  let scanned = 0;
  let full = 0;
  let partial = 0;
  let partialPending = 0; // got ≥1 value but <13h old → stays pending for fwd6h retry
  let failed = 0;
  for (;;) {
    const rows = await db.volCauseEvent.findMany({
      where: { settledAt: null, detectedAt: { lt: new Date(Date.now() - H6), gt: new Date(cursorTs) } },
      orderBy: [{ detectedAt: "asc" }],
      take: BATCH,
    });
    if (rows.length === 0) break;
    batch++;
    for (const ev of rows) {
      scanned++;
      cursorTs = Math.max(cursorTs, ev.detectedAt.getTime());
      try {
        const t0 = ev.detectedAt.getTime();
        const age = Date.now() - t0;
        const r2 = await resolveHorizonPrice(ev.price, ev.symbol, t0, H2, { usePricePoint: true, kit });
        const r6 = await resolveHorizonPrice(ev.price, ev.symbol, t0, H6, { usePricePoint: true, kit });
        if (r2.pct !== null) bump(sources, `2h:${r2.source}`);
        if (r6.pct !== null) bump(sources, `6h:${r6.source}`);
        const data: { fwd2hPct?: number; fwd6hPct?: number; settledAt?: Date } = {};
        if (r2.pct !== null) data.fwd2hPct = r2.pct;
        if (r6.pct !== null) data.fwd6hPct = r6.pct;
        if (data.fwd2hPct !== undefined && data.fwd6hPct !== undefined) {
          data.settledAt = new Date();
          await db.volCauseEvent.update({ where: { id: ev.id }, data });
          full++;
        } else if (Object.keys(data).length > 0) {
          if (age >= 13 * 3_600_000) {
            // beyond the original settle kline window — settle with what we have (mirrors volCause ageOk rule)
            data.settledAt = new Date();
            await db.volCauseEvent.update({ where: { id: ev.id }, data });
            partial++;
          } else {
            // 6h still reachable — persist partial progress WITHOUT settledAt so the cadence retries
            await db.volCauseEvent.update({ where: { id: ev.id }, data });
            partialPending++;
          }
        } else {
          failed++;
          bump(reasons, r2.rungNotes || "unknown");
        }
      } catch (e) {
        failed++;
        bump(reasons, `row-error:${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`);
      }
    }
    console.log(`[backfill] vce batch#${batch} scanned=${scanned} full=${full} partial=${partial} partialPending=${partialPending} failed=${failed} kitCalls=${kit.egressCalls}`);
    await sleep(120);
  }
  console.log(`[backfill] VCE DONE scanned=${scanned} settledFull=${full} settledPartial=${partial} partialPending=${partialPending} failed=${failed}`);
  console.log(`[backfill] VCE sources:`, JSON.stringify(Object.fromEntries([...sources.entries()].sort())));
  console.log(`[backfill] VCE failure-reasons:`, JSON.stringify(Object.fromEntries([...reasons.entries()].sort())));
}

// ── FuturesSnapshot pass ─────────────────────────────────────────────────────
async function backfillFuturesSnapshots(): Promise<void> {
  console.log("=== [backfill] FuturesSnapshot pass (null fwd fields whose horizon passed) ===");
  const kit = new KlineCache();
  const reasons = new Map<string, number>();
  const sources = new Map<string, number>();
  let cursorTs = 0;
  let batch = 0;
  let scanned = 0;
  let rowsSettled = 0;
  let fieldsSet = 0;
  let failed = 0;
  for (;;) {
    const rows = await db.futuresSnapshot.findMany({
      where: { ts: { lt: new Date(Date.now() - H15 - AGE_BUFFER), gt: new Date(cursorTs) }, OR: [{ fwd15mPct: null }, { fwd1hPct: null }, { fwd4hPct: null }] },
      orderBy: [{ ts: "asc" }],
      take: BATCH,
    });
    if (rows.length === 0) break;
    batch++;
    for (const row of rows) {
      scanned++;
      cursorTs = Math.max(cursorTs, row.ts.getTime());
      try {
        const ts = row.ts.getTime();
        const age = Date.now() - ts;
        const data: { fwd15mPct?: number; fwd1hPct?: number; fwd4hPct?: number } = {};
        const want: Array<[string, number, boolean]> = [
          ["m15", H15, row.fwd15mPct === null],
          ["h1", H1, row.fwd1hPct === null],
          ["h4", H4, row.fwd4hPct === null],
        ];
        let lastNotes = "";
        for (const [key, horizonMs, needed] of want) {
          if (!needed || age < horizonMs + AGE_BUFFER) continue;
          const r = await resolveHorizonPrice(row.price, row.symbol, ts, key as "m15" | "h1" | "h4", {
            useSibling: true, usePricePoint: true, kit,
          });
          if (r.pct !== null) {
            bump(sources, `${key}:${r.source}`);
            if (key === "m15") data.fwd15mPct = r.pct;
            else if (key === "h1") data.fwd1hPct = r.pct;
            else data.fwd4hPct = r.pct;
            fieldsSet++;
          } else {
            lastNotes = r.rungNotes;
          }
        }
        if (Object.keys(data).length > 0) {
          await db.futuresSnapshot.update({ where: { id: row.id }, data });
          rowsSettled++;
        } else {
          failed++;
          bump(reasons, lastNotes || "unknown");
        }
      } catch (e) {
        failed++;
        bump(reasons, `row-error:${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`);
      }
    }
    console.log(`[backfill] fs batch#${batch} scanned=${scanned} rowsSettled=${rowsSettled} fieldsSet=${fieldsSet} failed=${failed} kitCalls=${kit.egressCalls}`);
    await sleep(120);
  }
  console.log(`[backfill] FS DONE scanned=${scanned} rowsSettled=${rowsSettled} fieldsSet=${fieldsSet} failed=${failed}`);
  console.log(`[backfill] FS sources:`, JSON.stringify(Object.fromEntries([...sources.entries()].sort())));
  console.log(`[backfill] FS failure-reasons:`, JSON.stringify(Object.fromEntries([...reasons.entries()].sort())));
}

// ── summary ──────────────────────────────────────────────────────────────────
async function summarize(): Promise<void> {
  const [vceTotal, vceSettled, vceF2, vceF6] = await Promise.all([
    db.volCauseEvent.count(),
    db.volCauseEvent.count({ where: { settledAt: { not: null } } }),
    db.volCauseEvent.count({ where: { fwd2hPct: { not: null } } }),
    db.volCauseEvent.count({ where: { fwd6hPct: { not: null } } }),
  ]);
  const [fsTotal, fs15, fs1, fs4] = await Promise.all([
    db.futuresSnapshot.count(),
    db.futuresSnapshot.count({ where: { fwd15mPct: { not: null } } }),
    db.futuresSnapshot.count({ where: { fwd1hPct: { not: null } } }),
    db.futuresSnapshot.count({ where: { fwd4hPct: { not: null } } }),
  ]);
  const w0 = Date.UTC(2026, 9, 10);
  const [vceWin, fsWin] = await Promise.all([
    db.volCauseEvent.count({ where: { detectedAt: { gte: new Date(w0) }, fwd2hPct: { not: null } } }),
    db.futuresSnapshot.count({ where: { ts: { gte: new Date(w0) }, fwd1hPct: { not: null } } }),
  ]);
  console.log("=== [backfill] FINAL SUMMARY ===");
  console.log(`VolCauseEvent: total=${vceTotal} settledAt=${vceSettled} fwd2h=${vceF2} fwd6h=${vceF6} | window(10/10→) fwd2h settled=${vceWin}`);
  console.log(`FuturesSnapshot: total=${fsTotal} fwd15m=${fs15} fwd1h=${fs1} fwd4h=${fs4} | window(10/10→) fwd1h settled=${fsWin}`);
}

const t0 = Date.now();
await backfillVolCauses();
await backfillFuturesSnapshots();
await summarize();
console.log(`[backfill] elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
