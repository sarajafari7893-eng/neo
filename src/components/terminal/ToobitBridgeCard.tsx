"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, BadgeDollarSign, CircleStop, Gauge, LineChart, Radio, ShieldAlert, Timer } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";

/**
 * ToobitBridgeCard — v12.3 TASK-52 + v1.3.0 DOCTRINE (operator mandate
 * trace 1a15f7d945d27ead): the Toobit execution-bridge monitor. READ-ONLY by
 * doctrine: mutating actions are KEY-ONLY, the panel renders the mirror state:
 * mode, balance, FIXED-margin sizing (5$ × card leverage — NOT the legacy
 * cfg.notionalUsdt, whose stale 15$ display was the "Notional shows another
 * number" bug), entry gates (drift/delay), open intents with expected-vs-
 * actual notional, and the recent card-lifecycle trail.
 * v1.4.3 (trace 1a172ca1af260c0d): LIVE money-truth badge — exchange-verified
 * realized PnL of closed intents + open mark PnL (/status.livePnl) — and the
 * sizing note now names the exchange contractMultiplier (the $0.5-margin bug).
 * v1.5.0 (trace 1a1899d2237473d9): ACTIVATED with the FIXED $3 balance —
 * margin $3 (paperBalanceUsdt anchor $3, equity = 3$ + Σ realized), paper
 * fills book REAL book PnL, and the card renders the full-event journal:
 * equity curve (recharts), since-boot event counters, and the raw trail.
 * v1.5.1 (trace 1a18a0e79bbf5ec5 — «باگ اجرایی و محاسباتی»): ① the remaining-
 * after-سیو-سود notional now multiplies contractMultiplier (qty is in CONTRACTS
 * — pre-1.5.1 a ×0.01 symbol showed the remaining notional 100× too big);
 * ② a بی‌کلید badge when keysInstalled=false — the honest cause of «no live
 * position» (keys wiped by a sandbox recycle → LIVE+recon dead, PAPER only);
 * ③ the downtime STALE-CARD skip counter is visible on the doctrine strip.
 * Feed: /api/toobit-bridge (5s) + /api/toobit-bridge/journal (8s).
 */

interface IntentDTO {
  cardId: string; serial: number; symbol: string; tbSymbol: string;
  direction: string; status: string; mode: string;
  qtyOrig: number; qtyRemaining: number;
  cardEntry: number; tp3: number; stopLoss: number;
  fillPrice: number | null; openedAt: number | null; closedAt: number | null;
  closeReason: string | null;
  leverage?: number; levSrc?: string;
  expectedNotional?: number | null; actualNotional?: number | null;
  contractMult?: number; // v1.5.1 — real notional = qty × price × mult (contracts!)
  entryDriftBps?: number | null; entryAgeMs?: number | null;
  protected?: boolean; cardStatus?: string;
  lat: { detectMs: number | null; execMs: number | null; totalMs: number | null; slipBps: number | null };
  events: Array<{ at: number; ev: string; note?: string }>;
}
interface DoctrineSummary {
  opens: number;
  skipBy: Record<string, number>;
  violationsN: number;
  lastViolation: { at: number; serial: number; kind: string; detail: string } | null;
  lastScanAt: number;
  gates: { marginUsdt: number; maxEntryDriftBps: number; maxEntryAgeMs: number };
}
interface BridgeStatus {
  ok: boolean; bridge?: string; ver?: string;
  mode?: "LIVE" | "PAPER";
  liveApproved?: boolean;
  keysInstalled?: boolean; // v1.5.1 — false = کلید صرافی گم‌شده، LIVE و راستی‌آزمایی حساب مرده
  balanceUsdt?: number | null;
  cfg?: { marginUsdt: number; maxConcurrent: number; tp1Frac: number; tp2Frac: number; leverage: number; execEnabled: boolean; paperBalanceUsdt?: number };
  openIntents?: IntentDTO[];
  recent?: IntentDTO[];
  activeCount?: number | null; // v13.2.2 — DB ACTIVE signals, to mirror-check openIntents against
  metrics?: { n: number; totalMsP50: number | null; totalMsP95: number | null; detectMsP50: number | null; slipBpsP50: number | null; slipBpsWorst: number | null };
  livePnl?: { realizedClosedUsdt: number; openUnrealizedUsdt: number; closedN: number; openN: number }; // v1.4.3 — exchange-verified money truth
  paper?: { anchorUsdt: number; realizedUsdt: number; equityUsdt: number; closedN: number; wins: number; losses: number; winRate: number | null; curveN: number; openN: number }; // v1.5.0 — fixed-$3 account
  doctrine?: DoctrineSummary;
  instruments?: number;
}

