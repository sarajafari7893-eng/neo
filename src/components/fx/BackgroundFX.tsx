"use client";

import { useMemo } from "react";

/**
 * BackgroundFX — layered animated background:
 * grid + drifting neon orbs + floating particles + scan sweep + horizon glow.
 * Pure CSS animations; particles generated deterministically to avoid hydration mismatch.
 */
export function BackgroundFX() {
  const particles = useMemo(() => {
    const arr: Array<{ x: number; y: number; s: number; d: number; delay: number; c: string }> = [];
    const colors = ["#00ffa3", "#b26bff", "#ff4ecd", "#45f0df", "#ffb347"];
    // deterministic pseudo-random (stable across SSR/CSR)
    let seed = 42;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let i = 0; i < 26; i++) {
      arr.push({
        x: rnd() * 100,
        y: rnd() * 100,
        s: 1 + rnd() * 2.2,
        d: 5 + rnd() * 9,
        delay: rnd() * 8,
        c: colors[Math.floor(rnd() * colors.length)],
      });
    }
    return arr;
  }, []);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {/* base gradient */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_50%_-10%,rgb(var(--neon-rgb)/0.07),transparent_55%),radial-gradient(ellipse_80%_60%_at_100%_100%,rgba(178,107,255,0.06),transparent_60%)]" />

      {/* animated grid */}
      <div className="absolute inset-0 grid-bg opacity-60 [mask-image:radial-gradient(ellipse_75%_65%_at_50%_40%,black,transparent)]" />

      {/* drifting orbs */}
      <div className="absolute -top-32 -left-32 h-[34rem] w-[34rem] rounded-full bg-[radial-gradient(circle,rgb(var(--neon-rgb)/0.13),transparent_65%)] blur-3xl anim-drift" />
      <div
        className="absolute top-1/3 -right-40 h-[38rem] w-[38rem] rounded-full bg-[radial-gradient(circle,rgba(178,107,255,0.11),transparent_65%)] blur-3xl anim-drift"
        style={{ animationDelay: "-6s" }}
      />
      <div
        className="absolute bottom-0 left-1/4 h-[30rem] w-[30rem] rounded-full bg-[radial-gradient(circle,rgba(255,78,205,0.08),transparent_65%)] blur-3xl anim-drift"
        style={{ animationDelay: "-12s" }}
      />

      {/* particles */}
      {particles.map((p, i) => (
        <span
          key={i}
          className="absolute rounded-full anim-float"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.s,
            height: p.s,
            background: p.c,
            opacity: 0.35,
            boxShadow: `0 0 ${p.s * 4}px ${p.c}`,
            animationDuration: `${p.d}s`,
            animationDelay: `-${p.delay}s`,
          }}
        />
      ))}

      {/* horizontal scan sweep */}
      <div
        className="absolute left-0 h-px w-full bg-gradient-to-r from-transparent via-[rgb(var(--neon-rgb)/0.5)] to-transparent"
        style={{ animation: "scanline-sweep 9s linear infinite" }}
      />

      {/* bottom fade into content */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[#05070a] to-transparent" />
    </div>
  );
}
