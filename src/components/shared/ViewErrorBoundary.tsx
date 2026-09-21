"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/* ── v10.1 stability pass ──
 * A render crash inside one dashboard view (bad payload shape, a JSON
 * surprise, a divide-by-zero in a card) previously took the WHOLE app down
 * to the Next.js error overlay / white screen. This boundary contains the
 * blast radius to the single view: the header, tape, footer and every other
 * section keep running, and the operator gets a terminal-style recovery
 * card with the fault reason plus a one-click retry. Remounting on view
 * switch (key={view} in page.tsx) clears the fault automatically. */

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[view-crash]", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <section
          aria-label="View fault recovery"
          className="mx-auto my-10 max-w-lg rounded-lg border border-[rgba(255,77,94,0.45)] bg-[rgba(255,77,94,0.06)] p-6 text-center shadow-[0_0_30px_rgba(255,77,94,0.12)]"
        >
          <p className="font-terminal text-[11px] tracking-[0.25em] text-danger-neon">
            ▲ VIEW FAULT — SECTION HALTED
          </p>
          <p className="mt-3 break-words font-terminal text-[11px] text-ink-3">
            {this.state.error.message || "unknown render fault"}
          </p>
          <p className="mt-2 text-[11px] text-ink-3">
            Header, price tape and engine keep running — only this view paused.
          </p>
          <Button onClick={this.reset} className="mt-5 font-terminal tracking-widest">
            RETRY VIEW
          </Button>
        </section>
      );
    }
    return this.props.children;
  }
}
