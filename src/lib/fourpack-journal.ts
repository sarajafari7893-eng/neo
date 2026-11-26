// ── FlowRadar Neo v10.8 — FOUR-PACK GOVERNANCE JOURNAL (server-only) ────────
// Operator mandate (2026-09-15/16): the GOVERNOR MODULES FOUR-PACK (R1
// RISK-GOVERNOR · R2 TIME-GOVERNOR · R5 UI-CANARY · R6 SENIOR-REVIEW) keeps
// its verdicts as small in-memory rings buried inside each module's own
// EngineSetting blob. This module gives the pack ONE retrievable, auditable
// JSON journal doctrine — the same discipline the gate-journal (v8.2) and
// sv-telemetry (v10.2) already follow:
//   · append-only JSONL  .data/fourpack-journal.jsonl  (6MB rotate → .old)
//   · atomic latest-file .data/fourpack-latest.json    (tmp→rename)
//   · in-memory ring (fast reads) + tail-ingest hydration so Turbopack's
//     per-route module split-brain never shows a stale journal.
// Supervision verdict (delivered to operator): the four modules are
// deterministic, shadow-first, clamped and audited — they do NOT need a new
// autonomous agent/central-intelligence control loop on top. What they needed
// is THIS: a machine-readable doctrine file the central AI core (verdict-core
// / tp3-lab grounding) and the operator (download) can both study.
//
// Dependency-free (node:fs only) — the module writers call recordFourPack();
// read routes call fourpackRefresh() then getFourPackTail()/getFourPackDoc().

import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type FourPackModule = "r1-risk-governor" | "r2-time-governor" | "r5-ui-canary" | "r6-senior-review" | "ops-supervisor" | "mode"; // v14.0 — ops-supervisor lane journaled
export type FourPackKind = "cycle" | "flip" | "proposal" | "apply" | "mode" | "audit" | "page";

export interface FourPackEvent {
  at: number;
  module: FourPackModule;
  kind: FourPackKind;
  verdict: string | null;
  line: string;
  data?: Record<string, unknown>;
}

export interface FourPackHealth {
  counts: Record<string, number>;
  lastAt: Record<string, number>;
  fileBytes: number;
  rotated: boolean;
}

const RING_CAP = 600;
const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "fourpack-journal.jsonl");
const FILE_MAX_BYTES = 6 * 1024 * 1024;
const LATEST = path.join(DATA_DIR, "fourpack-latest.json");

const ring: FourPackEvent[] = [];
let persisted = 0;
let readPos = 0;
let hydratedAt = 0;
let hydrating: Promise<void> | null = null;
let refreshing: Promise<void> | null = null;
let lastRefreshAt = 0;
const REFRESH_MIN_INTERVAL_MS = 10_000;
const REFRESH_MAX_BITE = 256 * 1024;
const MODULES: FourPackModule[] = ["r1-risk-governor", "r2-time-governor", "r5-ui-canary", "r6-senior-review", "ops-supervisor", "mode"];

async function hydrate(): Promise<void> {
  if (hydrating) return hydrating;
  hydrating = (async () => {
    try {
      const buf = await readFile(FILE, "utf8").catch(() => "");
      if (buf) {
        const lines = buf.split("\n").filter(Boolean);
        for (const line of lines.slice(-RING_CAP)) {
          try {
            const rec = JSON.parse(line) as { k: FourPackModule; v: FourPackEvent };
            if (rec?.v?.at && ring.length < RING_CAP) ring.push(rec.v);
          } catch {
            /* torn line */
          }
        }
      }
      const st = await stat(FILE).catch(() => null);
      persisted = st?.size ?? 0;
      readPos = st?.size ?? 0;
      hydratedAt = Date.now();
      if ((st?.size ?? 0) > FILE_MAX_BYTES) {
        await rename(FILE, `${FILE}.old`).catch(() => undefined);
        persisted = 0;
        readPos = 0;
      }
    } catch {
      /* fresh start — journaling must never break the engine */
    }
  })();
  return hydrating;
}

/** READ-PATH LIVENESS — tail-ingest bytes another module instance wrote
 * (same split-brain countermeasure as gate-journal v8.2.1). */
