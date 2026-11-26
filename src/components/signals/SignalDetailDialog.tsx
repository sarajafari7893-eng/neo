"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toPng } from "html-to-image";
import { Brain, BarChart3, Check, Copy, Cpu, Ghost, Hash, ImageDown, Link2, Loader2, NotebookPen, Plus, Save, Sparkles, Tag, Telescope, Waves, X } from "lucide-react";

import type { SignalDTO } from "@/lib/api-types";
import { useUi } from "@/store/ui";
import {
  STATUS_META,
  distPct,
  fmtCountdown,
  fmtPct,
  fmtPrice,
  fmtUsd,
  signalBrief,
  timeAgo,
  ttlRemainingMs,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { ConfidenceBar, CountdownRing, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { LevelChart, type HistoryPoint } from "@/components/shared/LevelChart";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { usePulse, useNow } from "@/hooks/usePulse";
import { useToast } from "@/hooks/use-toast";

/* ── types ─────────────────────────────────────────────────── */
interface TimelineEventDTO {
  id: string;
  type: string;
  level?: string;
  message: string;
  createdAt: string;
}
interface SignalDetailResponse {
  signal: SignalDTO;
  timeline: TimelineEventDTO[];
}

/** per-card AI scan response (POST /api/ai/signal-scan) */
interface CardBriefResponse {
  serial: number;
  card: string;
  scannedAt: string;
  measured: { livePrice: number; netPnlPercent: number; netPnlUsd: number; feesUsd: number; heldMinutes: number; ttlMinutesRemaining: number };
  flowNow: { verdict: string; score: number; reasons: string[] };
  brief: { action: string; conviction: number; summary: string; risk: string; label: string };
}

const OPEN_STATUSES = new Set<string>(["ACTIVE", "TP1", "TP2"]);
/** TP resolution cascade rank — TP3 implies TP1+TP2 hit. */
const STATUS_RANK: Record<string, number> = {
  ACTIVE: 0, TP1: 1, TP2: 2, TP3: 3, SL: 0, EXPIRED: 0, CLOSED: 0,
};
const TONE_TO_BADGE = {
  live: "neon", win: "cyan", loss: "danger", warn: "amber", muted: "muted",
} as const;
type BadgeTone = "neon" | "violet" | "magenta" | "amber" | "danger" | "cyan" | "muted";

/** Timeline event type → badge tone (CREATED=violet, TP*=neon, SL=danger, TTL_EXPIRED=amber, TTL_EXTENDED=cyan, CLOSED=muted). */
function eventTone(e: TimelineEventDTO): BadgeTone {
  if (e.type.startsWith("TP")) return "neon";
  if (e.type === "SL") return "danger";
  if (e.type === "TTL_EXPIRED") return "amber";
  if (e.type === "TTL_EXTENDED") return "cyan";
  if (e.type === "BE_TRAIL") return "cyan";
  if (e.type === "CLOSED") return "muted";
  return "violet";
}
function eventDot(e: TimelineEventDTO): string {
  return {
    neon: "bg-neon shadow-[0_0_8px_rgb(var(--neon-rgb)/0.8)]",
    danger: "bg-danger-neon shadow-[0_0_8px_rgba(255,77,94,0.8)]",
    amber: "bg-amber-neon shadow-[0_0_8px_rgba(255,179,71,0.8)]",
    violet: "bg-violet-neon shadow-[0_0_8px_rgba(178,107,255,0.8)]",
    muted: "bg-ink-3",
    magenta: "bg-magenta-neon",
  }[eventTone(e)];
}

/* ── Operator journal ─────────────────────────────────────── */
const NOTES_MAX = 2000;

/**
 * Strategy-aware journal prompt seeds — tap to append a reflection
 * scaffold to the draft. Families mirror the engine's strategy ids.
 */
function journalPrompts(strategy: string): string[] {
  const s = strategy.toUpperCase();
  if (s.includes("BREAKOUT") || s.includes("RANGE-BREAK")) {
    return ["Trigger quality (close + volume):", "Failed-breakout plan:", "Re-entry trigger:"];
  }
  if (s.includes("MEAN-REVERT") || s.includes("RANGE")) {
    return ["Range boundaries respected?", "Reversion trigger (wick/flow):", "Invalidation beyond range:"];
  }
  if (s.includes("SWING") || s.includes("TREND")) {
    return ["Trend structure read:", "Pullback depth & timing:", "Swing management plan:"];
  }
  if (s.includes("MOMENTUM") || s.includes("SCALP")) {
    return ["Momentum source (CVD/funding):", "Execution slippage:", "Exit discipline:"];
  }
  return ["Thesis:", "Execution quality:", "Lesson:"];
}

/**
 * OperatorJournal — persisted free-text trade notes (PATCH action NOTES).
 * Draft buffer with dirty tracking, ⌘/Ctrl+Enter save, char budget,
 * accent focus ring + "UPDATED x AGO" stamp. Available for open AND
 * resolved deployments (post-trade journaling).
 */
function OperatorJournal({ sid, signal, onSaved }: { sid: string; signal: SignalDTO; onSaved: () => void }) {
  const { toast } = useToast();
  const now = useNow(15_000);
  const serverNotes = signal.operatorNotes ?? "";
  const [draft, setDraft] = useState(serverNotes);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = draft !== serverNotes;
  const overBudget = draft.length > NOTES_MAX;
  const areaRef = useRef<HTMLTextAreaElement>(null);

  /* re-sync the draft when a different signal is opened */
  useEffect(() => {
    setDraft(serverNotes);
    setJustSaved(false);
  }, [sid, serverNotes]);

  const save = useCallback(async () => {
    if (saving || overBudget || (!dirty && !justSaved)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/signals/${sid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "NOTES", notes: draft }),
      });
      if (!res.ok) throw new Error(`notes ${res.status}`);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1800);
      toast({
        title: draft.trim() ? "JOURNAL SAVED" : "JOURNAL CLEARED",
        description: `${signal.symbol} operator note ${draft.trim() ? "stored" : "wiped"} — synced to engine record.`,
      });
      onSaved();
    } catch {
      toast({
        title: "SAVE FAILED",
        description: `Could not persist the ${signal.symbol} note — retry in a moment.`,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }, [saving, overBudget, dirty, justSaved, draft, sid, signal.symbol, toast, onSaved]);

  /* ⌘/Ctrl+Enter saves from anywhere inside the textarea */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
  };

  const updatedAgo =
    signal.notesUpdatedAt && now !== 0
      ? timeAgo(signal.notesUpdatedAt, now).toUpperCase()
      : null;

  /* tap-to-seed a prompt scaffold at the end of the draft */
  const appendPrompt = (p: string) => {
    setDraft((d) => {
      const base = d.length ? (d.endsWith("\n") ? d : `${d}\n`) : "";
      return `${base}${p} `.slice(0, NOTES_MAX + 200);
    });
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  };

  const prompts = useMemo(() => journalPrompts(signal.strategy), [signal.strategy]);

  return (
    <section
      className="rounded-lg border border-[rgba(69,240,223,0.16)] bg-[rgba(69,240,223,0.03)] p-3.5 transition-colors focus-within:border-[rgba(69,240,223,0.35)]"
      aria-label="Operator journal"
    >
      <div className="flex items-center gap-2">
        <NotebookPen className="h-4 w-4 text-cyan-neon" aria-hidden />
        <span className="font-terminal text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-neon">
          OPERATOR JOURNAL
        </span>
        {updatedAgo && !dirty && (
          <span className="label-tech ml-auto text-ink-3">UPDATED {updatedAgo} AGO</span>
        )}
        {dirty && (
          <span className="ml-auto inline-flex items-center gap-1.5 font-terminal text-[9px] font-bold tracking-[0.18em] text-amber-neon">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-neon anim-pulse-dot" aria-hidden />
            UNSAVED
          </span>
        )}
      </div>

      <textarea
        ref={areaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, NOTES_MAX + 200))}
        onKeyDown={onKeyDown}
        rows={3}
        maxLength={NOTES_MAX + 200}
        aria-label={`Journal notes for ${signal.symbol} ${signal.direction}`}
        placeholder={
          serverNotes
            ? ""
            : "Log your read here — thesis, execution quality, emotions, lessons… (⌘↵ to save)"
        }
        className={cn(
          "mt-2.5 w-full resize-y rounded-md border border-white/8 bg-[rgba(5,8,10,0.55)] px-3 py-2.5",
          "font-terminal text-xs leading-relaxed text-ink placeholder:text-ink-3/70",
          "outline-none transition-colors",
          "focus:border-[rgba(69,240,223,0.4)] focus:shadow-[0_0_0_1px_rgba(69,240,223,0.25),0_0_18px_-6px_rgba(69,240,223,0.5)]",
          overBudget && "border-[rgba(255,77,94,0.5)]"
        )}
      />

      {/* per-strategy prompt seeds — tap to append a reflection scaffold */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="label-tech text-ink-3">PROMPTS</span>
        {prompts.map((p) => (
          <button
            key={p}
            type="button"
            tabIndex={overBudget ? -1 : 0}
            disabled={overBudget}
            onClick={() => appendPrompt(p)}
            title={`Append “${p}” to the note`}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-[rgba(69,240,223,0.2)] bg-[rgba(69,240,223,0.05)] px-2 py-1 font-terminal text-[9px] font-semibold tracking-[0.1em] text-cyan-neon/90 transition-all hover:border-[rgba(69,240,223,0.45)] hover:bg-[rgba(69,240,223,0.12)] hover:text-cyan-neon focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(69,240,223,0.6)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={9} strokeWidth={2.5} aria-hidden className="shrink-0" />
            <span className="truncate uppercase">{p.replace(/:$/, "")}</span>
          </button>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span
          className={cn(
            "font-terminal text-[9px] tabular-nums tracking-[0.14em]",
            overBudget ? "text-danger-neon" : draft.length > NOTES_MAX * 0.85 ? "text-amber-neon" : "text-ink-3"
          )}
          aria-live="polite"
        >
          {draft.length}/{NOTES_MAX}
          {overBudget ? " — TRIM TO SAVE" : ""}
        </span>
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              type="button"
              onClick={() => setDraft(serverNotes)}
              className="rounded-md border border-white/10 px-2.5 py-1.5 font-terminal text-[10px] font-semibold tracking-[0.14em] text-ink-3 transition-colors hover:border-white/20 hover:text-ink-2"
            >
              DISCARD
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={saving || overBudget || (!dirty && !justSaved)}
            aria-label={draft.trim() ? "Save journal note" : "Clear journal note"}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-terminal text-[10px] font-bold uppercase tracking-[0.16em] transition-all",
              "disabled:cursor-not-allowed disabled:opacity-45",
              justSaved
                ? "border-[rgb(var(--neon-rgb)/0.5)] bg-[rgb(var(--neon-rgb)/0.1)] text-neon"
                : "border-[rgba(69,240,223,0.35)] bg-[rgba(69,240,223,0.07)] text-cyan-neon hover:bg-[rgba(69,240,223,0.15)] hover:shadow-[0_0_14px_-4px_rgba(69,240,223,0.8)]"
            )}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : justSaved ? (
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
            ) : (
              <Save className="h-3.5 w-3.5" aria-hidden />
            )}
            {justSaved ? "SAVED" : draft.trim() ? "SAVE NOTE" : "CLEAR"}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ── Operator tags ────────────────────────────────────── */
const TAGS_MAX = 8;
const TAG_LEN_MAX = 28;

/** Client mirror of the server tag normalizer — uppercase kebab tokens. */
function normalizeTagToken(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TAG_LEN_MAX);
}

