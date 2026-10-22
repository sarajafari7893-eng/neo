import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // TASK-39 (operator signal 2026-09-27 ~00:15 IRST): sentinel memory warnings +
  // p0-watchdog app:degraded treadmill. Root cause: V8 heap is capped at 1400MB
  // (dev-up.sh v8.0) but TURBOPACK NATIVE (Rust) cache sat unbounded — default
  // 4GiB limit is a no-op on this 4GB no-swap box → next-server RSS ramped to
  // 2.3GB, MemAvailable dipped to 220-350MB (mem-crit), /api/pulse probes timed
  // out (GC pauses up to 2.6s) → down → heal → ramp again (6 recoveries in one
  // day). Cap the native cache at 768MiB (BYTES — Turbopack reads this value as
  // an absolute byte budget it evicts caches to stay under; verified unit via
  // hot-reloader-turbopack.js passing it straight to turbo createProject).
  // Expected steady-state RSS ~1.0-1.5GB → avail >600MB → sentinel quiet.
  experimental: {
    // TASK-39 round 2: 768MiB plateaued at RSS 2.05-2.11GB, but the 00:40-00:42
    // IRST triple burst (6h progress report + 513-row SignalEvents archive +
    // armor git cycle) consumed the remaining ~900MB headroom → kernel OOM-kill
    // (dmesg: "Killed process next-server anon-rss:2045392kB") → p0 heal. One
    // notch tighter: 512MiB native cap → expected plateau ~1.8GB, headroom
    // ~1.4GB. V8 stays at the post-mortem-validated 1400MB (dev-up.sh).
    //
    // EQ-98 (2026-10-13): 512MiB still produced a ~2.1GB hydration spike — five
    // kernel kills today (three within 4.5min, dmesg pids 5995/6500/12413/
    // 13254/13960, all anon-rss ~2.04-2.11GB). V8 cap lowered to 768MB
    // (dev-up.sh v9.2) + native cache 384MiB here → target plateau 1.4-1.7GB.
    // Trade-off: more frequent dev recompiles (cache evictions). The box has
    // no swap and swapon is container-denied — lowering the plateau is the
    // only lever that stops the kill loop.
    turbopackMemoryLimit: 402653184, // 384MiB (EQ-98)
  },
  // v10.6.1 persist-guard (operator APPROVE 2026-09-18, proposal #4): keep the
  // Prisma engine OUT of the bundle graph — bundling it duplicates the query
  // engine across route generations and multiplies SQLite writers (the
  // split-brain / write-lock class this guard retires).
  serverExternalPackages: ["@prisma/client", ".prisma/client", "prisma"],
  /* config options here */
  // v6.2.1 (architecture review P3): build-time type errors are no longer
  // masked — tsconfig excludes the non-app noise dirs, so this stays honest.
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
