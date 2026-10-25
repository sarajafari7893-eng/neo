// READ-ONLY Toobit live audit — signed GETs only (no order placement)
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const env = readFileSync("/home/z/my-project/mini-services/toobit-bridge/.env", "utf8");
const KEY = /^TOOBIT_API_KEY=(.*)$/m.exec(env)?.[1]?.trim() ?? "";
const SEC = /^TOOBIT_API_SECRET=(.*)$/m.exec(env)?.[1]?.trim() ?? "";
const BASE = "https://api.toobit.com";
const sig = (qs: string) => createHmac("sha256", SEC).update(qs).digest("hex");

async function sget(path: string, params: Record<string, string | number> = {}, show = 3500): Promise<any> {
  const full: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) full[k] = String(v);
  full.timestamp = String(Date.now() - 30);
  full.recvWindow = "5000";
  const qs = Object.entries(full).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const url = `${BASE}${path}?${qs}&signature=${sig(qs)}`;
  try {
    const r = await fetch(url, { headers: { "X-BB-APIKEY": KEY }, signal: AbortSignal.timeout(8000) });
    const t = await r.text();
    console.log(`\n=== GET ${path} ${JSON.stringify(params)} → ${r.status}`);
    let out: any = null;
    try { out = JSON.parse(t); console.log(JSON.stringify(out, null, 1).slice(0, show)); } catch { console.log(t.slice(0, 400)); }
    return out;
  } catch (e) { console.log(`GET ${path} EXC ${String(e).slice(0, 120)}`); return null; }
}

await sget("/api/v1/futures/balance", {}, 1200);
const pos = await sget("/api/v1/futures/positions", {}, 6000);
// probe conditional/stop order endpoints + income/trade history (all read-only)
await sget("/api/v1/futures/openOrders", { symbol: "SUI-SWAP-USDT" }, 1500);
await sget("/api/v1/futures/openConditionalOrders", { symbol: "SUI-SWAP-USDT" }, 2500);
await sget("/api/v1/futures/conditionalOrders", { symbol: "SUI-SWAP-USDT" }, 2500);
await sget("/api/v1/futures/income", { limit: 40 }, 4000);
await sget("/api/v1/futures/incomeHistory", { limit: 40 }, 500);
await sget("/api/v1/futures/userTrades", { symbol: "SUI-SWAP-USDT", limit: 12 }, 4000);
await sget("/api/v1/futures/tradingStop", { symbol: "SUI-SWAP-USDT" }, 1500);
console.log("\n--- positions raw keys of first row ---");
if (Array.isArray(pos) && pos[0]) console.log(Object.keys(pos[0]).join(","));
