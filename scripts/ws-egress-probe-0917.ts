// TEMP probe: does Binance fstream WS deliver frames from this sandbox?
const ws = new WebSocket("wss://fstream.binance.com/stream?streams=!miniTicker@arr");
let frames = 0;
const t0 = Date.now();
ws.onopen = () => console.log("WS-OPEN");
ws.onmessage = (ev) => {
  frames++;
  if (frames <= 2) {
    try {
      const d = JSON.parse(String(ev.data));
      console.log("FRAME", frames, "symbol:", d?.data?.s, "price:", d?.data?.c);
    } catch { console.log("FRAME", frames, "(unparsed)"); }
  }
};
ws.onerror = (e) => console.log("WS-ERROR", (e as any)?.message ?? "");
ws.onclose = (e) => console.log("WS-CLOSE code:", e.code, "reason:", e.reason?.slice(0, 80));
setTimeout(() => { console.log(`DONE frames=${frames} in ${Date.now() - t0}ms`); process.exit(0); }, 10000);
