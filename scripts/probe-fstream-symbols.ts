// ── PROBE: Binance fstream per-symbol streams vs !arr (v12.11 evidence) ─────
// v12.10 venue probe measured: fstream !miniTicker@arr SILENT from this egress
// while DIRECT per-symbol streams answered p50=30ms. This probe re-verifies
// RIGHT NOW before we wire the venue ring — read-only, 25s, no credentials.
// Run: bun scripts/probe-fstream-symbols.ts

const RUN_MS = 25_000;
const lanes: Array<{ name: string; url: string; parse: (d: string) => string | null }> = [
  {
    name: "fstream BTCUSDT@miniTicker (direct /ws)",
    url: "wss://fstream.binance.com/ws/btcusdt@miniTicker",
    parse: (d) => {
      try {
        const j = JSON.parse(d) as { e?: string; s?: string };
        return j.e === "24hrMiniTicker" ? j.s ?? null : null;
      } catch { return null; }
    },
  },
  {
    name: "fstream IRYSUSDT@miniTicker (microcap direct)",
    url: "wss://fstream.binance.com/ws/irysusdt@miniTicker",
    parse: (d) => {
      try {
        const j = JSON.parse(d) as { e?: string; s?: string };
        return j.e === "24hrMiniTicker" ? j.s ?? null : null;
      } catch { return null; }
    },
  },
  {
    name: "fstream combined !arr (control — expected silent)",
    url: "wss://fstream.binance.com/stream?streams=!miniTicker@arr",
    parse: (d) => {
      try {
        const j = JSON.parse(d) as { data?: { s?: string } };
        return j.data?.s ?? null;
      } catch { return null; }
    },
  },
];

const counts = new Map<string, number>();
const firstAt = new Map<string, number>();
const lastAt = new Map<string, number>();
const t0 = Date.now();

for (const lane of lanes) {
  counts.set(lane.name, 0);
  try {
    const ws = new WebSocket(lane.url);
    ws.onopen = () => console.log(`[probe] open  — ${lane.name}`);
    ws.onmessage = (ev) => {
      const sym = lane.parse(String(ev.data));
      if (!sym) return;
      counts.set(lane.name, (counts.get(lane.name) ?? 0) + 1);
      if (!firstAt.has(lane.name)) firstAt.set(lane.name, Date.now());
      lastAt.set(lane.name, Date.now());
    };
    ws.onerror = () => console.log(`[probe] error — ${lane.name}`);
    ws.onclose = () => console.log(`[probe] close — ${lane.name}`);
  } catch (e) {
    console.log(`[probe] throw — ${lane.name}: ${String(e).slice(0, 120)}`);
  }
}

setTimeout(() => {
  console.log("\n=== FSTREAM SYMBOL PROBE — 25s window ===");
  for (const lane of lanes) {
    const n = counts.get(lane.name) ?? 0;
    const f = firstAt.get(lane.name);
    const l = lastAt.get(lane.name);
    const ttfb = f ? `${f - t0}ms` : "—";
    const rate = f && l && n > 1 ? `${((l - f) / 1000 / (n - 1)).toFixed(1)}s/frame` : "—";
    const verdict = n > 0 ? "ALIVE" : "SILENT";
    console.log(`${verdict.padEnd(7)} frames=${String(n).padStart(5)}  ttfb=${ttfb.padEnd(8)} cadence=${rate}  | ${lane.name}`);
  }
  process.exit(0);
}, RUN_MS);