// v1.5.0 — full-event journal (report + chart contract)
interface JournalEvent { at: number; ev: string; note?: string; serial?: number }
interface JournalData {
  ok: boolean; bridge?: string; mode?: string;
  account?: { anchorUsdt: number; realizedUsdt: number; equityUsdt: number; closedN: number; wins: number; losses: number; winRate: number | null; curveN: number };
  equityCurve?: Array<{ at: number; eq: number; pnl: number }>;
  counters?: { totalSinceBoot: number; byKind: Record<string, number>; opens: number; orphans: number };
  closed?: Array<{ serial: number; symbol: string; mode: string; closeReason: string | null; realizedPnlUsdt: number | null; closedAt: number | null }>;
  recent?: JournalEvent[];
}

const STATUS_CLS: Record<string, string> = {
  OPEN: "text-neon", OPENING: "text-amber-neon", CLOSING: "text-amber-neon",
  CLOSED: "text-muted-foreground", FAILED: "text-danger-neon", SKIP: "text-muted-foreground",
};

function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}
const ago = (at: number | null): string => (at ? `${Math.max(0, Math.round((Date.now() - at) / 1000))}s` : "—");

export default function ToobitBridgeCard() {
  const { data, isError } = useQuery<BridgeStatus>({
    queryKey: ["toobit-bridge"],
    queryFn: async () => {
      const res = await fetch("/api/toobit-bridge", { cache: "no-store" });
      return (await res.json()) as BridgeStatus;
    },
    refetchInterval: 5000,
    retry: 1,
  });
  // v1.5.0 — full-event journal feed (equity curve + counters + raw trail)
  const { data: jn } = useQuery<JournalData>({
    queryKey: ["toobit-bridge-journal"],
    queryFn: async () => {
      const res = await fetch("/api/toobit-bridge/journal", { cache: "no-store" });
      return (await res.json()) as JournalData;
    },
    refetchInterval: 8000,
    retry: 1,
  });

  const mode = data?.mode ?? "PAPER";
  const live = mode === "LIVE";
  const m = data?.metrics;
  const d = data?.doctrine;
  const open = data?.openIntents ?? [];
  const recent = (data?.recent ?? []).slice(0, 6);
  const margin = data?.cfg?.marginUsdt ?? d?.gates.marginUsdt ?? 5;
  // lev band actually seen on cards (open + recent) — notional = margin × that card's lev
  const levs = [...open, ...recent].map((i) => i.leverage ?? 0).filter((v) => v >= 1);
  const levMin = levs.length ? Math.min(...levs) : null;
  const levMax = levs.length ? Math.max(...levs) : null;
  const driftSkips = (d?.skipBy?.["ENTRY-DRIFT"] ?? 0) + (d?.skipBy?.["ENTRY-DELAY"] ?? 0);
  const staleSkips = d?.skipBy?.["STALE-CARD"] ?? 0; // v1.5.1 — downtime births
  const keysOk = data?.keysInstalled !== false;
  const lp = data?.livePnl;
  const netUsdt = lp ? lp.realizedClosedUsdt + lp.openUnrealizedUsdt : null;
  // v1.5.0 — fixed-$3 paper account (بالانس ثابت) + journal
  const pa = data?.paper ?? jn?.account ?? null;
  const curve = (jn?.equityCurve ?? []).slice(-120);
  const evTotal = jn?.counters?.totalSinceBoot ?? 0;
  const topKinds = Object.entries(jn?.counters?.byKind ?? {}).slice(0, 5);
  const jEvents = (jn?.recent ?? []).slice(0, 10);

  return (
    <BentoCard className="p-4" tone={live ? "magenta" : "neon"} ariaLabel="Toobit execution bridge">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isError || data?.ok === false ? <LiveDot tone="danger" /> : <LiveDot tone={live ? "violet" : "neon"} />}
          <h3 className="text-sm font-semibold tracking-wide truncate">TOOBIT EXEC BRIDGE</h3>
          <NeonBadge tone={live ? "magenta" : "neon"} glow={live}>{mode}</NeonBadge>
          {data?.cfg?.execEnabled ? null : <NeonBadge tone="amber">PAUSED</NeonBadge>}
          {!keysOk && (
            <NeonBadge
              tone="amber"
              glow={false}
              title="کلیدهای API صرافی یافت نشد (فایل .env پس از recycle سندباکس پاک شده) — اجرای LIVE و راستی‌آزمایی حساب غیرفعال است؛ فقط PAPER کار می‌کند. بازگردانی کلید → پوشهٔ سرویس، فایل .env"
            >
              بی‌کلید
            </NeonBadge>
          )}
        </div>
        <Radio className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
      </div>

      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
        آینهٔ اجرای کارت سیگنال روی پرپچوال USDT-M تووبیت · مارجین ثابت {margin}$ · اهرم = اهرم کارت · نوتوینال واقعی = مارجین × اهرم × ضریب قرارداد صرافی (v1.4.3) · سیو سود TP1/TP2 · راستی‌آزمایی ۱۵s + پویش دکترین ۳۰s
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded-md border border-border/60 bg-background/40 px-2 py-1.5 flex items-center gap-1.5">
          <BadgeDollarSign className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Balance</span>
          <span className={cn("ml-auto font-mono", (data?.balanceUsdt ?? 0) > 0 ? "text-neon" : "text-muted-foreground")}>
            {data?.balanceUsdt === null || data?.balanceUsdt === undefined ? "—" : `${data?.balanceUsdt} USDT`}
          </span>
        </div>
        {/* v1.3.0: sizing reads marginUsdt × card leverage — the legacy
            notionalUsdt(15)×leverage(5) display here was the wrong-number bug */}
        <div className="rounded-md border border-border/60 bg-background/40 px-2 py-1.5 flex items-center gap-1.5">
          <Gauge className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground shrink-0">Sizing</span>
          <span className="ml-auto font-mono" title={`notional = ${margin}$ × اهرم همان کارت`}>
            {margin}$ مارجین · {levMin && levMax ? (levMin === levMax ? `×${levMin}` : `×${levMin}–×${levMax}`) : "×کارت"}
          </span>
        </div>
        <div className="rounded-md border border-border/60 bg-background/40 px-2 py-1.5 flex items-center gap-1.5">
          <Timer className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Entry p50/p95</span>
          <span className="ml-auto font-mono">{ms(m?.totalMsP50)} / {ms(m?.totalMsP95)}</span>
        </div>
        <div className="rounded-md border border-border/60 bg-background/40 px-2 py-1.5 flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Slip p50</span>
          <span className="ml-auto font-mono">{m?.slipBpsP50 === null || m?.slipBpsP50 === undefined ? "—" : `${m?.slipBpsP50.toFixed(1)}bps`}</span>
        </div>
      </div>

      {/* v1.3.0 doctrine strip — gates + violations (پیگیری و دکترین) */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded border border-border/60 bg-background/40 px-1.5 py-0.5 font-mono" title="فیلتر اختلاف قیمتی بالا">
          drift≤{d?.gates.maxEntryDriftBps ?? "—"}bps
        </span>
        <span className="rounded border border-border/60 bg-background/40 px-1.5 py-0.5 font-mono" title="فیلتر فاصله زمانی با تأخیر">
          age≤{d?.gates.maxEntryAgeMs ? Math.round(d.gates.maxEntryAgeMs / 1000) : "—"}s
        </span>
        {driftSkips > 0 && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-amber-500" title="ورودهای ردشده توسط گیت‌های drift/delay">
            {driftSkips} گیت-رد
          </span>
        )}
        {staleSkips > 0 && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-amber-500" title="کارت‌هایی که هنگام downtime پل متولد شدند و پنجرهٔ ورودشان (۹۰s) هنگام بازگشت پل گذشته بود — doctrine: تعقیب دیرهنگام ممنوع؛ در ژورنال با SKIP:STALE-CARD ثبت شده‌اند">
            {staleSkips} downtime
          </span>
        )}
        {(d?.violationsN ?? 0) > 0 ? (
          <span className="rounded border border-danger-neon/40 bg-danger-neon/10 px-1.5 py-0.5 font-mono text-danger-neon" title={d?.lastViolation ? `${d.lastViolation.kind}: ${d.lastViolation.detail}` : undefined}>
            {d?.violationsN} تخلف دکترین
          </span>
        ) : (
          <span className="rounded border border-border/60 bg-background/40 px-1.5 py-0.5 font-mono text-muted-foreground">
            دکترین ✓ {d?.opens ?? 0} ورود پاک
          </span>
        )}
        {/* v1.4.3 — LIVE money truth (exchange-verified): realized of closed + mark PnL of open */}
        {live && lp && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono",
              netUsdt !== null && netUsdt >= 0 ? "border border-neon/40 bg-neon/10 text-neon" : "border border-danger-neon/40 bg-danger-neon/10 text-danger-neon",
            )}
            title={`حقایق مالی صرافی: بسته‌شده ${lp.closedN} intent → realized ${lp.realizedClosedUsdt}$ · باز ${lp.openN} → سود/زیان لحظه‌ای ${lp.openUnrealizedUsdt}$`}
          >
            PnL {netUsdt !== null && netUsdt >= 0 ? "+" : ""}{netUsdt?.toFixed(2)}$
          </span>
        )}
      </div>

      {/* v1.5.0 — fixed-$3 account strip + equity curve (ژورنال مالی و نمودار) */}
      {pa && (
        <div className="mt-2 rounded-md border border-border/60 bg-background/40 px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className="flex items-center gap-1 font-mono" title="بالانس ثابت حساب (لنگر $3) — موجودی واقعی صرافی جداگانه نمایش داده می‌شود">
              <BadgeDollarSign className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              BALANCE {pa.anchorUsdt.toFixed(0)}$
            </span>
            <span className="font-mono text-muted-foreground" title="ابره = لنگر + Σ سود/زیان محقق‌شدهٔ paper (قیمت‌گذاری روی کتاب واقعی)">equity <span className="text-neon">{pa.equityUsdt.toFixed(4)}$</span></span>
            <span className={cn("font-mono", pa.realizedUsdt >= 0 ? "text-neon" : "text-danger-neon")} title="PnL محقق‌شدهٔ paper">PnL {pa.realizedUsdt >= 0 ? "+" : ""}{pa.realizedUsdt.toFixed(4)}$</span>
            <span className="font-mono text-muted-foreground" title="برد/باخت intents بسته‌شده">{pa.wins}W/{pa.losses}L{pa.winRate !== null ? ` · ${pa.winRate}%` : ""}</span>
            <span className="ml-auto font-mono text-muted-foreground">{evTotal} رویداد ژورنال</span>
          </div>
          {curve.length >= 2 && (
            <div className="mt-1 h-16" aria-hidden>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={curve} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgb(0 255 170)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="rgb(0 255 170)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <YAxis domain={["dataMin - 0.001", "dataMax + 0.001"]} hide />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 10, borderRadius: 6 }}
                    labelFormatter={() => ""}
                    formatter={(v: number | string, n: string) => [typeof v === "number" ? v.toFixed(4) : v, n === "eq" ? "equity $" : n]}
                  />
                  <Area type="monotone" dataKey="eq" stroke="rgb(0 255 170)" strokeWidth={1.5} fill="url(#eqFill)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* v1.5.0 — journal feed: آخرین رویدادها + شمارندهٔ انواع */}
      <div className="mt-2">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="flex items-center gap-1.5"><LineChart className="h-3 w-3" aria-hidden /> Event journal</span>
          <span className="flex gap-1.5 font-mono normal-case">
            {topKinds.map(([k, v]) => (
              <span key={k} className="rounded border border-border/60 bg-background/40 px-1 py-px" title={`${k}: ${v}`}>{k.toLowerCase().replace("exec-", "")} {v}</span>
            ))}
          </span>
        </div>
        <div className="mt-1 max-h-24 overflow-y-auto space-y-0.5 pr-1">
          {jEvents.length === 0 ? (
            <div className="text-[11px] text-muted-foreground py-1">journal empty — waiting for events</div>
          ) : (
            jEvents.map((e, i) => (
              <div key={`${e.at}-${i}`} className="flex items-center gap-2 text-[10px] rounded border border-border/30 bg-background/20 px-1.5 py-0.5">
                <span className="font-mono text-muted-foreground shrink-0">{ago(e.at)}</span>
                <span className="font-mono truncate max-w-36 text-neon">{e.ev}</span>
                <span className="truncate text-muted-foreground" title={e.note}>{e.note ?? ""}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* open positions — v13.2.2: ACTIVE-DB mirror invariant inline (operator Q trace 1a170800e221df4d) */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span>Open intents</span>
            {typeof data?.activeCount === "number" && (
              <span
                className={cn(
                  "rounded px-1 py-px font-mono normal-case",
                  open.length === data.activeCount
                    ? "border border-neon/40 bg-neon/10 text-neon"
                    : "border border-amber-500/40 bg-amber-500/10 text-amber-500",
                )}
                title={open.length === data.activeCount
                  ? "هر کارت ACTIVE یک intent دارد — ناورستی آینه برقرار است (اختلاف موقتی فقط با گیت‌های دکترین)"
                  : `اختلاف موقتی: ${Math.max(0, data.activeCount - open.length)} کارت در گیت دکترین (MAX-CONCURRENT/drift/delay) یا پنجرهٔ ورود`}
              >
                ACTIVE {data.activeCount}{open.length === data.activeCount ? " ✓" : " ⚠"}
              </span>
            )}
          </span>
          <span title={data?.cfg?.maxConcurrent ? `سقف هم‌زمانی: ${data.cfg.maxConcurrent} intent باز` : "بدون سقف هم‌زمانی — هر کارت ACTIVE فوراً intent می‌گیرد (v1.4.1)"}>{open.length}/{data?.cfg?.maxConcurrent ? data.cfg.maxConcurrent : "∞"}</span>
        </div>
        <div className="mt-1 max-h-24 overflow-y-auto space-y-1 pr-1">
          {open.length === 0 ? (
            <div className="text-[11px] text-muted-foreground py-1">no open intent — waiting for the next live card</div>
          ) : (
            open.map((it) => (
              <div key={it.cardId} className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-[11px]">
                <span className={cn("font-mono", it.direction === "LONG" ? "text-neon" : "text-violet-neon")}>{it.direction}</span>
                <span className="font-medium truncate">{it.symbol}</span>
                <span className="text-muted-foreground">#{it.serial}</span>
                <span className="font-mono text-muted-foreground" title={`اهرم = اهرم کارت سیگنال (${it.levSrc ?? "card"})`}>×{it.leverage ?? "—"}</span>
                <span className="ml-auto font-mono" title={`نوتوینال ورود ${it.expectedNotional ? it.expectedNotional.toFixed(2) : "—"}$ (مارجین ثابت ${margin}$ × ${it.leverage ?? "?"}) · باقی‌مانده پس از سیو سود (×ضریب قرارداد ${it.contractMult ?? 1})`}>
                  ${it.expectedNotional ? it.expectedNotional.toFixed(0) : "—"}
                  {it.qtyRemaining !== it.qtyOrig && it.qtyOrig > 0 ? <span className="text-muted-foreground"> → {((it.qtyRemaining * (it.fillPrice ?? it.cardEntry) * (it.contractMult ?? 1)) || 0).toFixed(0)}</span> : null}
                </span>
                <span className="font-mono text-muted-foreground">{ms(it.lat.totalMs)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* recent lifecycle trail */}
      <div className="mt-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Card lifecycle trail</div>
        <div className="mt-1 max-h-28 overflow-y-auto space-y-1 pr-1">
          {recent.length === 0 ? (
            <div className="text-[11px] text-muted-foreground py-1">no card seen yet</div>
          ) : (
            recent.map((it) => {
              const lastEv = it.events?.[it.events.length - 1];
              return (
                <div key={it.cardId} className="flex items-center gap-2 text-[11px] rounded-md border border-border/40 bg-background/30 px-2 py-1">
                  <span className="font-mono text-muted-foreground">#{it.serial}</span>
                  <span className="truncate max-w-24">{it.symbol}</span>
                  <span className={cn(STATUS_CLS[it.status] ?? "text-muted-foreground")}>{it.status}</span>
                  <span className="ml-auto truncate max-w-40 text-muted-foreground" title={lastEv?.note}>
                    {lastEv?.ev ?? "—"}{lastEv?.note ? ` · ${lastEv.note}` : ""}
                  </span>
                  <span className="font-mono text-muted-foreground shrink-0">{ago(it.closedAt ?? it.openedAt ?? it.events?.[0]?.at ?? null)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="mt-2 flex items-start gap-1.5 text-[10px] text-muted-foreground">
        <ShieldAlert className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
        <span>
          کنترل‌های مالی KEY-ONLY است (دکترین kill-switch): toggle/approve-live/close با هدر <code className="font-mono">x-nexus-key</code> به <code className="font-mono">/api/toobit-bridge</code> · {data?.instruments ?? "—"} ابزار · {m?.n ?? 0} نمونهٔ تأخیر
        </span>
      </div>
      {live && (
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-danger-neon">
          <CircleStop className="h-3 w-3" aria-hidden />
          <span>LIVE — سفارش‌های واقعی روی حساب تووبیت اجرا می‌شود</span>
        </div>
      )}
    </BentoCard>
  );
}
