// ── NEXUS//AI — LLM bridge (server-only) ──
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import ZAI from "z-ai-web-dev-sdk";
import { makeLlmClient, providerName } from "./llm-provider";
import { auditGrounding, findMockMarkers, type GroundingAudit } from "./veracity";
import { getAiSettings, THOUGHT_CHANNELS } from "./ai-settings";

// ── v6.7.4 THOUGHT-CORE — operator-upgradeable reasoning mode ──
// Every judgment channel resolves its `thinking` parameter through ONE helper
// backed by the operator-owned EngineSetting key "ai" (default ON). The
// deep-learn research desk is hard-wired to thought (it IS the thought
// channel); the symbol scanner stays fast by contract. Fails open to the
// per-channel default so a settings hiccup never bricks the AI stack.
type ThinkingParam = { type: "enabled" | "disabled" };
const THOUGHT: ThinkingParam = { type: "enabled" };
const FAST: ThinkingParam = { type: "disabled" };

export async function resolveThinking(channel: keyof typeof THOUGHT_CHANNELS | "deep-learn"): Promise<ThinkingParam> {
  try {
    const ai = await getAiSettings();
    const follows = THOUGHT_CHANNELS[channel] ?? false;
    return ai.thoughtMode === 1 && follows ? THOUGHT : FAST;
  } catch {
    return THOUGHT_CHANNELS[channel] ? THOUGHT : FAST;
  }
}

// ── v6.0 VERACITY WIRING — «هیچ توهم و شبیه سازی انجام نشه» ──
// EVERY model output is (a) recorded into the supervisor's outcome ring and
// (b) grounding-audited number-by-number against the measured bundle it saw.
// VIOLATION verdicts become audited HALLUCINATION findings; analyst-chat
// replies additionally get an operator-visible honesty footnote.
function reportOutcome(source: string, outcome: "MODEL" | "HEURISTIC" | "ERROR", detail?: string): void {
  void import("./supervisor")
    .then((m) => m.noteLlmOutcome(source, outcome, detail))
    .catch(() => undefined);
}
function reportAudit(source: string, bundle: string, response: string): void {
  try {
    const audit = auditGrounding(bundle, response);
    void import("./supervisor")
      .then((m) => m.noteGroundingAudit(source, audit))
      .catch(() => undefined);
  } catch {
    /* audit must never break the bridge */
  }
}

const SYSTEM_ANALYST = `You are FLOWRADAR-AI, the elite crypto market analyst of FlowRadar Neo inside a professional trading signal terminal.
Rules:
- LANGUAGE: always reply in the SAME language as the operator's last message (Persian/Farsi if they write in Persian, English if they write in English).
- CLARITY FIRST: open with a ONE-sentence direct answer, then the numbers behind it. No filler, no hedging boilerplate.
- GROUNDED: when a LIVE TELEMETRY bundle is present, cite ONLY numbers from it (they are measured in real time). If a number is not in the bundle, say the live feed does not cover it — NEVER guess from training data and NEVER present recalled figures as live.
- Be precise and quantitative. Use trading terminology (liquidity, CVD, funding, OI, structure).
- Never give financial advice guarantees; this is simulated analytics.
- Keep answers under 180 words unless asked otherwise.
- Format with short paragraphs or bullet lines. No markdown headers, plain text with "•" bullets is fine.`;

// v5.2 TOKEN RESILIENCE — root-cause fix for "analyst lost its neural link":
// the platform rotates /etc/.z-ai-config periodically, but the SDK singleton
// cached the OLD token forever → every call 401'd (missing/invalid X-Token)
// and the whole AI stack silently degraded to heuristics. Now: (a) the config
// file mtime is watched — a rotated token transparently re-creates the client;
// (b) any 401/X-Token failure triggers one forced reload + retry.
let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null;
let zaiStamp = "";

async function configStamp(): Promise<string> {
  const paths = [path.join(process.cwd(), ".z-ai-config"), path.join(os.homedir(), ".z-ai-config"), "/etc/.z-ai-config"];
  for (const p of paths) {
    try {
      const st = await fs.stat(p);
      return `${p}:${Math.round(st.mtimeMs)}`;
    } catch {
      /* try next */
    }
  }
  return "";
}

async function getZAI(force = false): Promise<Awaited<ReturnType<typeof ZAI.create>>> {
  // SELFHOST-0929: provider switch — LLM_PROVIDER=openai routes EVERY channel
  // (analyst / signal-brief / governor / probe) through any OpenAI-compatible
  // backend via the shape-compatible shim; zaidev (default) keeps the platform
  // SDK. Call sites untouched by design.
  const stamp = providerName() === "openai" ? "openai" : await configStamp();
  if (!force && zaiInstance && stamp === zaiStamp) return zaiInstance;
  zaiInstance = (await makeLlmClient()) as unknown as Awaited<ReturnType<typeof ZAI.create>>;
  zaiStamp = stamp;
  return zaiInstance;
}

/** Invalidate the cached client (called by the supervisor on LLM health alerts). */
export function invalidateZai(): void {
  zaiInstance = null;
  zaiStamp = "";
}
function retriableAuth(err: unknown): boolean {
  const m = String(err);
  return m.includes("401") || m.includes("X-Token") || m.includes("token");
}

/** Run an SDK call with transparent token-rotation recovery (retry once) and a
 * HARD TIMEOUT — v5.4 hardening: the deep-learn research call (thinking mode)
 * hung indefinitely and wedged the whole POST route; every AI call is now
 * capped (default 90s) so callers fall back to their heuristic paths. */
const AI_CALL_TIMEOUT_MS = Number(process.env.AI_CALL_TIMEOUT_MS ?? 90_000);

