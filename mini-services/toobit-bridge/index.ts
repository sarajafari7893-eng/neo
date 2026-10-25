// ── NEXUS//SIGNALS — TOOBIT EXECUTION BRIDGE v1.0.0 (:3021) ─────────────────
// Operator mandate (trace 1a15630c8d7dbd95): «اتصال صرافی Toobit به عنوان پل
// صدور و اجرای سیگنالها … کامل مدیریت شود و تمام اقدامات و اتفاقاتی که برای
// کارت سیگنال می افتد پیگیری و اجرا شود مثل سیو سود، بستن سیگنال منقضی شده،
// استاپ شده و همه موارد — اجرا و مدیریت تمام دستورات راستی آزمایی شود».
//
// CONTRACT
//   • Reads the engine ledger (db/custom.db Signal table) READ-ONLY via
//     bun:sqlite — the app process keeps sole Prisma ownership (doctrine).
//   • Mirrors the signal-card lifecycle onto Toobit USDT-M PERPETUALS
//     (*-SWAP-USDT — the only product line Toobit lists; verified live:
//     767 linear contracts, zero delivery/standard futures):
//       ACTIVE  → market entry + attached TP(tp3)/SL(stop) in ONE order
//       TP1     → bank TP1_FRAC of ORIGINAL qty (سیو سود)
//       TP2     → bank TP2_FRAC
//       TP3     → close remaining
//       SL      → close remaining (استاپ شده)
//       EXPIRED/CLOSED/VOID → close remaining (بستن سیگنال منقضی)
//   • RECONCILIATION every 30s: exchange positions/orders vs local intent —
//     drift is journaled, exchange-protected TP/SL is re-attached when absent,
//     unknown positions are REPORTED (never touched).
//   • LATENCY TELEMETRY per execution: card.createdAt → detected → sent →
//     filled, plus slippage vs the card entry price (دقت و سرعت ورود).
//   • MODE: PAPER (default — simulates fills on the REAL Toobit book) ⇄ LIVE
//     requires BOTH a positive futures balance AND an explicit operator
//     approval (POST /approve-live). No silent real-money path exists.
//   • Order-rate guard: sequential action queue; ORDERS 60/2s documented limit.
//   • LEVERAGE v1.2.0 (trace 1a15ddbdbabf84a9): اهرم صرافی = اهرم همان کارت
//     سیگنال (Signal.leverage) — pre-entry set-leverage per card, re-set only
//     on change; margin stays FIXED $5 → notional = 5 × cardLev.
//   • plain bun, NO --hot (LEASH-0929b doctrine), state in .data/toobit-bridge.
//   • v1.3.0 DOCTRINE SUPERVISOR (trace 1a15f7d945d27ead — «سوپروایزر مهندسی
//     ارشد برای پیگیری و دکترین»): every intent carries doctrine fields
//     (levSrc, expectedNotional, actualNotional, entryDriftBps, entryAgeMs,
//     protected) and two hard ENTRY GATES replace blind market entries:
//       ENTRY-DRIFT — skip if |refPrice − cardEntry| > maxEntryDriftBps
//                     (فیلتر سیگنال‌هایی با اختلاف قیمتی بالا)
//       ENTRY-DELAY — skip if card age at entry > maxEntryAgeMs
//                     (فیلتر فاصله زمانی با تأخیر)
//     doctrineScan() every 30s audits OPEN intents (leverage↔card mirror,
//     notional math, card-status mirror lag, protection) → DOCTRINE-VIOLATION
//     journal + GET /doctrine + .data/toobit-bridge/doctrine-latest.json.
//     The «Notional shows another number» root cause was the UI reading the
//     LEGACY cfg.notionalUsdt (15) — sizing since v1.1.0 is margin(5)×cardLev;
//     v1.3.0 exposes expected/actual notional per intent so the panel shows
//     the real math (step-rounding floor makes actual ≤ expected by design).
// ─────────────────────────────────────────────────────────────────────────────
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const VER = "toobit-bridge 1.4.3";
// v1.4.3 (operator order trace 1a172ca1af260c0d — «مارجین 5$/$0.5 به‌جای 10$، چرا هیچ سیگنالی در سود بسته نشده، وضعیت NX-3139 در لایو متفاوت است — اقدامات حیاتی فوری»):
//   Forensics proved FOUR independent root causes, all fixed here:
//   ① CONTRACT-MULTIPLIER SIZING BUG (the $0.5 margin) — exchangeInfo carries
//      contractMultiplier (0.1 for SUI/FARTCOIN, 1 for WLD/...) which was ignored:
//      the bridge believed it sent $50/$80 notional while the book saw $4.98/$7.93
//      → margin $0.49 on the exchange (NX-3126/NX-3140). Now qty = notional ÷
//      (price × mult) with mult parsed per symbol; floors/notionals are REAL USDT.
//   ② newClientOrderId REQUIRED (why no signal closed in profit) — Toobit
//      rejects every order without newClientOrderId (-1004). Opens always set it;
//      ALL TP1/TP2 bank orders and both SL close-fallbacks omitted it → 5/5
//      «سیو سود» banks rejected, no profit ever locked in LIVE. placeOrder now
//      auto-generates a clientOrderId for every order.
//   ③ ONE-SHOT TRANSITIONS (NX-3139 class divergence) — pollCards stamped
//      lastStatusSeen BEFORE the action; a rejected bank/close never retried and
//      the engine's stop-move (breakeven after TP1) never mirrored to the
//      exchange → ledger said SL +3.92% while the real position lost -0.59.
//      Now: failed bank/close revert the transition (retry next poll, capped),
//      and engine stopLoss/tp mutations on OPEN cards mirror to the exchange.
//   ④ RECON RE-ATTACH SPAM — 4176 re-attach events in ~10h because position-
//      level TP/SL never appears in openOrders. Re-assert is throttled to once
//      per 10min per symbol; stop-move mirrors bypass the throttle.
//   ⑤ LIVE PnL TELEMETRY — per-intent realizedPnlUsdt (position realizedPnL
//      via recon + userTrades at close) and /status.livePnl aggregate, so «چرا
//      هیچ سیگنالی در سود بسته نشده» is answerable in money, not guesses.
//   ⑥ BALANCE-CAP GATE — LIVE entries skip honestly (BALANCE-CAP) when the
//      fixed margin no longer fits the available balance (fresh balance read
//      at entry). marginUsdt stays $5 (standing v1.1.0 operator mandate;
//      $10 per entry does not fit the current balance — operator knob via /config).
// v1.4.2 (operator order trace 1a172a8554da03ad — «چرا سیستم با LIVE مشابه نیست؟» LIVE-signal audit):
//   TOOBIT REAL FLOOR LEARNING — exchangeInfo reports minNotional=0, but the
//   server enforces a real per-symbol order floor (~121-124+ USDT observed).
//   High-price symbols (BNB/ETH/TAO/ZEC) at fixed-$5 margin × card leverage
//   (notional 60-100) were OPEN-REJECTED -1199/-1202 "quantity too small" →
//   six FAILED intents whose cards were PAPER-profitable in the engine ledger
//   (3128 ZEC +6.5%, 3137 ETH +3.5% — phantom vs LIVE). Now: the first
//   "quantity too small" rejection teaches a per-symbol floor (floorLearn),
//   reclassifies the intent as an honest MIN-FLOOR SKIP (not FAILED), and
//   pre-skips future cards for that symbol while their notional ≤ learned floor.
// v1.4.1 (operator mandate trace 1a170bba02dff781 — «چرا سقف هم‌زمانی 3 است؟ باید بدون سقف باشد»):
//   UNLIMITED CONCURRENCY — maxConcurrent 0 = بدون سقف (مقدار پیش‌فرض). One-time
//   cfgRev=2 migration lifts the persisted legacy cap (3). /config accepts 0..50
//   (0 = unlimited). MAX-CONCURRENT skip + retry window now only exist when a
//   positive cap is explicitly configured. LIVE keys installed (gitignored .env).
// v1.4.0 (operator mandate trace 1a1704d407f00dad — «ممیزی TOOBIT EXEC BRIDGE + راستی‌آزمایی تمام دستورات مدیریت سیگنال‌ها»):
//   ① SINGLETON PID LOCK — forensics found the service running under `bun --hot`:
//      every file touch re-exec'd a NEW module generation INSIDE the same process
//      while the OLD generation's timers kept firing → two writers flip-flopped
//      state.json every ~30s ({146 intents, 3 open} ↔ {92 intents, 0 open}) and
//      one restart could lose the open intents to the ghost's stale snapshot.
//      Lock = one verified-alive pid file; second instance refuses to boot.
//      Dev script is now plain bun (LEASH-0929b restored).
//   ② ORPHAN SWEEP — ~52 cards (3055-3107) born during the ghost/downtime window
//      never got an intent (silent holes in the execution mirror). Every 60s the
//      sweep makes each unmirrored ACTIVE card an auditable ORPHAN-CARD event
//      (read-only; entries stay behind ENTRY-DELAY/DRIFT — no late chasing).
//   ③ RETRY WINDOW — MAX-CONCURRENT skips previously never re-entered the queue
//      (a freed slot within 90s was wasted). Now a skipped card retries while it
//      is still inside the ENTRY-DELAY window; beyond it RETRY-EXPIRED honestly.
//   ④ PAPER bank visibility — EXEC-BANK-PAPER events now reach audit.jsonl
//      (previously PAPER سیو سود was invisible there, only in state.json).
// v1.3.0 trace-1a15f7d945d27ead: DOCTRINE SUPERVISOR — entry gates (drift/delay), expected-vs-actual notional, /doctrine audit endpoint; v1.2.0 per-card leverage & v1.1.0 fixed-$5 margin unchanged
const ROOT = "/home/z/my-project";
const DATA = `${ROOT}/.data/toobit-bridge`;
const STATE = `${DATA}/state.json`;
const AUDIT = `${DATA}/audit.jsonl`;
const PORT = 3021;
const AUTH_KEY = "3195f6883529fa43a9d62d0fa92b01e7adc851ed0ed3b2b6";
const DB_PATH = `${ROOT}/db/custom.db`;

