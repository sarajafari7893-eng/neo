// ── FlowRadar Neo v10.2 SV-TELEMETRY HUB (server-only) ──────────
// Operator mandate 2026-09-15: «عملکرد و وضعیت Shadow veto را پیگیری کن تا
// داده‌های مورد نیاز به تمام بازوها سیم‌کشی و ارسال شود و بصورت جیسون فایل
// ذخیره و قابل بازیابی و استفاده باشد»
//
// One consolidated, versioned JSON document that tracks the shadow-veto
// subsystem end-to-end and is written to disk so EVERY consumer can retrieve
// and use it:
//   · per-arm feed wiring audit (real-keep / real-veto / paper-keep /
//     paper-veto): who feeds each arm, last fed/settled, starvation flags
//   · pipeline leak counters (real-link leaks, closure backlog, sweep state)
//   · wiring checks (adjudicator / real-link / closure / sweep / LLM)
//   · A/B arms + promotion evidence + config + health (live rings)
//   · history ring (compact samples, 24h) + alert ring with push delivery
//
// Storage: .data/shadow-veto-telemetry.json — atomic writes (tmp+rename),
// bounded size, survives rotation. Retrieval: GET /api/ai/shadow-veto/
// telemetry (serve or download) or read the file directly. Freshness: the
// engine tick calls captureSvTelemetry() every tick (self-throttled 10min),
// GET calls ensureFreshSvTelemetry() (15min staleness budget), POST forces.
//
// Push path: new alerts are fired to the operator relay + engine event tape
// (per-alert 6h cooldown) — data is not only stored, it is SENT. Fail-open
// everywhere: telemetry must never throw into the engine tick.
//
// NOTE (parallel-agent merge 2026-09-15): a second agent briefly shipped an
// overlapping tracker module and retired it to keep ONE capture pipeline.
// THIS module is the canonical SV telemetry surface — do not add a second
// snapshot builder; extend this one.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getShadowVetoState,
  shadowArmFeedDiagnostics,
  shadowPipelineDiag,
  type ArmFeedDiag,
  type ArmRow,
  type PromotionEvidence,
  type ShadowPipelineDiag,
  type ShadowVetoConfig,
  type ShadowVetoHealth,
  type ShadowVetoMode,
} from "@/lib/shadow-veto";

// ── types ─────────────────────────────────────────────────────

export interface SvArmTelemetry extends ArmFeedDiag {
  label: string;
  n: number;
  target: number;
  fillPct: number;
  wins: number;
  winRatePct: number | null;
  wilsonLB: number | null;
  netUsd: number;
}

export interface SvWiringCheck {
  ok: boolean;
  detail: string;
}

export interface SvAlert {
  id: string;
  at: number;
  level: "warn" | "info";
  text: string;
  delivered: boolean;
}

export interface SvHistorySample {
  t: number;
  mode: ShadowVetoMode;
  verdicts: number;
  papers: number;
  arms: Array<{ id: string; n: number; netUsd: number; winRatePct: number | null }>;
}

export interface SvTelemetrySnapshot {
  schemaVersion: 1;
  capturedAt: number;
  captureMs: number;
  mode: ShadowVetoMode;
  config: ShadowVetoConfig;
  stats: {
    total: number;
    passSide: number;
    rejectSide: number;
    vetoCount: number;
    tradeCount: number;
    modelSharePct: number | null;
    modelGroundedPct: number | null;
    avgConfidence: number | null;
    gateAgreement: number;
    paperOpen: number;
    paperSettled: number;
    recent24h: { n: number; modelSharePct: number | null; lastModelAgeH: number | null; lastVerdictAgeH: number | null };
  };
  arms: SvArmTelemetry[];
  wiring: {
    adjudicator: SvWiringCheck;
    realLink: SvWiringCheck;
    outcomeClosure: SvWiringCheck;
    paperSweep: SvWiringCheck;
    llm: SvWiringCheck & { cooling: boolean; consecutive429: number };
    pipeline: ShadowPipelineDiag;
  };
  promotion: PromotionEvidence;
  health: ShadowVetoHealth;
  store: { file: string; fileKB: number; historySamples: number; lastCaptureAt: number; writes: number };
  alerts: SvAlert[];
  history: SvHistorySample[];
}

