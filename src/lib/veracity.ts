// ── FlowRadar//VERACITY — grounding-audit primitives (pure, zero deps, server-safe) ──
// v6.0 operator mandate (Persian): «هیچ توهم و شبیه سازی انجام نشه» — ZERO
// hallucination, ZERO simulation. This module is the supervisor's instrument:
// given the GROUNDED telemetry bundle an LLM saw and the text it produced, it
// finds every number the model cited that does NOT exist in the measured data
// (hallucination fingerprints) plus simulation/placeholder language markers.

export interface GroundingAudit {
  cited: number; // numbers extracted from the response text
  unmatched: number[]; // cited numbers ABSENT from the bundle — hallucination fingerprints (max 8 kept)
  markers: string[]; // simulation/placeholder fingerprints found in the response
  verdict: "CLEAN" | "SUSPECT" | "VIOLATION";
}

const NUM_RE = /-?\d+(?:[.,]\d+)?/g;
const MOCK_RE =
  /\b(as an ai language model|mock(?:ed| data)?|placeholder|dummy(?: data)?|simulated data|fabricat(?:ed|e)|made up|invented (?:numbers?|data|figures)|lorem ipsum|example\.com|fake (?:data|numbers?)|hard-?coded (?:value|number)|sample data|for (?:testing|demonstration) purposes)\b/gi;

/** Tokens stripped BEFORE extraction — they manufacture false positives. */
const NOISE_RES = [
  /NX-\d{4}/g, // signal serials (e.g. NX-0033 → would look like "33")
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g, // timestamps 12:34 and ratios like 1:2.6 left-side
  /\bL\d(?:\.5)?\b/gi, // trigger layers L1 / L3.5
  /\bv\d(?:\.\d)?\b/gi, // engine versions v5.4
];

function normalize(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/** Numbers the auditor must NEVER flag: list indices, years, tiny ordinals. */
function isStructural(n: number, raw: string): boolean {
  if (/^\d{1,2}[.)]$/.test(raw)) return true; // "1." / "2)" list markers
  if (n >= 2019 && n <= 2100 && Number.isInteger(n)) return true; // years
  if (Number.isInteger(n) && Math.abs(n) <= 3) return true; // 0/1/2/3 — counts, rungs, indices
  return false;
}

function extractNumbers(text: string): number[] {
  let scrubbed = text;
  for (const re of NOISE_RES) scrubbed = scrubbed.replace(re, " ");
  const out: number[] = [];
  for (const m of scrubbed.matchAll(NUM_RE)) {
    const n = normalize(m[0]);
    if (!Number.isFinite(n) || isStructural(n, m[0])) continue;
    out.push(n);
  }
  return out;
}

function mockMarkers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(MOCK_RE)) found.add(m[0].toLowerCase());
  return [...found];
}

function bundleIndex(bundle: string): { exact: Set<string>; values: number[] } {
  const raw = extractNumbers(bundle);
  return {
    exact: new Set(raw.map((n) => String(n))),
    values: raw,
  };
}

/** Does a cited number exist in the bundle (string-equal or rounding-tolerant)? */
function matchesBundle(n: number, exact: Set<string>, values: number[]): boolean {
  if (exact.has(String(n))) return true;
  // tolerance = integer-rounding slop (±0.5) + 2% relative — a model that says
  // "34" for a measured 34.2 passes; one that invents 42.7 out of nowhere fails.
  return values.some((v) => Math.abs(v - n) <= Math.abs(v) * 0.02 + 0.51);
}

/**
 * Audit an LLM response against the grounded bundle it was built on.
 * CLEAN   — every cited number traces to measured telemetry
 * SUSPECT — 2-3 unmatched numbers, or simulation language present
 * VIOLATION — ≥4 unmatched numbers (or 3+ with simulation language)
 */
/** v8.2.1 — additive export: mock-marker scan for callers that audit citations
 * and raw-text markers over DIFFERENT strings (e.g. the shadow judge audits
 * reason numbers but must also fingerprint the raw model output). */
export function findMockMarkers(text: string): string[] {
  return mockMarkers(text);
}

export function auditGrounding(bundle: string, response: string): GroundingAudit {
  const { exact, values } = bundleIndex(bundle);
  const citedList = extractNumbers(response);
  const unmatchedSet = new Set<number>();
  for (const n of citedList) {
    if (matchesBundle(n, exact, values)) continue;
    unmatchedSet.add(n);
    if (unmatchedSet.size >= 8) break;
  }
  const markers = mockMarkers(response);
  const unmatched = [...unmatchedSet];

  let verdict: GroundingAudit["verdict"] = "CLEAN";
  if (markers.length > 0) verdict = "SUSPECT";
  if (unmatched.length >= 2 && markers.length > 0) verdict = "VIOLATION";
  if (unmatched.length >= 4) verdict = "VIOLATION";

  return { cited: citedList.length, unmatched, markers, verdict };
}
