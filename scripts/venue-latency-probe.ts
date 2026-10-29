// ── BINANCE PLANE LATENCY + COVERAGE FORENSICS (v14.0 Binance-only rewrite) ──
// Operator mandates: «ممیزی بررسی شود سرعت داده های کدام صرافی سریعتر و معتبرتر
// است؟» + «ردپای OKX/Bybit در کجا وجود دارد و با بایننس جایگزین شود».
//
// Measures, from THIS machine's egress (the only honest vantage):
//   ① WS event-time lag — exchange-stamped event time (E/ts) vs local receipt
//     time, p50/p95 over a 45s window, message rate, stalls — for the Binance
//     planes: SPOT trade stream, futures per-symbol bookTicker (the ring
//     format), spot !miniTicker@arr, futures fstream sanity probe.
//   ② REST latency ×5 — vision ping / api-gcp ping / fapi ping (ban-aware —
//     documented, not poked more than once).
//   ③ Binance coverage matrix — for the microcap pool: spot listing vs
//     futures listing (the honest Binance-only coverage map).
// READ-ONLY: public endpoints only, no auth, no writes. Run:
//   bun scripts/venue-latency-probe.ts

interface LagSample { lagMs: number }

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]!;
}

async function wsProbe(name: string, url: string, subMsg: unknown | null, extract: (msg: any) => { symbol: string; ts: number } | null, windowMs = 45_000): Promise<{ name: string; n: number; rate: number; p50: number; p95: number; opens: boolean; note: string }> {
  return new Promise((resolve) => {
    const lags: number[] = [];
    let opened = false;
    let done = false;
    const finish = (note: string) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* */ }
      resolve({ name, n: lags.length, rate: Number((lags.length / (windowMs / 1000)).toFixed(1)), p50: Math.round(pct(lags, 50)), p95: Math.round(pct(lags, 95)), opens: opened, note });
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve({ name, n: 0, rate: 0, p50: NaN, p95: NaN, opens: false, note: `connect throw: ${String(e).slice(0, 80)}` });
      return;
    }
    const timer = setTimeout(() => finish(opened ? "window complete" : "opened but no usable frames"), windowMs);
    ws.onopen = () => {
      opened = true;
      if (subMsg) ws.send(JSON.stringify(subMsg));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        const hit = extract(msg);
        if (hit) lags.push(Date.now() - hit.ts);
      } catch { /* skip */ }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      finish(opened ? "error after open" : "connect error");
    };
    ws.onclose = () => {
      clearTimeout(timer);
      finish(opened ? "closed early" : "closed before open");
    };
  });
}

async function restLatency(name: string, url: string, tries = 5): Promise<{ name: string; ok: number; p50: number; note: string }> {
  const lats: number[] = [];
  let note = "";
  for (let i = 0; i < tries; i++) {
    try {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      const dt = Date.now() - t0;
      if (res.ok) lats.push(dt);
      else note = `HTTP ${res.status}`;
    } catch (e) {
      note = String(e).includes("abort") ? "timeout" : String(e).slice(0, 60);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { name, ok: lats.length, p50: lats.length ? Math.round(pct(lats, 50)) : NaN, note: note || "ok" };
}

async function exists(name: string, url: string, check: (j: any) => boolean): Promise<string> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (res.status === 404) return "—";
    const j = await res.json();
    return check(j) ? "YES" : "—";
  } catch (e) {
    return "ERR";
  }
}

// ── ① WS latency probes (parallel, 45s window) ──
console.log("════ ① WS EVENT-TIME LAG (45s window, local receipt − exchange stamp) ════");
const [spot, futbook, miniarr, fstream] = await Promise.all([
  wsProbe("Binance SPOT   (btcusdt@trade)", "wss://stream.binance.com:9443/ws/btcusdt@trade", null, (m) => (m?.s === "BTCUSDT" && m?.E && m?.p ? { symbol: m.s, ts: m.E } : null)),
  wsProbe("Binance FUT-BOOK (btcusdt@bookTicker)", "wss://fstream.binance.com/ws/btcusdt@bookTicker", null, (m) => (m?.s === "BTCUSDT" && m?.E ? { symbol: m.s, ts: m.E } : null)),
  wsProbe("Binance SPOT-ARR (!miniTicker@arr)", "wss://stream.binance.com:9443/ws/!miniTicker@arr", null, (m) => (m?.s === "BTCUSDT" && m?.E ? { symbol: m.s, ts: m.E } : null)),
  wsProbe("Binance FUTURES fstream (aggTrade sanity)", "wss://fstream.binance.com/ws/btcusdt@aggTrade", null, (m) => (m?.s === "BTCUSDT" && m?.E ? { symbol: m.s, ts: m.E } : null), 20_000),
]);
for (const r of [spot, futbook, miniarr, fstream]) {
  console.log(`  ${r.name.padEnd(40)} opens:${r.opens ? "YES" : "NO "} frames:${String(r.n).padStart(6)} rate:${String(r.rate).padStart(6)}/s lag p50:${Number.isNaN(r.p50) ? "  n/a" : r.p50 + "ms"} p95:${Number.isNaN(r.p95) ? "  n/a" : r.p95 + "ms"}  ${r.note}`);
}

// ── ② REST latency (×5 each) ──
console.log("\n════ ② REST LATENCY (5 probes each) ════");
const rests = await Promise.all([
  restLatency("Binance VISION /api/v3/ping", "https://data-api.binance.vision/api/v3/ping"),
  restLatency("Binance GCP    /api/v3/ping", "https://api-gcp.binance.com/api/v3/ping"),
  restLatency("Binance SPOT   api/ping", "https://api.binance.com/api/v3/ping"),
  restLatency("Binance fapi   /ping (banned?)", "https://fapi.binance.com/fapi/v1/ping"),
]);
for (const r of rests) console.log(`  ${r.name.padEnd(30)} ok:${r.ok}/5 p50:${Number.isNaN(r.p50) ? "n/a" : r.p50 + "ms"} ${r.note}`);

// ── ③ Binance coverage matrix for the microcap pool (honest coverage map) ──
console.log("\n════ ③ BINANCE COVERAGE MATRIX (spot vs futures — the v14.0 map) ════");
const microcaps = ["JCT", "BTW", "BIR", "MAGMA", "IRYS"];
console.log(`  ${"SYMBOL".padEnd(10)} BIN-spot  BIN-fapi`);
for (const base of microcaps) {
  const [bspot, bfut] = await Promise.all([
    exists(`${base} spot`, `https://data-api.binance.vision/api/v3/exchangeInfo?symbol=${base}USDT`, (j) => Array.isArray(j?.symbols) && j.symbols.length > 0 && j.symbols[0]?.status === "TRADING"),
    exists(`${base} fapi`, `https://fapi.binance.com/fapi/v1/exchangeInfo`, (j) => Array.isArray(j?.symbols) && j.symbols.some((s: any) => s?.symbol === `${base}USDT` && s?.status === "TRADING")),
  ]);
  console.log(`  ${base.padEnd(10)} ${bspot.padEnd(9)} ${bfut}`);
}
console.log("\n  Verdict inputs: WS lag p50 = the plane's data-speed rank from THIS egress;");
console.log("  coverage = where the symbol actually trades on Binance (honest blind spots).");