// v8.4.1 429 BUDGET SHIELD — root-cause fix for "Neural link degraded" —
// v12.7 SENTINEL-20261020 (operator P2-a mandate): cap raised 10m → 30m. The
// provider throttle episodes observed 2026-10-20 outlasted the 10m ceiling, so
// the shield kept re-opening every ~10min and the log printed 118× 429 inside
// a 2000-line window. Env-overridable for drills; hard floor 60s.
// The platform rate-limits the LLM API (HTTP 429). Background consumers
// (shadow-veto adjudication, governor, deep-learn, symbol analysis) were
// hammering a throttled API 24/7 — 1700+ 429s in one log — which starved the
// OPERATOR-facing calls (analyst chat, card briefs) and produced the
// degraded-neural-link state. Doctrine: the operator comes FIRST. On a 429 a
// global escalating cooldown opens; background-tier calls fail FAST (their
// callers already have honest heuristic fallbacks) instead of burning quota;
// operator-tier calls still attempt through the cooldown.
let llm429Until = 0;
let llm429Streak = 0;
let lastLlmOkAt = 0;
const LLM_COOLDOWN_CAP_MS = Math.max(60_000, Number(process.env.LLM_COOLDOWN_CAP_MS ?? 30 * 60_000));

// v8.4.1 BG BUDGET — proactive HOURLY cap for background-tier calls. The 429
// shield is reactive (opens AFTER the provider throttles us); this cap is
// preventive: shadow adjudication + governor + symbol-scan + deep-learn share
// one hard hourly budget, so the provider quota never starves and the
// OPERATOR tier (aiChat / card briefs) always has headroom. Reactive +
// preventive together = a stable neural link instead of 429 storms.
const BG_BUDGET_PER_HOUR = Math.max(4, Number(process.env.LLM_BG_BUDGET_PER_HOUR ?? 24));
let bgHourBucket = Math.floor(Date.now() / 3_600_000);
let bgCallsThisHour = 0;

function is429(err: unknown): boolean {
  const m = String(err);
  return m.includes("429") || m.toLowerCase().includes("too many requests");
}

function note429(): void {
  // v8.4.1 N5 — escalation hygiene: a 429 observed INSIDE an open cooldown
  // window must not extend or escalate it. Operator-tier attempts (and the N3
  // probe) legitimately pass through the window; without this guard each such
  // attempt inflated the streak and pushed recovery further away — the exact
  // "429 COOLDOWN 37s → 240s → 8m" treadmill the operator reported.
  if (Date.now() < llm429Until) {
    console.warn(`[ai] 429 inside open cooldown window — window keeps its course (streak ${llm429Streak}, no escalation)`);
    return;
  }
  llm429Streak += 1;
  const cd = Math.min(30_000 * Math.pow(2, llm429Streak - 1), LLM_COOLDOWN_CAP_MS); // 30s→60s→2m→4m→8m→…→30m cap (v12.7)
  llm429Until = Date.now() + cd;
  console.warn(`[ai] 429 budget shield: cooldown ${Math.round(cd / 1000)}s (streak ${llm429Streak}) — background tier parked, operator tier protected`);
}

function noteLlmOk(): void {
  llm429Streak = 0;
  llm429Until = 0;
  lastLlmOkAt = Date.now();
}

/** Live LLM health for the supervisor/UI — is the neural link cooling down? */
export function llmHealth(): { cooling: boolean; cooldownRemainsMs: number; consecutive429: number; lastOkAt: number | null; bgUsed: number; bgBudget: number } {
  const now = Date.now();
  const cooling = now < llm429Until;
  const bucket = Math.floor(now / 3_600_000);
  const bgUsed = bucket === bgHourBucket ? bgCallsThisHour : 0;
  return { cooling, cooldownRemainsMs: cooling ? llm429Until - now : 0, consecutive429: llm429Streak, lastOkAt: lastLlmOkAt || null, bgUsed, bgBudget: BG_BUDGET_PER_HOUR };
}

// v8.4.1 N3 — ACTIVE RECOVERY PROBE: the shield is passive (it only learns
// the link is back when real traffic happens to fire). The probe makes
// recovery ACTIVE: one minimal "pong" call punches through the cooldown
// (operator-tier semantics — the probe exists to test THROUGH the window);
// success resets the shield instantly so MODEL verdicts resume without
// waiting for the next natural call. Auto-probe rides the engine tick every
// 5min while the link is cooling or no call has succeeded in 15min.
let probeInFlight = false;
let lastProbeAt = 0;
let lastAutoProbeAt = 0;
const PROBE_MIN_SPACING_MS = 120_000; // manual/API probes: ≥1 per 2min
const AUTO_PROBE_SPACING_MS = 300_000; // background probes: ≥1 per 5min
const AUTO_PROBE_IDLE_MS = 900_000; // auto-probe when no OK for 15min (or cooling)

export async function probeNeuralLink(): Promise<{ ok: boolean; detail: string; health: ReturnType<typeof llmHealth> }> {
  const now = Date.now();
  if (probeInFlight) return { ok: false, detail: "probe already in flight", health: llmHealth() };
  if (now - lastProbeAt < PROBE_MIN_SPACING_MS)
    return { ok: false, detail: `probe spacing — retry in ${Math.ceil((PROBE_MIN_SPACING_MS - (now - lastProbeAt)) / 1000)}s`, health: llmHealth() };
  probeInFlight = true;
  lastProbeAt = now;
  try {
    const zai = await getZAI();
    await Promise.race([
      zai.chat.completions.create({ messages: [{ role: "user", content: "Reply with exactly: pong" }] }),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`probe timeout after ${AI_CALL_TIMEOUT_MS}ms`)), AI_CALL_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    noteLlmOk();
    console.log("[ai] neural probe OK — link restored, 429 shield reset");
    return { ok: true, detail: "pong — neural link OK", health: llmHealth() };
  } catch (err) {
    if (is429(err)) note429(); // N5 decides whether this escalates (in-window → no)
    const detail = String(err).slice(0, 140);
    console.warn(`[ai] neural probe failed: ${detail}`);
    return { ok: false, detail, health: llmHealth() };
  } finally {
    probeInFlight = false;
  }
}

/** Engine-tick hook: one cheap probe per 5min while the link is degraded.
 * Returns null when the probe did not run (spacing/healthy-skip). */