/**
 * TagsEditor — operator tag curation (PATCH action TAGS). Chip ✕ remove,
 * input+Enter add with live normalization preview, popular-tag suggestions
 * harvested from the live signal pool, cap 8 with budget counter, ⌘↵ save.
 * Persists to the engine record → drives card chips, search and CSV exports.
 */
function TagsEditor({ sid, signal, onSaved }: { sid: string; signal: SignalDTO; onSaved: () => void }) {
  const { toast } = useToast();
  const { data: pulse } = usePulse(5000);
  const serverTags = signal.tags ?? [];
  const [draft, setDraft] = useState<string[]>(serverTags);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = draft.join(",") !== serverTags.join(",");
  const full = draft.length >= TAGS_MAX;
  const inputRef = useRef<HTMLInputElement>(null);

  /* re-sync when a different signal is opened */
  useEffect(() => {
    setDraft(signal.tags ?? []);
    setInput("");
    setJustSaved(false);
  }, [sid]);

  /* popular tag pool from live signals (freq-ordered, excludes current draft) */
  const suggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of pulse?.signals ?? []) {
      for (const t of s.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t)
      .filter((t) => !draft.includes(t))
      .slice(0, 6);
  }, [pulse, draft]);

  const addToken = (raw: string) => {
    const token = normalizeTagToken(raw);
    if (!token || full) return;
    if (!draft.includes(token)) setDraft((d) => [...d, token].slice(0, TAGS_MAX));
    setInput("");
  };

  const save = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/signals/${sid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "TAGS", tags: draft }),
      });
      if (!res.ok) throw new Error(`tags ${res.status}`);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1800);
      toast({
        title: "TAGS UPDATED",
        description: `${signal.symbol} now carries ${draft.length} tag${draft.length === 1 ? "" : "s"} — search + CSV synced.`,
      });
      onSaved();
    } catch {
      toast({
        title: "TAG SAVE FAILED",
        description: `Could not persist ${signal.symbol} tags — retry in a moment.`,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }, [saving, dirty, draft, sid, signal.symbol, toast, onSaved]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addToken(input);
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Backspace" && !input && draft.length) {
      setDraft((d) => d.slice(0, -1));
    }
  };

  return (
    <section
      className="rounded-lg border border-[rgba(69,240,223,0.16)] bg-[rgba(69,240,223,0.03)] p-3.5 transition-colors focus-within:border-[rgba(69,240,223,0.35)]"
      aria-label="Signal tags editor"
    >
      <div className="flex items-center gap-2">
        <Tag className="h-4 w-4 text-cyan-neon" aria-hidden />
        <span className="font-terminal text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-neon">
          OPERATOR TAGS
        </span>
        <span
          className={cn(
            "ml-auto font-terminal text-[9px] tabular-nums tracking-[0.14em]",
            full ? "text-amber-neon" : "text-ink-3"
          )}
          aria-live="polite"
        >
          {draft.length}/{TAGS_MAX}
        </span>
        {dirty && !justSaved && (
          <span className="inline-flex items-center gap-1.5 font-terminal text-[9px] font-bold tracking-[0.18em] text-amber-neon">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-neon anim-pulse-dot" aria-hidden />
            UNSAVED
          </span>
        )}
      </div>

      {/* chips + input */}
      <div
        className="mt-2.5 flex min-h-[42px] w-full flex-wrap items-center gap-1.5 rounded-md border border-white/8 bg-[rgba(5,8,10,0.55)] px-2.5 py-2 transition-colors focus-within:border-[rgba(69,240,223,0.4)] focus-within:shadow-[0_0_0_1px_rgba(69,240,223,0.25),0_0_18px_-6px_rgba(69,240,223,0.5)]"
        onClick={() => inputRef.current?.focus()}
      >
        {draft.map((t) => (
          <span
            key={t}
            className="group inline-flex items-center gap-1 rounded border border-[rgba(69,240,223,0.3)] bg-[rgba(69,240,223,0.07)] py-0.5 pl-2 pr-1 font-terminal text-[10px] font-bold uppercase tracking-[0.1em] text-cyan-neon"
          >
            #{t}
            <button
              type="button"
              onClick={() => setDraft((d) => d.filter((x) => x !== t))}
              aria-label={`Remove tag ${t}`}
              className="flex h-4 w-4 items-center justify-center rounded-sm text-cyan-neon/60 transition-colors hover:bg-white/10 hover:text-danger-neon focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(69,240,223,0.6)]"
            >
              <X size={10} strokeWidth={3} aria-hidden />
            </button>
          </span>
        ))}
        <div className="relative flex min-w-[120px] flex-1 items-center">
          <Hash className="pointer-events-none absolute left-1 h-3 w-3 text-ink-3" aria-hidden />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, TAG_LEN_MAX + 8))}
            onKeyDown={onKeyDown}
            disabled={full}
            maxLength={TAG_LEN_MAX + 8}
            aria-label="Add a tag"
            placeholder={full ? "TAG LIMIT REACHED" : draft.length ? "ADD TAG…" : "ADD FIRST TAG… (↵)"}
            className="w-full bg-transparent pl-4.5 font-terminal text-xs uppercase text-ink outline-none placeholder:text-ink-3/70 disabled:cursor-not-allowed"
          />
        </div>
      </div>

      {/* suggestions + actions */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {suggestions.length > 0 && !full && (
          <>
            <span className="label-tech inline-flex items-center gap-1 text-ink-3">
              <Hash size={9} aria-hidden /> POPULAR
            </span>
            {suggestions.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => addToken(t)}
                aria-label={`Add tag ${t}`}
                className="glass-soft inline-flex items-center gap-0.5 rounded px-2 py-1 font-terminal text-[9px] font-bold uppercase tracking-[0.1em] text-ink-2 transition-all hover:border-[rgba(69,240,223,0.4)] hover:text-cyan-neon hover:shadow-[0_0_10px_-2px_rgba(69,240,223,0.5)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(69,240,223,0.6)]"
              >
                <Plus size={9} aria-hidden />#{t}
              </button>
            ))}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <button
              type="button"
              onClick={() => {
                setDraft(serverTags);
                setInput("");
              }}
              className="rounded-md border border-white/10 px-2.5 py-1.5 font-terminal text-[10px] font-semibold tracking-[0.14em] text-ink-3 transition-colors hover:border-white/20 hover:text-ink-2"
            >
              DISCARD
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            aria-label="Save signal tags"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-terminal text-[10px] font-bold uppercase tracking-[0.16em] transition-all",
              "disabled:cursor-not-allowed disabled:opacity-45",
              justSaved
                ? "border-[rgb(var(--neon-rgb)/0.5)] bg-[rgb(var(--neon-rgb)/0.1)] text-neon"
                : "border-[rgba(69,240,223,0.35)] bg-[rgba(69,240,223,0.07)] text-cyan-neon hover:bg-[rgba(69,240,223,0.15)] hover:shadow-[0_0_14px_-4px_rgba(69,240,223,0.8)]"
            )}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : justSaved ? (
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
            ) : (
              <Save className="h-3.5 w-3.5" aria-hidden />
            )}
            {justSaved ? "SAVED" : "SAVE TAGS"}
          </button>
        </div>
      </div>
    </section>
  );
}

