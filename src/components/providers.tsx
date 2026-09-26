"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { SessionProvider } from "next-auth/react";
import { SystemBridge } from "@/components/fx/SystemBridge";
import { SignalDetailHost } from "@/components/shared/SignalDetailHost";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 2026-09-17 operator audit fix: was `false` — a tab backgrounded
            // during the 06:26Z sandbox rollback kept serving the pre-rollback
            // snapshot after refocusing (modules looked frozen / "not live").
            // With `true` + staleTime 3s, focus re-pulls anything older than
            // 3s, so returning to the tab always resyncs against the engine.
            refetchOnWindowFocus: true,
            staleTime: 3000,
            // v10.1 stability pass: absorb transient blips instead of surfacing
            // them — 2 retries with fast exponential backoff (0.5s → 4s cap).
            retry: 2,
            retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
          },
        },
      })
  );
  return (
    <QueryClientProvider client={client}>
      {/* next-auth session context — the operator badge + control-plane
          mutating cards read the session state from here (Task 34-1) */}
      <SessionProvider refetchOnWindowFocus={false}>
        <SystemBridge />
        {children}
        <SignalDetailHost />
      </SessionProvider>
    </QueryClientProvider>
  );
}