export async function fourpackRefresh(maxAgeMs = REFRESH_MIN_INTERVAL_MS): Promise<void> {
  await hydrate();
  if (Date.now() - lastRefreshAt < maxAgeMs) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const st = await stat(FILE).catch(() => null);
      if (!st) return;
      if (st.size < readPos) readPos = 0; // rotated
      if (st.size === readPos) return;
      const len = Math.min(st.size - readPos, REFRESH_MAX_BITE);
      const fh = await open(FILE, "r").catch(() => null);
      if (!fh) return;
      try {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, readPos);
        let text = buf.toString("utf8", 0, bytesRead);
        const lastNl = text.lastIndexOf("\n");
        if (lastNl === -1) return;
        text = text.slice(0, lastNl + 1);
        readPos += Buffer.byteLength(text, "utf8");
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line) as { v: FourPackEvent };
            if (rec?.v?.at) {
              ring.push(rec.v);
              if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
            }
          } catch {
            /* torn line */
          }
        }
        hydratedAt = Date.now();
      } finally {
        await fh.close().catch(() => undefined);
      }
    } catch {
      /* non-fatal */
    } finally {
      lastRefreshAt = Date.now();
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function health(): FourPackHealth {
  const counts: Record<string, number> = {};
  const lastAt: Record<string, number> = {};
  for (const m of MODULES) {
    counts[m] = 0;
    lastAt[m] = 0;
  }
  for (const e of ring) {
    counts[e.module] = (counts[e.module] ?? 0) + 1;
    if (e.at > (lastAt[e.module] ?? 0)) lastAt[e.module] = e.at;
  }
  return { counts, lastAt, fileBytes: persisted, rotated: false };
}

async function writeLatest(): Promise<void> {
  try {
    const last: Record<string, FourPackEvent | null> = {};
    for (const m of MODULES) {
      const evs = ring.filter((e) => e.module === m);
      last[m] = evs.length ? evs[evs.length - 1]! : null;
    }
    const doc = { schemaVersion: 1, at: Date.now(), health: health(), last };
    const tmp = `${LATEST}.tmp`;
    await writeFile(tmp, JSON.stringify(doc), "utf8");
    await rename(tmp, LATEST).catch(async () => {
      await appendFile(LATEST, "").catch(() => undefined);
    });
  } catch {
    /* non-fatal */
  }
}

/** THE writer — called by R1/R2/R5/R6 cycle code and the operator-action route. */
export async function recordFourPack(
  module: FourPackModule,
  kind: FourPackKind,
  line: string,
  data?: Record<string, unknown>,
  verdict?: string | null,
): Promise<void> {
  try {
    await hydrate();
    await mkdir(DATA_DIR, { recursive: true }).catch(() => undefined);
    const ev: FourPackEvent = { at: Date.now(), module, kind, verdict: verdict ?? null, line: line.slice(0, 400), data };
    ring.push(ev);
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
    const rec = JSON.stringify({ k: module, v: ev }) + "\n";
    await appendFile(FILE, rec, "utf8");
    persisted += rec.length;
    readPos += rec.length; // our own bytes — never re-ingest
    if (persisted > FILE_MAX_BYTES) {
      await rename(FILE, `${FILE}.old`).catch(() => undefined);
      persisted = 0;
      readPos = 0;
    }
    void writeLatest();
  } catch {
    /* journaling must never break a governor cycle */
  }
}

/** Journal tail for API/UI — newest first. */
export async function getFourPackTail(limit = 60): Promise<FourPackEvent[]> {
  await fourpackRefresh();
  return ring.slice(-limit).reverse();
}

/** Full document for the JSON doctrine download. */
export async function getFourPackDoc(limit = 500): Promise<{ schemaVersion: number; generatedAt: string; health: FourPackHealth; events: FourPackEvent[] }> {
  await fourpackRefresh();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    health: health(),
    events: ring.slice(-limit).reverse(),
  };
}

/** AI-CORE GROUNDING — compact narrative the central intelligence studies
 * every cycle (mirrors svTelemetryNarrative). Journal-based: no circular
 * imports into the modules themselves. */
export async function fourpackNarrative(): Promise<string> {
  await fourpackRefresh();
  if (!ring.length) return "FOUR-PACK: journal empty — governor modules have not cycled yet this boot.";
  const parts: string[] = [];
  for (const m of ["r1-risk-governor", "r2-time-governor", "r5-ui-canary", "r6-senior-review"] as const) {
    const last = [...ring].reverse().find((e) => e.module === m);
    if (last) {
      const ago = Math.round((Date.now() - last.at) / 60_000);
      parts.push(`${m}:${last.kind}${last.verdict ? `=${last.verdict}` : ""} (${ago}m ago) ${last.line}`);
    } else {
      parts.push(`${m}: no journal event yet`);
    }
  }
  return `FOUR-PACK JOURNAL (${ring.length} events): ${parts.join(" | ")}`;
}
