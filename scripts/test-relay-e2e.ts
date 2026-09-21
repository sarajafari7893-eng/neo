// ── E2E relay proof: send one WIN / one STOP / one EXPIRED banner card ──
// Uses REAL resolved signal rows from the ledger (no invented data) through
// the exact production path: buildCard → sendPhoto (multipart PNG) with
// HTML caption → Telegram. Prints relay health + per-send results.
import "./env-load";
import { relaySignalEvent, relayHealth } from "../src/lib/notify";
import { db } from "../src/lib/db";

async function main() {
  const win = await db.signal.findFirst({ where: { status: { in: ["TP2", "TP3"] } }, orderBy: { serial: "desc" } });
  const stop = await db.signal.findFirst({ where: { status: "SL" }, orderBy: { serial: "desc" } });
  const expired = await db.signal.findFirst({ where: { status: "EXPIRED" }, orderBy: { serial: "desc" } });
  if (!win || !stop || !expired) {
    console.error("missing real signals for the test", { win: !!win, stop: !!stop, expired: !!expired });
    process.exit(1);
  }
  relaySignalEvent("TP2", win.symbol, `[RELAY E2E PROOF] ${win.symbol} TP2 card — structured HTML + WIN banner image`, win.id);
  relaySignalEvent("SL", stop.symbol, `[RELAY E2E PROOF] ${stop.symbol} SL card — structured HTML + STOP banner image`, stop.id);
  relaySignalEvent("TTL_EXPIRED", expired.symbol, `[RELAY E2E PROOF] ${expired.symbol} EXPIRED card — structured HTML + EXPIRED banner image`, expired.id);
  // fire-and-forget — wait for the three sends to settle
  await new Promise((r) => setTimeout(r, 20_000));
  const h = relayHealth();
  console.log(`RELAY E2E: sent=${h.sent} failed=${h.failed} chat=${h.chatId} resolved=${h.chatResolved} lastErrors=${JSON.stringify(h.lastErrors)}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