// keys live in mini-services/toobit-bridge/.env (gitignored) — fallback empty
let API_KEY = "";
let API_SECRET = "";
try {
  const env = readFileSync(`${ROOT}/mini-services/toobit-bridge/.env`, "utf8");
  API_KEY = /^TOOBIT_API_KEY=(.*)$/m.exec(env)?.[1]?.trim() ?? "";
  API_SECRET = /^TOOBIT_API_SECRET=(.*)$/m.exec(env)?.[1]?.trim() ?? "";
} catch { /* keys absent → PAPER with no exchange account calls */ }

const BASE = "https://api.toobit.com";
const POLL_MS = 1500;
const RECON_MS = 15_000; // v1.1.0 (operator mandate): راستی‌آزمایی حساب با کمترین اختلاف زمانی — 30s → 15s
const STALE_SKIP_MS = 10 * 60_000; // a card older than this at first sight is never executed
const TRACK_LIMIT = 40;
const METRICS_WINDOW = 50;

interface BridgeConfig {
  notionalUsdt: number;   // LEGACY (pre-1.1.0 sizing) — kept only for old persisted state; UI must read marginUsdt × cardLev instead
  marginUsdt: number;     // FIXED per-signal entry MARGIN (v1.1.0 operator mandate trace 1a15bc29d2bb2c29) — notional = marginUsdt × cardLev
  maxConcurrent: number;  // max simultaneous open intents — 0 = UNLIMITED (v1.4.1 operator mandate)
  cfgRev?: number;        // config migration revision (2 = cap lifted to unlimited)
  tp1Frac: number;        // fraction of ORIGINAL qty banked at TP1
  tp2Frac: number;        // additional fraction banked at TP2
  leverage: number;       // FALLBACK for legacy cards with leverage<=0 (v1.2.0: per-card Signal.leverage is authoritative)
  execEnabled: boolean;   // master switch for NEW entries (closes always run)
  liveApproved: boolean;  // operator gate for real-money execution
  maxEntryDriftBps: number; // v1.3.0 ENTRY-DRIFT gate — skip when market has run away from cardEntry (bps)
  maxEntryAgeMs: number;    // v1.3.0 ENTRY-DELAY gate — skip when card age at entry exceeds this (ms)
}
const DEFAULT_CFG: BridgeConfig = {
  notionalUsdt: 15,
  marginUsdt: 5,
  maxConcurrent: 0,       // v1.4.1 — 0 = UNLIMITED simultaneous open intents (operator mandate)
  tp1Frac: 0.4,
  tp2Frac: 0.3,
  leverage: 5,
  execEnabled: true,
  liveApproved: false,
  maxEntryDriftBps: 80,     // 0.8% from card entry — beyond that the edge on the card is gone
  maxEntryAgeMs: 90_000,    // 90s entry window — دقت و سرعت بالای ورود
};

interface DoctrineViolation { at: number; serial: number; kind: string; detail: string }
interface DoctrineState {
  opens: number;                      // doctrine-clean opens counted since boot
  skipBy: Record<string, number>;     // skip counters by reason (incl. ENTRY-DRIFT / ENTRY-DELAY)
  violations: DoctrineViolation[];    // last 20 doctrine violations
  lastScanAt: number;
  orphans: number;                    // v1.4.0 — ACTIVE cards seen without any execution intent
}

interface Latency { detectMs: number | null; execMs: number | null; totalMs: number | null; slipBps: number | null }
interface Intent {
  cardId: string; serial: number; symbol: string; tbSymbol: string;
  direction: "LONG" | "SHORT";
  leverage: number; // v1.2.0 — the card's own leverage, mirrored onto the exchange before entry
  status: "OPENING" | "OPEN" | "CLOSING" | "CLOSED" | "FAILED" | "SKIP";
  mode: "LIVE" | "PAPER";
  qtyOrig: number; qtyRemaining: number;
  qtyBankedTp1: number; qtyBankedTp2: number;
  cardEntry: number; tp1: number; tp2: number; tp3: number; stopLoss: number;
  clientOrderId: string; orderId: string | null;
  fillPrice: number | null; openedAt: number | null; closedAt: number | null;
  closeReason: string | null;
  createdAt0?: number;
  lat: Latency;
  lastStatusSeen: string;
  cardStatus?: string;          // v1.3.0 doctrine — mirrored DB card status (open-management audit)
  contractMult?: number;        // v1.4.3 — exchange contractMultiplier at entry (real notional = qty × price × mult)
  sizingRev?: number;           // v1.4.3 — 3 = multiplier-aware sizing; 2 = pre-1.4.3 legacy (doctrine exempts from NOTIONAL-DELTA)
  realizedPnlUsdt?: number;     // v1.4.3 — exchange-verified realized PnL (position lifetime / close fills)
  unrealizedPnlUsdt?: number;   // v1.4.3 — current mark-to-market PnL from recon positions read
  prevStatusSeen?: string;      // v1.4.3 — status before the current transition (revert-on-reject retry)
  actionAttempts?: number;      // v1.4.3 — retry cap for reverted bank/close transitions
  levSrc?: "card" | "fallback"; // v1.3.0 doctrine — where the entry leverage came from
  expectedNotional?: number;    // v1.3.0 doctrine — marginUsdt × leverage (the card math)
  actualNotional?: number;      // v1.3.0 doctrine — qty × fillPrice (what the book actually saw)
  entryDriftBps?: number;       // v1.3.0 doctrine — |refPrice − cardEntry| at entry, bps
  entryAgeMs?: number;          // v1.3.0 doctrine — card age at entry (created → filled)
  protected?: boolean;          // v1.3.0 doctrine — protective TP/SL attached (LIVE) / sim active (PAPER)
  events: Array<{ at: number; ev: string; note?: string }>;
}
interface MetricsRow {
  serial: number; symbol: string; direction: string; mode: string;
  detectMs: number | null; execMs: number | null; totalMs: number | null;
  slipBps: number | null; fillPrice: number | null; cardEntry: number; at: number;
}
interface BridgeState {
  cfg: BridgeConfig;
  lastCreatedAtMs: number;
  intents: Record<string, Intent>;   // by cardId
  metrics: MetricsRow[];
  levMap: Record<string, number>; // v1.2.0 — last-set leverage per toobit symbol (re-set only on change)
  floorLearn: Record<string, number>; // v1.4.2 — learned per-symbol real order floor (USDT notional) from server rejections
  doctrine: DoctrineState;        // v1.3.0 — supervisor counters + violation journal
}
let S: BridgeState = { cfg: { ...DEFAULT_CFG }, lastCreatedAtMs: 0, intents: {}, metrics: [], levMap: {}, floorLearn: {}, doctrine: { opens: 0, skipBy: {}, violations: [], lastScanAt: 0, orphans: 0 } };