export async function maybeNeuralAutoProbe(): Promise<{ ok: boolean } | null> {
  try {
    const now = Date.now();
    const h = llmHealth();
    const idle = !h.lastOkAt || now - h.lastOkAt > AUTO_PROBE_IDLE_MS;
    if (!h.cooling && !idle) return null;
    // v12.7 SENTINEL-20261020 probe tail-gating: the probe is the only caller
    // that legitimately punches through an open cooldown — but a mid-window
    // probe carries zero information (the window is already committed) and
    // every one of them printed a 429 line. Probe only near the window TAIL
    // (≤90s remaining) so recovery is still detected promptly while failed
    // probes drop from ~2/window to ≤1/window.
    if (h.cooling && h.cooldownRemainsMs > 90_000) return null;
    if (now - lastAutoProbeAt < AUTO_PROBE_SPACING_MS) return null;
    lastAutoProbeAt = now;
    const r = await probeNeuralLink();
    return { ok: r.ok };
  } catch {
    return null;
  }
}

// v10.16 audit: true while the watchdog memory-action lease is fresh (<10min).
// Both watchdog layers write .data/ai/background-suspend under OOM proximity.
function memSuspendActive(): boolean {
  try {
    const raw = fsSync.readFileSync(path.join(process.cwd(), ".data", "ai", "background-suspend"), "utf8").trim();
    const until = parseInt(raw, 10);
    return Number.isFinite(until) && Date.now() / 1000 < until;
  } catch {
    return false;
  }
}

async function withZai<T>(fn: (zai: Awaited<ReturnType<typeof ZAI.create>>) => Promise<T>, opts?: { tier?: "operator" | "background" }): Promise<T> {
  if (opts?.tier === "background" && Date.now() < llm429Until) {
    throw new Error(`LLM 429-cooldown ${Math.ceil((llm429Until - Date.now()) / 1000)}s — background call skipped, heuristic tier`);
  }
  // v10.16 audit (watchdog memory-action channel): under OOM-proximity pressure
  // both watchdog layers write .data/ai/background-suspend (10min lease) — the
  // background tier fails fast so the box keeps RAM for the serving paths.
  if (opts?.tier === "background" && memSuspendActive()) {
    throw new Error("memory-pressure suspend active (.data/ai/background-suspend) — background LLM call skipped, heuristic tier");
  }
  if (opts?.tier === "background") {
    const bucket = Math.floor(Date.now() / 3_600_000);
    if (bucket !== bgHourBucket) {
      bgHourBucket = bucket;
      bgCallsThisHour = 0;
    }
    if (bgCallsThisHour >= BG_BUDGET_PER_HOUR) {
      throw new Error(`LLM background budget exhausted (${bgCallsThisHour}/${BG_BUDGET_PER_HOUR} this hour) — call skipped, heuristic tier`);
    }
    bgCallsThisHour += 1;
  }
  const attempt = async (): Promise<T> => {
    const zai = await getZAI();
    return Promise.race([
      fn(zai),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`AI call timeout after ${AI_CALL_TIMEOUT_MS}ms`)), AI_CALL_TIMEOUT_MS);
        t.unref?.();
      }),
    ]) as Promise<T>;
  };
  let result: T;
  try {
    result = await attempt();
  } catch (err) {
    if (is429(err)) note429();
    if (retriableAuth(err)) {
      console.warn("[ai] auth failure — reloading rotated .z-ai-config and retrying once");
      try {
        result = await attempt();
      } catch (retryErr) {
        if (is429(retryErr)) note429();
        // escalate to the AI SUPERVISOR (dynamic import — avoids ai↔supervisor cycle)
        void import("./supervisor")
          .then((m) => m.noteLlmAuthFailure())
          .catch(() => undefined);
        throw retryErr;
      }
    } else {
      throw err;
    }
  }
  noteLlmOk();
  return result;
}

/** Free-form chat with the AI analyst (optional verified-memory grounding) */
export async function aiChat(messages: Array<{ role: "user" | "assistant"; content: string }>, grounding?: string): Promise<string> {
  try {
    const completion = await withZai(async (zai) =>
      zai.chat.completions.create({
        messages: [{ role: "assistant", content: grounding ? `${SYSTEM_ANALYST}\n\n${grounding}` : SYSTEM_ANALYST }, ...messages.slice(-10)],
        thinking: await resolveThinking("analyst-chat"),
      }), { tier: "operator" }
    );
    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("empty completion");
    reportOutcome("analyst-chat", "MODEL");
    if (grounding) {
      try {
        const audit = auditGrounding(grounding, content);
        void import("./supervisor")
          .then((m) => m.noteGroundingAudit("analyst-chat", audit))
          .catch(() => undefined);
        if (audit.verdict === "VIOLATION") {
          return `${content}\n\n⚠ HONESTY AUDIT: ${audit.unmatched.length} numbers in this reply were not found in the live telemetry bundle — treat them as unverified (flagged to the AI supervisor).`;
        }
      } catch {
        /* audit must never break the chat */
      }
    }
    return content;
  } catch (err) {
    console.error("[aiChat]", err);
    reportOutcome("analyst-chat", "ERROR", String(err).slice(0, 120));
    return "⚠ Neural link degraded — analysis core unreachable. Retry shortly, operator. Local heuristics suggest monitoring funding rates and liquidity pools around recent session extremes.";
  }
}

/** Per-card AI brief — answers against a specific serial (NX-xxxx) with hard grounding. */
export interface CardBrief {
  action: "HOLD" | "CLOSE" | "PARTIAL";
  conviction: number;
  summary: string;
  risk: string;
  label: "MODEL" | "HEURISTIC";
}

