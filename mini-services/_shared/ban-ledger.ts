// ── NEXUS//SIGNALS shared fapi BAN-LEDGER (v1.0 — TASK-49) ──────────────────
// WHY: the app's fapi-gate (src/lib/fapi-gate.ts) persists named-IP bans to
// .data/fapi-gate/bans.json, but the mini-services that ALSO dial fapi
// (trade-service REST tape, price-ws REST ticker) ran their own private ban
// timers: each resumed polling the moment its own window elapsed, drew a
// still-banned pool IP, and the 418 contact re-escalated Binance's expiry —
// the 11:58Z→12:34Z→13:09Z pause spiral (2026-10-19). Every contact during a
// live ban can ESCALATE (supervisor-sr v1.0.1 lesson), so ALL fapi touchers
// must share ONE truth: this ledger.
//
// Contract:
//   · entries are { ip → banEndMs } carrying Binance's REAL "banned until"
//     (sanity-capped at +24h, never the cosmetic 35min display cap)
//   · readLedgerBans()     → live entries only (expired dropped)
//   · ledgerPoolBanUntil() → the LATEST live ban end across the pool (0 = clean)
//     — OBSERVABILITY ONLY since v1.1: it no longer drives resume rules.
//   · ledgerUnknownScopeBanUntil() → the latest live UNKNOWN-SCOPE ("_pool")
//     ban end (0 = clean) — THE resume rule since v1.1.
//   · writeLedgerBan()     → read-merge-write (never shortens an existing
//     entry), debounced so ban-storm bursts don't thrash the file
//
// v1.1 BINANCE-REVIVAL (operator order «سیستم را به بایننس متصل کن»,
// trace 1a15ac1a1724cdb1) — SCOPE-AWARE ledger, matching fapi-gate v12.6.
// Measured 2026-10-20 19:17Z: with ONE named pool IP banned, 9 direct draws
// returned 7×200 / 2×418 — the NAT pool is majority-clean. The old rule
// (“ONE banned IP means any request may land on it” ⇒ pool-wide silence)
// blacked out the fapi plane for up to 35min per named event and starved
// flow weighting ×0.5 (legacy). New contract:
//   · NAMED-IP ban (writeLedgerBan("1.2.3.4", until)) → ONE keyed entry.
//     Intel + per-lane 418 retry fuel — NEVER a pool-wide resume block.
//   · UNKNOWN-SCOPE ban (writeLedgerBan(null, until)) → a "_pool" marker.
//     Pool itself is the suspect ⇒ ALL consumers pause until it expires.
//   · writeLedgerBan no longer stamps a "_pool" marker alongside every named
//     entry (the old double-write turned every named ban into a silent global
//     blackout — the exact starvation this revision cures).
// Same file the app gate reads at boot and refreshes every 30s — one truth,
// four processes (app gate, trade-service, price-ws, supervisor-sr observer).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = process.env.NEXUS_ROOT || "/home/z/my-project";
const LEDGER_PATH = `${ROOT}/.data/fapi-gate/bans.json`;

const WRITE_DEBOUNCE_MS = 5_000;
const SANITY_CAP_MS = 24 * 3600_000; // a "banned until" beyond +24h is a parse artifact — clamp

let writeTimer: ReturnType<typeof setTimeout> | null = null;
const pendingWrites = new Map<string, number>();

export function readLedgerBans(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const raw = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as { ipBans?: Record<string, number> } | null;
    const now = Date.now();
    for (const [ip, until] of Object.entries(raw?.ipBans ?? {})) {
      if (typeof until === "number" && until > now) out.set(ip, until);
    }
  } catch {
    /* no ledger / unreadable — treat as clean, fail-open */
  }
  return out;
}

/** Latest live ban end across ALL pool IPs (0 = no known live ban).
 *  v1.1: observability/reporting only — resume rules use the scope-aware twin. */
export function ledgerPoolBanUntil(): number {
  let max = 0;
  for (const until of readLedgerBans().values()) if (until > max) max = until;
  return max;
}

/** v1.1 — latest live UNKNOWN-SCOPE ("_pool"-style) ban end (0 = clean).
 *  THE resume rule: pause all fapi dialing only while the POOL ITSELF is
 *  suspected; a single named pool member's ban never silences the fleet. */
export function ledgerUnknownScopeBanUntil(): number {
  let max = 0;
  for (const [key, until] of readLedgerBans()) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(key) && until > max) max = until;
  }
  return max;
}

/**
 * Merge one ban observation into the ledger. v1.1 SCOPE-AWARE: a named IP
 * (`ip` non-null) writes ONLY that keyed entry — intel, retried around, never
 * a fleet-wide pause. `ip` null (unparseable body — unknown scope) writes a
 * "_pool" marker so every consumer pauses until it expires. Never shortens
 * an existing entry; sanity-capped at +24h.
 */
export function writeLedgerBan(ip: string | null, untilMs: number): void {
  const now = Date.now();
  if (!Number.isFinite(untilMs) || untilMs <= now) return; // expired/past — nothing to record
  const until = Math.min(untilMs, now + SANITY_CAP_MS);
  if (ip) {
    pendingWrites.set(ip, Math.max(pendingWrites.get(ip) ?? 0, until));
  } else {
    pendingWrites.set("_pool", Math.max(pendingWrites.get("_pool") ?? 0, until));
  }
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush();
  }, WRITE_DEBOUNCE_MS);
}

function flush(): void {
  if (pendingWrites.size === 0) return;
  const writes = pendingWrites;
  pendingWrites.clear();
  try {
    let disk: Record<string, number> = {};
    try {
      const raw = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as { ipBans?: Record<string, number> } | null;
      disk = raw?.ipBans ?? {};
    } catch {
      /* fresh ledger */
    }
    const now = Date.now();
    for (const [ip, until] of Object.entries(disk)) {
      if (typeof until === "number" && until > now) {
        writes.set(ip, Math.max(writes.get(ip) ?? 0, until));
      }
    }
    mkdirSync(`${ROOT}/.data/fapi-gate`, { recursive: true });
    const ipBans: Record<string, number> = {};
    for (const [ip, until] of writes) if (until > Date.now()) ipBans[ip] = until;
    writeFileSync(LEDGER_PATH, JSON.stringify({ savedAt: new Date().toISOString(), ipBans }, null, 1));
  } catch {
    /* fail-open — observability only */
  }
}