const tehran = (d: number = Date.now()) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);
function log(level: "info" | "warn" | "crit", msg: string, extra: Record<string, unknown> = {}): void {
  try { appendFileSync(`${ROOT}/logs/toobit-bridge.log`, `${tehran()} ${level.toUpperCase()} ${msg} ${JSON.stringify(extra)}\n`); } catch { /* never */ }
}
function audit(ev: string, det: Record<string, unknown>): void {
  try { appendFileSync(AUDIT, JSON.stringify({ at: Date.now(), ev, ...det }) + "\n"); } catch { /* never */ }
  if (ev.startsWith("EXEC") || ev.startsWith("RECON-DRIFT") || ev.startsWith("SKIP") || ev.startsWith("DOCTRINE")) log(ev.startsWith("RECON") || ev.startsWith("DOCTRINE") ? "warn" : "info", ev, det);
}
// v1.3.0 doctrine counters — single funnel for every skip reason
function countSkip(reason: string): void {
  S.doctrine.skipBy[reason] = (S.doctrine.skipBy[reason] ?? 0) + 1;
}
function doctrineViolation(serial: number, kind: string, detail: string): void {
  S.doctrine.violations.push({ at: Date.now(), serial, kind, detail });
  if (S.doctrine.violations.length > 20) S.doctrine.violations = S.doctrine.violations.slice(-20);
  audit("DOCTRINE-VIOLATION", { serial, kind, detail });
}
let stateDirty = false;
function persistState(): void { stateDirty = true; }
function flushState(): void {
  if (!stateDirty) return;
  try {
    const tmp = `${STATE}.tmp`;
    writeFileSync(tmp, JSON.stringify(S));
    renameSync(tmp, STATE);
    stateDirty = false;
  } catch (e) { log("warn", "state flush failed", { err: String(e) }); }
}
function loadState(): void {
  try {
    if (existsSync(STATE)) {
      const raw = JSON.parse(readFileSync(STATE, "utf8")) as Partial<BridgeState>;
      S = {
        cfg: { ...DEFAULT_CFG, ...(raw.cfg ?? {}) },
        lastCreatedAtMs: raw.lastCreatedAtMs ?? 0,
        intents: raw.intents ?? {},
        metrics: raw.metrics ?? [],
        levMap: raw.levMap ?? {},
        floorLearn: raw.floorLearn ?? {},
        doctrine: { opens: raw.doctrine?.opens ?? 0, skipBy: raw.doctrine?.skipBy ?? {}, violations: raw.doctrine?.violations ?? [], lastScanAt: raw.doctrine?.lastScanAt ?? 0, orphans: raw.doctrine?.orphans ?? 0 },
      };
      // v1.4.1 migration: lift the legacy concurrency cap (3) once — operator
      // mandate «باید بدون سقف باشد». Explicit later /config writes persist normally.
      if ((S.cfg.cfgRev ?? 0) < 2) { S.cfg.maxConcurrent = 0; S.cfg.cfgRev = 2; }
      // v1.2.0 hardening: pre-v1.2.0 persisted intents have no leverage field —
      // backfill so notional math (margin × leverage) can never see undefined.
      // v1.3.0 hardening: backfill doctrine fields on legacy intents too.
      for (const it of Object.values(S.intents)) {
        if (!(it.leverage >= 1)) { it.leverage = S.cfg.leverage; it.levSrc = "fallback"; }
        if (it.levSrc === undefined) it.levSrc = "card";
        if (it.expectedNotional === undefined) it.expectedNotional = Number((S.cfg.marginUsdt * it.leverage).toFixed(6));
        if (it.actualNotional === undefined && it.qtyOrig > 0 && it.fillPrice) it.actualNotional = Number((it.qtyOrig * it.fillPrice).toFixed(6));
        if (it.entryAgeMs === undefined && it.lat.totalMs !== null) it.entryAgeMs = it.lat.totalMs;
        if (it.entryDriftBps === undefined && it.lat.slipBps !== null) it.entryDriftBps = Math.abs(it.lat.slipBps);
      }
    }
  } catch (e) { log("crit", "state load failed — starting clean", { err: String(e) }); }
}

