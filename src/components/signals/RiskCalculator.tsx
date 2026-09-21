"use client";

import { useMemo, useState } from "react";
import { Calculator, RotateCcw, ShieldAlert, TriangleAlert } from "lucide-react";

import type { SignalDTO } from "@/lib/api-types";
import { fmtPrice, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NeonBadge } from "@/components/shared/primitives";
import { usePulse } from "@/hooks/usePulse";

/**
 * Position-size / risk calculator.
 * risk$ = equity × risk% → notional = risk$ / stopDist% → qty & margin via leverage.
 * Prefillable from a live signal. Opened from the Signals toolbar or ⌘K palette.
 * Inner form remounts per signal via key → fresh prefill without effects.
 */

interface CalcState {
  direction: "LONG" | "SHORT";
  equity: string;
  riskPct: string;
  entry: string;
  stop: string;
  tp1: string;
  leverage: string;
}

function roundPrice(p: number): number {
  if (p >= 1000) return Math.round(p * 100) / 100;
  if (p >= 1) return Math.round(p * 1000) / 1000;
  return Math.round(p * 100000) / 100000;
}

const NUM =
  "h-11 w-full rounded-lg border border-[rgba(159,180,171,0.16)] bg-[rgba(12,18,23,0.5)] font-terminal text-sm tabular-nums text-ink placeholder:text-ink-3 focus-visible:ring-neon/50";

export default function RiskCalculator({
  open,
  onOpenChange,
  signal,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  signal?: SignalDTO | null;
}) {
  const { data } = usePulse(15000);
  const accountEquity = data?.stats.account?.equity ?? 10_000;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] w-[min(94vw,540px)] overflow-y-auto border-[rgb(var(--neon-rgb)/0.22)] bg-[rgba(7,11,14,0.97)] backdrop-blur-xl sm:rounded-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-terminal text-sm font-bold uppercase tracking-[0.2em] text-ink">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-[rgb(var(--neon-rgb)/0.35)] bg-[rgb(var(--neon-rgb)/0.08)] text-neon">
              <Calculator size={14} />
            </span>
            RISK CALCULATOR
          </DialogTitle>
          <DialogDescription className="font-terminal text-[11px] tracking-wide text-ink-3">
            POSITION SIZING FROM ACCOUNT RISK — NEVER RISK MORE THAN PLANNED
          </DialogDescription>
        </DialogHeader>
        <CalcForm key={signal?.id ?? "manual"} signal={signal ?? null} accountEquity={accountEquity} />
      </DialogContent>
    </Dialog>
  );
}

