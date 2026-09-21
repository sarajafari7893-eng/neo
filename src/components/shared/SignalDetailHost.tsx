"use client";

import { useEffect } from "react";
import { usePulse } from "@/hooks/usePulse";
import SignalDetailDialog from "@/components/signals/SignalDetailDialog";
import { useUi } from "@/store/ui";

/**
 * SignalDetailHost — always-mounted global signal-detail dialog.
 * Any surface (terminal signal-links, analytics operator log, ⌘K…) can
 * call `useUi.getState().setOpenSignal(id)` to open a deployment's full
 * detail without owning local dialog state. Resolves the live SignalDTO
 * from the pulse cache; closes cleanly when the signal leaves the window.
 *
 * Share-link deep linking: `…/#signal=<id>` (from the dialog SHARE button)
 * auto-opens the deployment once the pulse cache hydrates — and closing
 * the dialog strips the hash so refreshes don't re-spawn it. Survives
 * hashchange (paste a new link without reload).
 */
export function SignalDetailHost() {
  const openSignalId = useUi((s) => s.openSignalId);
  const setOpenSignal = useUi((s) => s.setOpenSignal);
  const { data } = usePulse(5000);

  /* ── hash → dialog (mount + hashchange) ── */
  useEffect(() => {
    const consume = () => {
      const m = /^#signal=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
      if (m?.[1]) useUi.getState().setOpenSignal(m[1]);
    };
    consume();
    window.addEventListener("hashchange", consume);
    return () => window.removeEventListener("hashchange", consume);
  }, []);

  /* ── dialog close → strip the hash (replaceState, no scroll jump) ── */
  useEffect(() => {
    if (openSignalId === null && window.location.hash.startsWith("#signal=")) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [openSignalId]);

  const signal = openSignalId ? (data?.signals ?? []).find((s) => s.id === openSignalId) ?? null : null;

  return (
    <SignalDetailDialog
      signal={signal}
      open={openSignalId !== null}
      onOpenChange={(v) => {
        if (!v) setOpenSignal(null);
      }}
    />
  );
}