export async function aiSignalBrief(grounding: string): Promise<CardBrief> {
  try {
    const completion = await withZai(async (zai) =>
      zai.chat.completions.create({
        messages: [
          { role: "assistant", content: `${SYSTEM_ANALYST}\nYou are scanning ONE deployed signal card. Respond with ONLY valid JSON, no code fences: {"action":"HOLD|CLOSE|PARTIAL","conviction":<0-100>,"summary":"<3-4 sentences: open with the serial, cite measured numbers>","risk":"<one sentence>"}\n${grounding}` },
          { role: "user", content: "Scan this card now. Use ONLY the context numbers." },
        ],
        thinking: await resolveThinking("card-brief"),
      }), { tier: "operator" }
    );
    const raw = completion.choices[0]?.message?.content ?? "";
    const json = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(json);
    const action = ["HOLD", "CLOSE", "PARTIAL"].includes(parsed.action) ? parsed.action : "HOLD";
    const summary = String(parsed.summary ?? "").slice(0, 800);
    const risk = String(parsed.risk ?? "").slice(0, 300);
    reportOutcome("card-brief", "MODEL");
    reportAudit("card-brief", grounding, `${summary} ${risk}`);
    return { action, conviction: Math.max(0, Math.min(100, Number(parsed.conviction) || 50)), summary, risk, label: "MODEL" };
  } catch (err) {
    console.error("[aiSignalBrief] fallback", err);
    reportOutcome("card-brief", "HEURISTIC", String(err).slice(0, 120));
    return { action: "HOLD", conviction: 50, summary: "Neural link degraded — heuristic scan only. Context numbers below remain authoritative.", risk: "Model unavailable; rely on measured levels and TTL.", label: "HEURISTIC" };
  }
}

/** AI GOVERNOR — grounded decision loop (v5.0). The LLM is a real operator
 *  over the engine: it receives ONLY measured system telemetry and returns
 *  strict decisions that the core validates, clamps, applies and audits. */
export interface GovernorDecision {
  action: "set_min_score" | "set_flow_veto" | "set_flow_shortlist" | "set_universe" | "set_ttl_extend_max" | "set_ttl_extend_minutes" | "set_ttl_near_tp" | "set_sl_atr_mult" | "set_rr_scale" | "set_regime_guard" | "set_max_active" | "set_risk_per_trade" | "run_backtest" | "run_autotune" | "no_op";
  value?: number;
  rationale: string;
}

export interface GovernorLlmResult {
  decisions: GovernorDecision[];
  label: "MODEL" | "HEURISTIC";
}

// tier marked at each call site below
export async function aiGovernorDecisions(context: string, heuristicFallback: GovernorDecision[]): Promise<GovernorLlmResult> {
  try {
    const completion = await withZai(async (zai) =>
      zai.chat.completions.create({
        messages: [
          {
            role: "assistant",
            content: `${SYSTEM_ANALYST}
You are now the AI GOVERNOR of this trading engine — an autonomous analyst wired into the system core.
You receive a GROUNDED telemetry bundle (every number is measured, none invented). Your job: decide how the engine's deployment gates should change to IMPROVE learned performance.
Rules of engagement:
- You may run at most ${3 /* v10.16 prompt fix: was the literal string "maxActions"; this is the REAL cap enforced below via decisions.slice(0, 3) (governor applies its own cfg.maxActions on top) */} actions; prefer precision over activity; no_op is a valid, often correct decision.
- set_min_score: raise when realized WR/backtest expectancy is poor (trade less, filter harder); lower only when evidence is MARGINAL and sample sizes are decent.
- set_flow_veto: raise (stricter) when flow-confirmed deploys still lose; lower when good setups get vetoed by marginal flow.
- set_flow_shortlist: how many top-scoring candidates get flow-checked (1-6).
- set_universe: how many USDT-M perps the flow scanner tracks (12-64) — raise when the domain misses flows (thin scan coverage), lower when rate/latency pressure shows.
- set_ttl_extend_max: DYNAMIC EXPIRY GATE — max TTL extensions granted per signal (0-3). Use the TTL-GATE line: when the extension→TP conversion rate is high (tpAfter >> slAfter) and post-expiry afterlife shows many would-have-won expiries, RAISE the budget; when extensions mostly re-expire or stop out, LOWER it (0 disables the gate).
- set_ttl_extend_minutes: minutes per extension (15-240) — longer for slow regimes/strategies, shorter when extensions barely convert.
- set_ttl_near_tp: unlevered % band to the next TP that auto-qualifies a maturing signal for extension (0.3-5.0, default 1.5). WIDEN it when the DENIED count stays high AND the EXPIRED post-mortem win share is high (trades keep expiring just OUTSIDE the band then winning afterwards); tighten it when granted extensions keep stopping out or re-expiring.
- set_sl_atr_mult: stop distance in ATR multiples (0.8-2.5, default 1.5) — the DYNAMIC RISK knob. Read the RISK LEDGER line: when the stop-rate is high AND the SL bucket bleeds the most USD, WIDEN stops (noise takes out trades that would have worked); when instead trades die of TIME (expiry bucket dominant, stops rare), stops are too far — TIGHTEN.
- set_rr_scale: scales every computed R:R ladder (0.75-1.35, default 1.0). LOWER it when TP3 hits are rare and stopped trades outnumber full-TP badly (greedy targets); RAISE it when full-TP conversion is strong and the RISK LEDGER shows winners reaching the final rung.
- set_regime_guard: regime-filter hardening level 0-2 (default 1). Read the REGIME LEDGER line: L0 = soft penalties only; L1 = hard VETO on breakout/momentum in strong chop; L2 = + BTC-spillover counter-trend surcharge + no mean-revert in vol expansion. RAISE the guard when the chop/volatile ledger bleeds USD; LOWER it (L0) only if the ledger proves you are vetoing profitable regimes.
- set_max_active: position capacity — max concurrent open signals (2-8, default 5). Read the DEPLOY/CAPACITY line: at capacity with healthy open PNL you may RAISE it to keep diversifying; LOWER it when open risk is concentrated, correlated, or the equity drawdown is deep.
- set_risk_per_trade: margin sizing scale on the confidence-sized margin (0.5-1.5, default 1.0). LOWER below 1.0 when the recent ledger bleeds (deep drawdown, expectancy negative) — survive first; RAISE above 1.0 ONLY when expectancy is positive and the equity curve is making new highs.
- CLAMP RANGES: every knob is hard-clamped by the core — the 0. CLAMPS line in the telemetry lists each legal range. Requesting a value outside the range wastes the action (the core pins it to the nearest legal value).
- run_backtest / run_autotune: trigger the history learner or the weight auto-tuner when outcomes changed materially or evidence is stale.
Respond with ONLY valid JSON, no code fences: {"decisions":[{"action":"set_min_score|set_flow_veto|set_flow_shortlist|set_universe|set_ttl_extend_max|set_ttl_extend_minutes|set_ttl_near_tp|set_sl_atr_mult|set_rr_scale|set_regime_guard|set_max_active|set_risk_per_trade|run_backtest|run_autotune|no_op","value":<number or null>,"rationale":"<one sentence citing specific bundle numbers>"}]}
${context}`,
        },
        { role: "user", content: "Governor cycle: review the telemetry and issue your decisions now." },
      ],
      thinking: await resolveThinking("governor"),
      }), { tier: "background" }
    );
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { decisions?: GovernorDecision[] };
    const valid = ["set_min_score", "set_flow_veto", "set_flow_shortlist", "set_universe", "set_ttl_extend_max", "set_ttl_extend_minutes", "set_ttl_near_tp", "set_sl_atr_mult", "set_rr_scale", "set_regime_guard", "set_max_active", "set_risk_per_trade", "run_backtest", "run_autotune", "no_op"];
    const decisions = (parsed.decisions ?? [])
      .filter((d) => valid.includes(d.action))
      .slice(0, 3)
      .map((d) => ({ action: d.action, value: typeof d.value === "number" ? d.value : undefined, rationale: String(d.rationale ?? "").slice(0, 300) }));
    if (decisions.length === 0) throw new Error("no usable decisions");
    reportOutcome("governor", "MODEL");
    reportAudit("governor", context, JSON.stringify(decisions));
    return { decisions, label: "MODEL" };
  } catch (err) {
    console.error("[aiGovernorDecisions] fallback", err);
    reportOutcome("governor", "HEURISTIC", String(err).slice(0, 120));
    return { decisions: heuristicFallback, label: "HEURISTIC" };
  }
}

