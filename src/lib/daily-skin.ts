// ── FlowRadar Neo v9.4 DAILY SKIN — operator mandate 2026-09-13 ────────────
// «TELEGRAM ART SKIN باید ساخت و تولید تصویر را با 7-SKIN CYCLE ACROSS ALL
//  TELEGRAM REPORTS انجام دهد» — the skin cycle must drive REAL AI image
// generation, one visual style per day, across all Telegram reports.
//
// Operator's 7 styles (fixed order, one per Tehran day):
//   1. BLUEPRINT   2. MOVIE (cinematic)   3. CYBERPUNK   4. ANIME
//   5. POP ART     6. VECTOR              7. CLAY
//
// Each skin now carries:
//   key   → assets/telegram/skin-{key}.png — AI-generated backdrop in THIS
//           style (same subject scene, seven different renderings; produced by
//           scripts/gen-skin-art.sh, idempotent + rate-limit aware)
//   style → the style prompt fragment used by the generator (single source of
//           truth: the artwork and this table can never drift apart)
//   tune  → composite modulation so overlay text stays readable WITHOUT hue-
//           rotating the style identity (hueShift stays 0 — a hue-rotated
//           blueprint or pop-art piece would stop being one)
//   artKind → legacy art-{KIND}.png fallback while skin files generate
//
// Deterministic per-Tehran-day pick (same day → same skin everywhere: daily
// poster, report previews, dashboard badge; next Tehran midnight → next style
// in the operator's order). Zero randomness, zero I/O, edge-safe.

export interface DailySkin {
  /** Tehran calendar day, "YYYY-MM-DD" */
  dayKey: string;
  /** rotation key — AI backdrop file is assets/telegram/skin-{key}.png */
  key: string;
  /** human label drawn on the artwork, e.g. "BLUEPRINT" */
  name: string;
  /** halo / accent hex for procedural backdrops */
  accent: string;
  /** procedural bg gradient top stop */
  deep1: string;
  /** procedural bg gradient bottom stop */
  deep2: string;
  /** legacy art-{KIND}.png used if the style backdrop is not generated yet */
  artKind: string;
  /** 0..2 halo placement variant for procedural backdrops */
  geometry: number;
  /** style identity is never hue-rotated (v9.4) */
  hueShift: number;
  /** sharp modulate tuning — keeps overlay text readable per style */
  tune: { brightness: number; saturation: number };
  /** AI generation prompt fragment — scripts/gen-skin-art.sh reads this style */
  style: string;
  /** epoch-day index the rotation is keyed on */
  seed: number;
}

const SKINS: Array<{
  key: string; name: string; accent: string; deep1: string; deep2: string;
  art: string; tune: { brightness: number; saturation: number }; style: string;
}> = [
  {
    key: "blueprint", name: "BLUEPRINT",
    accent: "#5fd4d0", deep1: "#0a1a20", deep2: "#060f14",
    art: "DAILY", tune: { brightness: 0.62, saturation: 0.8 },
    style: "technical engineering blueprint drawing style, precise white and cyan line-work on deep dark slate paper, measurement marks, cross-sections, annotated construction lines, grid paper texture",
  },
  {
    key: "movie", name: "CINEMATIC",
    accent: "#ffb347", deep1: "#140f0a", deep2: "#0a0705",
    art: "WIN", tune: { brightness: 0.58, saturation: 0.9 },
    style: "epic cinematic film still, anamorphic lens, dramatic rim lighting, volumetric haze, shallow depth of field, movie-poster color grading, film grain",
  },
  {
    key: "cyberpunk", name: "CYBERPUNK",
    accent: "#ff5c4d", deep1: "#170a12", deep2: "#0b0509",
    art: "STOP", tune: { brightness: 0.72, saturation: 0.92 },
    style: "neon cyberpunk megacity aesthetic, glowing magenta and orange holograms, rain-slick reflections, dense futuristic detail, blade-runner atmosphere",
  },
  {
    key: "anime", name: "ANIME",
    accent: "#ff6b9a", deep1: "#160b14", deep2: "#0b060a",
    art: "NEW", tune: { brightness: 0.66, saturation: 0.95 },
    style: "japanese anime illustration style, bold cel shading, dramatic speed lines, dynamic action pose energy, vibrant saturated colors, studio-quality key visual",
  },
  {
    key: "popart", name: "POP ART",
    accent: "#ffd166", deep1: "#1a1206", deep2: "#0d0904",
    art: "FULL", tune: { brightness: 0.7, saturation: 1.0 },
    style: "retro pop-art comic style, thick bold black outlines, halftone ben-day dots, saturated flat color blocks, warhol-style screen-print energy, dramatic comic shading",
  },
  {
    key: "vector", name: "VECTOR",
    accent: "#3ddc97", deep1: "#0a1510", deep2: "#050c09",
    art: "EXPIRED", tune: { brightness: 0.64, saturation: 0.85 },
    style: "clean flat vector illustration style, geometric shapes, smooth gradient mesh, minimal premium fintech poster art, crisp edges, isometric accents",
  },
  {
    key: "clay", name: "CLAY",
    accent: "#c0e860", deep1: "#121408", deep2: "#090b05",
    art: "SHORT", tune: { brightness: 0.68, saturation: 0.82 },
    style: "cute 3D clay render style, soft matte plasticine texture, rounded chunky shapes, pastel studio lighting, blender claymation look, subtle subsurface glow",
  },
];

/** Tehran-calendar day key ("YYYY-MM-DD") for a given instant. */
export function tehranDayKey(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/** Epoch-day index for a Tehran day key (rotation counter). */
function seedFor(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return Math.floor(Date.UTC(y, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

function build(dayKey: string, seed: number, s: (typeof SKINS)[number]): DailySkin {
  return {
    dayKey,
    key: s.key,
    name: s.name,
    accent: s.accent,
    deep1: s.deep1,
    deep2: s.deep2,
    artKind: s.art,
    geometry: seed % 3,
    hueShift: 0,
    tune: s.tune,
    style: s.style,
    seed,
  };
}

/** The skin in effect right now (or for the given instant). */
export function dailySkin(d: Date = new Date()): DailySkin {
  const dayKey = tehranDayKey(d);
  const seed = seedFor(dayKey);
  const s = SKINS[((seed % SKINS.length) + SKINS.length) % SKINS.length];
  return build(dayKey, seed, s);
}

/** Deterministic skin by rotation seed — used by preview strips (7-day proof). */
export function skinBySeed(seed: number): DailySkin {
  const s = SKINS[((seed % SKINS.length) + SKINS.length) % SKINS.length];
  return build(`seed-${seed}`, seed, s);
}

export const SKIN_COUNT = SKINS.length;
export const SKIN_NAMES = SKINS.map((s) => s.name);
export const SKIN_KEYS = SKINS.map((s) => s.key);

/** v9.5 per-card-kind art files (skin-{key}-{KIND}.png) — subject matches the
 * card meaning: new LONG, SHORT, TP/WIN, STOP, EXPIRED/AFTERLIFE. */
export const SKIN_KINDS = ["LONG", "SHORT", "TP", "STOP", "EXPIRED"] as const;
