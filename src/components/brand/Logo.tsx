"use client";

import { motion } from "framer-motion";
import { useNeon } from "@/components/analytics/chart-theme";
import { APP_NAME, APP_STAGE, APP_VERSION_LABEL, BRAND_TERMINAL } from "@/lib/brand";

/**
 * FlowRadar Neo animated logo — hexagon frame + radar sweep + bolt core.
 * Accent-following: gradient start + bolt use the operator accent hex.
 */
export function LogoMark({ size = 40 }: { size?: number }) {
  const neon = useNeon();
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className="anim-pulse-glow"
      initial={{ rotate: -8, opacity: 0 }}
      animate={{ rotate: 0, opacity: 1 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      role="img"
      aria-label="FlowRadar Neo logo"
    >
      <defs>
        <linearGradient id="lg-neon" x1="0" y1="0" x2="48" y2="48">
          <stop offset="0%" stopColor={neon} />
          <stop offset="100%" stopColor="#b26bff" />
        </linearGradient>
      </defs>
      {/* hexagon frame */}
      <path
        d="M24 3 42 13.5v21L24 45 6 34.5v-21L24 3Z"
        stroke="url(#lg-neon)"
        strokeWidth="2"
        fill="rgb(var(--neon-rgb)/0.05)"
      />
      {/* rotating dashed ring */}
      <g className="origin-center" style={{ animation: "radar-sweep 10s linear infinite", transformOrigin: "24px 24px" }}>
        <circle cx="24" cy="24" r="15.5" stroke="rgb(var(--neon-rgb)/0.35)" strokeWidth="1" strokeDasharray="4 6" fill="none" />
      </g>
      {/* N bolt */}
      <path
        d="M16 33V15l16 18V15"
        stroke={neon}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* radar dot */}
      <circle cx="24" cy="24" r="2.2" fill="#ff4ecd">
        <animate attributeName="opacity" values="1;0.35;1" dur="2s" repeatCount="indefinite" />
      </circle>
    </motion.svg>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3 select-none">
      <LogoMark size={compact ? 32 : 40} />
      {!compact && (
        <div className="leading-none">
          <div className="font-terminal font-bold text-lg tracking-[0.18em] text-foreground">
            {BRAND_TERMINAL.head}<span className="text-neon">{BRAND_TERMINAL.sep}</span>{BRAND_TERMINAL.tail}
          </div>
          <div className="label-tech mt-1">{APP_NAME} {APP_VERSION_LABEL} — {APP_STAGE}</div>
        </div>
      )}
    </div>
  );
}
