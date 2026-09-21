import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
