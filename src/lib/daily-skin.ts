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
    style: "ultra-premium dark technical blueprint art, glowing cyan holographic schematic line-work on deep navy slate, layered translucent drafting sheets floating in depth, precise measurement marks and cross-section annotations, soft cyan edge-glow, subtle depth-of-field bokeh between drawing layers, elegant engineering masterpiece composition",
  },
  {
    key: "movie", name: "CINEMATIC",
    accent: "#ffb347", deep1: "#140f0a", deep2: "#0a0705",
    art: "WIN", tune: { brightness: 0.58, saturation: 0.9 },
    style: "epic cinematic movie key art, anamorphic widescreen composition, dramatic volumetric god rays cutting through haze, strong rim lighting sculpting the subject, teal and amber color grade, shallow depth of field, high-contrast chiaroscuro lighting, luxury film-poster craft, subtle film grain",
  },
  {
    key: "cyberpunk", name: "CYBERPUNK",
    accent: "#ff5c4d", deep1: "#170a12", deep2: "#0b0509",
    art: "STOP", tune: { brightness: 0.72, saturation: 0.92 },
    style: "futuristic neon cyberpunk megacity key art, glowing magenta and cyan neon signage, rain-slick streets with mirror reflections, volumetric fog carrying neon glow, holographic depth layers, high-contrast night atmosphere, cinematic blade-runner mood, ultra-detailed professional digital art",
  },
  {
    key: "anime", name: "ANIME",
    accent: "#ff6b9a", deep1: "#160b14", deep2: "#0b060a",
    art: "NEW", tune: { brightness: 0.66, saturation: 0.95 },
    style: "premium japanese anime key visual, bold cel shading with crisp highlights, dynamic energy trails and speed lines, dramatic backlighting, vibrant saturated palette, studio-grade composition, sharp expressive detail, cinematic anime poster quality",
  },
  {
    key: "popart", name: "POP ART",
    accent: "#ffd166", deep1: "#1a1206", deep2: "#0d0904",
    art: "FULL", tune: { brightness: 0.7, saturation: 1.0 },
    style: "premium retro pop-art screen print, bold black ink outlines, large crisp halftone ben-day dots, punchy flat color blocks with offset print misregistration, dramatic comic-book shading, gallery-quality warhol poster composition",
  },
  {
    key: "vector", name: "VECTOR",
    accent: "#3ddc97", deep1: "#0a1510", deep2: "#050c09",
    art: "EXPIRED", tune: { brightness: 0.64, saturation: 0.85 },
    style: "premium minimal vector fintech key art, smooth gradient mesh shapes, elegant geometric composition with layered depth, crisp rounded edges, subtle isometric accents, sophisticated dark-mode palette with glowing mint accents, high-end poster design",
  },
  {
    key: "clay", name: "CLAY",
    accent: "#c0e860", deep1: "#121408", deep2: "#090b05",
    art: "SHORT", tune: { brightness: 0.68, saturation: 0.82 },
    style: "premium 3D claymation diorama, soft matte plasticine textures, rounded chunky shapes, cozy pastel studio lighting with soft shadows, subtle subsurface scattering glow, high-end 3D render quality, charming handcrafted look",
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