/** Structured single-symbol analysis */
export interface SymbolAnalysis {
  bias: string;
  summary: string;
  invalidation: string;
  conviction: number;
}

/** ── v5.4 DEEP-LEARN — research Q&A over full-TP (TP3) + stopped-out cases ──
 *  The LLM acts as the engine's research desk: it receives ONLY measured case
 *  files + the TP3 lab contrast, answers why winners ran the whole ladder and
 *  why losers died, and returns strict lessons that are persisted + grounded
 *  into every agent. Heuristic fallback produces honest, data-driven lessons. */
export interface DeepLearnLessonRaw {
  scope: "TP3_FULL" | "SL" | "MIXED";
  pattern: string;
  evidence: string;
  action: string;
  confidence: number;
}
export interface DeepLearnResult {
  lessons: DeepLearnLessonRaw[];
  hypothesis: string;
  label: "MODEL" | "HEURISTIC";
}

export async function aiDeepLearn(grounding: string, questions: string, lab: { fullTp: { count: number; avgConfidence: number; avgRr: number }; stopped: { count: number; avgConfidence: number } }): Promise<DeepLearnResult> {
  try {
    const completion = await withZai(async (zai) =>
      zai.chat.completions.create({
        messages: [
          {
            role: "assistant",
            content: `${SYSTEM_ANALYST}
You are now the FLOWRADAR DEEP-LEARN CORE — the research desk of the trading engine.
You receive measured case files of FULL-TP (TP3, whole ladder captured) and STOPPED-OUT deployments plus a statistical contrast. Your research method:
- Study what the full-TP winners SHARED at deploy time (factor votes, flow verdict, regime, conviction, R:R, timeframe).
- Study what the stopped-out trades showed that should have been a warning.
- Derive 2-4 concrete, measurable lessons. Each lesson: pattern (what to look for BEFORE deploy), evidence (cite the case numbers), action (a specific gate/weight/sizing/TTL behaviour change), confidence 0-100.
- Never invent numbers; cite only the grounding. Prefer precision over activity — 2 strong lessons beat 4 weak ones.
Respond with ONLY valid JSON, no code fences: {"lessons":[{"scope":"TP3_FULL|SL|MIXED","pattern":"...","evidence":"...","action":"...","confidence":0-100}],"hypothesis":"<3-6 sentence research answer to the questions>"}
${grounding}`,
          },
          { role: "user", content: `${questions}\nRun this research cycle now.` },
        ],
        thinking: await resolveThinking("deep-learn"), // hard-wired THOUGHT via THOUGHT_CHANNELS
      }), { tier: "background" }
    );
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { lessons?: DeepLearnLessonRaw[]; hypothesis?: string };
    const lessons = (parsed.lessons ?? [])
      .filter((l) => l && typeof l.pattern === "string")
      .slice(0, 4)
      .map((l) => ({
        scope: (["TP3_FULL", "SL", "MIXED"].includes(l.scope) ? l.scope : "MIXED") as DeepLearnLessonRaw["scope"],
        pattern: String(l.pattern ?? "").slice(0, 240),
        evidence: String(l.evidence ?? "").slice(0, 300),
        action: String(l.action ?? "").slice(0, 240),
        confidence: Number(l.confidence) || 60,
      }));
    if (lessons.length === 0) throw new Error("no usable lessons");
    const hypothesis = String(parsed.hypothesis ?? "").slice(0, 2400);
    reportOutcome("deep-learn", "MODEL");
    reportAudit("deep-learn", grounding, `${hypothesis} ${JSON.stringify(lessons)}`);
    return { lessons, hypothesis, label: "MODEL" };
  } catch (err) {
    console.error("[aiDeepLearn] fallback", err);
    reportOutcome("deep-learn", "HEURISTIC", String(err).slice(0, 120));
    // Honest heuristic lessons from the measured lab contrast (no invention)
    const lessons: DeepLearnLessonRaw[] = [];
    const confDelta = lab.fullTp.avgConfidence - lab.stopped.avgConfidence;
    if (lab.fullTp.count > 0 && lab.stopped.count > 0) {
      lessons.push({
        scope: "TP3_FULL",
        pattern: `Full-TP winners deployed at avg conviction ${lab.fullTp.avgConfidence} with RR ${lab.fullTp.avgRr} (${confDelta >= 0 ? "+" : ""}${confDelta} vs stop-outs)`,
        evidence: `${lab.fullTp.count} full-TP vs ${lab.stopped.count} stop-outs in the measured lab window`,
        action: confDelta >= 4 ? "Favour deployments with conviction ≥ the full-TP cohort average; treat sub-average conviction as ladder-trim candidates" : "Keep current conviction gate — winner/loser conviction profiles are too close to act on",
        confidence: 62,
      });
      lessons.push({
        scope: "SL",
        pattern: `Stop-outs died at avg conviction ${lab.stopped.avgConfidence} — study their shared tags/regime before the next deploy`,
        evidence: `${lab.stopped.count} stopped cases measured`,
        action: "Deploy the flow gate harder on setups whose tags match the stop-out cohort",
        confidence: 58,
      });
    } else {
      lessons.push({
        scope: "MIXED",
        pattern: "Sample too thin for a reliable winner/loser contrast",
        evidence: `${lab.fullTp.count} full-TP / ${lab.stopped.count} stop-out cases`,
        action: "Keep logging outcomes; the deep-learn cycle re-runs automatically",
        confidence: 50,
      });
    }
    return { lessons, hypothesis: "Neural link degraded — lessons derived from the measured TP3-lab contrast only (heuristic mode). No invented numbers.", label: "HEURISTIC" };
  }
}

