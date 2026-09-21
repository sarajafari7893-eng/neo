"use client";

import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { useNeon } from "@/components/analytics/chart-theme";

/* ── Bento card ─────────────────────────────────────────── */
export function BentoCard({
  children,
  className,
  tone = "neon",
  corners = false,
  delay = 0,
  onClick,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  tone?: "neon" | "violet" | "magenta";
  corners?: boolean;
  delay?: number;
  /** makes the whole card a keyboard-reachable button (Enter/Space activate) */
  onClick?: () => void;
  ariaLabel?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 22 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] }}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={ariaLabel}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={cn(
        "bento p-4 sm:p-5",
        onClick &&
          "cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--neon-rgb)/0.55)] focus-visible:ring-offset-0",
        tone === "violet" && "bento-violet",
        tone === "magenta" && "bento-magenta",
        corners && "hud-corners",
        className
      )}
    >
      {children}
    </motion.div>
  );
}

/* ── Neon badge ─────────────────────────────────────────── */
const badgeTones = {
  neon: "border-[rgb(var(--neon-rgb)/0.35)] text-neon bg-[rgb(var(--neon-rgb)/0.08)]",
  violet: "border-[rgba(178,107,255,0.4)] text-violet-neon bg-[rgba(178,107,255,0.08)]",
  magenta: "border-[rgba(255,78,205,0.4)] text-magenta-neon bg-[rgba(255,78,205,0.08)]",
  amber: "border-[rgba(255,179,71,0.4)] text-amber-neon bg-[rgba(255,179,71,0.08)]",
  danger: "border-[rgba(255,77,94,0.4)] text-danger-neon bg-[rgba(255,77,94,0.08)]",
  cyan: "border-[rgba(69,240,223,0.4)] text-cyan-neon bg-[rgba(69,240,223,0.08)]",
  muted: "border-[rgba(159,180,171,0.25)] text-ink-2 bg-[rgba(159,180,171,0.06)]",
} as const;

export function NeonBadge({
  children,
  tone = "neon",
  className,
  glow = false,
}: {
  children: ReactNode;
  tone?: keyof typeof badgeTones;
  className?: string;
  glow?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-terminal text-[10px] font-semibold uppercase tracking-[0.14em] whitespace-nowrap",
        badgeTones[tone],
        glow && "shadow-[0_0_14px_-2px_currentColor]",
        className
      )}
    >
      {children}
    </span>
  );
}

/* ── Live dot ───────────────────────────────────────────── */
export function LiveDot({ tone = "neon", className }: { tone?: "neon" | "danger" | "amber" | "violet"; className?: string }) {
  const c = { neon: "bg-neon", danger: "bg-danger-neon", amber: "bg-amber-neon", violet: "bg-violet-neon" }[tone];
  return <span className={cn("inline-block h-2 w-2 rounded-full anim-pulse-dot", c, className)} />;
}

/* ── Section header ─────────────────────────────────────── */
export function SectionHeader({
  index,
  title,
  subtitle,
  right,
}: {
  index: string;
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="relative">
        <div className="flex items-center gap-2">
          <span className="font-terminal text-[11px] font-bold text-neon/70">[{index}]</span>
          <h2 className="font-terminal text-lg font-bold uppercase tracking-[0.14em] text-foreground sm:text-xl">
            {title}
          </h2>
        </div>
        {/* animated scan beam underline */}
        <div className="mt-1.5 h-px w-40 overflow-hidden bg-white/8 sm:w-56" aria-hidden>
          <div
            className="h-full w-1/2 bg-gradient-to-r from-transparent via-neon to-transparent"
            style={{ animation: "beam-slide 3.2s ease-in-out infinite" }}
          />
        </div>
        {subtitle && <p className="mt-1.5 text-xs text-ink-2 sm:text-[13px]">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

/* ── Sparkline (pure SVG, no deps) ──────────────────────── */
export function Sparkline({
  data,
  width = 120,
  height = 36,
  tone = "neon",
  fill = true,
  strokeWidth = 1.5,
  className,
}: {
  data: number[];
  width?: number;
  height?: number;
  tone?: "neon" | "danger" | "violet" | "cyan";
  fill?: boolean;
  strokeWidth?: number;
  className?: string;
}) {
  const accentHex = useNeon(); // "neon" tone follows the operator accent
  if (!data || data.length < 2) return <svg width={width} height={height} className={className} />;
  const colors = {
    neon: accentHex,
    danger: "#ff4d5e",
    violet: "#b26bff",
    cyan: "#45f0df",
  };
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pts = data.map((v, i) => [i * stepX, height - 3 - ((v - min) / range) * (height - 6)] as const);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const color = colors[tone];
  const id = `spark-${tone}-${data.length}-${Math.round(min * 100)}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      {fill && (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${id})`} />
        </>
      )}
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2" fill={color}>
        <animate attributeName="opacity" values="1;0.3;1" dur="1.6s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

/* ── Confidence bar ─────────────────────────────────────── */
export function ConfidenceBar({ value, className }: { value: number; className?: string }) {
  const tone = value >= 85 ? "bg-neon" : value >= 70 ? "bg-cyan-neon" : value >= 55 ? "bg-amber-neon" : "bg-danger-neon";
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
        <motion.div
          className={cn("h-full rounded-full", tone)}
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          style={{ boxShadow: "0 0 8px currentColor" }}
        />
      </div>
      <span className="font-terminal text-[11px] font-bold text-ink-2">{value}%</span>
    </div>
  );
}

/* ── Stat chip ──────────────────────────────────────────── */
export function StatChip({
  label,
  value,
  tone = "neon",
  className,
}: {
  label: string;
  value: ReactNode;
  tone?: keyof typeof badgeTones;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border bg-white/[0.02] px-3 py-2", badgeTones[tone].split(" ")[0], className)}>
      <div className="label-tech">{label}</div>
      <div className={cn("mt-0.5 font-terminal text-sm font-bold", badgeTones[tone].split(" ")[1])}>{value}</div>
    </div>
  );
}

/* ── Countdown ring (TTL timer) ─────────────────────────── */
export function CountdownRing({
  progress,
  label,
  sub,
  size = 64,
  tone,
  urgent = false,
  ariaLabel,
}: {
  progress: number; // 0..1 remaining
  label: string;
  sub?: string;
  size?: number;
  tone?: "neon" | "amber" | "danger" | "cyan" | "muted";
  urgent?: boolean;
  /** overrides the default "Time remaining …" (use for resolved/terminal rings) */
  ariaLabel?: string;
}) {
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const accentHex = useNeon(); // neon tone follows the operator accent
  const t = tone ?? (progress > 0.5 ? "neon" : progress > 0.2 ? "amber" : "danger");
  const color = { neon: accentHex, amber: "#ffb347", danger: "#ff4d5e", cyan: "#45f0df", muted: "#9fb4ab" }[t];
  return (
    <div
      className={cn("relative inline-flex items-center justify-center", urgent && "anim-pulse-glow")}
      style={{ width: size, height: size }}
      role="timer"
      aria-label={ariaLabel ?? `Time remaining ${label}`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.07)" strokeWidth="3.5" fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth="3.5"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - Math.max(0, Math.min(1, progress)))}
          style={{ transition: "stroke-dashoffset 0.9s linear", filter: `drop-shadow(0 0 5px ${color})` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-terminal font-bold tabular-nums leading-none" style={{ color, fontSize: size * 0.24 }}>
          {label}
        </span>
        {sub && <span className="label-tech mt-0.5" style={{ fontSize: size * 0.13 }}>{sub}</span>}
      </div>
    </div>
  );
}
