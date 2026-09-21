"use client";

import { KeyboardIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUi } from "@/store/ui";
import { ACCENT_ORDER } from "@/lib/accent";
import { useAlerts } from "@/store/alerts";
import { cn } from "@/lib/utils";

/**
 * KeyboardShortcuts — operator legend overlay. Open via `?`, the header
 * keyboard button, or the ⌘K palette. Lists every global hotkey.
 */

function Row({ keys, label, hint }: { keys: string[]; label: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.03]">
      <div className="flex w-14 shrink-0 items-center gap-1">
        {keys.map((k) => (
          <kbd key={k} className="kbd">
            {k}
          </kbd>
        ))}
      </div>
      <span className="min-w-0 flex-1 font-terminal text-[10.5px] font-semibold uppercase leading-snug tracking-[0.1em] text-ink">
        {label}
      </span>
      {hint && <span className="hidden shrink-0 text-[10px] text-ink-3 md:block">{hint}</span>}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="label-tech mb-1.5 border-b border-white/8 pb-1.5 text-neon/70">{title}</h3>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

export function KeyboardShortcuts() {
  const { shortcutsOpen, setShortcutsOpen } = useUi();
  const accent = useAlerts((s) => s.accent);

  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent
        className="max-w-[min(94vw,640px)] gap-0 overflow-hidden border-[rgb(var(--neon-rgb)/0.22)] bg-[linear-gradient(150deg,rgba(14,21,27,0.98),rgba(6,10,13,0.97))] p-0 shadow-[0_0_60px_-12px_rgb(var(--neon-rgb)/0.3)]"
      >
        <div className="flex items-center gap-2 border-b border-white/8 px-5 py-3.5">
          <KeyboardIcon size={14} className="text-neon" aria-hidden />
          <span className="font-terminal text-xs font-bold uppercase tracking-[0.22em] text-foreground">
            OPERATOR KEYMAP
          </span>
          <span className="ml-auto hidden font-terminal text-[9px] tracking-[0.18em] text-ink-3 sm:block">
            PRESS <kbd className="kbd">ESC</kbd> TO CLOSE
          </span>
        </div>

        <DialogHeader className="sr-only">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>All available keyboard shortcuts</DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[62vh] grid-cols-1 gap-x-6 gap-y-4 overflow-y-auto p-5 sm:grid-cols-2">
          <Group title="NAVIGATION">
            <Row keys={["1"]} label="Command Deck" hint="dashboard" />
            <Row keys={["2"]} label="Signal Matrix" hint="signals" />
            <Row keys={["3"]} label="Performance Intel" hint="analytics" />
            <Row keys={["4"]} label="Engine Terminal" hint="feed" />
            <Row keys={["5"]} label="AI Core" hint="llm analyst" />
            <Row keys={["⌘", "K"]} label="Command palette" hint="any view" />
          </Group>

          <Group title="ACTIONS">
            <Row keys={["/"]} label="Focus symbol search" hint="signal matrix" />
            <Row keys={["C"]} label="Risk calculator" hint="position sizing" />
            <Row keys={["M"]} label="Mute / unmute alerts" />
            <Row keys={["S"]} label="Event sounds on / off" />
            <Row keys={["A"]} label="Cycle accent identity" hint={`${ACCENT_ORDER.length} identities`} />
          </Group>

          <Group title="SYSTEM">
            <Row keys={["?"]} label="This keymap" />
            <Row keys={["ESC"]} label="Close overlays" />
          </Group>

          <Group title="CURRENT IDENTITY">
            <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
              {ACCENT_ORDER.map((id) => (
                <span
                  key={id}
                  aria-current={id === accent}
                  className={cn(
                    "rounded-md border px-2 py-0.5 font-terminal text-[9px] font-bold tracking-[0.16em]",
                    id === accent
                      ? "border-[rgb(var(--neon-rgb)/0.5)] bg-[rgb(var(--neon-rgb)/0.1)] text-neon"
                      : "border-white/8 text-ink-3"
                  )}
                >
                  {id.toUpperCase()}
                </span>
              ))}
            </div>
            <p className="px-2 pt-1 text-[11px] leading-relaxed text-ink-3">
              Tap <kbd className="kbd">A</kbd> to cycle the terminal identity — borders, glows, charts
              and the logo re-tune instantly. Preference is persisted per browser.
            </p>
          </Group>
        </div>
      </DialogContent>
    </Dialog>
  );
}