/** ── v8.2 VERDICT-CORE — decision-border research desk (operator: «موتور گیج») ──
 *  Reads the MEASURED GateVerdict journal aggregate (which reason-codes
 *  confirm/reject, how close the rejects came) and returns grounded findings
 *  + a digest that is persisted for the AI CORE page and analyst grounding. */
export interface VerdictLearnResult {
  digest: string;
  findings: Array<{ pattern: string; evidence: string; action: string; confidence: number }>;
  label: "MODEL" | "HEURISTIC";
}

export async function aiVerdictLearn(grounding: string, stats: { total: number; rejectedScore: number; deployed: number; boundary: number; avgMarginRejected: number | null; topRejectDrivers: Array<{ code: string; n: number }>; topConfirmDrivers: Array<{ code: string; n: number }> }): Promise<VerdictLearnResult> {
  try {
    const completion = await withZai(async (zai) =>
      zai.chat.completions.create({
        messages: [
          {
            role: "assistant",
            content: `${SYSTEM_ANALYST}
You are now the FLOWRADAR VERDICT-CORE — the research desk that studies the engine's own approve/reject decisions at the deploy gate.
You receive a measured journal bundle: candidates that reached the decision border (score within ±10 of the EFFECTIVE threshold), the reasons that pushed them (pro/con factor votes, regime/MTF/liq-heat/chase threshold surcharges), and how the gate ruled.
Derive 2-3 concrete findings about WHY candidates confirm or reject: which drivers dominate, whether border rejects are hair-thin (surcharge-flipped) or wide misses, and what the gate behaviour implies.
Each finding: pattern (what to watch before deploy), evidence (cite journal numbers), action (what the operator/engine should monitor or do), confidence 0-100.
NEVER invent numbers — cite only the bundle. If outcome learning for rejected candidates is declared OBSERVING, say so instead of guessing win rates.
Respond with ONLY valid JSON, no code fences: {"findings":[{"pattern":"...","evidence":"...","action":"...","confidence":0-100}],"digest":"<3-6 sentence plain-text summary of the decision border right now>"}
${grounding}`,
          },
          { role: "user", content: "Verdict-core cycle: analyze the decision border journal now." },
        ],
        thinking: await resolveThinking("governor"),
      }), { tier: "background" }
    );
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { findings?: Array<{ pattern?: string; evidence?: string; action?: string; confidence?: number }>; digest?: string };
    const findings = (parsed.findings ?? [])
      .filter((f) => f && typeof f.pattern === "string")
      .slice(0, 3)
      .map((f) => ({ pattern: String(f.pattern).slice(0, 240), evidence: String(f.evidence ?? "").slice(0, 300), action: String(f.action ?? "").slice(0, 240), confidence: Number(f.confidence) || 60 }));
    if (findings.length === 0) throw new Error("no usable findings");
    reportOutcome("verdict-core", "MODEL");
    reportAudit("verdict-core", grounding, `${parsed.digest ?? ""} ${JSON.stringify(findings)}`);
    return { digest: String(parsed.digest ?? "").slice(0, 1600), findings, label: "MODEL" };
  } catch (err) {
    console.error("[aiVerdictLearn] fallback", err);
    reportOutcome("verdict-core", "HEURISTIC", String(err).slice(0, 120));
    const topRej = stats.topRejectDrivers[0];
    const topPro = stats.topConfirmDrivers[0];
    const findings: VerdictLearnResult["findings"] = [];
    if (topRej) {
      findings.push({
        pattern: `"${topRej.code}" dominates rejections (×${topRej.n})`,
        evidence: `${stats.rejectedScore} score-gate rejections in the window; avg miss ${stats.avgMarginRejected ?? "n/a"} pts`,
        action: stats.avgMarginRejected !== null && stats.avgMarginRejected > -4 ? "Hair-thin border rejects — surcharges are flipping marginal setups; keep shadow-tracking" : "Wide-margin rejects — the gate is a hard filter, no change warranted",
        confidence: 58,
      });
    }
    if (topPro) findings.push({ pattern: `"${topPro.code}" leads confirmations (×${topPro.n})`, evidence: `${stats.deployed} deployments measured`, action: "Keep this factor grounded; verify its settled cohort in the ledger", confidence: 55 });
    if (findings.length === 0) findings.push({ pattern: "Journal too thin for contrast", evidence: `${stats.total} rows`, action: "Keep logging; cycle re-runs automatically", confidence: 50 });
    return {
      digest: `Heuristic verdict-core read (${stats.total} rows: ${stats.boundary} border · ${stats.rejectedScore} rejects · ${stats.deployed} deployed). Top reject driver ${topRej?.code ?? "n/a"}; top confirm driver ${topPro?.code ?? "n/a"}. Neural link degraded — deterministic read only, no invented outcomes.`,
      findings,
      label: "HEURISTIC",
    };
  }
}

