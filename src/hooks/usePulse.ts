"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { PulseSnapshot } from "@/lib/api-types";

/* ── server-anchored clock (dashboard clock-drift fix, 2026-09-07) ──
 * TTL countdowns and relative ages were computed from the CLIENT clock;
 * any skew between the operator's device and the engine host shifted every
 * TTL/age by that amount. Each pulse payload carries the engine's epoch-ms
 * `ts`; we keep an EMA-smoothed offset and useNow()/serverNow() return the
 * server-anchored time. Hydration stays safe: server snapshot = 0. */
let clockOffsetMs = 0;
let clockSamples = 0;
const clockListeners = new Set<() => void>();

/** Current time anchored to the engine host clock (client-side). */
export function serverNow(): number {
  return Date.now() + clockOffsetMs;
}

/** Feed a server epoch-ms timestamp observed at receivedAtMs (default now). */
export function syncServerClock(serverTs: number | undefined | null, receivedAtMs: number = Date.now()): void {
  if (serverTs == null || !Number.isFinite(serverTs) || serverTs <= 0) return;
  const raw = serverTs - receivedAtMs;
  if (Math.abs(raw) > 5 * 60_000) return; // wild outlier → bad payload, ignore
  clockOffsetMs = clockSamples === 0 ? raw : Math.round(clockOffsetMs * 0.8 + raw * 0.2);
  clockSamples += 1;
  for (const l of clockListeners) l();
}

/** Human-readable drift telemetry (ms) — surfaced by the terminal/clock UIs. */
export function clockDriftMs(): number {
  return clockOffsetMs;
}

/** Polls the engine heartbeat — market, signals, events, stats.
 * v5.4: also surfaces feed staleness — `stale` flips true when the last poll
 * errored or no fresh snapshot has arrived for 3× the poll interval. During
 * the v5.4 engine incident the UI silently froze on the last good snapshot;
 * operators now SEE a STALE FEED badge instead of a quiet hang.
 * v10.1 stability pass: single transient poll hiccups no longer flip the UI
 * into DISRUPTED. Polls retry 3× on fast backoff (~0.5s → 4s) and the poll
 * interval tightens to 2s while errored, so recovery starts sooner. States
 * are graduated: healthy → `recovering` (hiccup but data still on screen,
 * amber chip) → `stale` (data older than 3× interval, red badge). */
export function usePulse(pollMs = 5000) {
  const q = useQuery<PulseSnapshot>({
    queryKey: ["pulse"],
    queryFn: async () => {
      const res = await fetch("/api/pulse", { cache: "no-store" });
      if (!res.ok) throw new Error(`pulse ${res.status}`);
      const json = (await res.json()) as PulseSnapshot;
      syncServerClock(json?.ts);
      return json;
    },
    refetchInterval: (query) => (query.state.error ? Math.min(2000, pollMs) : pollMs),
    refetchIntervalInBackground: true,
    placeholderData: (prev) => prev,
    retry: 3,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
  });
  const ageMs = q.dataUpdatedAt > 0 ? Date.now() - q.dataUpdatedAt : Infinity;
  const stale = ageMs > pollMs * 3;
  const recovering = (q.isError || ageMs > pollMs * 1.5) && !stale;
  return { data: q.data, isError: q.isError, error: q.error, stale, recovering, updatedAt: q.dataUpdatedAt };
}

/** Second-precision ticking clock, ANCHORED TO THE ENGINE HOST CLOCK
 * (SSR-safe: server snapshot = 0). All TTL countdowns / ages across the
 * dashboard flow through here, so operator device skew no longer bends them. */
export function useNow(intervalMs = 1000): number {
  const subscribe = useCallback(
    (cb: () => void) => {
      const id = setInterval(cb, intervalMs);
      clockListeners.add(cb);
      return () => {
        clearInterval(id);
        clockListeners.delete(cb);
      };
    },
    [intervalMs]
  );
  const getSnapshot = useCallback(() => Math.floor(serverNow() / 1000) * 1000, []);
  const getServerSnapshot = useCallback(() => 0, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Second-precision ticking clock anchored to the OPERATOR'S DEVICE SYSTEM
 * clock (raw Date.now() — matches the OS taskbar exactly). Operator request
 * 2026-09-07: «ساعت در داشبورد رو با ساعت سیستم یکی کن». Display-only wall
 * clock; TTL countdowns keep using engine-anchored serverNow(). SSR-safe:
 * server snapshot = 0. */
export function useDeviceNow(intervalMs = 1000): number {
  const subscribe = useCallback(
    (cb: () => void) => {
      const id = setInterval(cb, intervalMs);
      return () => clearInterval(id);
    },
    [intervalMs]
  );
  const getSnapshot = useCallback(() => Math.floor(Date.now() / 1000) * 1000, []);
  const getServerSnapshot = useCallback(() => 0, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** True after hydration (server snapshot = false). */
export function useMounted(): boolean {
  return useSyncExternalStore(
    useCallback(() => () => {}, []),
    useCallback(() => true, []),
    useCallback(() => false, [])
  );
}