export default function SignalDetailDialog({
  signal,
  open,
  onOpenChange,
}: {
  signal: SignalDTO | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const setSpotlightSymbol = useUi((s) => s.setSpotlightSymbol);
  const { data: pulse } = usePulse(5000);
  const now = useNow(1000);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const [exportingPng, setExportingPng] = useState(false);
  const captureRef = useRef<HTMLDivElement | null>(null);

  /* ── PNG snapshot of the whole detail card ────────────────
     the scroll body is temporarily expanded (max-h/overflow released)
     so the capture spans the FULL card, not just the visible viewport */
  async function handleExportPng() {
    const node = captureRef.current;
    if (!node || exportingPng) return;
    setExportingPng(true);
    const prevMax = node.style.maxHeight;
    const prevOv = node.style.overflowY;
    node.style.maxHeight = "none";
    node.style.overflowY = "visible";
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const dataUrl = await toPng(node, {
        pixelRatio: 2,
        backgroundColor: "#070b0e",
        style: { borderRadius: "12px" },
        filter: (n) =>
          !(n instanceof HTMLElement && (n.dataset?.exportIgnore === "true" || n.dataset?.slot === "dialog-close")),
      });
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
      const a = document.createElement("a");
      a.download = `flowradar-signal-${(sig?.symbol ?? "detail").toLowerCase()}-${stamp}.png`;
      a.href = dataUrl;
      a.click();
      toast({
        title: "SIGNAL SNAPSHOT SAVED",
        description: `${sig?.symbol ?? "Signal"} detail card exported as a PNG brief.`,
      });
    } catch {
      toast({
        title: "EXPORT FAILED",
        description: "Could not rasterize the detail card — try again.",
        variant: "destructive",
      });
    } finally {
      node.style.maxHeight = prevMax;
      node.style.overflowY = prevOv;
      setExportingPng(false);
    }
  }

  /* copy a shareable plaintext brief (also available on the card footer) */
  async function handleCopy() {
    if (!sig) return;
    try {
      await navigator.clipboard.writeText(signalBrief(sig, livePrice));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      toast({
        title: "SIGNAL COPIED",
        description: `${sig.symbol} ${sig.direction} brief on the clipboard — paste anywhere.`,
      });
    } catch {
      toast({
        title: "COPY BLOCKED",
        description: "Clipboard access denied by the browser.",
        variant: "destructive",
      });
    }
  }

  /* copy a deep-link URL that reopens this exact deployment (#signal=<id>) */
  async function handleShare() {
    if (!sig) return;
    const url = `${window.location.origin}${window.location.pathname}#signal=${sig.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setShared(true);
      setTimeout(() => setShared(false), 1600);
      toast({
        title: "SHARE LINK COPIED",
        description: `${sig.symbol} deep-link on the clipboard — pasting it reopens this card.`,
      });
    } catch {
      toast({
        title: "COPY BLOCKED",
        description: "Clipboard access denied by the browser.",
        variant: "destructive",
      });
    }
  }

  const sid = signal?.id ?? null;

  /* ── fetch full detail (signal + timeline) when open ───── */
  const { data: detail, isLoading } = useQuery<SignalDetailResponse>({
    queryKey: ["signal-detail", sid],
    queryFn: async () => {
      if (!sid) throw new Error("no signal id");
      const res = await fetch(`/api/signals/${sid}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`detail ${res.status}`);
      return (await res.json()) as SignalDetailResponse;
    },
    enabled: open && !!sid,
  });

  const sig = detail?.signal ?? signal;
  const timeline = detail?.timeline ?? [];

  /* live price from pulse market map */
  const livePrice = useMemo(
    () => pulse?.market.find((m) => m.symbol === sig?.symbol)?.price,
    [pulse, sig?.symbol]
  );

  /* ── AI SIGNAL BRIEF (R17) — serial-grounded per-card scan ── */
  const signalAutoScanSerial = useUi((s) => s.signalAutoScanSerial);
  const setSignalAutoScanSerial = useUi((s) => s.setSignalAutoScanSerial);
  const [brief, setBrief] = useState<CardBriefResponse | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const scannedSerialRef = useRef<number | null>(null);

  const runBrief = useCallback(
    async (serial: number) => {
      setBriefLoading(true);
      setBrief(null);
      try {
        const res = await fetch("/api/ai/signal-scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serial }),
        });
        if (!res.ok) throw new Error(`scan ${res.status}`);
        setBrief((await res.json()) as CardBriefResponse);
      } catch {
        toast({
          title: "AI SCAN FAILED",
          description: "Could not reach the scan core — retry in a moment.",
          variant: "destructive",
        });
      } finally {
        setBriefLoading(false);
      }
    },
    [toast]
  );

  /* auto-run when opened via a card's AI SCAN button */
  useEffect(() => {
    if (!open || !signalAutoScanSerial) return;
    if (scannedSerialRef.current === signalAutoScanSerial) {
      setSignalAutoScanSerial(null);
      return;
    }
    scannedSerialRef.current = signalAutoScanSerial;
    void runBrief(signalAutoScanSerial);
    setSignalAutoScanSerial(null);
  }, [open, signalAutoScanSerial, runBrief, setSignalAutoScanSerial]);

  /* ── price history for the TP/SL overlay chart ─────────── */
  const { data: historyData } = useQuery<{ series: HistoryPoint[] }>({
    queryKey: ["price-history", sig?.symbol],
    queryFn: async () => {
      const res = await fetch(`/api/market/history?symbol=${sig?.symbol}&hours=24`, { cache: "no-store" });
      if (!res.ok) throw new Error(`history ${res.status}`);
      return (await res.json()) as { series: HistoryPoint[] };
    },
    enabled: open && !!sig?.symbol,
    staleTime: 60_000,
    refetchInterval: 60_000, // v5.4: keep the 24H window rolling (chart was frozen between remounts)
  });

  /* ── v6.0 TOTAL AUTONOMY: manual close removed ───────────
     Exits are engine-managed (TP1/TP2/TP3 ladder, stop, TTL). No operator
     lifecycle control — the AI SUPERVISOR enforces the no-manual mandate. */

  if (!sig) return null;
  const long = sig.direction === "LONG";
  const cur = livePrice ?? sig.entryPrice;
  const isOpen = !sig.closedAt && OPEN_STATUSES.has(sig.status);
  const statusMeta = STATUS_META[sig.status] ?? { label: sig.status, tone: "muted" as const };
  const statusBadgeTone = (TONE_TO_BADGE[statusMeta.tone] ?? "muted") as BadgeTone;

  const rank = STATUS_RANK[sig.status] ?? 0;
  const crossTp = (level: number) => (long ? cur >= level : cur <= level);
  const tpHit = (n: 1 | 2 | 3, level: number) => rank >= n || (isOpen && crossTp(level));
  const slStopped = sig.status === "SL" || (isOpen && (long ? cur <= sig.stopLoss : cur >= sig.stopLoss));

  const ttlTotalMs = Math.max(1, sig.ttlMinutes * 60_000);
  const remaining = now === 0 ? ttlTotalMs : ttlRemainingMs(sig.expiresAt, now);
  const ttlProgress = Math.max(0, Math.min(1, remaining / ttlTotalMs));
  const ttlCd = now === 0 ? "--:--:--" : fmtCountdown(sig.expiresAt, now);

  /* signed est. PnL% at a level (direction-adjusted distance × leverage) */
  const estPnl = (level: number) => {
    const raw = distPct(sig.entryPrice, level);
    return (long ? raw : -raw) * sig.leverage;
  };

  const expiresClock =
    now === 0 ? "--:--" : new Date(sig.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const createdLabel = now === 0 ? "--" : timeAgo(sig.createdAt, now);

  const keyValues: Array<{ label: string; value: ReactNode }> = [
    { label: "SERIAL", value: <span className="text-violet-neon">NX-{String(sig.serial ?? 0).padStart(4, "0")}</span> },
    { label: "ENTRY PRICE", value: <span className="text-ink">{fmtPrice(sig.entryPrice)}</span> },
    {
      label: "ENTRY ZONE",
      value: (
        <span className="text-ink-2">
          {fmtPrice(sig.entryZoneLow)}–{fmtPrice(sig.entryZoneHigh)}
        </span>
      ),
    },
    {
      label: "CURRENT PRICE",
      value: (
        <span className="flex items-center gap-1.5 text-neon">
          <LiveDot />
          {fmtPrice(cur)}
        </span>
      ),
    },
    { label: "LEVERAGE", value: <span className="text-amber-neon">×{sig.leverage}</span> },
    { label: "MARGIN", value: <span className="text-ink-2">{fmtUsd(sig.marginUsd, false)}</span> },
    { label: "POSITION SIZE", value: <span className="text-ink">{fmtUsd(sig.marginUsd * sig.leverage)}</span> },
    { label: "RISK : REWARD", value: <span className="text-cyan-neon">1 : {sig.riskReward.toFixed(1)}</span> },
    {
      label: "FEES (COMM + SWAP)",
      value: (
        <span className="text-ink-2" title="taker 0.05%×2 round-trip + funding 0.01%/8h pro-rated — realized when resolved">
          ${(sig.feeUsd + sig.swapUsd).toFixed(3)}
        </span>
      ),
    },
    { label: "CREATED", value: <span className="text-ink-2">{createdLabel}</span> },
    { label: "EXPIRES", value: <span className="text-amber-neon">{expiresClock}</span> },
  ];

  const levels: Array<{
    key: string;
    label: string;
    price: number;
    hit: boolean;
    danger?: boolean;
    hitLabel: string;
  }> = [
    { key: "tp1", label: "TP1", price: sig.tp1, hit: tpHit(1, sig.tp1), hitLabel: "HIT" },
    { key: "tp2", label: "TP2", price: sig.tp2, hit: tpHit(2, sig.tp2), hitLabel: "HIT" },
    { key: "tp3", label: "TP3", price: sig.tp3, hit: tpHit(3, sig.tp3), hitLabel: "HIT" },
    {
      key: "sl",
      label: "STOP-LOSS",
      price: sig.stopLoss,
      hit: slStopped,
      danger: true,
      hitLabel: "STOPPED",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92vh] gap-0 overflow-hidden rounded-xl border-[rgb(var(--neon-rgb)/0.18)] bg-[rgba(7,11,14,0.96)] p-0 backdrop-blur-2xl sm:max-w-2xl"
      >
        <DialogDescription className="sr-only">
          Full deployment detail for {sig.symbol} {sig.direction} signal: levels, TTL, AI analysis and event timeline.
        </DialogDescription>

        <div ref={captureRef} className="max-h-[70vh] overflow-y-auto p-5 sm:p-6">
          {/* ── Title block ── */}
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <DialogTitle asChild>
              <button
                type="button"
                onClick={() => setSpotlightSymbol(sig.symbol)}
                aria-label={`Open ${sig.symbol} market spotlight`}
                className="group inline-flex items-center gap-1.5 rounded font-terminal text-xl font-bold uppercase tracking-[0.12em] text-ink outline-none transition-colors hover:text-neon focus-visible:ring-1 focus-visible:ring-[rgb(var(--neon-rgb)/0.6)] focus-visible:text-neon"
              >
                {sig.symbol}
                <Telescope
                  size={15}
                  aria-hidden
                  className="text-ink-3 transition-all duration-300 group-hover:-translate-y-px group-hover:text-neon group-hover:drop-shadow-[0_0_6px_rgb(var(--neon-rgb)/0.8)]"
                />
              </button>
            </DialogTitle>
            <NeonBadge tone={long ? "neon" : "magenta"} glow>
              {sig.direction}
            </NeonBadge>
            <NeonBadge tone={statusBadgeTone} glow={statusMeta.tone === "live"}>
              {statusMeta.label}
            </NeonBadge>
            <NeonBadge tone="violet">{sig.strategy}</NeonBadge>
            <NeonBadge tone="cyan">{sig.timeframe}</NeonBadge>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Cpu className="h-3 w-3 text-ink-3" />
            <span className="label-tech">ENGINE // {sig.engine}</span>
            <span className="label-tech ml-auto hidden items-center gap-1 text-ink-3 sm:flex">
              <Telescope size={9} aria-hidden /> TAP SYMBOL FOR SPOTLIGHT
            </span>
          </div>

          {isLoading ? (
            /* ── Loading skeleton ── */
            <div className="mt-5 space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 rounded-lg bg-white/[0.05]" />
                ))}
              </div>
              <Skeleton className="h-36 rounded-lg bg-white/[0.05]" />
              <Skeleton className="h-24 rounded-lg bg-white/[0.05]" />
              <Skeleton className="h-40 rounded-lg bg-white/[0.05]" />
            </div>
          ) : (
            <div className="mt-5 space-y-5">
              {/* ── Key values grid ── */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {keyValues.map((kv) => (
                  <div key={kv.label} className="glass-soft rounded-lg px-3 py-2">
                    <div className="label-tech">{kv.label}</div>
                    <div className="mt-1 font-terminal text-sm font-bold tabular-nums">{kv.value}</div>
                  </div>
                ))}
                {/* TTL cell with live ring — frozen to an OUTCOME state once resolved */}
                <div className="glass-soft col-span-2 flex items-center justify-between gap-3 rounded-lg px-3 py-2 sm:col-span-1">
                  <div>
                    <div className="label-tech">TTL</div>
                    <div className="mt-1 font-terminal text-sm font-bold tabular-nums text-amber-neon">
                      {sig.ttlMinutes}M · {isOpen ? ttlCd : "RESOLVED"}
                    </div>
                  </div>
                  {isOpen ? (
                    <CountdownRing size={44} progress={ttlProgress} label={now === 0 ? "--:--" : ttlCd.slice(3)} sub="TTL" />
                  ) : (
                    <CountdownRing
                      size={44}
                      progress={rank >= 1 ? 1 : 0}
                      label={rank >= 1 ? sig.status : sig.status === "SL" ? "STOP" : sig.status === "EXPIRED" ? "0:00" : "END"}
                      sub={rank >= 1 ? "HIT" : sig.status === "SL" ? "OUT" : sig.status === "EXPIRED" ? "TTL END" : "CLOSED"}
                      tone={rank >= 1 ? "cyan" : sig.status === "SL" ? "danger" : sig.status === "EXPIRED" ? "amber" : "muted"}
                      ariaLabel={`Deployment resolved — ${sig.status}`}
                    />
                  )}
                </div>
              </div>

              {/* ── Price history × levels overlay ── */}
              <section>
                <div className="label-tech mb-1.5 flex items-center justify-between">
                  <span>{"// PRICE ACTION × LEVELS — 24H"}</span>
                  <span className="text-cyan-neon/60">{sig.symbol}</span>
                </div>
                <div className="glass-soft rounded-lg p-2">
                  <LevelChart signal={sig} history={historyData?.series ?? []} livePrice={livePrice} />
                </div>
              </section>

              {/* ── Levels table ── */}
              <section>
                <div className="label-tech mb-1.5">{"// LEVELS"}</div>
                <div className="glass-soft overflow-hidden rounded-lg">
                  <div className="grid grid-cols-[4.5rem_1fr_4.25rem_5rem_2rem] items-center gap-2 border-b border-white/5 px-3 py-2">
                    <span className="label-tech">LEVEL</span>
                    <span className="label-tech text-right">PRICE</span>
                    <span className="label-tech text-right">DIST</span>
                    <span className="label-tech text-right">EST PNL</span>
                    <span />
                  </div>
                  {levels.map((lv) => {
                    const tone = lv.danger ? "danger" : "neon";
                    return (
                      <div
                        key={lv.key}
                        className={cn(
                          "grid grid-cols-[4.5rem_1fr_4.25rem_5rem_2rem] items-center gap-2 border-b border-white/5 px-3 py-2 last:border-0",
                          lv.hit && (lv.danger ? "bg-[rgba(255,77,94,0.06)]" : "bg-[rgb(var(--neon-rgb)/0.05)]")
                        )}
                      >
                        <span
                          className={cn(
                            "font-terminal text-[10px] font-bold uppercase tracking-[0.14em]",
                            lv.hit ? (lv.danger ? "text-danger-neon" : "text-neon") : "text-ink-2"
                          )}
                        >
                          {lv.label}
                        </span>
                        <span className="text-right font-terminal text-xs font-bold tabular-nums text-ink">
                          {fmtPrice(lv.price)}
                        </span>
                        <span className="text-right font-terminal text-[10px] tabular-nums text-ink-3">
                          {fmtPct(distPct(sig.entryPrice, lv.price))}
                        </span>
                        <span
                          className={cn(
                            "text-right font-terminal text-[10px] font-bold tabular-nums",
                            estPnl(lv.price) >= 0 ? "text-neon" : "text-danger-neon"
                          )}
                        >
                          {fmtPct(estPnl(lv.price))}
                        </span>
                        <span className="flex items-center justify-center">
                          {lv.hit ? (
                            lv.danger ? (
                              <X className="h-3.5 w-3.5 text-danger-neon" strokeWidth={3} />
                            ) : (
                              <Check className="h-3.5 w-3.5 text-neon" strokeWidth={3} />
                            )
                          ) : (
                            <span className={cn("h-1.5 w-1.5 rounded-full", lv.danger ? "bg-danger-neon/40" : "bg-neon/30")} />
                          )}
                        </span>
                        {/* status marker text kept for a11y */}
                        <span className="sr-only">{lv.hit ? lv.hitLabel : "pending"}</span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-1 font-terminal text-[9px] tracking-[0.1em] text-ink-3">
                  EST PNL = DIRECTION-ADJUSTED DISTANCE × LEVERAGE · STOP RISK ≈ -{fmtUsd(
                    sig.marginUsd * (Math.abs(sig.entryPrice - sig.stopLoss) / sig.entryPrice) * sig.leverage
                  )}
                </p>
              </section>

              {/* ── AI SIGNAL BRIEF (R17) — serial-grounded scan of THIS card ── */}
              <section className="rounded-lg border border-[rgba(69,240,223,0.25)] bg-[rgba(69,240,223,0.05)] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Sparkles className="h-4 w-4 text-cyan-neon" />
                  <span className="font-terminal text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-neon">
                    AI SIGNAL BRIEF — {`NX-${String(sig.serial ?? 0).padStart(4, "0")}`}
                  </span>
                  {brief && (
                    <NeonBadge tone={brief.brief.action === "HOLD" ? "cyan" : brief.brief.action === "CLOSE" ? "danger" : "amber"} className="ml-auto">
                      {brief.brief.action} · {Math.round(brief.brief.conviction)}%
                    </NeonBadge>
                  )}
                  <button
                    type="button"
                    onClick={() => void runBrief(sig.serial ?? 0)}
                    disabled={briefLoading || !sig.serial}
                    className="flex min-h-9 items-center gap-1.5 rounded border border-[rgba(69,240,223,0.35)] px-2.5 font-terminal text-[10px] font-bold tracking-[0.14em] text-cyan-neon transition-colors hover:bg-[rgba(69,240,223,0.1)] disabled:opacity-40"
                    aria-label="Re-run AI scan of this card"
                  >
                    {briefLoading ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Sparkles className="size-3" aria-hidden />}
                    {briefLoading ? "SCANNING…" : brief ? "RE-SCAN" : "SCAN NOW"}
                  </button>
                </div>
                {briefLoading && !brief && <p className="mt-3 font-terminal text-[11px] text-ink-3">scanning THIS card — live NET PnL, factor votes at deploy, fresh flow re-measure…</p>}
                {brief && (
                  <>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {[
                        { label: "NET PNL", value: `${brief.measured.netPnlPercent >= 0 ? "+" : ""}${brief.measured.netPnlPercent.toFixed(2)}%`, cls: brief.measured.netPnlPercent >= 0 ? "text-neon" : "text-danger-neon" },
                        { label: "FEES NOW", value: `$${brief.measured.feesUsd.toFixed(3)}`, cls: "text-ink-2" },
                        { label: "FLOW NOW", value: `${brief.flowNow.verdict} ${brief.flowNow.score >= 0 ? "+" : ""}${brief.flowNow.score}`, cls: brief.flowNow.score >= 8 ? "text-neon" : brief.flowNow.score <= -8 ? "text-danger-neon" : "text-amber-neon" },
                        { label: "TTL LEFT", value: `${brief.measured.ttlMinutesRemaining}M`, cls: "text-amber-neon" },
                      ].map((c) => (
                        <div key={c.label} className="rounded border border-white/8 bg-white/[0.02] px-2.5 py-1.5">
                          <div className="label-tech text-[9px]">{c.label}</div>
                          <div className={cn("mt-0.5 font-terminal text-xs font-bold tabular-nums", c.cls)}>{c.value}</div>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{brief.brief.summary}</p>
                    <div className="mt-2 flex items-start gap-2 rounded border border-[rgba(255,179,71,0.3)] bg-[rgba(255,179,71,0.06)] px-2.5 py-2">
                      <Ghost className="mt-0.5 size-3.5 shrink-0 text-amber-neon" aria-hidden />
                      <p className="text-xs leading-relaxed text-amber-neon/90">{brief.brief.risk}</p>
                    </div>
                    <p className="mt-2 font-terminal text-[9px] tracking-[0.12em] text-ink-3">
                      {brief.brief.label === "HEURISTIC" ? "HEURISTIC FALLBACK — MODEL UNAVAILABLE · " : "MODEL GROUNDED · "}
                      SCANNED {new Date(brief.scannedAt).toISOString().slice(11, 19)}Z · EVERY NUMBER MEASURED
                    </p>
                  </>
                )}
              </section>

              {/* ── AI analysis ── */}
              <section className="rounded-lg border border-[rgba(178,107,255,0.25)] bg-[rgba(178,107,255,0.06)] p-4">
                <div className="flex items-center gap-2">
                  <Brain className="h-4 w-4 text-violet-neon" />
                  <span className="font-terminal text-[10px] font-bold uppercase tracking-[0.22em] text-violet-neon">
                    FLOWRADAR-NEO AI ANALYSIS
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{sig.analysis}</p>
                <div className="mt-3">
                  <div className="label-tech mb-1">CONFIDENCE</div>
                  <ConfidenceBar value={sig.confidence} />
                </div>
              </section>

              {/* ── ORDER-FLOW CONFIRMATION (v4.3+) — snapshot at deploy ── */}
              {sig.flow && (
                <section className="rounded-lg border border-[rgba(69,240,223,0.25)] bg-[rgba(69,240,223,0.04)] p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Waves className="h-4 w-4 text-cyan-neon" />
                    <span className="font-terminal text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-neon">ORDER-FLOW CONFIRMATION</span>
                    <NeonBadge tone={sig.flow.verdict === "CONFIRMS" ? "neon" : sig.flow.verdict === "CONFLICTS" ? "danger" : "amber"} className="ml-auto">
                      {sig.flow.verdict} {sig.flow.score >= 0 ? "+" : ""}{sig.flow.score}/25
                    </NeonBadge>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      { label: "OI Δ1H", v: sig.flow.metrics.oiDelta1h, fmt: (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`, tip: "open-interest change over 1h at deploy" },
                      { label: "OI Δ10M", v: sig.flow.metrics.oiDelta10m, fmt: (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`, tip: "open-interest change over 10m at deploy" },
                      { label: "CVD NET", v: sig.flow.metrics.cvdNetPctOfVol, fmt: (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`, tip: "taker buy−sell net as % of taker volume" },
                      { label: "TAKER B/S", v: sig.flow.metrics.takerRatio, fmt: (x: number) => x.toFixed(3), tip: "last taker long/short ratio vs mean" },
                      { label: "CROWD L/S", v: sig.flow.metrics.crowdLongShort, fmt: (x: number) => `${x.toFixed(2)}:1`, tip: "global account long/short (retail crowd)" },
                      { label: "FUNDING /8H", v: sig.flow.metrics.funding8h, fmt: (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(4)}%`, tip: "predicted funding rate per 8h" },
                      { label: "OI NOTIONAL", v: sig.flow.metrics.oiValueUsd, fmt: (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : `$${(x / 1e6).toFixed(1)}M`), tip: "open interest value in USD" },
                      { label: "FLOW WEIGHT", v: sig.flow.oiWeight, fmt: (x: number) => `×${x.toFixed(2)}`, tip: "OI-notional weighting applied to the flow score (v4.5)" },
                    ].map((c) => (
                      <div key={c.label} className="rounded border border-white/8 bg-white/[0.02] px-2.5 py-1.5" title={c.tip}>
                        <div className="label-tech text-[9px]">{c.label}</div>
                        <div className={cn("mt-0.5 font-terminal text-xs font-bold tabular-nums", c.v === null || c.v === undefined ? "text-ink-3" : "text-ink")}>{c.v === null || c.v === undefined ? "—" : c.fmt(c.v)}</div>
                      </div>
                    ))}
                  </div>
                  {sig.flow.reasons.length > 0 && (
                    <ul className="mt-3 space-y-1">
                      {sig.flow.reasons.slice(0, 4).map((r, i) => (
                        <li key={i} className="flex items-start gap-1.5 font-terminal text-[10px] leading-relaxed text-ink-3">
                          <span className="text-cyan-neon">▸</span> {r}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 font-terminal text-[9px] tracking-[0.12em] text-ink-3">MEASURED FROM BINANCE USDT-M FUTURES · SNAPSHOT AT DEPLOY · PRICE-MOVING FLOWS ONLY</p>
                </section>
              )}

              {/* ── FACTOR VOTES — indicator votes at deploy (audit trail) ── */}
              {sig.factors && sig.factors.length > 0 && (
                <section className="rounded-lg border border-white/8 bg-white/[0.02] p-4">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-violet-neon" />
                    <span className="font-terminal text-[10px] font-bold uppercase tracking-[0.22em] text-violet-neon">FACTOR VOTES AT DEPLOY</span>
                    <NeonBadge tone="muted" className="ml-auto">{sig.factors.length} FACTORS</NeonBadge>
                  </div>
                  <div className="mt-3 space-y-1.5">
                    {sig.factors.map((f) => (
                      <div key={f.factor} className="flex items-center gap-2" title={f.detail}>
                        <span className="w-28 shrink-0 truncate font-terminal text-[10px] uppercase tracking-[0.1em] text-ink-2">{f.factor}</span>
                        <div className="relative h-1.5 min-w-0 flex-1 rounded-full bg-white/5">
                          <div className="absolute left-1/2 top-0 h-full w-px bg-white/15" aria-hidden />
                          <div
                            className={cn("absolute top-0 h-full rounded-full", f.vote >= 0 ? "bg-neon" : "bg-danger-neon")}
                            style={{
                              left: f.vote >= 0 ? "50%" : `${50 - Math.min(50, (Math.abs(f.vote) / 25) * 50)}%`,
                              width: `${Math.min(50, (Math.abs(f.vote) / 25) * 50)}%`,
                              boxShadow: "0 0 6px currentColor",
                            }}
                          />
                        </div>
                        <span className={cn("w-12 shrink-0 text-right font-terminal text-[10px] font-bold tabular-nums", f.vote > 0 ? "text-neon" : f.vote < 0 ? "text-danger-neon" : "text-ink-3")}>
                          {f.vote > 0 ? "+" : ""}{f.vote.toFixed(1)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 font-terminal text-[9px] tracking-[0.12em] text-ink-3">RAW VOTES PRESERVED FOR AUDIT · CALIBRATED WEIGHTS (v4.8) SCALE THESE AT SCAN TIME</p>
                </section>
              )}

              {/* ── EXPIRED afterlife row (Bug 5 fix) ── */}
              {sig.status === "EXPIRED" && (
                <section className="flex flex-wrap items-center gap-2 rounded-lg border border-[rgba(255,179,71,0.3)] bg-[rgba(255,179,71,0.05)] px-3.5 py-3">
                  <Ghost className="size-4 text-amber-neon" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="label-tech">EXPIRED LIFECYCLE — 48H AFTERLIFE TRACKING</div>
                    <p className="mt-1 font-terminal text-[10px] leading-relaxed text-ink-3">
                      Position auto-closed at TTL mark ({fmtPct(sig.pnlPercent)} NET){(sig.ttlExtensions ?? 0) > 0 ? ` after ${sig.ttlExtensions} dynamic expiry-gate extension${sig.ttlExtensions === 1 ? "" : "s"} (TTL ${sig.ttlMinutes}m base)` : ` · TTL ${sig.ttlMinutes}m`}. Post-expiry follow-up: {sig.afterlife === "TRACKING" ? "still tracking — watching for TP/SL re-tests within 48h" : sig.afterlife === "FLAT" ? "48h window closed without a re-test" : (sig.afterlife ?? "TRACKING").replace("_", " ") + " confirmed"}. Post-expiry best excursion {sig.maxPostPnlPercent >= 0 ? "+" : ""}{sig.maxPostPnlPercent.toFixed(1)}% levered — feeds TTL calibration.
                    </p>
                  </div>
                </section>
              )}

              {/* ── Operator tags ── */}
              <TagsEditor
                sid={sig.id}
                signal={sig}
                onSaved={() => {
                  void qc.invalidateQueries({ queryKey: ["signal-detail", sid] });
                  void qc.invalidateQueries({ queryKey: ["pulse"] });
                }}
              />

              {/* ── Operator journal ── */}
              <OperatorJournal
                sid={sig.id}
                signal={sig}
                onSaved={() => {
                  void qc.invalidateQueries({ queryKey: ["signal-detail", sid] });
                  void qc.invalidateQueries({ queryKey: ["pulse"] });
                }}
              />

              {/* ── Timeline ── */}
              <section>
                <div className="label-tech mb-2">{"// EVENT TIMELINE"}</div>
                {timeline.length === 0 ? (
                  <p className="font-terminal text-xs text-ink-3">NO EVENTS RECORDED</p>
                ) : (
                  <ol className="space-y-3 border-l border-[rgb(var(--neon-rgb)/0.14)] pl-4">
                    {timeline.map((e) => (
                      <li key={e.id} className="relative">
                        <span className={cn("absolute -left-[21px] top-1 h-2 w-2 rounded-full", eventDot(e))} />
                        <div className="flex flex-wrap items-center gap-1.5">
                          <NeonBadge tone={eventTone(e)}>{e.type}</NeonBadge>
                          <span className="font-terminal text-[10px] tabular-nums text-ink-3">
                            {new Date(e.createdAt).toLocaleTimeString("en-GB", { hour12: false })}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{e.message}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          )}
        </div>

        {/* ── Footer action ── */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[rgb(var(--neon-rgb)/0.12)] bg-[rgba(5,8,10,0.6)] p-4">
          <Button
            type="button"
            variant="outline"
            onClick={handleShare}
            aria-label="Copy share link for this signal"
            className={cn(
              "h-11 border-white/10 bg-transparent font-terminal text-[11px] font-semibold tracking-[0.16em] text-ink-2 transition-all hover:border-[rgba(178,107,255,0.45)] hover:bg-[rgba(178,107,255,0.08)] hover:text-violet-neon",
              shared && "border-[rgba(178,107,255,0.5)] text-violet-neon"
            )}
          >
            {shared ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <Link2 className="h-4 w-4" />}
            {shared ? "LINKED" : "SHARE"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleCopy}
            aria-label="Copy signal brief to clipboard"
            className={cn(
              "h-11 border-white/10 bg-transparent font-terminal text-[11px] font-semibold tracking-[0.16em] text-ink-2 transition-all hover:border-[rgba(69,240,223,0.4)] hover:bg-[rgba(69,240,223,0.08)] hover:text-cyan-neon",
              copied && "border-[rgba(69,240,223,0.5)] text-cyan-neon"
            )}
          >
            {copied ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <Copy className="h-4 w-4" />}
            {copied ? "COPIED" : "COPY BRIEF"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleExportPng}
            disabled={exportingPng}
            aria-label="Export signal detail card as PNG"
            className="h-11 border-white/10 bg-transparent font-terminal text-[11px] font-semibold tracking-[0.16em] text-ink-2 transition-all hover:border-[rgb(var(--neon-rgb)/0.4)] hover:bg-[rgb(var(--neon-rgb)/0.08)] hover:text-neon"
          >
            {exportingPng ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageDown className="h-4 w-4" />}
            {exportingPng ? "CAPTURING…" : "PNG"}
          </Button>
          {isOpen && (
            <span className="mr-auto font-terminal text-[10px] tracking-[0.16em] text-ink-3">
              EXITS ENGINE-MANAGED — TP LADDER · STOP · TTL (TOTAL AUTONOMY)
            </span>
          )}
          {!isOpen && (
            <span className="mr-auto font-terminal text-[10px] tracking-[0.16em] text-ink-3">
              DEPLOYMENT RESOLVED — BRIEF STILL SHAREABLE
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
