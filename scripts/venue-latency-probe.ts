// ── VENUE LATENCY + COVERAGE FORENSICS (AUDIT-20261023 follow-up) ──
// Operator mandate: «ممیزی بررسی شود سرعت داده های کدام صرافی سریعتر و معتبرتر
// است؟» + «اگر جریانات اسپات کامل و معتبر نیست باید فقط از فیوچرز استفاده کرد».
//
// Measures, from THIS machine's egress (the only honest vantage):
//   ① WS event-time lag — exchange-stamped event time (E/ts) vs local receipt
//     time, p50/p95 over a 45s window, message rate, stalls — for the three
//     live planes: Binance SPOT, Bybit linear, OKX swap. Binance futures
//     fstream probed too to document its silence (IP-suppressed).
//   ② REST latency ×5 — spot ping / bybit time / okx time / fapi ping (expect
//     ban — documented, not poked more than once).
//   ③ Futures-coverage matrix for the blocked microcaps — which venue can
//     become a SECOND venue (the structural rehabilitation path for the
//     SINGLE-VENUE vetoes): OKX swap / Gate USDT futures / MEXC futures /
//     HTX linear / Binance spot listing check.
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
const [spot, bybit, okx, fstream] = await Promise.all([
  wsProbe("Binance SPOT  (btcusdt@trade)", "wss://stream.binance.com:9443/ws/btcusdt@trade", null, (m) => (m?.s === "BTCUSDT" && m?.E && m?.p ? { symbol: m.s, ts: m.E } : null)),
  wsProbe("Bybit linear  (tickers.BTCUSDT)", "wss://stream.bybit.com/v5/public/linear", { op: "subscribe", args: ["tickers.BTCUSDT"] }, (m) => (m?.topic === "tickers.BTCUSDT" && m?.ts ? { symbol: "BTCUSDT", ts: m.ts } : null)),
  wsProbe("OKX swap     (BTC-USDT tickers)", "wss://ws.okx.com:8443/ws/v5/public", { op: "subscribe", args: [{ channel: "tickers", instId: "BTC-USDT" }] }, (m) => (m?.arg?.instId === "BTC-USDT" && m?.data?.[0]?.ts ? { symbol: "BTC-USDT", ts: Number(m.data[0].ts) } : null)),
  wsProbe("Binance FUTURES fstream (sanity)", "wss://fstream.binance.com/ws/btcusdt@trade", null, (m) => (m?.s === "BTCUSDT" && m?.E ? { symbol: m.s, ts: m.E } : null), 20_000),
]);
for (const r of [spot, bybit, okx, fstream]) {
  console.log(`  ${r.name.padEnd(40)} opens:${r.opens ? "YES" : "NO "} frames:${String(r.n).padStart(6)} rate:${String(r.rate).padStart(6)}/s lag p50:${Number.isNaN(r.p50) ? "  n/a" : r.p50 + "ms"} p95:${Number.isNaN(r.p95) ? "  n/a" : r.p95 + "ms"}  ${r.note}`);
}

// ── ② REST latency (×5 each) ──
console.log("\n════ ② REST LATENCY (5 probes each) ════");
const rests = await Promise.all([
  restLatency("Binance SPOT  api/ping", "https://api.binance.com/api/v3/ping"),
  restLatency("Binance fapi  /ping (banned?)", "https://fapi.binance.com/fapi/v1/ping"),
  restLatency("Bybit         /market/time", "https://api.bybit.com/v5/market/time"),
  restLatency("OKX           /public/time", "https://www.okx.com/api/v5/public/time"),
]);
for (const r of rests) console.log(`  ${r.name.padEnd(30)} ok:${r.ok}/5 p50:${Number.isNaN(r.p50) ? "n/a" : r.p50 + "ms"} ${r.note}`);

// ── ③ Futures coverage matrix for the vetoed microcaps (rehabilitation map) ──
console.log("\n════ ③ SECOND-VENUE COVERAGE MATRIX (futures planes — the rehab path) ════");
const microcaps = ["JCT", "BTW", "BIR", "MAGMA", "IRYS"];
console.log(`  ${"SYMBOL".padEnd(10)} OKX-swap  Gate-USDT  MEXC-fut  HTX-lin  BIN-spot`);
for (const base of microcaps) {
  const [okxR, gateR, mexcR, htxR, bspot] = await Promise.all([
    exists(`${base} OKX`, `https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${base}-USDT-SWAP`, (j) => Array.isArray(j?.data) && j.data.length > 0 && j.data[0]?.state === "live"),
    exists(`${base} Gate`, `https://api.gateio.ws/api/v4/futures/usdt/contracts/${base}_USDT`, (j) => j?.name === `${base}_USDT` && j?.in_delisting !== true),
    exists(`${base} MEXC`, `https://contract.mexc.com/api/v1/contract/detail?symbol=${base}_USDT`, (j) => j?.data?.symbol === `${base}_USDT` && j?.data?.state === 0),
    exists(`${base} HTX`, `https://api.hbdm.com/linear-swap-api/v1/swap_contract_info?contract_code=${base}-USDT`, (j) => Array.isArray(j?.data) && j.data.length > 0 && j.data[0]?.contract_status === 1),
    exists(`${base} Bspot`, `https://api.binance.com/api/v3/exchangeInfo?symbol=${base}USDT`, (j) => Array.isArray(j?.symbols) && j.symbols.length > 0 && j.symbols[0]?.status === "TRADING"),
  ]);
  console.log(`  ${base.padEnd(10)} ${okxR.padEnd(9)} ${gateR.padEnd(10)} ${mexcR.padEnd(9)} ${htxR.padEnd(8)} ${bspot}`);
}
console.log("\n  Verdict inputs: WS lag p50 = the venue's data-speed rank from THIS egress;");
console.log("  coverage YES = a wireable second venue (lifts SINGLE-VENUE to NO-BINANCE-CONFIRM).");
