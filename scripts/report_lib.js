/* NEXUS//SIGNALS — Persian RTL engineering forensic report (docx)
 * Cover: R1 recipe (RTL-mirrored) + DS-1 palette — structure per design-system.md
 * Sections: cover (no num) / TOC (Roman) / body (Arabic start 1)
 */
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, Header, Footer,
  AlignmentType, HeadingLevel, PageNumber, BorderStyle, WidthType, ShadingType,
  TableLayoutType, SectionType, NumberFormat, TableOfContents, ImageRun, VerticalAlign,
} = require("docx");
const fs = require("fs");

/* ── palette DS-1 (Deep Sea) ───────────────────────────────────────────── */
const PAL = {
  bg: "0B1C2C", primary: "FFFFFF", accent: "529286",
  cover: { titleColor: "FFFFFF", subtitleColor: "B0B8C0", metaColor: "90989F", footerColor: "687078" },
  table: { headerBg: "529286", headerText: "FFFFFF", accentLine: "529286", innerLine: "BECFCC", surface: "E8ECEB" },
};
const BODY = "182030", MUTED = "506070";
const FONT = { ascii: "Tahoma", hAnsi: "Tahoma", cs: "Tahoma" };

const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };
const allNoBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };

/* ── RTL helpers ───────────────────────────────────────────────────────── */
function rtl(text, opts = {}) {
  return new TextRun({ text, rightToLeft: true, font: FONT, color: opts.color || BODY,
    size: opts.size || 24, bold: !!opts.bold, italics: !!opts.italics });
}
function body(text, opts = {}) {
  return new Paragraph({
    bidirectional: true, alignment: AlignmentType.JUSTIFIED,
    spacing: { line: 312, after: opts.after ?? 120 },
    children: [rtl(text, opts)],
  });
}
function bullet(text, opts = {}) {
  return new Paragraph({
    bidirectional: true, alignment: AlignmentType.JUSTIFIED,
    bullet: { level: 0 }, spacing: { line: 312, after: 60 },
    children: [rtl(text, opts)],
  });
}
function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1, bidirectional: true, alignment: AlignmentType.RIGHT,
    spacing: { before: 360, after: 140, line: 312 },
    children: [rtl(text, { bold: true, size: 30, color: "0B1C2C" })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2, bidirectional: true, alignment: AlignmentType.RIGHT,
    spacing: { before: 240, after: 100, line: 312 },
    children: [rtl(text, { bold: true, size: 26, color: "204054" })],
  });
}
function caption(text) {
  return new Paragraph({
    bidirectional: true, alignment: AlignmentType.CENTER, keepNext: true,
    spacing: { before: 160, after: 80, line: 312 },
    children: [rtl(text, { size: 20, color: MUTED, bold: true })],
  });
}

/* ── RTL data table ────────────────────────────────────────────────────── */
function dataTable(headers, rows, widths, opts = {}) {
  const thin = { style: BorderStyle.SINGLE, size: 4, color: PAL.table.innerLine };
  const acc = { style: BorderStyle.SINGLE, size: 8, color: PAL.table.accentLine };
  const cellPara = (t, bold, color, align) => new Paragraph({
    bidirectional: true, alignment: align || AlignmentType.CENTER,
    spacing: { line: 276 }, children: [rtl(String(t), { size: 19, bold: !!bold, color: color || BODY })],
  });
  const mkCell = (t, i, isHeader, zebra) => new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    shading: { type: ShadingType.CLEAR, fill: isHeader ? PAL.table.headerBg : (zebra ? PAL.table.surface : "FFFFFF") },
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    width: widths ? { size: widths[i], type: WidthType.PERCENTAGE } : undefined,
    children: [cellPara(t, isHeader, isHeader ? PAL.table.headerText : BODY,
      opts.leftAlign && !isHeader && i === (opts.leftAlignCol ?? 0) ? AlignmentType.RIGHT : AlignmentType.CENTER)],
  });
  return new Table({
    visuallyRightToLeft: true,
    width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED,
    borders: { top: acc, bottom: acc, left: thin, right: thin, insideHorizontal: thin, insideVertical: thin },
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true,
        children: headers.map((hh, i) => mkCell(hh, i, true, false)) }),
      ...rows.map((r, ri) => new TableRow({ cantSplit: true,
        children: r.map((cc, i) => mkCell(cc, i, false, ri % 2 === 1)) })),
    ],
  });
}