// ── toobit HTTP (v1 form-urlencoded signing — live-verified scheme) ─────────
let clockOffset = 0; // serverTime - localTime
async function syncClock(): Promise<void> {
  try {
    const r = await fetch(`${BASE}/api/v1/time`, { signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { serverTime: number };
    clockOffset = j.serverTime - Date.now();
    log("info", "clock synced", { offsetMs: clockOffset });
  } catch (e) { log("warn", "clock sync failed", { err: String(e) }); }
}
function hmac(secret: string, s: string): string { return createHmac("sha256", secret).update(s).digest("hex"); }

async function pubGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T | null> {
  try {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const r = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, { signal: AbortSignal.timeout(6500) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

/** Signed v1 request — ALL params in the form body (query string empty),
    signature = HMAC_SHA256(secret, totalParams) appended as body param. */
async function signed<T>(method: "GET" | "POST", path: string, params: Record<string, string | number> = {}): Promise<{ ok: boolean; status: number; data: T | null; err: string | null }> {
  if (!API_KEY || !API_SECRET) return { ok: false, status: 0, data: null, err: "no API credentials" };
  const full: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) full[k] = String(v);
  full.timestamp = String(Date.now() + clockOffset);
  full.recvWindow = "5000";
  const qs = Object.entries(full).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const sig = hmac(API_SECRET, qs);
  try {
    const init: RequestInit = method === "GET"
      ? { signal: AbortSignal.timeout(8000) }
      : { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-BB-APIKEY": API_KEY }, body: `${qs}&signature=${sig}`, signal: AbortSignal.timeout(8000) };
    if (method === "GET") (init as Record<string, unknown>).headers = { "X-BB-APIKEY": API_KEY };
    const url = method === "GET" ? `${BASE}${path}?${qs}&signature=${sig}` : `${BASE}${path}`;
    const r = await fetch(url, init);
    const text = await r.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* non-json */ }
    return { ok: r.ok, status: r.status, data: (data ?? null) as T | null, err: r.ok ? null : text.slice(0, 240) };
  } catch (e) {
    return { ok: false, status: 0, data: null, err: String(e) };
  }
}

// ── instruments (tick/step/min rounding source of truth) ────────────────────
interface Instr { tickSize: number; stepSize: number; minQty: number; maxQty: number; minNotional: number; mult: number } // v1.4.3 mult = contractMultiplier (real notional = qty × price × mult)
let instruments = new Map<string, Instr>();
let instrumentsAt = 0;
async function refreshInstruments(): Promise<void> {
  const j = await pubGet<{ contracts?: Array<{ symbol: string; contractMultiplier?: string; filters?: Array<{ filterType?: string; filter?: string; tickSize?: string; stepSize?: string; minQty?: string; maxQty?: string; minNotional?: string }> }> }>("/api/v1/exchangeInfo");
  const out = new Map<string, Instr>();
  for (const c of j?.contracts ?? []) {
    let instr: Partial<Instr> = {};
    for (const f of c.filters ?? []) {
      const t = f.filterType ?? f.filter ?? "";
      if (t === "PRICE_FILTER") instr.tickSize = Number(f.tickSize);
      if (t === "LOT_SIZE") { instr.stepSize = Number(f.stepSize); instr.minQty = Number(f.minQty); instr.maxQty = Number(f.maxQty); }
      if (t === "MIN_NOTIONAL") instr.minNotional = Number(f.minNotional);
    }
    if (instr.stepSize && instr.stepSize > 0) out.set(c.symbol, { tickSize: instr.tickSize ?? 0, stepSize: instr.stepSize, minQty: instr.minQty ?? 0, maxQty: instr.maxQty ?? 0, minNotional: instr.minNotional ?? 0, mult: Number(c.contractMultiplier) > 0 ? Number(c.contractMultiplier) : 1 });
  }
  if (out.size > 0) {
    const non1 = [...out.values()].filter((i) => i.mult !== 1).length;
    instruments = out; instrumentsAt = Date.now();
    log("info", "instruments refreshed", { contracts: out.size, nonUnityContractMultiplier: non1 }); // v1.4.3 — visibility into the sizing trap
  }
}
const toobitSymbol = (sym: string): string => `${sym.replace(/USDT$/, "")}-SWAP-USDT`;
function floorStep(q: number, step: number): number {
  if (!(step > 0)) return q;
  return Math.floor(q / step + 1e-9) * step;
}
function fmtQty(q: number): string { return q.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""); }

// ── ledger reader (READ-ONLY — Prisma owns writes, doctrine) ────────────────
interface CardRow {
  id: string; serial: number; symbol: string; direction: string;
  entryPrice: number; tp1: number; tp2: number; tp3: number; stopLoss: number;
  leverage: number; // v1.2.0 per-card leverage (Signal.leverage)
  status: string; qualityFlag: string | null; createdAt: string | number;
}
let sqldb: Database | null = null;
function openDb(): boolean {
  try {
    sqldb = new Database(DB_PATH, { readonly: true });
    return true;
  } catch (e) {
    log("crit", "sqlite readonly open failed", { err: String(e) });
    return false;
  }
}
function parseTs(v: string | number): number {
  if (typeof v === "number") return v;
  const t = Date.parse(String(v).replace(" ", "T"));
  return Number.isFinite(t) ? t : 0;
}
function fetchRecentCards(limit = 60): CardRow[] {
  if (!sqldb) return [];
  try {
    const rows = sqldb.query(`SELECT id, serial, symbol, direction, entryPrice, tp1, tp2, tp3, stopLoss, leverage, status, qualityFlag, createdAt FROM Signal ORDER BY createdAt DESC LIMIT ${limit}`).all() as unknown as CardRow[];
    return rows;
  } catch (e) { log("warn", "card read failed", { err: String(e) }); return []; }
}
function fetchCardsByIds(ids: string[]): CardRow[] {
  if (!sqldb || ids.length === 0) return [];
  try {
    const ph = ids.map(() => "?").join(",");
    const rows = sqldb.query(`SELECT id, serial, symbol, direction, entryPrice, tp1, tp2, tp3, stopLoss, leverage, status, qualityFlag, createdAt FROM Signal WHERE id IN (${ph})`).all(...ids) as unknown as CardRow[];
    return rows;
  } catch (e) { log("warn", "card refresh failed", { err: String(e) }); return []; }
}

// ── market data for PAPER fills / drift checks ──────────────────────────────
const tickCache = new Map<string, { at: number; last: number; bid: number; ask: number }>();
async function tbTicker(tbSymbol: string): Promise<{ last: number; bid: number; ask: number } | null> {
  const hit = tickCache.get(tbSymbol);
  if (hit && Date.now() - hit.at < 2000) return hit;
  const j = await pubGet<Array<{ c?: string; b?: string; a?: string }>>("/quote/v1/contract/ticker/24hr", { symbol: tbSymbol });
  const row = Array.isArray(j) ? j[0] : null;
  const last = Number(row?.c), bid = Number(row?.b), ask = Number(row?.a);
  if (!(last > 0)) return null;
  const v = { last, bid: bid > 0 ? bid : last, ask: ask > 0 ? ask : last, at: Date.now() };
  tickCache.set(tbSymbol, v);
  return v;
}

// ── execution engine ─────────────────────────────────────────────────────────
const EXEC_DISABLED_FILE = `${DATA}/DISABLED`;
const killFile = (): boolean => existsSync(EXEC_DISABLED_FILE);

// ── v1.4.0 SINGLETON LOCK (trace 1a1704d407f00dad) ───────────────────────────
const PID_FILE = `${DATA}/bridge.pid`;
function acquireSingletonLock(): boolean {
  try {
    if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
    if (existsSync(PID_FILE)) {
      const old = Number(readFileSync(PID_FILE, "utf8").trim());
      if (Number.isFinite(old) && old > 0 && old !== process.pid) {
        try { process.kill(old, 0); log("crit", "another bridge instance is alive — refusing to boot", { pid: old }); return false; }
        catch { /* pid gone — stale lock, take over */ }
      }
    }
    writeFileSync(PID_FILE, String(process.pid));
    return true;
  } catch (e) { log("crit", "singleton lock failed", { err: String(e) }); return false; }
}
function releaseSingletonLock(): void {
  try { if (existsSync(PID_FILE) && readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) rmSync(PID_FILE); } catch { /* never */ }
}

// v1.2.0 (trace 1a15ddbdbabf84a9): the exchange leverage must MATCH the signal
// card's leverage — set per symbol before entry, re-set only when the value
// actually changes (previous per-symbol memo ignored card-level differences).
async function ensureLeverage(tbSymbol: string, lev: number): Promise<void> {
  if (S.levMap[tbSymbol] === lev) return;
  const m = await signed("POST", "/api/v1/futures/marginType", { symbol: tbSymbol, marginType: "ISOLATED" });
  if (!m.ok && !/no need|already|unchanged|-4076/i.test(m.err ?? "")) log("warn", "marginType set failed (continuing)", { tbSymbol, err: m.err });
  const l = await signed("POST", "/api/v1/futures/leverage", { symbol: tbSymbol, leverage: lev });
  if (!l.ok) log("warn", "leverage set failed (continuing)", { tbSymbol, lev, err: l.err });
  S.levMap[tbSymbol] = lev;
  persistState();
}

async function placeOrder(tbSymbol: string, side: "BUY_OPEN" | "SELL_OPEN" | "BUY_CLOSE" | "SELL_CLOSE", qty: number, opts: { takeProfit?: number; stopLoss?: number; clientOrderId?: string } = {}): Promise<{ ok: boolean; orderId: string | null; err: string | null }> {
  const params: Record<string, string | number> = {
    symbol: tbSymbol,
    side,
    type: "LIMIT",
    priceType: "MARKET", // v1 market entry — matches at last price ±5% band
    quantity: fmtQty(qty),
  };
  if (opts.clientOrderId) params.newClientOrderId = opts.clientOrderId;
  if (opts.takeProfit && opts.takeProfit > 0) { params.takeProfit = String(opts.takeProfit); params.tpTriggerBy = "MARK_PRICE"; params.tpOrderType = "MARKET"; }
  if (opts.stopLoss && opts.stopLoss > 0) { params.stopLoss = String(opts.stopLoss); params.slTriggerBy = "MARK_PRICE"; params.slOrderType = "MARKET"; }
  const r = await signed<{ code?: number; orderId?: string; order_id?: string; msg?: string }>("POST", "/api/v1/futures/order", params);
  if (!r.ok || (typeof r.data === "object" && r.data !== null && typeof (r.data as { code?: number }).code === "number" && (r.data as { code?: number }).code !== 200)) {
    return { ok: false, orderId: null, err: r.err ?? JSON.stringify(r.data) };
  }
  const d = r.data as { orderId?: string; order_id?: string; result?: { orderId?: string } } | null;
  const orderId = d?.orderId ?? d?.order_id ?? d?.result?.orderId ?? null;
  return { ok: true, orderId, err: null };
}

async function flashClose(tbSymbol: string, side: "LONG" | "SHORT"): Promise<{ ok: boolean; err: string | null }> {
  const r = await signed("POST", "/api/v1/futures/flashClose", { symbol: tbSymbol, side });
  return { ok: r.ok, err: r.ok ? null : (r.err ?? "flashClose failed") };
}

// ── action queue (sequential — order-rate guard) ────────────────────────────
type Action = { kind: "open" | "bank" | "close"; cardId: string; frac?: number; reason: string };
const actionQ: Action[] = [];
let qBusy = false;
// v1.4.0 RETRY WINDOW — cards skipped by MAX-CONCURRENT get a second chance
// while still inside the ENTRY-DELAY window (a freed slot <90s after birth is
// a real edge, not a stale chase). In-memory only: after a restart the window
// has already passed, which the ENTRY-DELAY gate would refuse anyway.
let retryList: Array<{ cardId: string; createdAt0: number }> = [];

function pushAction(a: Action): void {
  actionQ.push(a);
  void drainQ();
}
async function drainQ(): Promise<void> {
  if (qBusy) return;
  qBusy = true;
  try {
    while (actionQ.length > 0) {
      const a = actionQ.shift()!;
      const it = S.intents[a.cardId];
      if (!it) continue;
      try {
        if (a.kind === "open") await doOpen(it);
        else if (a.kind === "bank") await doBank(it, a.frac ?? 0, a.reason);
        else await doClose(it, a.reason);
      } catch (e) {
        audit("EXEC-ERROR", { cardId: a.cardId, kind: a.kind, err: String(e) });
      }
      persistState();
      flushState();
      await new Promise((r) => setTimeout(r, 250)); // pacing — 60 orders / 2s limit
    }
  } finally { qBusy = false; }
}

async function doOpen(it: Intent): Promise<void> {
  const liveMode = isLiveMode();
  it.mode = liveMode ? "LIVE" : "PAPER";
  const tick = await tbTicker(it.tbSymbol);
  if (!tick) { it.status = "FAILED"; it.events.push({ at: Date.now(), ev: "NO_TICKER", note: it.tbSymbol }); audit("EXEC-FAIL", { serial: it.serial, why: "no toobit ticker" }); return; }
  const instr = instruments.get(it.tbSymbol);
  if (!instr) { it.status = "FAILED"; it.events.push({ at: Date.now(), ev: "NO_INSTRUMENT" }); audit("EXEC-FAIL", { serial: it.serial, why: `symbol absent on toobit: ${it.tbSymbol}` }); return; }
  const refPrice = it.direction === "LONG" ? tick.ask : tick.bid;
  // v1.1.0 FIXED-$5 MARGIN (margin never varies per signal) + v1.2.0 PER-CARD
  // LEVERAGE (operator mandate trace 1a15ddbdbabf84a9): notional = fixed margin
  // × THE CARD'S leverage — size and risk mirror the signal card exactly.
  const notional = S.cfg.marginUsdt * it.leverage;
  it.expectedNotional = Number(notional.toFixed(6));
  let qty = notional / refPrice;

  // v1.3.0 ENTRY GATES (operator mandate trace 1a15f7d945d27ead):
  // ① ENTRY-DELAY — فاصله زمانی با تأخیر: a card whose entry window has passed
  //    is no longer the signal the card described; chasing it trades a stale edge.
  const ageAtEntry = Date.now() - (it.createdAt0 ?? Date.now());
  it.entryAgeMs = ageAtEntry;
  if (ageAtEntry > S.cfg.maxEntryAgeMs) {
    it.status = "SKIP";
    it.events.push({ at: Date.now(), ev: "ENTRY-DELAY", note: `age=${Math.round(ageAtEntry / 1000)}s > cap ${Math.round(S.cfg.maxEntryAgeMs / 1000)}s` });
    countSkip("ENTRY-DELAY");
    audit("EXEC-SKIP", { serial: it.serial, why: `entry-delay: card age ${Math.round(ageAtEntry / 1000)}s exceeds ${Math.round(S.cfg.maxEntryAgeMs / 1000)}s window` });
    return;
  }
  // ② ENTRY-DRIFT — اختلاف قیمتی بالا: if the book has already run away from
  //    the card's entry, the fill is not the card's trade — skip honestly.
  const driftBps = Math.abs(refPrice - it.cardEntry) / it.cardEntry * 10_000;
  it.entryDriftBps = Number(driftBps.toFixed(2));
  if (it.cardEntry > 0 && driftBps > S.cfg.maxEntryDriftBps) {
    it.status = "SKIP";
    it.events.push({ at: Date.now(), ev: "ENTRY-DRIFT", note: `drift=${driftBps.toFixed(0)}bps > cap ${S.cfg.maxEntryDriftBps}bps (ref=${refPrice} vs card=${it.cardEntry})` });
    countSkip("ENTRY-DRIFT");
    audit("EXEC-SKIP", { serial: it.serial, why: `entry-drift: ${driftBps.toFixed(0)}bps from card entry exceeds ${S.cfg.maxEntryDriftBps}bps cap` });
    return;
  }
  // $5-fixed mandate: a symbol whose exchange floor (minNotional / minQty×price)
  // cannot fit inside the mandated margin notional is SKIPPED honestly —
  // silently upsizing would breach the fixed-margin contract.
  const floorNotional = Math.max(instr.minNotional, instr.minQty * refPrice, S.floorLearn?.[it.tbSymbol] ?? 0);
  if (floorNotional > notional) {
    it.status = "SKIP";
    it.events.push({ at: Date.now(), ev: "MIN_FLOOR_SKIP", note: `${it.tbSymbol} floor=${floorNotional.toFixed(2)} > marginNotional=${notional}${S.floorLearn?.[it.tbSymbol] ? " (learned)" : ""} ` });
    countSkip("MIN-FLOOR");
    audit("EXEC-SKIP", { serial: it.serial, why: `exchange floor ${floorNotional.toFixed(2)} USDT exceeds fixed-margin notional ${notional} USDT` });
    return;
  }
  qty = floorStep(Math.min(qty, instr.maxQty), instr.stepSize);
  if (qty < instr.minQty) { it.status = "FAILED"; it.events.push({ at: Date.now(), ev: "QTY_BELOW_MIN" }); audit("EXEC-FAIL", { serial: it.serial, why: `qty ${qty} < minQty ${instr.minQty}` }); return; }

  const tSent = Date.now();
  let fillPrice: number | null = null;
  let orderId: string | null = null;
  if (liveMode) {
    await ensureLeverage(it.tbSymbol, it.leverage);
    const side = it.direction === "LONG" ? "BUY_OPEN" : "SELL_OPEN";
    const r = await placeOrder(it.tbSymbol, side, qty, { takeProfit: it.tp3, stopLoss: it.stopLoss, clientOrderId: it.clientOrderId });
    audit("EXEC-OPEN", { serial: it.serial, symbol: it.tbSymbol, side, qty, lev: it.leverage, tp3: it.tp3, sl: it.stopLoss, ok: r.ok, orderId: r.orderId, err: r.err });
    if (!r.ok) {
      // v1.4.2 — server-side real floor: exchangeInfo hides it (minNotional=0)
      // but the book rejects with -1199/-1202 "quantity too small". Teach the
      // floor, reclassify as an honest MIN-FLOOR SKIP, keep the ledger truthful.
      if (/quantity too small/i.test(r.err ?? "")) {
        const prevFloor = S.floorLearn?.[it.tbSymbol] ?? 0;
        S.floorLearn[it.tbSymbol] = Math.max(prevFloor, notional);
        it.status = "SKIP";
        it.events.push({ at: Date.now(), ev: "MIN_FLOOR_LEARNED", note: `${it.tbSymbol} real floor ≥ ${notional} USDT (server -1199/-1202; exchangeInfo said ${floorNotional.toFixed(2)})` });
        countSkip("MIN-FLOOR");
        audit("EXEC-SKIP", { serial: it.serial, why: `server floor learned: ${it.tbSymbol} ≥ ${notional} USDT notional (rejected quantity-too-small; exchangeInfo floor ${floorNotional.toFixed(2)})` });
        persistState();
        return;
      }
      it.status = "FAILED"; it.events.push({ at: Date.now(), ev: "OPEN_REJECTED", note: (r.err ?? "").slice(0, 160) }); return;
    }
    orderId = r.orderId;
    fillPrice = await resolveFill(it.tbSymbol, orderId, refPrice);
  } else {
    fillPrice = refPrice; // paper fill on the real toobit book (taker side)
  }
  const tFill = Date.now();
  it.status = "OPEN";
  it.qtyOrig = qty;
  it.qtyRemaining = qty;
  it.orderId = orderId;
  it.fillPrice = fillPrice;
  it.openedAt = tFill;
  // v1.3.0 doctrine bookkeeping — the truth of what the book actually saw:
  // step-size floor rounding makes actualNotional ≤ expectedNotional by design.
  it.actualNotional = fillPrice ? Number((qty * fillPrice).toFixed(6)) : null;
  it.protected = it.mode === "LIVE" ? true : true; // LIVE: attached TP/SL in same order + recon re-check; PAPER: sim active
  S.doctrine.opens++;
  const ndelta = it.expectedNotional && it.actualNotional ? Math.abs(it.actualNotional - it.expectedNotional) / it.expectedNotional * 10_000 : 0;
  audit("EXEC-OPEN-DOCTRINE", { serial: it.serial, lev: it.leverage, levSrc: it.levSrc ?? "card", margin: S.cfg.marginUsdt, expectedNotional: it.expectedNotional, actualNotional: it.actualNotional, notionalDeltaBps: Number(ndelta.toFixed(1)), entryAgeMs: it.entryAgeMs, entryDriftBps: it.entryDriftBps });
  if (ndelta > 2000) doctrineViolation(it.serial, "NOTIONAL-DELTA", `exp=${it.expectedNotional} act=${it.actualNotional} (${ndelta.toFixed(0)}bps) — step-rounding or minQty floor`);
  it.lat = {
    detectMs: it.lat.detectMs ?? null,
    execMs: tFill - tSent,
    totalMs: it.createdAt0 !== undefined ? tFill - it.createdAt0 : null,
    slipBps: fillPrice && it.cardEntry > 0 ? ((it.direction === "LONG" ? fillPrice - it.cardEntry : it.cardEntry - fillPrice) / it.cardEntry) * 10_000 : null,
  };
  it.events.push({ at: tFill, ev: "OPEN", note: `${it.mode} qty=${qty} fill=${fillPrice}` });
  S.metrics.push({ serial: it.serial, symbol: it.symbol, direction: it.direction, mode: it.mode, detectMs: it.lat.detectMs, execMs: it.lat.execMs, totalMs: it.lat.totalMs, slipBps: it.lat.slipBps, fillPrice, cardEntry: it.cardEntry, at: tFill });
  if (S.metrics.length > METRICS_WINDOW) S.metrics = S.metrics.slice(-METRICS_WINDOW);
}

// resolve the real average fill price of a market order (best effort)
async function resolveFill(tbSymbol: string, orderId: string | null, fallback: number): Promise<number> {
  if (orderId) {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 350));
      const r2 = await signed<{ status?: string; orderStatus?: string; avgPrice?: string; price?: string; executedQty?: string; cumQty?: string }>("GET", "/api/v1/futures/order", { orderId });
      const d = r2.data as Record<string, unknown> | null;
      const st = String(d?.status ?? d?.orderStatus ?? "").toUpperCase();
      const avg = Number(d?.avgPrice ?? d?.price ?? 0);
      if (avg > 0) return avg;
      if (/CANCELED|REJECTED|EXPIRED/.test(st)) break;
      if (st === "FILLED" || i === 2) break;
    }
  }
  return fallback;
}

