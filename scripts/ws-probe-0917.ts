// TEMP probe: verify price-ws live data (operator dashboard audit 2026-09-17)
import { io } from "socket.io-client";

const url = process.argv[2] || "http://localhost:3003";
const sock = io(url, { path: "/", transports: ["websocket", "polling"], timeout: 8000 });

let pushCount = 0;
const t0 = Date.now();

sock.on("connect", () => {
  console.log("CONNECTED", url, "sid", sock.id);
  sock.emit("prices:snapshot:request");
});

sock.on("prices:snapshot", (p: any) => {
  const rows: any[] = p.rows ?? [];
  const btc = rows.find((r) => r.symbol === "BTCUSDT");
  console.log("SNAPSHOT source=", p.source, "rows=", rows.length, "BTC=", btc?.price, "at=", btc?.at, "ageMs=", btc ? Date.now() - btc.at : "n/a");
});

sock.on("prices", (p: any) => {
  pushCount++;
  if (pushCount <= 3) {
    const rows: any[] = p.rows ?? [];
    const btc = rows.find((r) => r.symbol === "BTCUSDT");
    console.log("PUSH#", pushCount, "source=", p.source, "rows=", rows.length, "BTC=", btc?.price, "ageMs=", btc ? Date.now() - btc.at : "n/a");
  }
});

sock.on("price:source", (p: any) => console.log("SOURCE-EVENT", p?.source));
sock.on("disconnect", (r: any) => console.log("DISCONNECT", r));
sock.on("connect_error", (e: any) => console.log("CONNECT_ERROR", e?.message ?? e));

setTimeout(() => {
  console.log(`PROBE-DONE pushes=${pushCount} elapsed=${Date.now() - t0}ms`);
  process.exit(0);
}, 12000);