/** ── v8.2 SHADOW ADJUDICATOR — AI-core Phase 0 second opinion at the gate fence ──
 *  Called by lib/shadow-veto.ts for candidates inside the adjudication window
 *  (hair-thin passes gap 0..+3 and near-miss rejects gap −8..0). VETO-ONLY
 *  doctrine: the core may agree or block, never create signals. The verdict is
 *  recorded + paper-tracked; in shadow mode it NEVER affects live flow.
 *  v8.2.1 GROUNDING PATCH (operator: «پچ grounding قاضی سایه را کامل و مهندسی
 *  بزن») — the judge was the LAST unaudited LLM path in the bridge. Now every
 *  MODEL verdict is number-by-number grounding-audited against the evidence
 *  bundle it saw: CLEAN/SUSPECT verdicts carry their audit to the record;
 *  a VIOLATION (unmatched citations / simulation fingerprints) has its verdict
 *  DISCARDED and the deterministic heuristic speaks instead (fail-open —
 *  hallucinated evidence can never become a veto voice). */
export interface ShadowAdjudication {
  verdict: "TRADE" | "VETO";
  confidence: number; // 0..100
  reason: string;
  label: "MODEL" | "HEURISTIC";
  audit: { cited: number; unmatched: number[]; verdict: "CLEAN" | "SUSPECT" | "VIOLATION" } | null; // null = legacy/heuristic-without-model-attempt
}

export interface ShadowAdjudicationCtx {
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  side: "PASS" | "REJECT"; // hair-thin pass vs near-miss reject
  gap: number;
  score: number;
  effMin: number;
  thr: Record<string, number>;
  confirms: Array<{ factor: string; vote: number; detail?: string }>;
  opposes: Array<{ factor: string; vote: number; detail?: string }>;
  notes: string | null;
}

function shadowHeuristic(ctx: ShadowAdjudicationCtx): { verdict: "TRADE" | "VETO"; confidence: number; reason: string; label: "MODEL" | "HEURISTIC" } {
  // deterministic fallback: signed net pressure of the journaled votes
  const net = [...ctx.confirms, ...ctx.opposes].reduce((a, f) => a + f.vote, 0);
  const opposeHeavy = net < 0;
  return {
    verdict: opposeHeavy ? "VETO" : "TRADE",
    confidence: 52,
    reason: `heuristic: net vote pressure ${net >= 0 ? "+" : ""}${net.toFixed(0)} — ${opposeHeavy ? "opposing factors outweigh confirms" : "no concrete opposing dominance"}`,
    label: "HEURISTIC",
  };
}