async function doBank(it: Intent, fracOfOrig: number, reason: string): Promise<void> {
  if (it.status !== "OPEN" || it.qtyRemaining <= 0) return;
  let qty = floorStep(Math.min(it.qtyOrig * fracOfOrig, it.qtyRemaining), instruments.get(it.tbSymbol)?.stepSize ?? 0);
  if (qty <= 0) return;
  if (qty >= it.qtyRemaining) return doClose(it, reason);
  if (it.mode === "LIVE") {
    const side = it.direction === "LONG" ? "SELL_CLOSE" : "BUY_CLOSE";
    const r = await placeOrder(it.tbSymbol, side, qty);
    audit("EXEC-BANK", { serial: it.serial, reason, qty, ok: r.ok, err: r.err });
    if (!r.ok) { it.events.push({ at: Date.now(), ev: "BANK_REJECTED", note: (r.err ?? "").slice(0, 160) }); return; }
  } else {
    // v1.4.0 — PAPER سیو سود was invisible in audit.jsonl (only in state.json);
    // the paper fill rides the REAL toobit book so it deserves the same trail.
    audit("EXEC-BANK-PAPER", { serial: it.serial, reason, qty, note: "paper fill on real book" });
  }
  it.qtyRemaining = Number((it.qtyRemaining - qty).toFixed(10));
  if (reason === "TP1") it.qtyBankedTp1 = qty;
  if (reason === "TP2") it.qtyBankedTp2 = qty;
  it.events.push({ at: Date.now(), ev: reason, note: `banked ${qty} (سیو سود)` });
}

async function doClose(it: Intent, reason: string): Promise<void> {
  if (it.status === "CLOSED" || it.status === "CLOSING") return;
  it.status = "CLOSING";
  if (it.mode === "LIVE" && it.qtyRemaining > 0) {
    const flash = await flashClose(it.tbSymbol, it.direction);
    audit("EXEC-CLOSE", { serial: it.serial, reason, flash: flash.ok, err: flash.err });
    if (!flash.ok) {
      // fallback: explicit MARKET close of the remaining qty
      const side = it.direction === "LONG" ? "SELL_CLOSE" : "BUY_CLOSE";
      const r = await placeOrder(it.tbSymbol, side, it.qtyRemaining);
      audit("EXEC-CLOSE-FALLBACK", { serial: it.serial, reason, ok: r.ok, err: r.err });
      if (!r.ok) { it.status = "OPEN"; it.events.push({ at: Date.now(), ev: "CLOSE_REJECTED", note: (r.err ?? "").slice(0, 160) }); return; }
    }
  }
  it.qtyRemaining = 0;
  it.status = "CLOSED";
  it.closedAt = Date.now();
  it.closeReason = reason;
  it.events.push({ at: it.closedAt, ev: "CLOSED", note: reason });
  persistState();
}

