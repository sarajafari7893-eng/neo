// ── NEXUS//SIGNALS spot-host gate (v13.2.1 SPOT-BAN-BACKOFF) ────────────────
// Completes the v13.2 SPOT-HOST LADDER: the ladder could DETECT a 418/429
// (fall through to the next rung) but had NO per-host backoff, so every tick
// re-poked the banned host first — wasting weight and keeping ban pressure
// alive. Live evidence 2026-10-25T00:48Z: data-api.binance.vision flapped
// 429/418 at x-mbx-used-weight-1m: 467 with retry-after: 889s while fapi
// served 200 @73ms (separate ban pools per host confirmed).
//
// Contract (read-only, zero data invention):
//   · 418 → host silent for retry-after seconds (capped 15min)
//   · 429 → soft 60s pause (retry-after respected when present)
//   · ladders ask spotHostsReady() and skip mid-ban hosts → traffic
//     auto-redistributes to the healthy rung and slides back on expiry.
//   · globalThis dedupe — Turbopack can instantiate per-route bundles; the
//     engine tick loop and /api routes MUST share one ban map (fbStats pattern).
const CAP_MS = 15 * 60_000;

interface GateState { bannedUntil: Record<string, number> }
const g = globalThis as { __nexusSpotHostGate?: GateState };
g.__nexusSpotHostGate ??= { bannedUntil: {} };
const S = g.__nexusSpotHostGate;

export function spotHostReady(host: string, now = Date.now()): boolean {
  return (S.bannedUntil[host] ?? 0) <= now;
}

export function spotHostsReady(hosts: string[], now = Date.now()): string[] {
  return hosts.filter((h) => spotHostReady(h, now));
}

/** Feed a 418/429 Response — parse retry-after (s) and arm the host's ban window. One honest warn per episode. */
export function noteSpotHostThrottle(host: string, status: number, headers: Headers): void {
  const now = Date.now();
  let ms = status === 418 ? CAP_MS : 60_000;
  const ra = Number(headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) ms = Math.min(ra * 1000, CAP_MS);
  const prev = S.bannedUntil[host] ?? 0;
  if (prev < now + 1000) {
    console.warn(`[spot-host-gate] ${host} → ${status} — leg silent ${Math.round(ms / 1000)}s (weight1m=${headers.get("x-mbx-used-weight-1m") ?? "?"})`);
  }
  S.bannedUntil[host] = Math.max(prev, now + ms);
}

/** Shared ladder fetch for the spot-plane rungs: skip banned hosts, arm bans on 418/429, honest null on total failure. */
export async function spotLadderJson<T>(path: string, hosts: string[], timeoutMs = 8000): Promise<T | null> {
  for (const host of spotHostsReady(hosts)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${host}${path}`, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (res.status === 418 || res.status === 429) {
        noteSpotHostThrottle(host, res.status, res.headers);
        continue;
      }
      if (!res.ok) continue;
      return (await res.json()) as T;
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