function img(path, w, h) {
  return new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 160 },
    children: [new ImageRun({ type: "png", data: fs.readFileSync(path),
      transformation: { width: w, height: h } })],
  });
}

/* ── cover (R1 mirrored for RTL) ───────────────────────────────────────── */
function calcTitleLayout(title, maxWidthTwips, preferredPt = 40, minPt = 24) {
  const charWidth = (pt) => pt * 20;
  const charsPerLine = (pt) => Math.floor(maxWidthTwips / charWidth(pt));
  let titlePt = preferredPt, lines;
  while (titlePt >= minPt) {
    const cpl = charsPerLine(titlePt);
    if (cpl < 2) { titlePt -= 2; continue; }
    lines = splitTitleLines(title, cpl);
    if (lines.length <= 3) break;
    titlePt -= 2;
  }
  if (!lines || lines.length > 3) { lines = splitTitleLines(title, charsPerLine(minPt)); titlePt = minPt; }
  return { titlePt, titleLines: lines };
}
function splitTitleLines(title, charsPerLine) {
  if (title.length <= charsPerLine) return [title];
  const breakAfter = new Set([..."،。؛：!؟", ..."-_—–·/ \t"]);
  const lines = []; let remaining = title;
  while (remaining.length > charsPerLine) {
    let breakAt = -1;
    for (let i = charsPerLine; i >= Math.floor(charsPerLine * 0.6); i--) {
      if (i < remaining.length && breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
    }
    if (breakAt === -1) {
      const limit = Math.min(remaining.length, Math.ceil(charsPerLine * 1.3));
      for (let i = charsPerLine + 1; i < limit; i++) { if (breakAfter.has(remaining[i - 1])) { breakAt = i; break; } }
    }
    if (breakAt === -1) breakAt = charsPerLine;
    lines.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) lines.push(remaining);
  return lines;
}
function calcCoverSpacing(params) {
  const { titleLineCount = 1, titlePt = 36, hasSubtitle = false, hasEnglishLabel = false,
    metaLineCount = 0, fixedHeight = 800, pageHeight = 16838 } = params;
  const SAFETY = 1200;
  const usableHeight = pageHeight - SAFETY;
  const titleHeight = titleLineCount * (titlePt * 23 + 200);
  const subtitleHeight = hasSubtitle ? (12 * 23 + 600) : 0;
  const englishLabelHeight = hasEnglishLabel ? (9 * 23 + 600) : 0;
  const metaHeight = metaLineCount * (10 * 23 + 100);
  const implicitParaHeight = 3 * 300;
  const contentHeight = titleHeight + subtitleHeight + englishLabelHeight + metaHeight + fixedHeight + implicitParaHeight;
  const safeRemaining = Math.max(usableHeight - contentHeight, 400);
  const FOOTER_MIN = 800;
  const rawTop = Math.floor(safeRemaining * 0.45), rawBottom = Math.floor(safeRemaining * 0.45);
  const bottomSpacing = Math.max(rawBottom, FOOTER_MIN);
  const topSpacing = Math.max(rawTop - Math.max(0, FOOTER_MIN - rawBottom), 400);
  return { topSpacing, bottomSpacing };
}
function buildCoverR1RTL(config) {
  const P = config.palette, C = P.cover;
  const padL = 800, padR = 1200;
  const availableWidth = 11906 - padL - padR - 300;
  const { titlePt, titleLines } = calcTitleLayout(config.title, availableWidth, 40, 24);
  const titleSize = titlePt * 2;
  const spacing = calcCoverSpacing({ titleLineCount: titleLines.length, titlePt,
    hasSubtitle: !!config.subtitle, hasEnglishLabel: !!config.englishLabel,
    metaLineCount: (config.metaLines || []).length, fixedHeight: 400 });
  const accentRight = { style: BorderStyle.SINGLE, size: 8, color: P.accent, space: 12 };
  const children = [];
  children.push(new Paragraph({ spacing: { before: spacing.topSpacing } }));
  if (config.englishLabel) {
    children.push(new Paragraph({
      bidirectional: true, alignment: AlignmentType.RIGHT,
      indent: { left: padL, right: padR }, spacing: { after: 500 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: P.accent, space: 8 } },
      children: [new TextRun({ text: config.englishLabel.split("").join("  "),
        size: 18, color: P.accent, font: { ascii: "Calibri", hAnsi: "Calibri" }, characterSpacing: 40 })],
    }));
  }
  for (let i = 0; i < titleLines.length; i++) {
    children.push(new Paragraph({
      bidirectional: true, alignment: AlignmentType.RIGHT,
      indent: { right: padR, left: padL },
      spacing: { after: i < titleLines.length - 1 ? 100 : 300, line: Math.ceil(titlePt * 23), lineRule: "atLeast" },
      children: [new TextRun({ text: titleLines[i], size: titleSize, bold: true,
        rightToLeft: true, color: C.titleColor, font: FONT })],
    }));
  }
  if (config.subtitle) {
    children.push(new Paragraph({
      bidirectional: true, alignment: AlignmentType.RIGHT,
      indent: { right: padR, left: padL }, spacing: { after: 800 },
      children: [new TextRun({ text: config.subtitle, size: 24, rightToLeft: true,
        color: C.subtitleColor, font: FONT })],
    }));
  }
  for (const line of (config.metaLines || [])) {
    children.push(new Paragraph({
      bidirectional: true, alignment: AlignmentType.RIGHT,
      indent: { right: padR + 200, left: padL }, spacing: { after: 80 },
      border: { right: accentRight },
      children: [new TextRun({ text: line, size: 24, rightToLeft: true, color: C.metaColor, font: FONT })],
    }));
  }
  children.push(new Paragraph({ spacing: { before: spacing.bottomSpacing } }));
  children.push(new Paragraph({
    bidirectional: true, alignment: AlignmentType.RIGHT,
    indent: { left: padL, right: padR },
    border: { top: { style: BorderStyle.SINGLE, size: 2, color: P.accent, space: 8 } },
    spacing: { before: 200 },
    children: [
      new TextRun({ text: config.footerRight || "", size: 16, rightToLeft: true, color: C.footerColor, font: FONT }),
      new TextRun({ text: "                                   ", font: FONT, size: 16 }),
      new TextRun({ text: config.footerLeft || "", size: 16, color: C.footerColor, font: { ascii: "Calibri", hAnsi: "Calibri" } }),
    ],
  }));
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED, borders: allNoBorders,
    rows: [new TableRow({ height: { value: 16838, rule: "exact" },
      children: [new TableCell({ shading: { type: ShadingType.CLEAR, fill: P.bg }, borders: noBorders, children })] })],
  })];
}

/* ── header/footer ─────────────────────────────────────────────────────── */
const pageFooter = () => new Footer({ children: [new Paragraph({
  alignment: AlignmentType.CENTER,
  children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: MUTED, font: FONT })] })] });
const pageHeader = () => new Header({ children: [new Paragraph({
  bidirectional: true, alignment: AlignmentType.RIGHT,
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: PAL.table.innerLine, space: 4 } },
  children: [rtl("NEXUS//SIGNALS · گزارش مهندسی ریشه‌یابی NX-3247 و تخریب LIVE", { size: 16, color: MUTED })] })] });

module.exports = { PAL, BODY, MUTED, FONT, NB, noBorders, allNoBorders, rtl, body, bullet, h1, h2,
  caption, dataTable, img, buildCoverR1RTL, pageFooter, pageHeader,
  Document, Packer, Paragraph, TextRun, TableOfContents, SectionType, NumberFormat, AlignmentType };
