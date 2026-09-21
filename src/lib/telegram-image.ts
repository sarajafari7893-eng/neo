// ── FlowRadar Neo v6.3 telegram banner renderer (server-only) ──
// Dependency-free PNG generator for signal status banners (WIN / STOP /
// EXPIRED / NEW / SHORT / TTL_EXT / FULL). Draws a dark cyber-terminal card
// with a status headline, symbol line and two detail lines using an embedded
// 5×7 bitmap font, then encodes a real PNG via node:zlib — no canvas, no
// image library, nothing invented: every byte is rendered from the numbers
// the engine measured.
// (Operator round: «استفاده از تصویرهای ضمینه شده برای سیگنالهای win ، stop ، EXPIRED»
//  + lost-window batch 2026-09-05 21:09: NEW / TTL / FULL / Short banners)

import zlib from "node:zlib";
import { BRAND_TERMINAL } from "./brand";

// classic 5×7 bitmap font (HD44780-style), one byte per row, bit4 = leftmost px
const FONT: Record<string, number[]> = {
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  " ": [0, 0, 0, 0, 0, 0, 0],
  "+": [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  "%": [0x19, 0x1a, 0x02, 0x04, 0x08, 0x0b, 0x13],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ":": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  "/": [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
};

type RGB = [number, number, number];

const BG: RGB = [10, 13, 20]; // #0a0d14 — terminal ink
const INK: RGB = [232, 240, 236]; // near-white
const MUTED: RGB = [110, 128, 120]; // dim sage
const WIN: RGB = [0, 255, 163]; // neon mint
const STOP: RGB = [255, 77, 94]; // danger
const EXPIRED: RGB = [255, 179, 71]; // amber
const VIOLET: RGB = [178, 107, 255];

export type BannerStatus = "WIN" | "STOP" | "EXPIRED" | "NEW" | "SHORT" | "TTL_EXT" | "FULL" | "AFTERLIFE";

const AFTERLIFE: RGB = [219, 96, 255]; // spectral magenta — EXPIRED FOLLOW-UP verdicts

const STATUS_TEXT: Record<BannerStatus, string> = {
  WIN: "WIN", STOP: "STOPPED", EXPIRED: "EXPIRED",
  NEW: "NEW SIGNAL", SHORT: "SHORT SIGNAL", TTL_EXT: "TTL EXTENDED", FULL: "FULL TARGET",
  AFTERLIFE: "AFTERLIFE",
};
const STATUS_COLOR: Record<BannerStatus, RGB> = {
  WIN: WIN, STOP: STOP, EXPIRED: EXPIRED,
  NEW: WIN, SHORT: STOP, TTL_EXT: VIOLET, FULL: WIN,
  AFTERLIFE: AFTERLIFE,
};

function asciiUpper(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 +\-%.:()/]/g, "");
}

interface Canvas {
  w: number;
  h: number;
  px: Uint8Array; // RGB
}

function makeCanvas(w: number, h: number): Canvas {
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    px[i * 3] = BG[0];
    px[i * 3 + 1] = BG[1];
    px[i * 3 + 2] = BG[2];
  }
  return { w, h, px };
}

function setPx(c: Canvas, x: number, y: number, [r, g, b]: RGB): void {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 3;
  c.px[i] = r;
  c.px[i + 1] = g;
  c.px[i + 2] = b;
}

function fillRect(c: Canvas, x: number, y: number, w: number, h: number, col: RGB): void {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) setPx(c, x + dx, y + dy, col);
}

function textWidth(text: string, scale: number): number {
  return asciiUpper(text).length * 6 * scale - scale; // 5px glyph + 1px gap
}

function drawText(c: Canvas, text: string, x: number, y: number, scale: number, col: RGB): void {
  const chars = asciiUpper(text);
  let cx = x;
  for (const ch of chars) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        const bits = glyph[row]!;
        for (let gx = 0; gx < 5; gx++) {
          if (bits & (1 << (4 - gx))) fillRect(c, cx + gx * scale, y + row * scale, scale, scale, col);
        }
      }
    }
    cx += 6 * scale;
  }
}

function drawTextCentered(c: Canvas, text: string, y: number, scale: number, col: RGB): void {
  const w = textWidth(text, scale);
  drawText(c, text, Math.max(4, Math.floor((c.w - w) / 2)), y, scale, col);
}

// ── PNG encoder (color type 2 — truecolor RGB, 8-bit, filter 0) ──
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(c: Canvas): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  // raw scanlines with leading filter byte 0
  const raw = Buffer.alloc(c.h * (c.w * 3 + 1));
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 3 + 1)] = 0;
    Buffer.from(c.px.buffer, c.px.byteOffset + y * c.w * 3, c.w * 3).copy(raw, y * (c.w * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface BannerSpec {
  status: BannerStatus;
  /** e.g. "BTCUSDT LONG" */
  title: string;
  /** e.g. "NX-0127 · +25.6% NET" */
  line1?: string;
  /** e.g. "TP 2/3 BANKED · RR 1:2.8" */
  line2?: string;
  /** footer strip, defaults to FLOWRADAR//NEO */
  footer?: string;
}

/** Render the status banner → PNG buffer (640×360). Pure, synchronous, honest. */
export function renderStatusBanner(spec: BannerSpec): Buffer {
  const W = 640;
  const H = 360;
  const c = makeCanvas(W, H);
  const accent = STATUS_COLOR[spec.status];

  // top + bottom accent bars
  fillRect(c, 0, 0, W, 8, accent);
  fillRect(c, 0, H - 8, W, 8, accent);
  // thin rules under the headline zone
  fillRect(c, 32, 232, W - 64, 2, [36, 46, 42]);
  fillRect(c, 32, 300, W - 64, 2, [36, 46, 42]);
  // HUD corner ticks
  for (const [x, y] of [[16, 20], [W - 22, 20], [16, H - 28], [W - 22, H - 28]] as Array<[number, number]>) {
    fillRect(c, x, y, 6, 2, MUTED);
    fillRect(c, x < W / 2 ? x : x + 4, y, 2, 6, MUTED);
  }

  drawTextCentered(c, `${BRAND_TERMINAL.head}${BRAND_TERMINAL.sep}${BRAND_TERMINAL.tail}`, 26, 2, MUTED);
  drawTextCentered(c, STATUS_TEXT[spec.status], 74, 9, accent);
  drawTextCentered(c, asciiUpper(spec.title), 180, 4, INK);
  if (spec.line1) drawTextCentered(c, spec.line1, 246, 3, accent);
  if (spec.line2) drawTextCentered(c, spec.line2, 276, 3, INK);
  drawTextCentered(c, asciiUpper(spec.footer ?? "FLOWRADAR-NEO LIVE ENGINE"), 320, 2, VIOLET);
  return encodePng(c);
}