export async function aiShadowAdjudication(ctx: ShadowAdjudicationCtx): Promise<ShadowAdjudication> {
  // v8.4.3 VERDICT-CORE WIRING (operator: «چرا از نتایج Verdict core استفاده
  // نمیشه؟») — the judge now consults the core's own deep-learn lessons over
  // the gate journal (institutional memory of recurring confirm/reject
  // patterns). Consultative only: the doctrine block below forbids treating a
  // lesson as an automatic veto/flip; every MODEL verdict still passes the
  // number-by-number grounding audit, and any VIOLATION still discards the
  // model's voice (fail-open). Dynamic import — verdict.ts sits across the
  // engine/shadow-veto import web.
  let coreMemory = "";
  try {
    const { getVerdictCoreState } = await import("./verdict");
    const vc = await getVerdictCoreState();
    if (vc.lessons.length) {
      coreMemory = `VERDICT-CORE MEMORY (the engine's own deep-learn findings over recent gate verdicts — consult as context, never as an automatic verdict):\n${vc.lessons.slice(0, 3).map((l) => `- ${l.pattern} → ${l.action} (confidence ${l.confidence}%, ${l.label})`).join("\n")}\n`;
    }
  } catch { /* verdict-core unavailable → judge works from the bundle alone */ }
  const bundle = [
    `CANDIDATE: ${ctx.symbol} ${ctx.direction} · strategy ${ctx.strategy} · confluence score ${ctx.score.toFixed(1)} vs EFFECTIVE gate ${ctx.effMin} (gap ${ctx.gap >= 0 ? "+" : ""}${ctx.gap.toFixed(1)}).`,
    `FENCE POSITION: ${ctx.side === "PASS" ? "PASSED the numeric gate by a hair (gap 0..+3) — question: block this deployment?" : "MISSED the numeric gate by ≤8 pts (the boundary band) — question: is the numeric rejection wrong; should this trade anyway?"}`,
    `THRESHOLD MODIFIERS: ${Object.entries(ctx.thr).filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(" · ") || "none (base gate only)"}.`,
    `CONFIRMING FACTORS: ${ctx.confirms.map((f) => `${f.factor} ${f.vote >= 0 ? "+" : ""}${f.vote}${f.detail ? ` (${f.detail})` : ""}`).join(" · ") || "none"}.`,
    `OPPOSING FACTORS: ${ctx.opposes.map((f) => `${f.factor} ${f.vote >= 0 ? "+" : ""}${f.vote}${f.detail ? ` (${f.detail})` : ""}`).join(" · ") || "none"}.`,
    `REGIME/HEAT NOTES: ${ctx.notes ?? "none"}.`,
    coreMemory,
  ].filter(Boolean).join("\n");
  try {
    const completion = await withZai(async (zai) =>
      zai.chat.completions.create({
        messages: [
          {
            role: "assistant",
            content: `You are the FLOWRADAR SHADOW ADJUDICATOR — a veto-only second opinion that reviews borderline candidates at the engine's deploy gate.
DOCTRINE (strict):
- You may only VETO (block) or let TRADE. You can never create signals, resize, or move targets.
- Default is TRADE: only VETO when the measured evidence is concretely bad — opposing factors dominate the confirms, the candidate only passed because a threshold discount flattered it, it chases a fresh eruption, it faces a flush-risk liquidity cluster, MTF flow conflicts, or the regime ruling is fighting the direction.
- A near-miss reject (REJECT side) should flip to TRADE only if the numeric miss is clearly surcharge-flavored (the modifiers, not the confluence, caused the miss) AND the confirming factors are strong.
- Judge the REASON QUALITY, not the score magnitude. Never invent data — use only the bundle.
Respond with ONLY valid JSON, no code fences: {"verdict":"TRADE|VETO","confidence":<0-100>,"reason":"<one line, max 140 chars, cite the decisive factors>"}
BUNDLE:
${bundle}`,
          },
          { role: "user", content: `Adjudicate this ${ctx.side === "PASS" ? "hair-thin pass" : "near-miss reject"} now.` },
        ],
        thinking: await resolveThinking("governor"),
      }), { tier: "background" }
    );
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as { verdict?: string; confidence?: number; reason?: string };
    const verdict = parsed.verdict === "VETO" ? "VETO" : "TRADE";
    const confidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 60));
    const reason = String(parsed.reason ?? "no reason given").slice(0, 180);
    // v8.2.1 GROUNDING AUDIT — audit the REASON (the factual claims; verdict is
    // categorical and confidence is self-assessed, neither asserts world facts),
    // and fingerprint the RAW model output for simulation/placeholder language
    // (veracity semantics: markers → SUSPECT, markers + ≥2 unmatched → VIOLATION).
    const reasonAudit = auditGrounding(bundle, reason);
    const rawMarkers = findMockMarkers(raw);
    const auditVerdict: GroundingAudit["verdict"] =
      rawMarkers.length > 0 ? (reasonAudit.unmatched.length >= 2 ? "VIOLATION" : "SUSPECT") : reasonAudit.verdict;
    const audit = { ...reasonAudit, verdict: auditVerdict };
    void import("./supervisor")
      .then((m) => m.noteGroundingAudit("shadow-veto", audit))
      .catch(() => undefined);
    const auditFootprint = { cited: audit.cited, unmatched: audit.unmatched, verdict: audit.verdict };
    if (audit.verdict === "VIOLATION") {
      // HALLUCINATION FINGERPRINT — the model's verdict cannot stand on ungrounded
      // reasoning. Discard it; the deterministic heuristic speaks instead (fail-open,
      // veto-only doctrine: no veto voice may rest on invented evidence).
      console.error("[aiShadowAdjudication] grounding VIOLATION — model verdict discarded, heuristic speaks:", auditFootprint);
      reportOutcome("shadow-veto", "HEURISTIC", `grounding violation — ${audit.unmatched.length} unmatched citations`);
      return { ...shadowHeuristic(ctx), audit: auditFootprint };
    }
    reportOutcome("shadow-veto", "MODEL");
    return {
      verdict,
      confidence,
      reason,
      label: "MODEL",
      audit: auditFootprint,
    };
  } catch (err) {
    console.error("[aiShadowAdjudication] heuristic fallback", err);
    reportOutcome("shadow-veto", "HEURISTIC", String(err).slice(0, 120));
    return { ...shadowHeuristic(ctx), audit: null };
  }
}

export async function aiAnalyzeSymbol(symbol: string, price: number, change24h: number): Promise<SymbolAnalysis> {
  try {
    const completion = await withZai(async (zai) =>
      zai.chat.completions.create({
        messages: [
          { role: "assistant", content: `${SYSTEM_ANALYST}\nRespond with ONLY valid JSON, no code fences: {"bias":"BULLISH|BEARISH|NEUTRAL","summary":"<2-3 sentences on structure, flow, key levels>","invalidation":"<one level-based sentence>","conviction":<0-100 number>}` },
          { role: "user", content: `Analyze ${symbol}. Current price ${price}. 24h change ${change24h.toFixed(2)}%. Provide structural read.` },
        ],
        thinking: await resolveThinking("symbol-scan"), // contract: always FAST
      }), { tier: "background" }
    );
    const raw = completion.choices[0]?.message?.content ?? "";
    const json = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(json);
    const summary = String(parsed.summary ?? "").slice(0, 600);
    reportOutcome("symbol-scan", "MODEL");
    // NOTE: no grounding audit here — this call has no measured bundle to audit
    // against (the model produces fresh structural analysis by design).
    return {
      bias: ["BULLISH", "BEARISH", "NEUTRAL"].includes(parsed.bias) ? parsed.bias : "NEUTRAL",
      summary,
      invalidation: String(parsed.invalidation ?? "").slice(0, 240),
      conviction: Math.max(0, Math.min(100, Number(parsed.conviction) || 72)),
    };
  } catch (err) {
    console.error("[aiAnalyzeSymbol]", err);
    reportOutcome("symbol-scan", "HEURISTIC", String(err).slice(0, 120));
    // procedural fallback
    const bias = change24h > 1 ? "BULLISH" : change24h < -1 ? "BEARISH" : "NEUTRAL";
    return {
      bias,
      summary: `${symbol} trades at ${price} with ${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}% on the session. ${bias === "BULLISH" ? "Buyers defend intraday value; reclaim of session high opens liquidity above." : bias === "BEARISH" ? "Sellers control value; weakness below session low likely taps resting liquidity." : "Range-bound compression — await displacement for directional commitment."} Local model only (neural link offline).`,
      invalidation: `Structure invalidated on a decisive break of the ${bias === "BULLISH" ? "session low" : bias === "BEARISH" ? "session high" : "range mid"}.`,
      conviction: 68,
    };
  }
}
