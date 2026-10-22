"use client";

// ── usePriceStream — socket.io price channel (mini-services/price-ws :3003) ──
// Module-singleton socket + listener fan-out. Relative gateway path per rules:
// io("/?XTransformPort=3003") — NEVER a direct port URL.

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";

export interface PriceRow {
  symbol: string;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  at: number;
}

export type PriceSource = "WS PUSH" | "WS·BYBIT" | "WS·REST 2.5S" | "WS OFFLINE";

interface PriceState {
  rows: Map<string, PriceRow>;
  source: PriceSource;
}

const state: PriceState = { rows: new Map(), source: "WS OFFLINE" };
const listeners = new Set<() => void>();
let socket: Socket | null = null;
let refCount = 0;

function ensureSocket(): Socket {
  if (socket) return socket;
  // v10.1 resilience: capped jittered backoff — fast first retries (3s),
  // never exceeds 15s, ±50% jitter avoids synchronized reconnect storms.
  // SELFHOST-0929: the sandbox gateway path (?XTransformPort=3003) is the
  // default; a self-hosted deploy sets NEXT_PUBLIC_WS_URL (build-time, e.g.
  // "/ws" behind a reverse proxy, or "http://host:3003" for direct LAN) and
  // the default keeps sandbox behavior.
  socket = io(process.env.NEXT_PUBLIC_WS_URL ?? "/?XTransformPort=3003", {
    path: "/",
    transports: ["websocket", "polling"],
    reconnectionDelay: 3000,
    reconnectionDelayMax: 15000,
    randomizationFactor: 0.5,
    timeout: 8000,
  });

  socket.on("prices:snapshot", (payload: { source: PriceSource; rows: PriceRow[] }) => {
    for (const r of payload.rows ?? []) state.rows.set(r.symbol, r);
    state.source = payload.source ?? "WS OFFLINE";
    listeners.forEach((l) => l());
  });

  socket.on("prices", (payload: { source: PriceSource; rows: PriceRow[] }) => {
    for (const r of payload.rows ?? []) state.rows.set(r.symbol, r);
    state.source = payload.source ?? state.source;
    listeners.forEach((l) => l());
  });

  socket.on("price:source", (payload: { source: PriceSource }) => {
    state.source = payload.source ?? state.source;
    listeners.forEach((l) => l());
  });

  socket.on("disconnect", () => {
    state.source = "WS OFFLINE";
    listeners.forEach((l) => l());
  });

  // v10.1: after EVERY reconnect immediately refill the tape — otherwise the
  // strip idles on the last pre-drop rows until the server's next push.
  socket.on("connect", () => {
    socket?.emit("prices:snapshot:request");
  });

  return socket;
}

/** Subscribe to the live price channel. Returns a stable snapshot ref that
 * updates in place — components read `rows.get(symbol)` during render. */
export function usePriceStream(): PriceState {
  const [, setTick] = useState(0);

  useEffect(() => {
    refCount++;
    const sock = ensureSocket();
    const notify = () => setTick((t) => t + 1);
    listeners.add(notify);
    if (sock.connected) {
      // request a fresh snapshot on mount
      sock.emit("prices:snapshot:request");
    }
    return () => {
      refCount--;
      listeners.delete(notify);
      if (refCount === 0) {
        sock.disconnect();
        socket = null;
        state.source = "WS OFFLINE";
      }
    };
  }, []);

  return state;
}

/** Current source badge string, e.g. "WS PUSH" / "WS·REST 2.5S" / "WS OFFLINE". */
export function priceSourceLabel(s: PriceSource): string {
  return s;
}