// ── card poll — the lifecycle mirror ────────────────────────────────────────
let pollBusy = false;
async function pollCards(): Promise<void> {
  if (pollBusy) return;
  pollBusy = true;
  try {
    if (instrumentsAt === 0 || Date.now() - instrumentsAt > 10 * 60_000) await refreshInstruments();
    const cards = fetchRecentCards(60);
    if (cards.length === 0) return;
    const newest = Math.max(...cards.map((c) => parseTs(c.createdAt)));
    if (newest > S.lastCreatedAtMs) S.lastCreatedAtMs = newest;

    // ⓪ v1.4.0 RETRY WINDOW — a freed capacity slot inside the ENTRY-DELAY
    // window re-opens a MAX-CONCURRENT-skipped card (was: skipped forever).
    if (retryList.length > 0 && !killFile() && S.cfg.execEnabled) {
      const openCount0 = Object.values(S.intents).filter((x) => x.status === "OPEN" || x.status === "OPENING").length;
      if (S.cfg.maxConcurrent > 0 && openCount0 < S.cfg.maxConcurrent) {
        const nowMs = Date.now();
        retryList = retryList.filter((r) => {
          const it = S.intents[r.cardId];
          if (!it || it.status !== "SKIP") return false; // resolved otherwise
          const age = nowMs - (it.createdAt0 ?? r.createdAt0);
          if (age > S.cfg.maxEntryAgeMs) { audit("RETRY-EXPIRED", { serial: it.serial, ageSec: Math.round(age / 1000) }); return false; }
          it.status = "OPENING";
          it.events.push({ at: nowMs, ev: "RETRY", note: "capacity freed inside entry window" });
          pushAction({ kind: "open", cardId: r.cardId, reason: "RETRY-MAX-CONCURRENT" });
          audit("RETRY-OPEN", { serial: it.serial, symbol: it.symbol });
          return false;
        });
      }
    }

    // ① brand-new cards → intent
    for (const c of cards) {
      if (S.intents[c.id]) continue;
      if (c.status !== "ACTIVE") continue; // only live cards are executed
      const created = parseTs(c.createdAt);
      const age = Date.now() - created;
      const tbSymbol = toobitSymbol(c.symbol);
      const known = instruments.has(tbSymbol);
      const openCount = Object.values(S.intents).filter((x) => x.status === "OPEN" || x.status === "OPENING").length;
      let skip: string | null = null;
      if (age > STALE_SKIP_MS) skip = "STALE-CARD";
      else if (!known) skip = "SYMBOL-ABSENT-ON-TOOBIT";
      else if (!killFile() && S.cfg.execEnabled && S.cfg.maxConcurrent > 0 && openCount >= S.cfg.maxConcurrent) skip = "MAX-CONCURRENT";
      if (skip) countSkip(skip); // v1.3.0 doctrine funnel
      if (skip === "MAX-CONCURRENT") retryList.push({ cardId: c.id, createdAt0: created }); // v1.4.0 — eligible for the retry window
      const dir = c.direction === "SHORT" ? "SHORT" : "LONG";
      const levOk = c.leverage >= 1 && c.leverage <= 50;
      const intent: Intent = {
        cardId: c.id, serial: c.serial, symbol: c.symbol, tbSymbol,
        direction: dir,
        leverage: levOk ? c.leverage : S.cfg.leverage, // v1.2.0 per-card (fallback: cfg for legacy rows)
        levSrc: levOk ? "card" : "fallback", // v1.3.0 doctrine
        status: skip ? "SKIP" : "OPENING", mode: isLiveMode() ? "LIVE" : "PAPER",
        qtyOrig: 0, qtyRemaining: 0, qtyBankedTp1: 0, qtyBankedTp2: 0,
        cardEntry: c.entryPrice, tp1: c.tp1, tp2: c.tp2, tp3: c.tp3, stopLoss: c.stopLoss,
        clientOrderId: `NX${String(c.serial).padStart(4, "0")}`,
        orderId: null, fillPrice: null, openedAt: null, closedAt: null, closeReason: null,
        lat: { detectMs: age, execMs: null, totalMs: null, slipBps: null },
        lastStatusSeen: c.status,
        events: [{ at: Date.now(), ev: skip ? `SKIP:${skip}` : "DETECTED", note: `age=${age}ms` }],
      };
      intent.createdAt0 = created;
      S.intents[c.id] = intent;
      audit(skip ? "SKIP" : "DETECT", { serial: c.serial, symbol: c.symbol, direction: dir, age, skip });
      if (!skip && !killFile() && S.cfg.execEnabled) pushAction({ kind: "open", cardId: c.id, reason: "CARD-ACTIVE" });
    }

    // ② tracked cards → status transitions
    const liveIds = Object.keys(S.intents).filter((id) => {
      const st = S.intents[id]?.status;
      return st === "OPENING" || st === "OPEN";
    }).slice(-TRACK_LIMIT);
    if (liveIds.length > 0) {
      const rows = fetchCardsByIds(liveIds);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of liveIds) {
        const it = S.intents[id]!;
        const c = byId.get(id);
        if (!c) continue;
        const prev = it.lastStatusSeen;
        if (c.status === prev) continue;
        it.lastStatusSeen = c.status;
        it.cardStatus = c.status; // v1.3.0 doctrine — visible open-management mirror
        if (c.status === "TP1") pushAction({ kind: "bank", cardId: id, frac: S.cfg.tp1Frac, reason: "TP1" });
        else if (c.status === "TP2") pushAction({ kind: "bank", cardId: id, frac: S.cfg.tp2Frac, reason: "TP2" });
        else if (c.status === "TP3") pushAction({ kind: "close", cardId: id, reason: "TP3 (سیو سود کامل)" });
        else if (c.status === "SL") pushAction({ kind: "close", cardId: id, reason: "SL (استاپ شده)" });
        else if (c.status === "EXPIRED") pushAction({ kind: "close", cardId: id, reason: "EXPIRED (سیگنال منقضی)" });
        else if (c.status === "CLOSED") pushAction({ kind: "close", cardId: id, reason: "CLOSED" });
        else if (c.status === "VOID") pushAction({ kind: "close", cardId: id, reason: "VOID (qualityFlag)" });
        audit("CARD-EVENT", { serial: it.serial, from: prev, to: c.status });
      }
    }

    // ③ paper-mode protective TP/SL sim (exchange-side stand-in)
    for (const it of Object.values(S.intents)) {
      if (it.mode !== "PAPER" || it.status !== "OPEN") continue;
      const t = await tbTicker(it.tbSymbol);
      if (!t) continue;
      if (it.direction === "LONG") {
        if (t.last >= it.tp3) pushAction({ kind: "close", cardId: it.cardId, reason: "PAPER-TP3" });
        else if (t.last <= it.stopLoss) pushAction({ kind: "close", cardId: it.cardId, reason: "PAPER-SL" });
      } else {
        if (t.last <= it.tp3) pushAction({ kind: "close", cardId: it.cardId, reason: "PAPER-TP3" });
        else if (t.last >= it.stopLoss) pushAction({ kind: "close", cardId: it.cardId, reason: "PAPER-SL" });
      }
    }
  } finally {
    flushState();
    pollBusy = false;
  }
}

// ── mode + account ───────────────────────────────────────────────────────────
// ── v1.4.0 ORPHAN SWEEP — پیگیری کارت‌های بدون آینهٔ اجرا ────────────────────
// Forensics (trace 1a1704d407f00dad): ~52 cards (3055-3107) born during the
// ghost/downtime window never got an intent — silent holes in the execution
// mirror. Read-only visibility: each unmirrored ACTIVE card becomes ONE
// auditable ORPHAN-CARD event. No forced entries — late chasing stays behind
// the ENTRY-DELAY/ENTRY-DRIFT doctrine (a card older than the window is not
// the trade the card described).
const orphanSeen = new Set<string>();
let orphanSweepBusy = false;
function orphanSweep(): void {
  if (orphanSweepBusy || !sqldb) return;
  orphanSweepBusy = true;
  try {
    const cards = fetchRecentCards(300); // ~last 300 cards ≈ 24-48h coverage
    for (const c of cards) {
      if (c.status !== "ACTIVE" || S.intents[c.id] || orphanSeen.has(c.id)) continue;
      orphanSeen.add(c.id);
      if (orphanSeen.size > 500) { const first = orphanSeen.values().next().value; if (first) orphanSeen.delete(first); }
      const age = Date.now() - parseTs(c.createdAt);
      S.doctrine.orphans = (S.doctrine.orphans ?? 0) + 1;
      audit("ORPHAN-CARD", { serial: c.serial, symbol: c.symbol, direction: c.direction, ageMin: Math.round(age / 60_000), note: "ACTIVE card without execution intent — born during bridge downtime/ghost window (read-only visibility)" });
    }
  } finally { orphanSweepBusy = false; }
}

let balanceUsdt: number | null = null;
let balanceAt = 0;
async function refreshBalance(): Promise<void> {
  if (!API_KEY) { balanceUsdt = null; return; }
  const r = await signed<Array<{ coin?: string; asset?: string; availableBalance?: string; balance?: string }>>("GET", "/api/v1/futures/balance");
  const rows = Array.isArray(r.data) ? r.data : [];
  const usdt = rows.find((b) => (b.coin ?? b.asset) === "USDT");
  const avail = Number(usdt?.availableBalance ?? usdt?.balance ?? 0);
  balanceUsdt = Number.isFinite(avail) ? avail : null;
  balanceAt = Date.now();
}
function isLiveMode(): boolean {
  return S.cfg.liveApproved && (balanceUsdt ?? 0) > 0 && API_KEY.length > 0;
}