function CalcForm({ signal, accountEquity }: { signal: SignalDTO | null; accountEquity: number }) {
  const [form, setForm] = useState<CalcState>(() =>
    signal
      ? {
          direction: signal.direction,
          equity: String(Math.round(accountEquity)),
          riskPct: "1",
          entry: String(roundPrice(signal.entryPrice)),
          stop: String(roundPrice(signal.stopLoss)),
          tp1: String(roundPrice(signal.tp1)),
          leverage: String(signal.leverage),
        }
      : {
          direction: "LONG",
          equity: String(Math.round(accountEquity)),
          riskPct: "1",
          entry: "",
          stop: "",
          tp1: "",
          leverage: "10",
        }
  );

  function set<K extends keyof CalcState>(k: K, v: CalcState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function reset() {
    setForm({
      direction: "LONG",
      equity: String(Math.round(accountEquity)),
      riskPct: "1",
      entry: "",
      stop: "",
      tp1: "",
      leverage: "10",
    });
  }

  const r = useMemo(() => {
    const equity = parseFloat(form.equity);
    const riskPct = parseFloat(form.riskPct);
    const entry = parseFloat(form.entry);
    const stop = parseFloat(form.stop);
    const tp1 = parseFloat(form.tp1);
    const lev = parseFloat(form.leverage);
    if (
      !Number.isFinite(equity) || equity <= 0 ||
      !Number.isFinite(riskPct) || riskPct <= 0 ||
      !Number.isFinite(entry) || entry <= 0 ||
      !Number.isFinite(stop) || stop <= 0 || stop === entry ||
      !Number.isFinite(lev) || lev < 1
    )
      return null;

    const long = form.direction === "LONG";
    const validSide = long ? stop < entry : stop > entry;

    const riskUsd = (equity * riskPct) / 100;
    const stopDistPct = (Math.abs(entry - stop) / entry) * 100;
    const notional = riskUsd / (stopDistPct / 100);
    const qty = notional / entry;
    const margin = notional / lev;
    const levOnEquity = notional / equity;
    const liq = long ? entry * (1 - 0.95 / lev) : entry * (1 + 0.95 / lev);
    const rr =
      Number.isFinite(tp1) && tp1 > 0 ? Math.abs(tp1 - entry) / Math.abs(entry - stop) : null;

    return { validSide, riskUsd, stopDistPct, notional, qty, margin, levOnEquity, liq, rr };
  }, [form]);

  return (
    <div className="space-y-3">
      {/* prefill chip */}
      {signal && (
        <div className="flex items-center gap-2">
          <NeonBadge tone="violet">
            PREFILLED · {signal.symbol} {signal.direction}
          </NeonBadge>
          <button
            type="button"
            onClick={reset}
            className="ml-auto flex h-8 items-center gap-1 rounded-md border border-white/10 px-2 font-terminal text-[9px] font-bold uppercase tracking-[0.16em] text-ink-3 transition-colors hover:border-[rgba(255,77,94,0.4)] hover:text-danger-neon focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60"
          >
            <RotateCcw size={11} /> CLEAR
          </button>
        </div>
      )}

      {/* direction toggle */}
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Trade direction">
        {(["LONG", "SHORT"] as const).map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={form.direction === d}
            onClick={() => set("direction", d)}
            className={cn(
              "h-11 rounded-lg border font-terminal text-[11px] font-bold tracking-[0.2em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60",
              form.direction === d &&
                d === "LONG" &&
                "border-[rgb(var(--neon-rgb)/0.4)] bg-[rgb(var(--neon-rgb)/0.1)] text-neon",
              form.direction === d &&
                d === "SHORT" &&
                "border-[rgba(255,78,205,0.45)] bg-[rgba(255,78,205,0.12)] text-magenta-neon",
              form.direction !== d && "border-white/10 text-ink-3 hover:text-ink-2"
            )}
          >
            {d}
          </button>
        ))}
      </div>

      {/* inputs */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="ACCOUNT EQUITY $">
          <Input inputMode="decimal" value={form.equity} onChange={(e) => set("equity", e.target.value)} className={NUM} placeholder="10000" aria-label="Account equity" />
        </Field>
        <Field label="RISK PER TRADE %">
          <Input inputMode="decimal" value={form.riskPct} onChange={(e) => set("riskPct", e.target.value)} className={NUM} placeholder="1" aria-label="Risk percent per trade" />
        </Field>
        <Field label="ENTRY PRICE">
          <Input inputMode="decimal" value={form.entry} onChange={(e) => set("entry", e.target.value)} className={NUM} placeholder="0.000" aria-label="Entry price" />
        </Field>
        <Field label="STOP LOSS">
          <Input inputMode="decimal" value={form.stop} onChange={(e) => set("stop", e.target.value)} className={NUM} placeholder="0.000" aria-label="Stop loss price" />
        </Field>
        <Field label="TAKE PROFIT 1 (OPT.)">
          <Input inputMode="decimal" value={form.tp1} onChange={(e) => set("tp1", e.target.value)} className={NUM} placeholder="0.000" aria-label="Take profit 1 price" />
        </Field>
        <Field label="LEVERAGE ×">
          <Input inputMode="decimal" value={form.leverage} onChange={(e) => set("leverage", e.target.value)} className={NUM} placeholder="10" aria-label="Leverage" />
        </Field>
      </div>

      {/* output */}
      {!r ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-white/12 px-3.5 py-4 font-terminal text-[10px] uppercase tracking-[0.18em] text-ink-3">
          <Calculator size={13} className="shrink-0" aria-hidden />
          AWAITING VALID INPUTS — EQUITY, RISK, ENTRY, STOP &amp; LEVERAGE
        </div>
      ) : !r.validSide ? (
        <div
          role="alert"
          className="flex items-center gap-2.5 rounded-lg border border-[rgba(255,77,94,0.4)] bg-[rgba(255,77,94,0.08)] px-3.5 py-4 font-terminal text-[11px] tracking-wide text-danger-neon"
        >
          <ShieldAlert size={16} className="shrink-0" aria-hidden />
          INVALID STRUCTURE — FOR A {form.direction} THE STOP MUST BE{" "}
          {form.direction === "LONG" ? "BELOW ENTRY" : "ABOVE ENTRY"}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Out label="RISK AMOUNT" value={fmtUsd(r.riskUsd)} tone="danger" />
            <Out label="STOP DISTANCE" value={`${r.stopDistPct.toFixed(2)}%`} tone="amber" />
            <Out label="POSITION SIZE" value={fmtUsd(r.notional)} tone="neon" big />
            <Out label="QUANTITY" value={fmtPrice(r.qty)} tone="ink" />
            <Out label="MARGIN REQ." value={fmtUsd(r.margin)} tone="cyan" />
            <Out label="EST. LIQUIDATION" value={fmtPrice(r.liq)} tone="danger" />
          </div>

          {/* exposure bar */}
          <div>
            <div className="flex items-center justify-between font-terminal text-[9px] uppercase tracking-[0.18em] text-ink-3">
              <span>NOTIONAL / EQUITY</span>
              <span className={cn("tabular-nums", r.levOnEquity > 5 ? "text-amber-neon" : "text-ink-2")}>
                {r.levOnEquity.toFixed(2)}× ACCOUNT
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/5">
              <div
                className={cn("h-full rounded-full", r.levOnEquity > 5 ? "bg-amber-neon" : "bg-neon")}
                style={{
                  width: `${Math.min(100, (r.levOnEquity / 10) * 100)}%`,
                  boxShadow: "0 0 8px currentColor",
                }}
              />
            </div>
          </div>

          {r.rr !== null && (
            <div className="flex items-center justify-between rounded-lg border border-[rgba(69,240,223,0.25)] bg-[rgba(69,240,223,0.05)] px-3.5 py-2.5">
              <span className="label-tech">RISK : REWARD → TP1</span>
              <span
                className={cn(
                  "font-terminal text-sm font-bold tabular-nums",
                  r.rr >= 1.5 ? "text-neon" : r.rr >= 1 ? "text-amber-neon" : "text-danger-neon"
                )}
              >
                1 : {r.rr.toFixed(2)}
              </span>
            </div>
          )}

          {r.levOnEquity > 5 && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-[rgba(255,179,71,0.35)] bg-[rgba(255,179,71,0.07)] px-3.5 py-2.5 text-[11px] leading-snug text-amber-neon"
            >
              <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                HIGH EXPOSURE — NOTIONAL IS {r.levOnEquity.toFixed(1)}× YOUR EQUITY. A{" "}
                {(r.stopDistPct * r.levOnEquity).toFixed(1)}% adverse gap beyond SL would threaten the account
                (slippage / gaps).
              </span>
            </div>
          )}

          <p className="font-terminal text-[9px] leading-relaxed tracking-wide text-ink-3">
            LIQUIDATION ESTIMATED AT ~{form.leverage}× ISOLATED MARGIN (0.5% MAINTENANCE BUFFER). SIMULATED
            ENVIRONMENT — ALWAYS VERIFY AGAINST THE EXCHANGE.
          </p>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label-tech mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function Out({
  label,
  value,
  tone,
  big = false,
}: {
  label: string;
  value: string;
  tone: "neon" | "danger" | "amber" | "cyan" | "ink";
  big?: boolean;
}) {
  const color = {
    neon: "text-neon neon-text",
    danger: "text-danger-neon",
    amber: "text-amber-neon",
    cyan: "text-cyan-neon",
    ink: "text-ink",
  }[tone];
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2.5">
      <div className="label-tech">{label}</div>
      <div className={cn("mt-0.5 font-terminal font-bold tabular-nums", color, big ? "text-lg" : "text-sm")}>
        {value}
      </div>
    </div>
  );
}