// ── storage ───────────────────────────────────────────────────

const TEL_DIR = path.join(process.cwd(), ".data");
const TEL_FILE = path.join(TEL_DIR, "shadow-veto-telemetry.json");
const HISTORY_CAP = 144; // 24h at 10min cadence
const ALERT_CAP = 24;
const CAPTURE_MIN_INTERVAL_MS = 10 * 60_000;
const PUSH_COOLDOWN_MS = 6 * 3600_000;

let lastCaptureAt = 0;
let capturing: Promise<SvTelemetrySnapshot | null> | null = null;
let cached: SvTelemetrySnapshot | null = null;
let writes = 0;

function agoShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

async function readStore(): Promise<SvTelemetrySnapshot | null> {
  try {
    const buf = await readFile(TEL_FILE, "utf8");
    const parsed = JSON.parse(buf) as SvTelemetrySnapshot;
    if (parsed && parsed.schemaVersion === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function writeStore(snap: SvTelemetrySnapshot): Promise<void> {
  try {
    await mkdir(TEL_DIR, { recursive: true });
    // v10.6.1 persist-guard (operator APPROVE): serialize snapshot writes and
    // stamp the monotonic watermark so a stale module generation can never
    // regress the snapshot with an older derived view.
    const { persistWatermark, serializePersist } = await import("./persist-guard");
    await serializePersist("sv-telemetry", async () => {
      const tmp = `${TEL_FILE}.tmp`;
      await writeFile(tmp, JSON.stringify(snap), "utf8");
      await rename(tmp, TEL_FILE); // atomic — readers never see a torn file
      await persistWatermark("sv-telemetry");
      writes++;
    });
  } catch {
    /* non-fatal — telemetry must never break the engine */
  }
}

// ── arm merge: live arm numbers × feed diagnostics ────────────

function mergeArms(arms: ArmRow[], feeds: ArmFeedDiag[]): SvArmTelemetry[] {
  const byId = new Map(feeds.map((f) => [f.id, f]));
  return arms.map((a) => {
    const f = byId.get(a.id);
    return {
      id: a.id,
      label: a.label,
      feedSource: f?.feedSource ?? "n/a",
      n: a.n,
      target: a.target,
      fillPct: Math.min(100, Number(((a.n / a.target) * 100).toFixed(1))),
      wins: a.wins,
      winRatePct: a.winRatePct,
      wilsonLB: a.wilsonLB,
      netUsd: a.netUsd,
      fed: f?.fed ?? 0,
      open: f?.open ?? 0,
      settled: f?.settled ?? 0,
      lastFedAt: f?.lastFedAt ?? 0,
      lastSettledAt: f?.lastSettledAt ?? 0,
      neverFed: f?.neverFed ?? true,
      starved: f?.starved ?? false,
      starveDetail: f?.starveDetail ?? null,
    };
  });
}

// ── alert evaluation (delta vs previous snapshot) ─────────────

function evaluateAlerts(prev: SvTelemetrySnapshot | null, next: SvTelemetrySnapshot): SvAlert[] {
  const now = Date.now();
  const prevById = new Map((prev?.alerts ?? []).map((a) => [a.id, a]));
  const out: SvAlert[] = [];

  const push = (id: string, level: SvAlert["level"], text: string) => {
    const p = prevById.get(id);
    // re-arm only after the cooldown; unchanged alerts keep their original at
    if (p && now - p.at < PUSH_COOLDOWN_MS) {
      out.push(p);
      return;
    }
    out.push({ id, at: now, level, text, delivered: false });
  };

  if (next.mode !== "off") {
    // arm starvation — only for arms that HAVE been fed before (never-fed is
    // the wired-but-idle state, not a fault; it is visible, not pushed)
    for (const a of next.arms) {
      if (a.starved) {
        push(`arm-starve:${a.id}`, "warn", `SHADOW-VETO arm feed starved — ${a.id} (${a.label}): nothing new for ${agoShort(now - a.lastFedAt)} while adjudicator active. ${a.starveDetail ?? ""}`);
      }
      // never-fed REAL arms while adjudication is flowing deserve one info
      if (a.neverFed && a.id.startsWith("real") && next.wiring.pipeline.verdicts24h > 0) {
        push(`arm-idle:${a.id}`, "info", `SHADOW-VETO arm idle — ${a.id} never fed, yet ${next.wiring.pipeline.verdicts24h} verdicts in 24h. Feed is wired; qualifying records (fence events) just have not occurred.`);
      }
    }
    // REAL-arm link leak — v10.19: ACTIVE leaks only (stale unlinked, not swept
    // orphan, within reach). Orphans/aged are structural, promotion-inert.
    const prevStale = prev?.wiring.pipeline.unlinkedPassStale ?? 0;
    if (next.wiring.pipeline.unlinkedPassStale > prevStale) {
      push("link-leak", "warn", `SHADOW-VETO REAL-arm ACTIVE link leak — ${next.wiring.pipeline.unlinkedPassStale} unlinked PASS verdict(s) within link reach (was ${prevStale}). Evidence may be under-linked; retro-link sweep + orphan stamping (v10.19) keep this count honest.`);
    }
    // closure backlog — linked verdicts waiting for the settlement sweep
    if (next.wiring.pipeline.pendingRealOutcomes > 5) {
      push("closure-backlog", "warn", `SHADOW-VETO closure backlog — ${next.wiring.pipeline.pendingRealOutcomes} linked verdicts awaiting outcome closure (sweep closes 40/round every 40 ticks).`);
    }
  }

  // promotion readiness edge — announced once per transition
  if (next.promotion.ready && prev && !prev.promotion.ready) {
    push("promotion-ready", "info", "SHADOW-VETO promotion evidence gate now READY (arms filled with Wilson-LB separation + negative would-veto net). Auto-promotion watchdog will flip mode=veto on its next check.");
  }

  // keep recent prev alerts this capture no longer re-evaluates (ring continuity)
  for (const a of prev?.alerts ?? []) {
    if (!out.some((x) => x.id === a.id) && now - a.at < 24 * 3600_000) out.push(a);
  }
  return out.sort((a, b) => b.at - a.at).slice(0, ALERT_CAP);
}

async function deliverNewAlerts(alerts: SvAlert[]): Promise<void> {
  const fresh = alerts.filter((a) => !a.delivered);
  if (fresh.length === 0) return;
  for (const a of fresh) {
    a.delivered = true; // mark first — delivery is best-effort, never retried into spam
    try {
      const [engine, notify] = await Promise.all([import("@/lib/engine"), import("@/lib/notify")]);
      void engine.fireEvent(null, null, "SYSTEM", a.level === "warn" ? "warn" : "info", a.text).catch(() => undefined);
      await notify.sendDirect(a.text).catch(() => undefined);
    } catch {
      /* push is best-effort */
    }
  }
}

// ── capture ───────────────────────────────────────────────────

/** Build one telemetry snapshot from the live rings + pipeline diagnostics,
 * merge with the previous store (history + alert continuity), atomically
 * persist, and push any NEW alerts. Never throws. */
export async function captureSvTelemetry(force = false): Promise<SvTelemetrySnapshot | null> {
  if (!force && Date.now() - lastCaptureAt < CAPTURE_MIN_INTERVAL_MS) return cached ?? (await readStore());
  if (capturing) return capturing;
  capturing = (async () => {
    const t0 = Date.now();
    try {
      const s = await getShadowVetoState(); // refreshes rings + config (cached) — no direct DB hits here
      const pipeline = shadowPipelineDiag();
      const feeds = shadowArmFeedDiagnostics(s.config.mode);
      const arms = mergeArms(s.arms, feeds);
      const llmMod = await import("@/lib/ai").catch(() => null);
      const llm = llmMod ? llmMod.llmHealth() : { cooling: false, cooldownRemainsMs: 0, consecutive429: 0, lastOkAt: null };

      const lastVerdictAgo = pipeline.lastVerdictAt ? Date.now() - pipeline.lastVerdictAt : Infinity;
      const wiring: SvTelemetrySnapshot["wiring"] = {
        adjudicator: {
          ok: pipeline.lastVerdictAt === 0 || lastVerdictAgo < 24 * 3600_000,
          detail: pipeline.lastVerdictAt === 0 ? "no adjudications yet (wired, awaiting first fence candidate)" : `last verdict ${agoShort(lastVerdictAgo)} · budget ${s.health.callsLastHour}/${s.config.budgetPerHour}·h · pending ${s.health.pending}`,
        },
        realLink: {
          ok: pipeline.unlinkedPassStale === 0,
          detail: pipeline.unlinkedPassStale === 0
            ? `link integrity OK — ${pipeline.unlinkedPass24h} recent within reach · ${pipeline.unlinkedPassOrphan} swept orphan(s) · ${pipeline.unlinkedPassAged} aged out (v10.19)`
            : `${pipeline.unlinkedPassStale} ACTIVE link leak(s) — stale unlinked PASS verdict(s) with reachable deploys (orphans swept: ${pipeline.unlinkedPassOrphan} · aged out: ${pipeline.unlinkedPassAged})`,
        },
        outcomeClosure: {
          ok: pipeline.pendingRealOutcomes <= 5,
          detail: `${pipeline.pendingRealOutcomes} linked verdict(s) awaiting settlement closure (sweep every 40 ticks, batch 40)`,
        },
        paperSweep: {
          ok: true,
          detail: `${pipeline.pendingPapers} paper position(s) open · ${s.stats.paperSettled} settled · last paper opened ${pipeline.lastPaperOpenAt ? agoShort(Date.now() - pipeline.lastPaperOpenAt) : "never"}`,
        },
        llm: {
          ok: !llm.cooling,
          cooling: llm.cooling,
          consecutive429: llm.consecutive429,
          detail: llm.cooling ? `429 budget shield active ${Math.ceil(llm.cooldownRemainsMs / 1000)}s (MODEL verdicts parked, heuristic speaks)` : llm.consecutive429 > 0 ? `link recovering (×${llm.consecutive429} 429s)` : "LLM link healthy",
        },
        pipeline,
      };

      const prev = cached ?? (await readStore());
      const alerts = evaluateAlerts(prev, { ...emptyShell(), mode: s.config.mode, arms, promotion: s.promotion, wiring } as SvTelemetrySnapshot);

      // history sample — replace near-duplicate (multi-instance double capture)
      const hist = (prev?.history ?? []).filter((h) => t0 - h.t > 5 * 60_000);
      hist.push({
        t: t0,
        mode: s.config.mode,
        verdicts: s.health.verdicts,
        papers: s.health.papers,
        arms: arms.map((a) => ({ id: a.id, n: a.n, netUsd: a.netUsd, winRatePct: a.winRatePct })),
      });

      const snap: SvTelemetrySnapshot = {
        schemaVersion: 1,
        capturedAt: t0,
        captureMs: Date.now() - t0,
        mode: s.config.mode,
        config: s.config,
        stats: s.stats,
        arms,
        wiring,
        promotion: s.promotion,
        health: s.health,
        store: { file: ".data/shadow-veto-telemetry.json", fileKB: 0, historySamples: hist.length, lastCaptureAt: t0, writes: writes + 1 },
        alerts: alerts.slice(0, ALERT_CAP),
        history: hist.slice(-HISTORY_CAP),
      };
      snap.store.fileKB = Math.round(JSON.stringify(snap).length / 1024);

      await writeStore(snap);
      cached = snap;
      lastCaptureAt = t0;
      void deliverNewAlerts(snap.alerts).catch(() => undefined); // push path — fire and forget
      return snap;
    } catch {
      return null; // telemetry must never break the engine tick
    } finally {
      capturing = null;
    }
  })();
  return capturing;
}

function emptyShell(): SvTelemetrySnapshot {
  // minimal shape so evaluateAlerts can be called before the full snapshot exists
  return {
    schemaVersion: 1,
    capturedAt: 0,
    captureMs: 0,
    mode: "shadow",
    config: {} as ShadowVetoConfig,
    stats: { total: 0, passSide: 0, rejectSide: 0, vetoCount: 0, tradeCount: 0, modelSharePct: null, modelGroundedPct: null, avgConfidence: null, gateAgreement: 0, paperOpen: 0, paperSettled: 0, recent24h: { n: 0, modelSharePct: null, lastModelAgeH: null, lastVerdictAgeH: null } },
    arms: [],
    wiring: {
      adjudicator: { ok: true, detail: "" },
      realLink: { ok: true, detail: "" },
      outcomeClosure: { ok: true, detail: "" },
      paperSweep: { ok: true, detail: "" },
      llm: { ok: true, cooling: false, consecutive429: 0, detail: "" },
      pipeline: { unlinkedPass24h: 0, unlinkedPassStale: 0, unlinkedPassOrphan: 0, unlinkedPassAged: 0, pendingRealOutcomes: 0, pendingPapers: 0, lastVerdictAt: 0, lastPaperOpenAt: 0, verdicts24h: 0, papers24h: 0 },
    },
    promotion: { ready: false, criteria: [], revocation: { pressure: false, detail: "" }, sequential: { state: "CONTINUE" as const, z: null, boundary: null, infoFrac: null, alphaSpent: null, dPct: null, minNMet: false, detail: "", checkedAt: 0 } },
    health: { verdicts: 0, papers: 0, fileKB: 0, pending: 0, callsLastHour: 0, auditViolations: 0, hydratedAt: 0 },
    store: { file: TEL_FILE, fileKB: 0, historySamples: 0, lastCaptureAt: 0, writes: 0 },
    alerts: [],
    history: [],
  };
}

// ── retrieval ─────────────────────────────────────────────────

/** Read the persisted snapshot — file is the source of truth, cache is a
 * fast-path. Returns null only if nothing has ever been captured. */
export async function getSvTelemetry(): Promise<SvTelemetrySnapshot | null> {
  if (cached && cached.capturedAt >= lastCaptureAt) {
    const st = await stat(TEL_FILE).catch(() => null);
    if (st && st.mtimeMs <= cached.capturedAt + 5_000) return cached;
  }
  const fromDisk = await readStore();
  if (fromDisk) cached = fromDisk;
  return fromDisk;
}

/** GET-path freshness: serve the file, but if it is missing or older than
 * 15min, trigger a (throttled) capture first — retrieval stays cheap and the
 * document never goes silently stale. */
export async function ensureFreshSvTelemetry(): Promise<SvTelemetrySnapshot | null> {
  const st = await stat(TEL_FILE).catch(() => null);
  if (!st) return captureSvTelemetry(true);
  if (Date.now() - st.mtimeMs > 15 * 60_000) return (await captureSvTelemetry(false)) ?? getSvTelemetry();
  return getSvTelemetry();
}

/** Two-line narrative for the verdict-core grounding bundle — the core itself
 * becomes a consumer of the telemetry (it studies its own feed wiring). */
export async function svTelemetryNarrative(): Promise<string> {
  const snap = await ensureFreshSvTelemetry();
  if (!snap) return "SV-TELEMETRY: unavailable this cycle.";
  const armsLine = snap.arms.map((a) => `${a.id} ${a.n}/${a.target}${a.neverFed ? " (idle)" : a.starved ? " STARVED" : ` fed ${agoShort(Date.now() - a.lastFedAt)} ago`}`).join(" · ");
  const wires = [snap.wiring.adjudicator, snap.wiring.realLink, snap.wiring.outcomeClosure, snap.wiring.paperSweep];
  const bad = wires.filter((w) => !w.ok).length;
  const openAlerts = snap.alerts.filter((a) => Date.now() - a.at < PUSH_COOLDOWN_MS).length;
  return `SV-TELEMETRY: wiring ${bad === 0 ? "ALL-OK" : `${bad} check(s) failing`} · ${armsLine} · alerts open ${openAlerts} · snapshot ${agoShort(Date.now() - snap.capturedAt)} ago (.data/shadow-veto-telemetry.json v${snap.schemaVersion}).`;
}
