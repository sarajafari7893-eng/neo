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
  // 2026-09-21 resilience rails — boot-time belt-and-braces alongside the
  // pulse wiring (the pulse is the primary driver; these catch the case of a
  // booted-but-never-pulsed process). Both internally throttled + fail-soft.
  try {
    const guard = await import("./lib/env-guard");
    const scheduler = await import("./lib/daily-scheduler");
    setTimeout(() => {
      void guard.maybeEnsureEnv().catch(() => undefined);
      void scheduler.maybeRunScheduledReports().catch(() => undefined);
      setInterval(() => {
        void guard.maybeEnsureEnv().catch(() => undefined);
        void scheduler.maybeRunScheduledReports().catch(() => undefined);
      }, 5 * 60_000);
    }, 20_000).unref?.();
  } catch {
    /* rails must never break boot */
  }
}
