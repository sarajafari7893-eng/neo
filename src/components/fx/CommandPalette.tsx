"use client";

import { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard,
  Radar,
  LineChart,
  TerminalSquare,
  Sparkles,
  Zap,
  ScanLine,
  Command,
  Calculator,
  ImageDown,
  FileSpreadsheet,
  BellOff,
  Bell,
  Volume2,
  VolumeX,
  Keyboard,
  Palette,
  Telescope,
  NotebookPen,
  ScrollText,
  Check,
  Copy,
  Rows3,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useUi, type ViewId } from "@/store/ui";
import { useAlerts } from "@/store/alerts";
import { useToast } from "@/hooks/use-toast";
import { usePulse } from "@/hooks/usePulse";
import { primeAudio, playConfirmChirp } from "@/lib/sounds";
import { STATUS_META, fmtPct, fmtPrice } from "@/lib/format";
import { ACCENTS, ACCENT_ORDER, nextAccent, type AccentId } from "@/lib/accent";
import { BRAND_TERMINAL } from "@/lib/brand";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { SignalDTO } from "@/lib/api-types";

const NAV_ITEMS: Array<{ id: ViewId; label: string; icon: React.ComponentType<{ size?: number | string; className?: string }>; shortcut: string }> = [
  { id: "dashboard", label: "Go to Dashboard", icon: LayoutDashboard, shortcut: "1" },
  { id: "signals", label: "Go to Signal Matrix", icon: Radar, shortcut: "2" },
  { id: "analytics", label: "Go to Performance Intel", icon: LineChart, shortcut: "3" },
  { id: "terminal", label: "Go to Engine Terminal", icon: TerminalSquare, shortcut: "4" },
  { id: "ai", label: "Go to AI Core", icon: Sparkles, shortcut: "5" },
];

