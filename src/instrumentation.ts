// ── FlowRadar Neo v8.3 server instrumentation ──────────────────────────────
// Runs once per server process boot (Node.js runtime only). This is where the
// Telegram communication bridge long-poller is started — the main app process
// is kept alive by the keep-alive cron (job 354312), so hosting the poller
// here avoids yet another separate mini-service process to babysit.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const bridge = await import("./lib/telegram-bridge");
    bridge.startBridgePoller();
  } catch (err) {
    console.error("[instrumentation] telegram-bridge bootstrap failed", err);
  }
}
