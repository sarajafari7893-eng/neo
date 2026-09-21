// NEXUS-LIVE System Architecture Expert Report (Persian, RTL) — docx R1/DM-1
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, PageBreak, Header, Footer, PageNumber, NumberFormat,
  AlignmentType, HeadingLevel, WidthType, BorderStyle, ShadingType,
  SectionType, TableLayoutType, TableOfContents,
} = require("docx");
const fs = require("fs");

// ---------- palette DM-1 (Deep Cyan — AI/tech) ----------
const P = {
  bg: "162235", accent: "37DCF2",
  cover: { titleColor: "FFFFFF", subtitleColor: "B0B8C0", metaColor: "90989F", footerColor: "687078" },
  table: { headerBg: "1B6B7A", headerText: "FFFFFF", accentLine: "1B6B7A", innerLine: "C8DDE2", surface: "EDF3F5" },
  head: "162235", body: "1A2530", sec: "5A6B7A",
};
const FA = { ascii: "Tahoma", hAnsi: "Tahoma", cs: "Tahoma" };

const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };
const allNoBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };

// ---------- RTL helpers ----------
function r(text, o = {}) {
  return new TextRun({ text, font: FA, size: 24, sizeComplexScript: true, rightToLeft: true, color: P.body, ...o });
}
function body(runs, o = {}) {
  const children = Array.isArray(runs) ? runs : [r(runs)];
  return new Paragraph({ bidirectional: true, alignment: AlignmentType.JUSTIFIED,
    spacing: { line: 312, after: 140 }, children, ...o });
}
function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, bidirectional: true,
    spacing: { before: 360, after: 180, line: 312 },
    children: [r(text, { bold: true, boldComplexScript: true, size: 32, color: P.head })] });
}
function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, bidirectional: true,
    spacing: { before: 260, after: 140, line: 312 },
    children: [r(text, { bold: true, boldComplexScript: true, size: 28, color: P.head })] });
}
function caption(text, keep = false) {
  return new Paragraph({ bidirectional: true, alignment: AlignmentType.CENTER,
    keepNext: keep, spacing: { before: 120, after: 200, line: 312 },
    children: [r(text, { size: 21, color: P.sec })] });
}

// ---------- RTL table builder ----------
function cell(text, o = {}) {
  const { header = false, width = 25, fill = null } = o;
  return new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    shading: header
      ? { type: ShadingType.CLEAR, fill: P.table.headerBg }
      : (fill ? { type: ShadingType.CLEAR, fill } : undefined),
    children: [new Paragraph({ bidirectional: true, spacing: { line: 312 },
      children: [r(text, { size: 21, color: header ? P.table.headerText : P.body,
        bold: header ? true : undefined, boldComplexScript: header ? true : undefined })] })],
  });
}
function table(widths, headerCells, rows) {
  return new Table({
    visuallyRightToLeft: true,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: P.table.accentLine },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: P.table.accentLine },
      left: NB, right: NB,
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: P.table.innerLine },
      insideVertical: NB,
    },
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true,
        children: headerCells.map((t, i) => cell(t, { header: true, width: widths[i] })) }),
      ...rows.map((row, ri) => new TableRow({ cantSplit: true,
        children: row.map((t, i) => cell(t, { width: widths[i], fill: ri % 2 === 1 ? P.table.surface : null })) })),
    ],
  });
}

// ---------- cover (R1, RTL-adapted) ----------
function calcTitleLayoutFa(title, maxWidthTwips, preferredPt = 40, minPt = 24) {
  const charWidth = (pt) => pt * 13; // Persian glyph average width
  const charsPerLine = (pt) => Math.floor(maxWidthTwips / charWidth(pt));
  const split = (t, cpl) => {
    if (t.length <= cpl) return [t];
    const words = t.split(" ");
    const lines = []; let cur = "";
    for (const w of words) {
      const cand = cur ? cur + " " + w : w;
      if (cand.length > cpl && cur) { lines.push(cur); cur = w; } else { cur = cand; }
    }
    if (cur) lines.push(cur);
    if (lines.length > 1 && lines[lines.length - 1].length <= 2) {
      lines[lines.length - 2] += " " + lines.pop();
    }
    return lines;
  };
  let titlePt = preferredPt, lines;
  while (titlePt >= minPt) {
    const cpl = charsPerLine(titlePt);
    if (cpl < 2) { titlePt -= 2; continue; }
    lines = split(title, cpl);
    if (lines.length <= 3) break;
    titlePt -= 2;
  }
  if (!lines || lines.length > 3) { lines = split(title, charsPerLine(minPt)); titlePt = minPt; }
  return { titlePt, titleLines: lines };
}

