// ── FlowRadar Neo v8.3 server instrumentation ──────────────────────────────
// Runs once per server process boot (Node.js runtime only). This is where the
// Telegram communication bridge long-poller is started — the main app process
// is kept alive by the keep-alive cron (job 354312), so hosting the poller
// here avoids yet another separate mini-service process to babysit.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // ── v12.12 undici TLS-teardown guard (SENTINEL-M0M2-20261024) ─────────────
  // 59× `uncaughtException: AssertionError false==true` from
  // node:internal/deps/undici (Parser.finish / TLSSocket.onHttpSocketEnd):
  // a peer closes the TLS connection mid-response and undici's parser races
  // its own assertion during cleanup. The response is already dead — the
  // assertion carries ZERO recovery value, but an unguarded path can take the
  // whole server down. Swallow ONLY this exact signature (throttled log),
  // let every other uncaughtException fall through to Next's own handler.
  try {
    let undiciSwallowed = 0;
    let lastUndiciLogAt = 0;
    process.on("uncaughtException", (err: unknown) => {
      const isUndiciAssert =
        err instanceof Error && err.name === "AssertionError" && /undici/.test(err.stack ?? "");
      if (!isUndiciAssert) return; // not ours — existing handlers own it
      undiciSwallowed++;
      const now = Date.now();
      if (now - lastUndiciLogAt >= 60_000) {
        lastUndiciLogAt = now;
        console.warn(
          `[instrumentation] undici TLS-teardown assertion swallowed ×${undiciSwallowed} — process kept alive (v12.12)`
        );
      }
    });
  } catch {
    /* guard must never break boot */
  }
  try {
    const bridge = await import("./lib/telegram-bridge");
    bridge.startBridgePoller();
  } catch (err) {
    console.error("[instrumentation] telegram-bridge bootstrap failed", err);
  }
  // ── v13.1 RAM-SHED governor (RAM-SHED-20261024) ───────────────────────────
  // Box: 4GB / NO swap. 2026-10-24 16:29→16:59Z: FIVE kernel OOM-kills of
  // next-server in 30 minutes (dmesg anon-rss 2.03-2.35GB), two of them
  // triggered by `git pack-objects` during routine commits and one by
  // tokio/caddy. All soft caps ALREADY exist (V8 768MB via dev-up v9.2
  // envelope, turbopack native 384MiB via next.config EQ-98) yet dev-mode
  // residue (module graph, postcss worker 447MB, GC lag) keeps ramping RSS
  // until the kernel shoots — and the kernel kill is the WORST possible
  // recycle: random timing, takes down whoever invoked the oom-killer, and
  // races mem-guard's own ladder.
  // Doctrine: a CONTROLLED self-recycle while the .next cache is warm (5s
  // gap; heal chain p0-watchdog :3020 → dev-up probe-gated spawn, proven
  // dozens of times today) beats a random kernel kill every time. This
  // governor ONLY acts earlier than the kernel — it never kills a healthy
  // process: every threshold requires sustained pressure AND (for the
  // primary lane) a real MemAvailable squeeze. Boot grace 300s — never
  // interfere with warm hydration.
  try {
    const g = globalThis as {
      __nexusRamShed?: {
        ver: string;
        lastShedAt: number;
        lastRecycleAt: number;
        recycles: number;
        sheds: number;
        rssMB: number;
        availMB: number;
      };
      __nexusShed?: () => number;
    };
    g.__nexusRamShed ??= {
      ver: "ram-shed v13.1",
      lastShedAt: 0,
      lastRecycleAt: 0,
      recycles: 0,
      sheds: 0,
      rssMB: 0,
      availMB: 0,
    };
    const BOOT_AT = Date.now();
    const GRACE_MS = 300_000; // 5min boot grace
    const TICK_MS = 15_000;
    const highStart = { a: 0, b: 0 }; // sustained-pressure streak clocks (ms)
    let lastHeartbeat = 0;
    const availMB = (): number => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const m = require("node:fs").readFileSync("/proc/meminfo", "utf8") as string;
        const hit = m.match(/^MemAvailable:\s+(\d+) kB/m);
        return hit ? Math.round(parseInt(hit[1]!, 10) / 1024) : 9999;
      } catch {
        return 9999;
      }
    };
    const timer = setInterval(() => {
      try {
        const st = g.__nexusRamShed!;
        if (Date.now() - BOOT_AT < GRACE_MS) return;
        st.rssMB = Math.round(process.memoryUsage().rss / 1048576);
        st.availMB = availMB();
        const now = Date.now();
        // telemetry heartbeat every 5min — always visible in dev.log
        if (now - lastHeartbeat >= 300_000) {
          lastHeartbeat = now;
          console.log(
            `[ram-shed] heartbeat rss=${st.rssMB}MB avail=${st.availMB}MB recycles=${st.recycles} sheds=${st.sheds}`
          );
        }
        // LANE 1 — soft shed: trim discretionary caches before pressure builds
        if ((st.availMB < 420 || st.rssMB > 1800) && typeof g.__nexusShed === "function" && now - st.lastShedAt >= 60_000) {
          const freed = g.__nexusShed();
          st.lastShedAt = now;
          st.sheds += 1;
          console.warn(`[ram-shed] shed#${st.sheds} freed=${freed} cache entries rss=${st.rssMB}MB avail=${st.availMB}MB`);
        }
        // LANE 2 — controlled self-recycle (pre-empting the kernel OOM-killer):
        //   A) rss>2000 sustained 60s AND avail<380  (the exact pre-kill profile
        //      of all five dmesg kills today), or
        //   B) rss>2250 sustained 90s regardless of avail (hard plateau — the
        //      kernel WILL reach us within minutes at this fleet load), or
        //   C) avail<120 single tick (kernel-imminent; mem-guard acts at <130
        //      but races are lethal — exit first, heal chain brings us back).
        const laneA = st.rssMB > 2000 && st.availMB < 380;
        const laneB = st.rssMB > 2250;
        const laneC = st.availMB < 120;
        // streak clocks reset the moment their lane pressure clears (hysteresis)
        if (!laneA) highStart.a = 0;
        if (!laneB) highStart.b = 0;
        if (laneA && highStart.a === 0) highStart.a = now;
        if (laneB && highStart.b === 0) highStart.b = now;
        if (laneA && now - highStart.a >= 60_000) {
          st.lastRecycleAt = now;
          st.recycles += 1;
          console.error(
            `[ram-shed] SELF-RECYCLE#${st.recycles} lane=A rss=${st.rssMB}MB avail=${st.availMB}MB held=60s — controlled exit, warm-cache heal expected ≤45s (RAM-SHED-20261024)`
          );
          process.exit(0);
        }
        if (laneB && now - highStart.b >= 90_000) {
          st.lastRecycleAt = now;
          st.recycles += 1;
          console.error(
            `[ram-shed] SELF-RECYCLE#${st.recycles} lane=B rss=${st.rssMB}MB held=90s — hard plateau, controlled exit (RAM-SHED-20261024)`
          );
          process.exit(0);
        }
        if (laneC) {
          st.lastRecycleAt = now;
          st.recycles += 1;
          console.error(
            `[ram-shed] SELF-RECYCLE#${st.recycles} lane=C avail=${st.availMB}MB single-tick — kernel-imminent, controlled exit (RAM-SHED-20261024)`
          );
          process.exit(0);
        }
      } catch {
        /* the governor must never crash the process it guards */
      }
    }, TICK_MS);
    timer.unref?.();
  } catch {
    /* governor must never break boot */
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