// ── reconciliation (راستی‌آزمایی) ────────────────────────────────────────────
let reconBusy = false;
async function reconcile(): Promise<void> {
  if (reconBusy || !isLiveMode()) return;
  reconBusy = true;
  try {
    const pos = await signed<Array<{ symbol: string; side: string; position: string; avgPrice: string; unrealizedPnL?: string }>>("GET", "/api/v1/futures/positions");
    const rows = Array.isArray(pos.data) ? pos.data : [];
    const openIntents = Object.values(S.intents).filter((i) => i.status === "OPEN" || i.status === "OPENING");
    for (const p of rows) {
      const qty = Number(p.position);
      if (!(qty > 0)) continue;
      const match = openIntents.find((i) => i.tbSymbol === p.symbol && i.direction === p.side);
      if (!match) { audit("RECON-UNKNOWN-POSITION", { symbol: p.symbol, side: p.side, qty }); continue; }
      const avg = Number(p.avgPrice);
      if (avg > 0 && match.fillPrice && Math.abs(avg - match.fillPrice) / avg > 0.002) {
        audit("RECON-DRIFT-ENTRY", { serial: match.serial, exchange: avg, local: match.fillPrice });
        match.fillPrice = avg;
        match.actualNotional = Number((match.qtyOrig * avg).toFixed(6)); // v1.3.0 — keep the doctrine truth synced
      }
      // exchange-side protective orders present?
      const oo = await signed<Array<{ symbol?: string; type?: string; orderType?: string }>>("GET", "/api/v1/futures/openOrders", { symbol: p.symbol });
      const orows = Array.isArray(oo.data) ? oo.data : [];
      const hasStop = orows.some((o) => (o.type ?? o.orderType ?? "").toUpperCase().includes("STOP"));
      match.protected = hasStop; // v1.3.0 doctrine — protection is audited, not assumed
      if (!hasStop) {
        const side = match.direction === "LONG" ? "LONG" : "SHORT";
        const r = await signed("POST", "/api/v1/futures/position/trading-stop", { symbol: p.symbol, side, takeProfit: String(match.tp3), stopLoss: String(match.stopLoss), tpTriggerBy: "MARK_PRICE", slTriggerBy: "MARK_PRICE" });
        audit("RECON-REATTACH-TPSL", { serial: match.serial, symbol: p.symbol, ok: r.ok, err: r.err });
        match.protected = r.ok; // re-attach succeeded → protected again
      }
    }
    // intents whose position vanished on-exchange → verify + close bookkeeping
    for (const it of openIntents) {
      if (it.mode !== "LIVE") continue;
      const still = rows.some((p) => p.symbol === it.tbSymbol && p.side === it.direction && Number(p.position) > 0);
      if (!still && it.status === "OPEN") {
        audit("RECON-POSITION-GONE", { serial: it.serial, symbol: it.tbSymbol });
        it.status = "CLOSED";
        it.qtyRemaining = 0;
        it.closedAt = Date.now();
        it.closeReason = it.closeReason ?? "EXCHANGE-CLOSED (recon)";
        it.events.push({ at: Date.now(), ev: "RECON-CLOSED" });
      }
    }
    persistState();
  } finally { reconBusy = false; }
}

// ── metrics helpers ──────────────────────────────────────────────────────────
const pct = (arr: Array<number | null>, p: number): number | null => {
  const v = arr.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))]!;
};
function metricsSummary() {
  const m = S.metrics;
  return {
    n: m.length,
    detectMsP50: pct(m.map((x) => x.detectMs), 50),
    execMsP50: pct(m.map((x) => x.execMs), 50),
    totalMsP50: pct(m.map((x) => x.totalMs), 50),
    totalMsP95: pct(m.map((x) => x.totalMs), 95),
    slipBpsP50: pct(m.map((x) => x.slipBps), 50),
    slipBpsWorst: pct(m.map((x) => x.slipBps), 100),
    last: m.slice(-5).reverse(),
  };
}

// ── v1.3.0 DOCTRINE SUPERVISOR — پیگیری و دکترین (trace 1a15f7d945d27ead) ──
// Every 30s: audit OPEN intents against the card ledger — leverage mirror,
// notional math (expected vs actual), card-status mirror lag, protection —
// and persist a snapshot the senior supervisor (supervisor-cron) polls.
let doctrineBusy = false;
async function doctrineScan(): Promise<void> {
  if (doctrineBusy || !sqldb) return;
  doctrineBusy = true;
  try {
    const now = Date.now();
    const openIntents = Object.values(S.intents).filter((i) => i.status === "OPEN" || i.status === "OPENING");
    if (openIntents.length > 0) {
      const rows = fetchCardsByIds(openIntents.map((i) => i.cardId));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const it of openIntents) {
        const c = byId.get(it.cardId);
        // ① leverage must mirror the card (v1.2.0 doctrine) — violation only,
        // never a mid-flight mutation of a live position's bookkeeping.
        if (c && c.leverage >= 1 && c.leverage !== it.leverage) {
          doctrineViolation(it.serial, "LEV-MISMATCH", `card=${c.leverage} intent=${it.leverage} — card ledger is authoritative; next entries use ${c.leverage}`);
        }
        // ② notional math on the live position (margin ثابت × اهرم کارت)
        const exp = S.cfg.marginUsdt * it.leverage;
        it.expectedNotional = Number(exp.toFixed(6));
        if (it.qtyOrig > 0 && it.fillPrice) {
          it.actualNotional = Number((it.qtyOrig * it.fillPrice).toFixed(6));
          const deltaBps = Math.abs(it.actualNotional - exp) / exp * 10_000;
          if (deltaBps > 2000) doctrineViolation(it.serial, "NOTIONAL-DELTA", `exp=${exp.toFixed(2)} act=${it.actualNotional.toFixed(2)} (${deltaBps.toFixed(0)}bps)`);
        }
        // ③ card-status mirror (مدیریت سیگنال‌های باز): record + lag audit
        if (c) {
          it.cardStatus = c.status;
          const TERMINAL = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED", "VOID"];
          const openedFor = it.openedAt ? now - it.openedAt : 0;
          if (TERMINAL.includes(c.status) && it.status === "OPEN" && openedFor > 90_000 && !TERMINAL.includes(it.lastStatusSeen)) {
            doctrineViolation(it.serial, "MIRROR-LAG", `card=${c.status} but intent still OPEN ${Math.round(openedFor / 1000)}s — pollCards transition should have fired`);
          }
        }
        // ④ protection: LIVE audited by recon (hasStop); PAPER sim always on
        if (it.protected === undefined) it.protected = it.mode !== "LIVE";
      }
    }
    S.doctrine.lastScanAt = now;
    const snap = {
      at: now, ver: VER,
      gates: { marginUsdt: S.cfg.marginUsdt, maxEntryDriftBps: S.cfg.maxEntryDriftBps, maxEntryAgeMs: S.cfg.maxEntryAgeMs, maxConcurrent: S.cfg.maxConcurrent },
      counters: { opens: S.doctrine.opens, skipBy: S.doctrine.skipBy, orphans: S.doctrine.orphans ?? 0 },
      violations: S.doctrine.violations.slice(-10),
      openIntents: openIntents.map((i) => ({ serial: i.serial, symbol: i.symbol, direction: i.direction, lev: i.leverage, levSrc: i.levSrc ?? "card", expectedNotional: i.expectedNotional ?? null, actualNotional: i.actualNotional ?? null, entryAgeMs: i.entryAgeMs ?? null, entryDriftBps: i.entryDriftBps ?? null, cardStatus: i.cardStatus ?? i.lastStatusSeen, status: i.status, mode: i.mode, protected: i.protected ?? (i.mode !== "LIVE") })),
    };
    try { writeFileSync(`${DATA}/doctrine-latest.json`, JSON.stringify(snap, null, 2)); } catch { /* snapshot best-effort */ }
    persistState();
  } finally { doctrineBusy = false; }
}
function doctrineSummary() {
  return {
    opens: S.doctrine.opens,
    skipBy: S.doctrine.skipBy,
    orphans: S.doctrine.orphans ?? 0, // v1.4.0
    violationsN: S.doctrine.violations.length,
    lastViolation: S.doctrine.violations.length > 0 ? S.doctrine.violations[S.doctrine.violations.length - 1]! : null,
    lastScanAt: S.doctrine.lastScanAt,
    gates: { marginUsdt: S.cfg.marginUsdt, maxEntryDriftBps: S.cfg.maxEntryDriftBps, maxEntryAgeMs: S.cfg.maxEntryAgeMs },
  };
}