export function CommandPalette() {
  const {
    paletteOpen,
    setPaletteOpen,
    setView,
    setActiveSymbol,
    setCalcOpen,
    setShortcutsOpen,
    setSpotlightSymbol,
    requestAnalyticsExport,
    requestAnalyticsCsv,
    requestOperatorLog,
  } = useUi();
  const alertsMuted = useAlerts((s) => s.alertsMuted);
  const setAlertsMuted = useAlerts((s) => s.setAlertsMuted);
  const soundEnabled = useAlerts((s) => s.soundEnabled);
  const setSoundEnabled = useAlerts((s) => s.setSoundEnabled);
  const accent = useAlerts((s) => s.accent);
  const setAccent = useAlerts((s) => s.setAccent);
  const viewMode = useAlerts((s) => s.viewMode);
  const setViewMode = useAlerts((s) => s.setViewMode);
  const { toast } = useToast();

  /* journal-digest preview dialog (replaces blind clipboard copy) */
  const [digest, setDigest] = useState<{ text: string; count: number } | null>(null);
  const [digestCopied, setDigestCopied] = useState(false);

  // global hotkeys: ⌘K palette, 1-5 views, ? keymap, / search,
  // C calculator, M mute, S sounds, A accent cycle
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
        return;
      }
      if (paletteOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (typing) return;

      if (["1", "2", "3", "4", "5"].includes(e.key)) {
        const item = NAV_ITEMS.find((n) => n.shortcut === e.key);
        if (item) setView(item.id);
        return;
      }
      switch (e.key) {
        case "?":
          e.preventDefault();
          setShortcutsOpen(true);
          break;
        case "/":
          e.preventDefault();
          setView("signals");
          requestAnimationFrame(() => {
            const input = document.querySelector<HTMLInputElement>('input[aria-label="Search signals"]');
            input?.focus();
          });
          break;
        case "c":
        case "C":
          setView("signals");
          setCalcOpen(true);
          break;
        case "m":
        case "M":
          setAlertsMuted(!alertsMuted);
          break;
        case "s":
        case "S":
          setSoundEnabled(!soundEnabled);
          break;
        case "a":
        case "A":
          setAccent(nextAccent(accent));
          break;
        default:
          break;
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [paletteOpen, setPaletteOpen, setView, setShortcutsOpen, setCalcOpen, alertsMuted, setAlertsMuted, soundEnabled, setSoundEnabled, accent, setAccent]);

  /* v6.0 TOTAL AUTONOMY: the manual "deploy new AI signal" command was REMOVED —
     deployment is 100% autonomous via the trigger-bus → governor-gated engine
     (POST /api/signals returns 423 by design; zero manual deployment modes). */

  function scanSymbol(symbol: string) {
    setActiveSymbol(symbol);
    setView("ai");
    setPaletteOpen(false);
  }

  /* build (not copy) a terminal-style digest of every journaled deployment;
     the preview dialog offers an explicit COPY affordance */
  const { data: pulseForDigest } = usePulse(15000);
  function openJournalDigest() {
    setPaletteOpen(false);
    const built = buildJournalDigest(pulseForDigest?.signals ?? []);
    if (!built) {
      toast({
        title: "JOURNAL EMPTY",
        description: "No operator notes yet — write one from any signal detail dialog.",
      });
      return;
    }
    setDigestCopied(false);
    setDigest(built);
  }

  async function copyDigest() {
    if (!digest) return;
    try {
      await navigator.clipboard.writeText(digest.text);
      setDigestCopied(true);
      setTimeout(() => setDigestCopied(false), 1600);
      toast({
        title: "JOURNAL DIGEST COPIED",
        description: `${digest.count} entr${digest.count === 1 ? "y" : "ies"} on the clipboard — paste into your log.`,
      });
    } catch {
      toast({ title: "COPY BLOCKED", description: "Clipboard access denied by the browser.", variant: "destructive" });
    }
  }

  return (
    <>
    <CommandDialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      className="border-[rgb(var(--neon-rgb)/0.25)]"
    >
      <div className="flex items-center gap-2 border-b border-white/5 px-4 pt-4">
        <Command size={14} className="text-neon" aria-hidden />
        <span className="label-tech">FLOWRADAR COMMAND</span>
        <span className="ml-auto font-terminal text-[9px] tracking-[0.18em] text-ink-3">ESC TO CLOSE</span>
      </div>
      <CommandInput placeholder="Type a command or search symbols…" className="font-terminal" />
      <CommandList className="font-terminal">
        <CommandEmpty>NO MATCHING COMMAND.</CommandEmpty>

        <CommandGroup heading="NAVIGATE">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.id}
                value={`${item.label} ${item.id}`}
                onSelect={() => {
                  setView(item.id);
                  setPaletteOpen(false);
                }}
                className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgb(var(--neon-rgb)/0.08)] data-[selected=true]:text-neon"
              >
                <Icon size={14} />
                {item.label}
                <CommandShortcut className="text-ink-3">{item.shortcut}</CommandShortcut>
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="ENGINE">
          <CommandItem
            value="autonomous deployment status ai core"
            onSelect={() => {
              setView("ai");
              setPaletteOpen(false);
            }}
            className="gap-2.5 text-violet-neon data-[selected=true]:bg-[rgba(178,107,255,0.1)]"
          >
            <Zap size={14} />
            Autonomous deployment — AI core (no manual deploy)
          </CommandItem>
          <CommandItem
            value="open risk calculator position sizing"
            onSelect={() => {
              setView("signals");
              setCalcOpen(true);
              setPaletteOpen(false);
            }}
            className="gap-2.5 text-amber-neon data-[selected=true]:bg-[rgba(255,179,71,0.1)]"
          >
            <Calculator size={14} />
            Open risk calculator
          </CommandItem>
          <CommandItem
            value="toggle event alert notifications mute"
            onSelect={() => {
              setAlertsMuted(!alertsMuted);
              setPaletteOpen(false);
              toast({
                title: alertsMuted ? "ALERTS LIVE" : "ALERTS MUTED",
                description: alertsMuted
                  ? "Live signal events will pop as toasts again."
                  : "Live event toasts silenced — inbox keeps tracking.",
              });
            }}
            className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgba(69,240,223,0.08)] data-[selected=true]:text-cyan-neon"
          >
            {alertsMuted ? <BellOff size={14} /> : <Bell size={14} />}
            {alertsMuted ? "Unmute event alerts" : "Mute event alerts"}
          </CommandItem>
          <CommandItem
            value="toggle event sounds audio blips"
            onSelect={() => {
              const next = !soundEnabled;
              setSoundEnabled(next);
              if (next) {
                primeAudio();
                playConfirmChirp();
              }
              setPaletteOpen(false);
              toast({
                title: next ? "EVENT SOUNDS ON" : "EVENT SOUNDS OFF",
                description: next
                  ? "Synth blips armed — TP hits chirp, stop-outs buzz."
                  : "Audio disabled — silent terminal mode.",
              });
            }}
            className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgba(69,240,223,0.08)] data-[selected=true]:text-cyan-neon"
          >
            {soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
            {soundEnabled ? "Disable event sounds" : "Enable event sounds"}
          </CommandItem>
          <CommandItem
            value="open operator log journal analytics notebook"
            onSelect={() => {
              setView("analytics");
              requestOperatorLog();
              setPaletteOpen(false);
            }}
            className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgba(69,240,223,0.08)] data-[selected=true]:text-cyan-neon"
          >
            <NotebookPen size={14} />
            Open operator log
          </CommandItem>
          <CommandItem
            value="journal digest operator notes clipboard preview log"
            onSelect={() => {
              openJournalDigest();
            }}
            className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgba(69,240,223,0.08)] data-[selected=true]:text-cyan-neon"
          >
            <ScrollText size={14} />
            Open journal digest preview
          </CommandItem>
          <CommandItem
            value="toggle signal matrix view grid table layout density"
            onSelect={() => {
              const next = viewMode === "GRID" ? "TABLE" : "GRID";
              setViewMode(next);
              setView("signals");
              setPaletteOpen(false);
              toast({
                title: `MATRIX → ${next}`,
                description: next === "TABLE" ? "Dense terminal rows — scan mode." : "Signal cards — full detail mode.",
              });
            }}
            className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgb(var(--neon-rgb)/0.08)] data-[selected=true]:text-neon"
          >
            <Rows3 size={14} />
            Toggle matrix grid / table
            <CommandShortcut className="text-ink-3">{viewMode}</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="export analytics performance intel png image snapshot"
            onSelect={() => {
              setView("analytics");
              requestAnalyticsExport();
              setPaletteOpen(false);
            }}
            className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgb(var(--neon-rgb)/0.08)] data-[selected=true]:text-neon"
          >
            <ImageDown size={14} />
            Export analytics PNG
          </CommandItem>
          <CommandItem
            value="export analytics performance intel csv spreadsheet data"
            onSelect={() => {
              setView("analytics");
              requestAnalyticsCsv();
              setPaletteOpen(false);
            }}
            className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgba(69,240,223,0.08)] data-[selected=true]:text-cyan-neon"
          >
            <FileSpreadsheet size={14} />
            Export analytics CSV
          </CommandItem>
          <CommandItem
            value="open keyboard shortcuts keymap help"
            onSelect={() => {
              setPaletteOpen(false);
              setShortcutsOpen(true);
            }}
            className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgb(var(--neon-rgb)/0.08)] data-[selected=true]:text-neon"
          >
            <Keyboard size={14} />
            Keyboard shortcuts
            <CommandShortcut className="text-ink-3">?</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="cycle accent color identity theme"
            onSelect={() => {
              const next = nextAccent(accent);
              setAccent(next);
              setPaletteOpen(false);
              toast({ title: `ACCENT → ${next.toUpperCase()}`, description: "Terminal identity re-tuned." });
            }}
            className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgb(var(--neon-rgb)/0.08)] data-[selected=true]:text-neon"
          >
            <Palette size={14} />
            Cycle accent identity
            <CommandShortcut className="text-ink-3">A</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <TopMoverSpotlight onSpot={(sym) => { setSpotlightSymbol(sym); setPaletteOpen(false); }} />

        <SymbolScanGroup onScan={scanSymbol} />

        <CommandSeparator />

        <AccentGroup accent={accent} onPick={(id) => { setAccent(id); setPaletteOpen(false); }} />
      </CommandList>
    </CommandDialog>
    <DigestPreviewDialog
      digest={digest}
      onOpenChange={(v) => {
        if (!v) setDigest(null);
      }}
      copied={digestCopied}
      onCopy={() => void copyDigest()}
    />
    </>
  );
}

