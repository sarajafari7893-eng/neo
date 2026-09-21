"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Bot, Brain, Loader2, Radar, ScanLine, SendHorizonal, ShieldAlert, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { BentoCard, ConfidenceBar, LiveDot, NeonBadge, SectionHeader } from "@/components/shared/primitives";
import { useMounted, useNow, usePulse } from "@/hooks/usePulse";
import { useUi } from "@/store/ui";
import { fmtPrice, timeAgo } from "@/lib/format";
import type { PulseSnapshot } from "@/lib/api-types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import EngineMemoryCard from "@/components/ai/EngineMemoryCard";
import ExchangeConsensusCard from "@/components/ai/ExchangeConsensusCard";
import FlowMatrixCard from "@/components/ai/FlowMatrixCard";
import GateTunablesCard from "@/components/ai/GateTunablesCard";
import BacktestCard from "@/components/ai/BacktestCard";
import GovernorCard from "@/components/ai/GovernorCard";
import AdvisorCard from "@/components/ai/AdvisorCard";
import AgentCard from "@/components/ai/AgentCard";
import DeepLearnCard from "@/components/ai/DeepLearnCard";
import VerdictCoreCard from "@/components/ai/VerdictCoreCard";
import GovernorModulesCard from "@/components/ai/GovernorModulesCard";
import ThoughtCoreCard from "@/components/ai/ThoughtCoreCard";
import SmartMoneyBoard from "@/components/dashboard/SmartMoneyBoard";
import VolOnsetRadarCard from "@/components/dashboard/VolOnsetRadarCard";
import VolCauseCard from "@/components/dashboard/VolCauseCard";

/* ── config / types ─────────────────────────────────────────────────── */

const GREETING =
  "FLOWRADAR-NEO AI online, operator. Ask for market reads, setups, or risk guidance. Try: 'Analyze BTC structure' or 'What's the engine bias today?'";

const QUICK_CHIPS: ReadonlyArray<string> = [
  "Analyze BTC",
  "Top momentum setup?",
  "Risk assessment",
  "Market regime now",
];

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** content actually sent to the API (may include hidden context prefix) */
  raw?: string;
  error?: boolean;
}

interface ChatApiResponse {
  reply?: string;
  error?: string;
}

interface AnalyzeResponse {
  symbol: string;
  price: number;
  change24h: number;
  bias: string;
  summary: string;
  invalidation: string;
  conviction: number;
}

interface ScanResult {
  symbol: string;
  bias: string;
  summary: string;
  invalidation: string;
  conviction: number;
  price: number;
  change24h: number;
  at: string;
}

function biasTone(bias: string): "neon" | "danger" | "amber" {
  return bias === "BULLISH" ? "neon" : bias === "BEARISH" ? "danger" : "amber";
}

function biasText(bias: string): string {
  return bias === "BULLISH" ? "text-neon" : bias === "BEARISH" ? "text-danger-neon" : "text-amber-neon";
}

/* v5.2: chat grounding moved SERVER-SIDE — /api/ai/chat builds a fresh live
   telemetry bundle on every turn (analyst-context.ts), so the client no longer
   injects a stale first-message snapshot. History stays clean operator text. */

/** Minimal **bold** → <strong> renderer; everything else stays plain. */
function renderRich(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i} className="font-semibold text-ink">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function AiAvatar({ error = false }: { error?: boolean }) {
  return (
    <div
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md border",
        error
          ? "border-[rgba(255,77,94,0.4)] bg-[rgba(255,77,94,0.1)] text-danger-neon"
          : "border-[rgba(178,107,255,0.4)] bg-[rgba(178,107,255,0.12)] text-violet-neon"
      )}
      aria-hidden
    >
      <Brain className="size-4" />
    </div>
  );
}

/* ── main section ───────────────────────────────────────────────────── */