// ── HTTP API ─────────────────────────────────────────────────────────────────
const bootAt = Date.now();
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const authed = req.headers.get("x-nexus-key") === AUTH_KEY;
    if (req.method === "GET" && (path === "/health" || path === "/")) {
      return Response.json({ ok: true, ver: VER, mode: isLiveMode() ? "LIVE" : "PAPER", execEnabled: S.cfg.execEnabled, killFile: killFile(), bootAt, uptimeS: Math.round((Date.now() - bootAt) / 1000) });
    }
    if (req.method === "GET" && path === "/doctrine") {
      // v1.3.0 — the senior-supervisor feed (supervisor-cron polls this)
      const intents = Object.values(S.intents).sort((a, b) => (b.openedAt ?? b.closedAt ?? 0) - (a.openedAt ?? a.closedAt ?? 0));
      return Response.json({
        ok: true, ver: VER, mode: isLiveMode() ? "LIVE" : "PAPER",
        doctrine: doctrineSummary(),
        violations: S.doctrine.violations.slice(-20).reverse(),
        openIntents: intents.filter((i) => i.status === "OPEN" || i.status === "OPENING").map((i) => ({ serial: i.serial, symbol: i.symbol, direction: i.direction, lev: i.leverage, levSrc: i.levSrc ?? "card", expectedNotional: i.expectedNotional ?? null, actualNotional: i.actualNotional ?? null, entryAgeMs: i.entryAgeMs ?? null, entryDriftBps: i.entryDriftBps ?? null, cardStatus: i.cardStatus ?? i.lastStatusSeen, status: i.status, mode: i.mode, protected: i.protected ?? (i.mode !== "LIVE"), openedAt: i.openedAt, lat: i.lat })),
      });
    }
    if (req.method === "GET" && path === "/status") {
      const intents = Object.values(S.intents).sort((a, b) => (b.openedAt ?? b.closedAt ?? 0) - (a.openedAt ?? a.closedAt ?? 0));
      return Response.json({
        ver: VER,
        mode: isLiveMode() ? "LIVE" : "PAPER",
        liveApproved: S.cfg.liveApproved,
        balanceUsdt, balanceAt,
        cfg: S.cfg,
        killFile: killFile(),
        openIntents: intents.filter((i) => i.status === "OPEN" || i.status === "OPENING"),
        recent: intents.slice(-12).reverse(),
        metrics: metricsSummary(),
        instruments: instruments.size,
        clockOffsetMs: clockOffset,
        lastCreatedAtMs: S.lastCreatedAtMs,
        doctrine: doctrineSummary(), // v1.3.0 — UI panel + senior supervisor read this
      });
    }
    if (req.method === "POST") {
      if (!authed) return Response.json({ ok: false, err: "unauthorized" }, { status: 401 });
      let body: Record<string, unknown> = {};
      try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
      if (path === "/exec-toggle") {
        S.cfg.execEnabled = body.enabled !== false;
        audit("CFG-EXEC-TOGGLE", { enabled: S.cfg.execEnabled });
        persistState(); flushState();
        return Response.json({ ok: true, execEnabled: S.cfg.execEnabled });
      }
      if (path === "/approve-live") {
        S.cfg.liveApproved = body.approve === true;
        audit("CFG-LIVE-APPROVAL", { approve: S.cfg.liveApproved });
        persistState(); flushState();
        return Response.json({ ok: true, liveApproved: S.cfg.liveApproved, note: "LIVE requires positive futures balance too" });
      }
      if (path === "/config") {
        const c = S.cfg;
        if (typeof body.marginUsdt === "number" && body.marginUsdt >= 1 && body.marginUsdt <= 100) c.marginUsdt = body.marginUsdt;
        if (typeof body.notionalUsdt === "number" && body.notionalUsdt >= 5 && body.notionalUsdt <= 500) c.notionalUsdt = body.notionalUsdt;
        if (typeof body.maxConcurrent === "number" && body.maxConcurrent >= 0 && body.maxConcurrent <= 50) c.maxConcurrent = Math.floor(body.maxConcurrent); // 0 = UNLIMITED (v1.4.1)
        if (typeof body.tp1Frac === "number" && body.tp1Frac > 0 && body.tp1Frac < 1) c.tp1Frac = body.tp1Frac;
        if (typeof body.tp2Frac === "number" && body.tp2Frac > 0 && body.tp2Frac < 1) c.tp2Frac = body.tp2Frac;
        if (typeof body.leverage === "number" && body.leverage >= 1 && body.leverage <= 50) c.leverage = Math.floor(body.leverage);
        if (typeof body.maxEntryDriftBps === "number" && body.maxEntryDriftBps >= 10 && body.maxEntryDriftBps <= 500) c.maxEntryDriftBps = Math.floor(body.maxEntryDriftBps);
        if (typeof body.maxEntryAgeMs === "number" && body.maxEntryAgeMs >= 10_000 && body.maxEntryAgeMs <= 600_000) c.maxEntryAgeMs = Math.floor(body.maxEntryAgeMs);
        audit("CFG-UPDATE", { cfg: c });
        persistState(); flushState();
        return Response.json({ ok: true, cfg: c });
      }
      if (path === "/close") {
        const serial = Number(body.serial);
        const it = Object.values(S.intents).find((i) => i.serial === serial && (i.status === "OPEN" || i.status === "OPENING"));
        if (!it) return Response.json({ ok: false, err: "no open intent for serial" }, { status: 404 });
        pushAction({ kind: "close", cardId: it.cardId, reason: "OPERATOR-MANUAL" });
        return Response.json({ ok: true, queued: true, serial });
      }
      if (path === "/test-cycle") {
        // verification hook — PAPER ONLY (real-order protection): opens a
        // synthetic intent on the REAL toobit book, then closes it. Exercises
        // detect→open→close→metrics without touching the engine ledger.
        if (isLiveMode()) return Response.json({ ok: false, err: "test-cycle blocked in LIVE mode" }, { status: 403 });
        const sym = String(body.symbol ?? "BTCUSDT").toUpperCase().replace(/USDT$/, "");
        const tbSymbol = `${sym}-SWAP-USDT`;
        if (!instruments.has(tbSymbol)) return Response.json({ ok: false, err: `symbol absent: ${tbSymbol}` }, { status: 404 });
        const cardId = `test-${Date.now()}`;
        const now = Date.now();
        const tick = await tbTicker(tbSymbol);
        const entry = Number(body.entry) || tick?.last || 0;
        const dir = body.direction === "SHORT" ? "SHORT" : "LONG";
        const it: Intent = {
          cardId, serial: 0, symbol: `${sym}USDT`, tbSymbol,
          direction: dir,
          leverage: S.cfg.leverage,
          levSrc: "fallback" as const,
          status: "OPENING", mode: "PAPER",
          qtyOrig: 0, qtyRemaining: 0, qtyBankedTp1: 0, qtyBankedTp2: 0,
          cardEntry: entry,
          // protective bands ±5% so the paper TP/SL sim never fires mid-test
          tp1: 0, tp2: 0,
          tp3: dir === "LONG" ? entry * 1.05 : entry * 0.95,
          stopLoss: dir === "LONG" ? entry * 0.95 : entry * 1.05,
          clientOrderId: `TEST${String(now % 100000)}`,
          orderId: null, fillPrice: null, openedAt: null, closedAt: null, closeReason: null,
          createdAt0: now - 1234, // synthetic 1.2s detect-lag reference
          lat: { detectMs: 1234, execMs: null, totalMs: null, slipBps: null },
          lastStatusSeen: "TEST",
          events: [{ at: now, ev: "TEST-CYCLE", note: "verification hook (paper)" }],
        };
        S.intents[cardId] = it;
        pushAction({ kind: "open", cardId, reason: "TEST-CYCLE" });
        setTimeout(() => { const t = S.intents[cardId]; if (t && t.status === "OPEN") pushAction({ kind: "close", cardId, reason: "TEST-CYCLE-CLOSE" }); }, 2500);
        audit("TEST-CYCLE", { symbol: tbSymbol, direction: it.direction });
        return Response.json({ ok: true, cardId, note: "paper open+close queued" });
 }
      return Response.json({ ok: false, err: "unknown path" }, { status: 404 });
    }
    return Response.json({ ok: false, err: "not found" }, { status: 404 });
  },
});

// ── main loops ───────────────────────────────────────────────────────────────
log("info", `${VER} booting`, { port: PORT, hasKeys: API_KEY.length > 0, dbExists: existsSync(DB_PATH) });
audit("BOOT", { ver: VER, hasKeys: API_KEY.length > 0 });
if (!acquireSingletonLock()) process.exit(1); // v1.4.0 — one writer, ever
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { flushState(); releaseSingletonLock(); process.exit(0); });
loadState();
if (openDb()) {
  await syncClock();
  await refreshInstruments().catch(() => undefined);
  await refreshBalance().catch(() => undefined);
  log("info", "armed", { mode: isLiveMode() ? "LIVE" : "PAPER", instruments: instruments.size, balanceUsdt });
  setInterval(() => { void pollCards(); }, POLL_MS);
  setInterval(() => { void reconcile(); }, RECON_MS);
  setInterval(() => { void doctrineScan(); }, 30_000); // v1.3.0 — senior-supervisor audit loop
  setInterval(() => { void refreshBalance(); }, 60_000);
  setInterval(() => { void syncClock(); }, 10 * 60_000);
  setInterval(flushState, 1000);
  setInterval(orphanSweep, 60_000); // v1.4.0 — unmirrored ACTIVE cards become auditable
  void pollCards();
  orphanSweep();
} else {
  log("crit", "DB unavailable — retrying in 10s");
  setInterval(() => { if (!sqldb && openDb()) { void syncClock(); void pollCards(); } }, 10_000);
}