/** pure digest builder — ASCII-only (clipboard-safe), newest entries first */
function buildJournalDigest(signals: SignalDTO[]): { text: string; count: number } | null {
  const journaled = signals
    .filter((s) => (s.operatorNotes ?? "").trim().length > 0)
    .sort((a, b) => (b.notesUpdatedAt ?? "").localeCompare(a.notesUpdatedAt ?? ""));
  if (journaled.length === 0) return null;
  const lines = [
    `< ${BRAND_TERMINAL.head}${BRAND_TERMINAL.sep}${BRAND_TERMINAL.tail} - OPERATOR JOURNAL DIGEST >`,
    `${journaled.length} ENTRIES - ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`,
    "-".repeat(44),
  ];
  for (const s of journaled) {
    const meta = STATUS_META[s.status] ?? { label: s.status };
    const note = s.operatorNotes!.trim().replace(/\s+/g, " ");
    lines.push(
      `> ${s.symbol} ${s.direction} | ${meta.label} | ${fmtPct(s.pnlPercent)} @ ${fmtPrice(s.entryPrice)}`,
      `  ${note.slice(0, 180)}${note.length > 180 ? "..." : ""}`
    );
  }
  return { text: lines.join("\n"), count: journaled.length };
}

/** digest preview dialog — read before you copy (terminal render + counts) */
function DigestPreviewDialog({
  digest,
  onOpenChange,
  copied,
  onCopy,
}: {
  digest: { text: string; count: number } | null;
  onOpenChange: (v: boolean) => void;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <Dialog open={digest !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-hidden rounded-xl border-[rgba(69,240,223,0.25)] bg-[rgba(7,11,14,0.97)] p-0 backdrop-blur-2xl sm:max-w-xl">
        <DialogDescription className="sr-only">
          Preview of the operator journal digest before copying it to the clipboard.
        </DialogDescription>
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <ScrollText className="h-4 w-4 text-cyan-neon" aria-hidden />
            <DialogTitle className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">
              JOURNAL DIGEST
            </DialogTitle>
            <span className="ml-auto font-terminal text-[9px] tabular-nums tracking-[0.14em] text-ink-3">
              {digest?.count ?? 0} {(digest?.count ?? 0) === 1 ? "ENTRY" : "ENTRIES"} · {digest?.text.length ?? 0} CHARS
            </span>
          </div>
          <pre
            className="mt-4 max-h-[46vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/8 bg-[rgba(5,8,10,0.75)] p-3.5 font-terminal text-[11px] leading-relaxed text-ink-2 scrollbar-thin"
            aria-label="Journal digest plaintext preview"
          >
            {digest?.text ?? ""}
          </pre>
          <p className="mt-2 font-terminal text-[9px] tracking-[0.12em] text-ink-3">
            NEWEST FIRST · TRIMMED TO 180 CHARS PER NOTE · PASTE INTO ANY LOG
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[rgba(69,240,223,0.12)] bg-[rgba(5,8,10,0.6)] p-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="h-11 border-white/10 bg-transparent font-terminal text-[11px] tracking-[0.16em] text-ink-2 hover:bg-white/5"
          >
            CLOSE
          </Button>
          <Button
            type="button"
            onClick={onCopy}
            className="h-11 min-w-[130px] border border-[rgba(69,240,223,0.4)] bg-[rgba(69,240,223,0.12)] font-terminal text-[11px] font-bold tracking-[0.2em] text-cyan-neon hover:bg-[rgba(69,240,223,0.22)]"
          >
            {copied ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <Copy className="h-4 w-4" />}
            {copied ? "COPIED" : "COPY"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* one-click spotlight on the current #1 volatility mover */
function TopMoverSpotlight({ onSpot }: { onSpot: (symbol: string) => void }) {
  const { data } = usePulse(15000);
  const top = useMemo(() => {
    const m = [...(data?.market ?? [])].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
    return m[0];
  }, [data?.market]);
  return (
    <CommandGroup heading="SPOTLIGHT">
      <CommandItem
        value="symbol spotlight top mover market drilldown"
        onSelect={() => top && onSpot(top.symbol)}
        className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgb(var(--neon-rgb)/0.08)] data-[selected=true]:text-neon"
      >
        <Telescope size={14} />
        Spotlight top mover
        {top && (
          <span className="ml-auto font-terminal text-[10px] font-bold tracking-[0.12em] text-ink-3">
            {top.symbol} · {top.change24h >= 0 ? "+" : ""}{top.change24h.toFixed(1)}%
          </span>
        )}
      </CommandItem>
    </CommandGroup>
  );
}

/* accent identity picker — live preview chips */
function AccentGroup({ accent, onPick }: { accent: string; onPick: (id: AccentId) => void }) {
  return (
    <CommandGroup heading="IDENTITY / ACCENT">
      {ACCENT_ORDER.map((id) => (
        <CommandItem
          key={id}
          value={`accent ${id}`}
          onSelect={() => onPick(id)}
          className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgb(var(--neon-rgb)/0.08)] data-[selected=true]:text-neon"
        >
          <span
            aria-hidden
            className={cn(
              "inline-block h-3 w-3 shrink-0 rounded-full border",
              id === accent ? "border-white/60" : "border-black/50"
            )}
            style={{
              background: ACCENTS[id].hex,
              boxShadow: id === accent ? `0 0 10px ${ACCENTS[id].hex}` : undefined,
            }}
          />
          {id.charAt(0).toUpperCase() + id.slice(1)} accent
          {id === accent && <span className="ml-auto font-terminal text-[9px] tracking-[0.18em] text-neon">ACTIVE</span>}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/* symbols group pulled from pulse cache (no extra fetch) */
function SymbolScanGroup({ onScan }: { onScan: (s: string) => void }) {
  const { data } = usePulse(15000);
  const symbols = data?.market ?? [];
  return (
    <CommandGroup heading="AI SYMBOL SCAN">
      {symbols.length === 0 && (
        <div className="px-3 py-2 text-xs text-ink-3">loading markets…</div>
      )}
      {symbols.map((m) => (
        <CommandItem
          key={m.symbol}
          value={`scan ${m.symbol} ${m.name}`}
          onSelect={() => onScan(m.symbol)}
          className="gap-2.5 text-ink-2 data-[selected=true]:bg-[rgba(69,240,223,0.08)] data-[selected=true]:text-cyan-neon"
        >
          <ScanLine size={14} />
          <span className="font-semibold">{m.symbol}</span>
          <span className="text-xs text-ink-3">{m.name}</span>
          <span className="ml-auto text-[10px] text-ink-3 tabular-nums">
            {m.price >= 1000 ? m.price.toFixed(0) : m.price.toFixed(m.price >= 1 ? 2 : 4)}
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