function calcCoverSpacing(params) {
  const { titleLineCount = 1, titlePt = 36, hasSubtitle = false, hasEnglishLabel = false,
    metaLineCount = 0, fixedHeight = 800, pageHeight = 16838, marginTop = 0, marginBottom = 0 } = params;
  const SAFETY = 1200;
  const usableHeight = pageHeight - marginTop - marginBottom - SAFETY;
  const titleHeight = titleLineCount * (titlePt * 23 + 200);
  const subtitleHeight = hasSubtitle ? (12 * 23 + 600) : 0;
  const englishLabelHeight = hasEnglishLabel ? (9 * 23 + 600) : 0;
  const metaHeight = metaLineCount * (10 * 23 + 100);
  const implicitParaHeight = 3 * 300;
  const contentHeight = titleHeight + subtitleHeight + englishLabelHeight + metaHeight + fixedHeight + implicitParaHeight;
  const remainingSpace = usableHeight - contentHeight;
  const safeRemaining = Math.max(remainingSpace, 400);
  const FOOTER_MIN = 800;
  const rawTop = Math.floor(safeRemaining * 0.45);
  const rawBottom = Math.floor(safeRemaining * 0.45);
  const bottomSpacing = Math.max(rawBottom, FOOTER_MIN);
  const topSpacing = Math.max(rawTop - Math.max(0, FOOTER_MIN - rawBottom), 400);
  const midSpacing = Math.max(safeRemaining - topSpacing - bottomSpacing, 0);
  return { topSpacing, midSpacing, bottomSpacing };
}

function buildCoverR1(config) {
  const C = config.palette;
  const padL = 1200, padR = 800;
  const availableWidth = 11906 - padL - padR - 300;
  const { titlePt, titleLines } = calcTitleLayoutFa(config.title, availableWidth, 40, 24);
  const titleSize = titlePt * 2;
  const spacing = calcCoverSpacing({
    titleLineCount: titleLines.length, titlePt,
    hasSubtitle: !!config.subtitle, hasEnglishLabel: !!config.englishLabel,
    metaLineCount: (config.metaLines || []).length, fixedHeight: 400,
  });
  const children = [];
  children.push(new Paragraph({ spacing: { before: spacing.topSpacing } }));
  if (config.englishLabel) {
    children.push(new Paragraph({
      indent: { left: padL, right: padR }, spacing: { after: 500 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.accent, space: 8 } },
      children: [new TextRun({ text: config.englishLabel.split("").join("  "),
        size: 18, color: C.accent, font: FA, characterSpacing: 40 })],
    }));
  }
  for (let i = 0; i < titleLines.length; i++) {
    children.push(new Paragraph({
      bidirectional: true, indent: { left: padL, right: padR },
      spacing: { after: i < titleLines.length - 1 ? 100 : 300, line: Math.ceil(titlePt * 23), lineRule: "atLeast" },
      children: [r(titleLines[i], { size: titleSize, sizeComplexScript: true, bold: true, boldComplexScript: true, color: C.titleColor })],
    }));
  }
  if (config.subtitle) {
    children.push(new Paragraph({
      bidirectional: true, indent: { left: padL, right: padR }, spacing: { after: 800, line: 312 },
      children: [r(config.subtitle, { size: 24, color: C.subtitleColor })],
    }));
  }
  for (const line of (config.metaLines || [])) {
    children.push(new Paragraph({
      bidirectional: true, indent: { left: padL + 200, right: padR }, spacing: { after: 80, line: 312 },
      children: [r(line, { size: 24, color: C.metaColor })],
    }));
  }
  children.push(new Paragraph({ spacing: { before: spacing.bottomSpacing } }));
  children.push(new Paragraph({
    bidirectional: true, indent: { left: padL, right: padR },
    border: { top: { style: BorderStyle.SINGLE, size: 2, color: C.accent, space: 8 } },
    spacing: { before: 200, line: 312 },
    children: [r(config.footerText || "", { size: 16, color: C.footerColor })],
  }));
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: config.bg }, borders: noBorders,
        verticalAlign: "top",
        children,
      })],
    })],
  })];
}

// ---------- figure ----------
const imgBuf = fs.readFileSync("/home/z/my-project/scripts/dash-check.png");
const IMG_W = 1280, IMG_H = 577;
const dispW = 580, dispH = Math.round(dispW * IMG_H / IMG_W);

// ---------- shared header/footer ----------
function runningHeader() {
  return new Header({ children: [new Paragraph({
    bidirectional: true, alignment: AlignmentType.CENTER, spacing: { line: 312 },
    children: [r("گزارش کارشناسی معماری سیستم NEXUS-LIVE", { size: 18, color: "808080" })],
  })] });
}
function pageNumFooter() {
  return new Footer({ children: [new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { line: 312 },
    children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "808080", font: FA })],
  })] });
}

// ---------- TOC section children ----------
const tocChildren = [
  new Paragraph({
    bidirectional: true, alignment: AlignmentType.CENTER, spacing: { before: 480, after: 360, line: 312 },
    children: [r("فهرست مطالب", { bold: true, boldComplexScript: true, size: 32, color: P.head })],
  }),
  new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }),
  new Paragraph({
    bidirectional: true, spacing: { before: 200, line: 312 },
    children: [r("توجه: این فهرست با کدهای فیلد تولید شده است. پس از هر ویرایش، برای به‌روزرسانی شماره صفحات، روی فهرست راست‌کلیک کرده و گزینه Update Field را انتخاب کنید.", { italics: true, size: 18, color: "888888" })],
  }),
  new Paragraph({ children: [new PageBreak()] }),
];

module.exports = { Document, Packer, Paragraph, TextRun, SectionType, NumberFormat, AlignmentType,
  HeadingLevel, ImageRun, P, FA, r, body, h1, h2, caption, table, buildCoverR1,
  imgBuf, dispW, dispH, runningHeader, pageNumFooter, tocChildren, fs };
