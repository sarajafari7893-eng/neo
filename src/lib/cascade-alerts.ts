// ── v12.10 CASCADE-FREEZE registry (server-only) ────────────────────────────
// AUDIT-20261023 follow-up — operator mandate: «چرا سرعت تشخیص هنوز اصلاح
// نشده؟ چه اقدامات مهندسی لازم است؟»
//
// Root cause measured: the L3_LIQ_CASCADE layer is LIQUIDATION-STREAM based
// (forceOrder) — structurally silent for microcaps that produce zero
// forceOrder events (JCT/IRYS forensics), and VolCauseEvent registration is
// backward-looking (IRYS +565% day = ONE event, registered 16h late at the
// tick-top; the −77.4% crash after it registered NOTHING).
//
// This registry is fed by the price-ws TICK-VELOCITY detector (a ≥±5% move
// inside a 60s sliding window — measured on the live WS tape, independent of
// liquidation streams). A cascade alert freezes BOTH-direction machine
// deploys for the symbol for FREEZE_MS: the engine checks
// cascadeFreezeActive(symbol) before deploying. Detection latency drops from
// the measured 359s (NX-3046) to the 15-60s window of the tick plane.
//
// Storage: globalThis singleton map (Turbopack per-route split-brain safe,
// same doctrine as flow-scanner's fbStats) — 10min TTL self-expires, re-fires
// extend the freeze. No DB writes: the single-writer discipline stays intact.

export interface CascadeAlert {
  symbol: string;
  side: "UP" | "DOWN";
  movePct: number; // signed move inside the window
  windowMs: number; // measured span of the move
  lane: string; // WS lane that saw it (WS·SPOT / WS PUSH / WS·FUT-BOOK)
  at: number; // alert epoch ms
  until: number; // freeze expiry epoch ms
}

const FREEZE_MS = 10 * 60_000;
const MAX_ALERTS = 200;

const g = globalThis as { __nexusCascadeAlerts?: Map<string, CascadeAlert> };
g.__nexusCascadeAlerts ??= new Map<string, CascadeAlert>();
const alerts = g.__nexusCascadeAlerts;

/** Record/refresh a cascade alert from the price-ws plane (freeze extends on re-fire). */
export function recordCascadeAlert(input: { symbol: string; side: string; movePct: number; windowMs: number; lane: string; at: number }): CascadeAlert {
  const now = Date.now();
  const prev = alerts.get(input.symbol);
  const rec: CascadeAlert = {
    symbol: input.symbol,
    side: input.side === "UP" ? "UP" : "DOWN",
    movePct: Number(input.movePct.toFixed(2)),
    windowMs: Math.max(0, Math.round(input.windowMs)),
    lane: String(input.lane).slice(0, 24),
    at: input.at > 0 && input.at <= now + 5_000 ? input.at : now,
    until: Math.max(now + FREEZE_MS, prev && prev.until > now ? prev.until : 0),
  };
  alerts.set(rec.symbol, rec);
  // prune expired + cap the ring (oldest-alert-first)
  for (const [k, v] of alerts) if (v.until < now) alerts.delete(k);
  if (alerts.size > MAX_ALERTS) {
    const oldest = [...alerts.values()].sort((a, b) => a.at - b.at)[0];
    if (oldest) alerts.delete(oldest.symbol);
  }
  return rec;
}

/** Engine hot-path check — is the symbol's deploy lane frozen by a live cascade? */
export function cascadeFreezeActive(symbol: string): { active: boolean; info: CascadeAlert | null } {
  const rec = alerts.get(symbol);
  if (!rec || rec.until < Date.now()) return { active: false, info: null };
  return { active: true, info: rec };
}

/** All active freezes — /api dashboard + supervisor grounding. */
export function cascadeFreezes(): CascadeAlert[] {
  const now = Date.now();
  for (const [k, v] of alerts) if (v.until < now) alerts.delete(k);
  return [...alerts.values()].sort((a, b) => b.at - a.at);
}