export default function AiCoreSection() {
  const { data: pulse } = usePulse(5000);
  const mounted = useMounted();
  const now = useNow(1000);
  const activeSymbol = useUi((s) => s.activeSymbol);
  const setActiveSymbol = useUi((s) => s.setActiveSymbol);

  /* ── analyst chat state ── */
  const [messages, setMessages] = useState<ChatMsg[]>([{ id: "greeting", role: "assistant", content: GREETING }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const idRef = useRef(1);
  const nextId = useCallback(() => `m${idRef.current++}`, []);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const send = useCallback(
    async (textIn: string) => {
      const text = textIn.trim();
      if (!text || loading) return;
      const userMsg: ChatMsg = { id: nextId(), role: "user", content: text };
      const history: ChatMsg[] = [...messages, userMsg];
      setMessages(history);
      setInput("");
      setLoading(true);
      try {
        const res = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history.map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        if (!res.ok) throw new Error(`chat ${res.status}`);
        const data: ChatApiResponse = await res.json();
        const reply = (data.reply ?? "").trim();
        if (!reply) throw new Error("empty reply");
        setMessages((prev) => [...prev, { id: nextId(), role: "assistant", content: reply }]);
      } catch {
        toast.error("Neural link failed — AI core unreachable.");
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            content: "⚠ Transmission failed — neural link unreachable. Retry shortly, operator.",
            error: true,
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [loading, messages, nextId]
  );

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void send(input);
  };

  /* keep chat pinned to the latest message */
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, loading]);

  /* ── symbol scanner state ── */
  const market = useMemo(() => pulse?.market ?? [], [pulse]);
  const [selSymbol, setSelSymbol] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [history, setHistory] = useState<ScanResult[]>([]);

  /* consume cross-view symbol handoff (activeSymbol → scanner preselect) */
  useEffect(() => {
    if (activeSymbol) {
      setSelSymbol(activeSymbol);
      setActiveSymbol(null);
    }
  }, [activeSymbol, setActiveSymbol]);

  /* keep a valid selection once the market snapshot arrives */
  useEffect(() => {
    setSelSymbol((cur) => {
      if (market.length === 0) return cur;
      if (cur && market.some((m) => m.symbol === cur)) return cur;
      const btc = market.find((m) => m.symbol === "BTC");
      return (btc ?? market[0]).symbol;
    });
  }, [market]);

  const runScan = useCallback(async () => {
    if (!selSymbol || scanning) return;
    setScanning(true);
    setResult(null);
    try {
      const res = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: selSymbol }),
      });
      if (!res.ok) throw new Error(`analyze ${res.status}`);
      const data = (await res.json()) as AnalyzeResponse;
      const r: ScanResult = {
        symbol: data.symbol,
        bias: data.bias,
        summary: data.summary,
        invalidation: data.invalidation,
        conviction: data.conviction,
        price: data.price,
        change24h: data.change24h,
        at: new Date().toISOString(),
      };
      setResult(r);
      setHistory((prev) => [r, ...prev.filter((h) => h.symbol !== r.symbol)].slice(0, 3));
    } catch {
      toast.error("Scan failed — neural core unreachable.");
    } finally {
      setScanning(false);
    }
  }, [scanning, selSymbol]);

  /* ── AI position opinions (display-only) ── */
  const openSignals = useMemo(
    () =>
      (pulse?.signals ?? [])
        .filter((s) => s.status === "ACTIVE" || s.status === "TP1" || s.status === "TP2")
        .slice(0, 3),
    [pulse]
  );

  return (
    <section aria-label="AI core">
      <SectionHeader
        index="05"
        title="AI CORE"
        subtitle="LLM analyst chat + symbol scanner — grounded in live engine telemetry"
        right={
          <NeonBadge tone="violet" glow>
            <LiveDot tone="violet" /> online
          </NeonBadge>
        }
      />

      {/* v6.7.4 THOUGHT-CORE — operator switch for AI reasoning mode */}
      <div className="mt-4">
        <ThoughtCoreCard />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        {/* ══ A) ANALYST CHAT ══ */}
        <BentoCard corners className="flex h-[60vh] flex-col overflow-hidden p-0 sm:p-0 lg:col-span-3 lg:h-[70vh]">
          {/* header */}
          <div
            className="flex flex-wrap items-center gap-2 border-b border-[rgba(178,107,255,0.22)] px-4 py-3"
            style={{ background: "linear-gradient(90deg, rgba(178,107,255,0.16), rgba(178,107,255,0.03))" }}
          >
            <Sparkles className="size-4 text-violet-neon" aria-hidden />
            <span className="font-terminal text-xs font-bold uppercase tracking-[0.18em] text-ink">
              FLOWRADAR-NEO AI ANALYST
            </span>
            <NeonBadge tone="violet" className="ml-auto">
              <LiveDot tone="violet" /> NEURAL LINK: ONLINE
            </NeonBadge>
            <NeonBadge tone="muted">glm-4.6 · thought core</NeonBadge>
          </div>

          {/* messages */}
          <div
            ref={chatScrollRef}
            role="log"
            aria-live="polite"
            aria-label="AI analyst conversation"
            className="flex-1 space-y-4 overflow-y-auto p-4"
          >
            {messages.map((m) =>
              m.role === "user" ? (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className="flex justify-end"
                >
                  <div className="glass max-w-[85%] rounded-lg border border-[rgb(var(--neon-rgb)/0.35)] px-3.5 py-2.5 text-sm leading-relaxed text-ink">
                    {m.content}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className="flex items-start gap-2.5"
                >
                  <AiAvatar error={m.error} />
                  <div
                    className={cn(
                      "max-w-[90%] whitespace-pre-wrap rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed",
                      m.error
                        ? "border-[rgba(255,77,94,0.4)] bg-[rgba(255,77,94,0.06)] text-danger-neon"
                        : "border-[rgba(178,107,255,0.25)] bg-[rgba(178,107,255,0.07)] text-ink-2"
                    )}
                  >
                    {renderRich(m.content)}
                  </div>
                </motion.div>
              )
            )}
            {loading && (
              <div className="flex items-center gap-2.5">
                <AiAvatar />
                <div
                  className="flex items-center gap-1.5 rounded-lg border border-[rgba(178,107,255,0.25)] bg-[rgba(178,107,255,0.07)] px-4 py-3"
                  aria-label="AI is typing"
                  role="status"
                >
                  {[0, 1, 2].map((i) => (
                    <motion.span
                      key={i}
                      className="size-1.5 rounded-full bg-violet-neon"
                      animate={{ y: [0, -4, 0], opacity: [0.4, 1, 0.4] }}
                      transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* quick chips */}
          <div className="flex flex-wrap gap-2 border-t border-white/5 px-4 py-2.5">
            {QUICK_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                disabled={loading}
                onClick={() => void send(chip)}
                className={cn(
                  "min-h-11 rounded border border-[rgba(178,107,255,0.3)] px-3 font-terminal text-[10px] font-bold uppercase tracking-[0.14em] text-violet-neon transition-colors",
                  "hover:bg-[rgba(178,107,255,0.12)] disabled:opacity-40",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-neon/60"
                )}
              >
                {chip}
              </button>
            ))}
          </div>

          {/* input row */}
          <form onSubmit={handleSubmit} className="flex items-center gap-2 px-4 pb-4">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the analyst…"
              aria-label="Message the AI analyst"
              disabled={loading}
              className="h-11 flex-1 border-[rgba(178,107,255,0.25)] font-terminal text-sm placeholder:text-ink-3"
            />
            <Button
              type="submit"
              disabled={loading || input.trim().length === 0}
              aria-label="Send message"
              className={cn(
                "h-11 w-11 shrink-0 border border-[rgba(178,107,255,0.4)] bg-[rgba(178,107,255,0.15)] p-0 text-violet-neon",
                "hover:bg-[rgba(178,107,255,0.3)] focus-visible:ring-violet-neon/60"
              )}
            >
              <SendHorizonal className="size-4" aria-hidden />
            </Button>
          </form>
        </BentoCard>

        {/* ══ right rail: scanner + opinions ══ */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          {/* B) SYMBOL SCANNER */}
          <BentoCard tone="violet" className="p-4 sm:p-4" delay={0.05}>
            <div className="mb-4 flex items-center gap-2">
              <ScanLine className="size-4 text-violet-neon" aria-hidden />
              <div>
                <h3 className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">SYMBOL SCAN</h3>
                <p className="label-tech mt-0.5">LLM structural read</p>
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={selSymbol ?? ""} onValueChange={setSelSymbol}>
                <SelectTrigger
                  aria-label="Select symbol to scan"
                  className="h-11 w-full flex-1 border-[rgba(178,107,255,0.3)] font-terminal text-sm focus-visible:ring-violet-neon/50"
                >
                  <SelectValue placeholder="SELECT SYMBOL" />
                </SelectTrigger>
                <SelectContent className="border-[rgba(178,107,255,0.3)]">
                  {market.map((m) => (
                    <SelectItem key={m.symbol} value={m.symbol} className="font-terminal text-sm">
                      {m.symbol}
                      <span className="text-ink-3">· ${fmtPrice(m.price)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                onClick={() => void runScan()}
                disabled={scanning || selSymbol.length === 0}
                aria-label="Run AI symbol scan"
                className={cn(
                  "h-11 border border-[rgba(178,107,255,0.4)] bg-[rgba(178,107,255,0.15)] font-terminal text-[11px] font-bold uppercase tracking-[0.16em] text-violet-neon",
                  "hover:bg-[rgba(178,107,255,0.3)] focus-visible:ring-violet-neon/60"
                )}
              >
                {scanning ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Radar className="size-4" aria-hidden />}
                {scanning ? "SCANNING…" : "RUN SCAN"}
              </Button>
            </div>

            {/* result */}
            {result && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35 }}
                className="mt-4 rounded-lg border border-[rgba(178,107,255,0.25)] bg-[rgba(178,107,255,0.05)] p-3.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <NeonBadge tone={biasTone(result.bias)} glow className="px-2.5 py-1 text-[11px]">
                    {result.bias}
                  </NeonBadge>
                  <NeonBadge tone="muted">{result.symbol}</NeonBadge>
                  <NeonBadge tone="muted">${fmtPrice(result.price)}</NeonBadge>
                  <NeonBadge tone={result.change24h >= 0 ? "neon" : "danger"}>
                    {result.change24h >= 0 ? "+" : ""}
                    {result.change24h.toFixed(2)}%
                  </NeonBadge>
                </div>
                <div className="mt-3">
                  <div className="label-tech mb-1.5">Conviction</div>
                  <ConfidenceBar value={Math.round(result.conviction)} />
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">{result.summary}</p>
                <div className="mt-3 flex items-start gap-2 rounded border border-[rgba(255,179,71,0.3)] bg-[rgba(255,179,71,0.06)] px-2.5 py-2">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-neon" aria-hidden />
                  <p className="text-xs leading-relaxed text-amber-neon/90">{result.invalidation}</p>
                </div>
              </motion.div>
            )}

            {/* scan history */}
            {history.length > 0 && (
              <div className="mt-4">
                <div className="label-tech mb-1.5">Scan History</div>
                <div className="space-y-1">
                  {history.map((h) => (
                    <button
                      key={`${h.symbol}-${h.at}`}
                      type="button"
                      onClick={() => setResult(h)}
                      aria-label={`Show ${h.symbol} scan result`}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-2 rounded border border-white/5 px-2.5 font-terminal text-[11px] transition-colors",
                        "hover:border-[rgba(178,107,255,0.4)] hover:bg-[rgba(178,107,255,0.08)]",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-neon/60"
                      )}
                    >
                      <span className="font-bold text-ink">{h.symbol}</span>
                      <span className={cn("font-bold", biasText(h.bias))}>{h.bias}</span>
                      <span className="ml-auto tabular-nums text-ink-3">
                        {mounted && now > 0 ? timeAgo(h.at, now) : "--"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </BentoCard>

          {/* AI POSITION OPINIONS */}
          <BentoCard className="p-4 sm:p-4" delay={0.1}>
            <div className="mb-3 flex items-center gap-2">
              <Bot className="size-4 text-magenta-neon" aria-hidden />
              <span className="label-tech">AI Position Opinions</span>
              <NeonBadge tone="magenta" className="ml-auto">
                {openSignals.length} open
              </NeonBadge>
            </div>
            {openSignals.length === 0 ? (
              <p className="font-terminal text-[11px] text-ink-3">— no open positions to opine on —</p>
            ) : (
              <div className="space-y-3">
                {openSignals.map((s) => (
                  <div key={s.id} className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-terminal text-xs font-bold text-ink">{s.symbol}</span>
                      <NeonBadge tone={s.direction === "LONG" ? "neon" : "magenta"}>{s.direction}</NeonBadge>
                      <span className="ml-auto font-terminal text-[10px] uppercase tracking-[0.14em] text-ink-3">
                        AI conviction {s.confidence}%
                      </span>
                    </div>
                    <ConfidenceBar value={s.confidence} className="mt-2" />
                  </div>
                ))}
              </div>
            )}
          </BentoCard>
        </div>
      </div>

      {/* ══ v4.8 telemetry grid: memory + consensus ══ */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <EngineMemoryCard />
        <ExchangeConsensusCard />
      </div>

      {/* ══ v4.4/v4.5 grid: flow matrix + gate tunables ══ */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <FlowMatrixCard />
        <GateTunablesCard />
      </div>

      {/* ══ SMART MONEY · WHALE FLOW + VOL-ONSET RADAR + VOL-CAUSE FORENSICS —
          operator relocations 2026-09-07:
          «SMART MONEY · WHALE FLOW را به صفحه AI CORE ببر» ثم
          «VOL-ONSET RADAR و VOL-CAUSE FORENSICS رو هم به صفحه AI CORE ببر» —
          the full market-forensics desk now lives beside the AI analyst. ══ */}
      <SmartMoneyBoard />
      <VolOnsetRadarCard />
      <VolCauseCard />

      {/* ══ v4.8 BACKTEST & LEARNER — replayed-history performance learner ══ */}
      <div className="mt-4">
        <BacktestCard />

        {/* AI GOVERNOR — the LLM analyst with independent, clamped authority over the core (v5.0) */}
        <GovernorCard />

        {/* v10.0 GOVERNOR MODULES — the operator four-module package: R1 RISK-GOVERNOR,
            R2 TIME-GOVERNOR (shadow-first sizing, operator authority flips), R5 UI-CANARY
            (light render-health watchdog) and R6 DAILY SENIOR-REVIEW (nightly read-only
            auditor, clamped proposals, TG-gated). Mandate 2026-09-15. */}
        <GovernorModulesCard />

        {/* v6.6 AI ADVISOR — evidence-gated calibration proposals; operator APPROVE applies */}
        <AdvisorCard />

        {/* v5.4 AI DEEP-LEARN LAB — full-TP × stop-out research desk, lessons grounded into every agent */}
        <DeepLearnCard />

        {/* v8.2 VERDICT-CORE — the gate journal (confirm/reject reasons) streamed to the
            central core for deep learning; operator mandate «موتور گیج» 2026-09-08.
            The live needle/roster half lives on the TERMINAL gate-gauge card. */}
        <VerdictCoreCard />

        {/* AI AGENT — skills & autonomy manifest (v5.1) */}
        <AgentCard />
      </div>
    </section>
  );
}
