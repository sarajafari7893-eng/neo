// realized PnL from userTrades (READ-ONLY) — compact
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
  try { return JSON.parse(t); } catch { return null; }
}
const SYMBOLS = ["SUI-SWAP-USDT", "FARTCOIN-SWAP-USDT", "WLD-SWAP-USDT", "IRYS-SWAP-USDT", "JCT-SWAP-USDT", "UNI-SWAP-USDT", "BNB-SWAP-USDT", "TAO-SWAP-USDT", "ZEC-SWAP-USDT", "ETH-SWAP-USDT", "AKE-SWAP-USDT", "BIRB-SWAP-USDT", "MAGMA-SWAP-USDT", "NEAR-SWAP-USDT", "XRP-SWAP-USDT", "ERA-SWAP-USDT", "DOGE-SWAP-USDT", "BTW-SWAP-USDT", "ENA-SWAP-USDT", "1000PEPE-SWAP-USDT", "SOL-SWAP-USDT", "BTC-SWAP-USDT"];
let totReal = 0, totComm = 0, nFills = 0;
for (const s of SYMBOLS) {
  const t = await sget("/api/v1/futures/userTrades", { symbol: s, limit: 200 });
  if (!Array.isArray(t) || t.length === 0) continue;
  let real = 0, comm = 0;
  const detail: string[] = [];
  for (const f of t) {
    real += Number(f.realizedPnl ?? 0);
    comm += Number(f.commission ?? 0) - Number(f.makerRebate ?? 0);
    nFills++;
    if (Number(f.realizedPnl ?? 0) !== 0 || /CLOSE/.test(f.side ?? "")) detail.push(`${String(f.time).slice(5)} ${f.side} q${f.qty}@${f.price} pnl${(+f.realizedPnl).toFixed(4)} fee${(+f.commission).toFixed(4)}`);
  }
  totReal += real; totComm += comm;
  console.log(`${s}: realized=${real.toFixed(4)} fee=${comm.toFixed(4)} fills=${t.length}${detail.length ? "\n   " + detail.join("\n   ") : ""}`);
}
console.log(`\nTOTAL: realized ${totReal.toFixed(4)} | fees ${totComm.toFixed(4)} | NET ${(totReal - totComm).toFixed(4)} USDT (${nFills} fills)`);
