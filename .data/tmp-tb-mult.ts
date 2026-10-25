// exchangeInfo multiplier discovery + realized PnL from userTrades (READ-ONLY)
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const env = readFileSync("/home/z/my-project/mini-services/toobit-bridge/.env", "utf8");
const KEY = /^TOOBIT_API_KEY=(.*)$/m.exec(env)?.[1]?.trim() ?? "";
const SEC = /^TOOBIT_API_SECRET=(.*)$/m.exec(env)?.[1]?.trim() ?? "";
const BASE = "https://api.toobit.com";
const sig = (qs: string) => createHmac("sha256", SEC).update(qs).digest("hex");

async function sget(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const full: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) full[k] = String(v);
  full.timestamp = String(Date.now() - 30);
  full.recvWindow = "5000";
  const qs = Object.entries(full).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const r = await fetch(`${BASE}${path}?${qs}&signature=${sig(qs)}`, { headers: { "X-BB-APIKEY": KEY }, signal: AbortSignal.timeout(8000) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { _status: r.status, _body: t.slice(0, 200) }; }
}

// ① full raw entry of one 0.1-mult symbol and one 1-mult symbol
const info = await sget("/api/v1/exchangeInfo");
const list = info?.contracts ?? info?.symbols ?? [];
console.log("total contracts:", list.length);
for (const want of ["SUI-SWAP-USDT", "FARTCOIN-SWAP-USDT", "WLD-SWAP-USDT", "BNB-SWAP-USDT", "IRYS-SWAP-USDT"]) {
  const c = list.find((x: any) => x.symbol === want);
  if (c) console.log("\nRAW", want, "=>", JSON.stringify(c, null, 1).slice(0, 1400));
}
// ② openOrders without symbol (do conditional stops show anywhere?)
const oo = await sget("/api/v1/futures/openOrders");
console.log("\nopenOrders (no symbol):", JSON.stringify(oo).slice(0, 600));
// ③ allOrders for SUI (order history incl conditional?)
const ao = await sget("/api/v1/futures/allOrders", { symbol: "SUI-SWAP-USDT", limit: 20 });
console.log("\nallOrders SUI:", JSON.stringify(ao).slice(0, 1200));

// ④ realized PnL per symbol from userTrades (LIVE window)
const SYMBOLS = ["SUI-SWAP-USDT", "FARTCOIN-SWAP-USDT", "WLD-SWAP-USDT", "IRYS-SWAP-USDT", "JCT-SWAP-USDT", "UNI-SWAP-USDT", "BNB-SWAP-USDT", "TAO-SWAP-USDT", "ZEC-SWAP-USDT", "ETH-SWAP-USDT", "AKE-SWAP-USDT", "BIRB-SWAP-USDT", "MAGMA-SWAP-USDT", "NEAR-SWAP-USDT", "XRP-SWAP-USDT", "ERA-SWAP-USDT", "BTC-SWAP-USDT", "SOL-SWAP-USDT", "DOGE-SWAP-USDT", "1000PEPE-SWAP-USDT"];
let totReal = 0, totComm = 0, nFills = 0;
const perSym: Record<string, { real: number; comm: number; n: number; fills: string[] }> = {};
for (const s of SYMBOLS) {
  const t = await sget("/api/v1/futures/userTrades", { symbol: s, limit: 200 });
  if (!Array.isArray(t) || t.length === 0) continue;
  let real = 0, comm = 0;
  for (const f of t) {
    real += Number(f.realizedPnl ?? 0);
    comm += Number(f.commission ?? 0) - Number(f.makerRebate ?? 0);
    nFills++;
  }
  totReal += real; totComm += comm;
  perSym[s] = { real: +real.toFixed(4), comm: +comm.toFixed(4), n: t.length, fills: t.slice(-3).map((f: any) => `${f.side} q${f.qty} @${f.price} pnl${(+f.realizedPnl).toFixed(4)}`) };
}
console.log("\n=== REALIZED PnL per symbol (userTrades) ===");
for (const [s, v] of Object.entries(perSym)) console.log(`${s}: realized ${v.real} comm ${v.comm} fills ${v.n} | last: ${v.fills.join(" | ")}`);
console.log(`\nTOTAL realized ${totReal.toFixed(4)} - commissions ${totComm.toFixed(4)} = net ${(totReal - totComm).toFixed(4)} USDT over ${nFills} fills`);
