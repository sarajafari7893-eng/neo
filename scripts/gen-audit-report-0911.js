// ── NEXUS//SIGNALS — Persian (RTL) Module Performance Audit DOCX generator ──
// docx skill: Create route · Report scene (Template A) · Cover recipe R1 (mirrored
// RTL) · Palette FG-1 (Forest Mint, dark cover → light tables) · Tahoma complex-
// script typography · 3-section page numbering (cover / TOC roman / body arabic).
// Run: node scripts/gen-audit-report-0911.js   (docx resolved from project root)
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, PageNumber, NumberFormat, AlignmentType, HeadingLevel,
  WidthType, BorderStyle, ShadingType, TableLayoutType, SectionType,
  TableOfContents,
} = require("docx");
const fs = require("fs");

// ── FG-1 palette (validated) ──
const P = {
  bg: "0C1F1A", primary: "FFFFFF", accent: "3DDBB5",
  cover: { titleColor: "FFFFFF", subtitleColor: "B0B8C0", metaColor: "90989F", footerColor: "687078" },
  table: { headerBg: "2A7A65", headerText: "FFFFFF", accentLine: "2A7A65", innerLine: "C5D8D0", surface: "EDF5F2" },
  headingColor: "1E5B4C", // darkened accent for body headings on white
};
const FA_FONT = { ascii: "Tahoma", hAnsi: "Tahoma", cs: "Tahoma", eastAsia: "Tahoma" };
const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };
const allNoBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };

// ── Persian RTL run/paragraph helpers ──
function faRun(text, o = {}) {
  return new TextRun({
    text, rightToLeft: true, font: FA_FONT,
    size: o.size ?? 24, sizeComplexScript: o.size ?? 24,
    bold: o.bold ?? false, boldComplexScript: o.bold ?? false,
    italics: o.italics ?? false, color: o.color ?? "000000",
  });
}
function faPara(text, o = {}) {
  return new Paragraph({
    bidirectional: true,
    alignment: o.align ?? AlignmentType.JUSTIFIED,
    heading: o.heading,
    keepNext: o.keepNext,
    spacing: { line: 312, before: o.before, after: o.after ?? 140 },
    border: o.border,
    children: Array.isArray(text) ? text : [faRun(text, o)],
  });
}
function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1, bidirectional: true, alignment: AlignmentType.RIGHT,
    spacing: { before: 360, after: 160, line: 312 },
    children: [faRun(text, { size: 32, bold: true, color: P.headingColor })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2, bidirectional: true, alignment: AlignmentType.RIGHT,
    spacing: { before: 240, after: 120, line: 312 },
    children: [faRun(text, { size: 28, bold: true, color: P.headingColor })],
  });
}

// ── RTL data table (percentage widths, WPS-safe, cross-page controlled) ──
function cellPara(text, o = {}) {
  return new Paragraph({
    bidirectional: true, alignment: AlignmentType.RIGHT,
    spacing: { line: 276 },
    children: [faRun(String(text), { size: o.size ?? 21, bold: o.bold ?? false, color: o.color ?? "000000" })],
  });
}
function dataTable(headers, rows, widths) {
  return new Table({
    visuallyRightToLeft: true,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: P.table.accentLine },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: P.table.accentLine },
      left: NB, right: NB,
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: P.table.innerLine },
      insideVertical: NB,
    },
    rows: [
      new TableRow({
        tableHeader: true, cantSplit: true,
        children: headers.map((t, i) => new TableCell({
          children: [cellPara(t, { bold: true, color: P.table.headerText })],
          shading: { type: ShadingType.CLEAR, fill: P.table.headerBg },
          margins: { top: 70, bottom: 70, left: 110, right: 110 },
          width: { size: widths[i], type: WidthType.PERCENTAGE },
        })),
      }),
      ...rows.map((r, ri) => new TableRow({
        cantSplit: true,
        children: r.map((t, i) => new TableCell({
          children: [cellPara(t, { bold: ri < rows.length && i === 0 })],
          shading: ri % 2 === 1 ? { type: ShadingType.CLEAR, fill: P.table.surface } : undefined,
          margins: { top: 60, bottom: 60, left: 110, right: 110 },
          width: { size: widths[i], type: WidthType.PERCENTAGE },
        })),
      })),
    ],
  });
}
function tableCaption(text) {
  return new Paragraph({
    bidirectional: true, alignment: AlignmentType.RIGHT, keepNext: true,
    spacing: { before: 160, after: 80, line: 312 },
    children: [faRun(text, { size: 21, bold: true, color: P.headingColor })],
  });
}

// ── Persian title layout (calcTitleLayout adapted: Persian glyph ≈ pt×12 twips) ──
function splitTitleLines(title, charsPerLine) {
  if (title.length <= charsPerLine) return [title];
  const breakAfter = new Set([..."،؛:!؟", ..." \t", ..."-_—–·/"]);
  const lines = [];
  let remaining = title;
  while (remaining.length > charsPerLine) {
    let breakAt = -1;
    for (let i = charsPerLine; i >= Math.floor(charsPerLine * 0.6); i--) {
      if (i < remaining.length && breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
    }
    if (breakAt === -1) {
      const limit = Math.min(remaining.length, Math.ceil(charsPerLine * 1.3));
      for (let i = charsPerLine + 1; i < limit; i++) {
        if (breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
      }
    }
    if (breakAt === -1) breakAt = charsPerLine;
    lines.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) lines.push(remaining);
  if (lines.length > 1 && lines[lines.length - 1].length <= 2) {
    const last = lines.pop();
    lines[lines.length - 1] += " " + last;
  }
  return lines;
}
function calcTitleLayoutFA(title, maxWidthTwips, preferredPt = 40, minPt = 24) {
  const charWidth = (pt) => pt * 12; // Persian avg glyph width (≈0.6em)
  let titlePt = preferredPt, lines;
  while (titlePt >= minPt) {
    const cpl = Math.floor(maxWidthTwips / charWidth(titlePt));
    if (cpl < 2) { titlePt -= 2; continue; }
    lines = splitTitleLines(title, cpl);
    if (lines.length <= 3) break;
    titlePt -= 2;
  }
  if (!lines || lines.length > 3) {
    lines = splitTitleLines(title, Math.floor(maxWidthTwips / charWidth(minPt)));
    titlePt = minPt;
  }
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
  const safeRemaining = Math.max(usableHeight - contentHeight, 400);
  const FOOTER_MIN = 800;
  const rawTop = Math.floor(safeRemaining * 0.45);
  const rawBottom = Math.floor(safeRemaining * 0.45);
  const bottomSpacing = Math.max(rawBottom, FOOTER_MIN);
  const topSpacing = Math.max(rawTop - Math.max(0, FOOTER_MIN - rawBottom), 400);
  const midSpacing = Math.max(safeRemaining - topSpacing - bottomSpacing, 0);
  return { topSpacing, midSpacing, bottomSpacing };
}

// ── Cover — Recipe R1 mirrored for RTL (single 16838 wrapper, allNoBorders) ──
function buildCoverR1RTL(config) {
  const C = config.palette;
  const padR = 1200, padL = 800; // mirrored: text hugs the RIGHT edge
  const availableWidth = 11906 - padR - padL - 300;
  const { titlePt, titleLines } = calcTitleLayoutFA(config.title, availableWidth, 40, 24);
  const titleSize = titlePt * 2;
  const spacing = calcCoverSpacing({
    titleLineCount: titleLines.length, titlePt,
    hasSubtitle: !!config.subtitle, hasEnglishLabel: !!config.englishLabel,
    metaLineCount: (config.metaLines || []).length, fixedHeight: 400,
  });
  const accentRight = { style: BorderStyle.SINGLE, size: 8, color: C.accent, space: 12 };
  const children = [];
  children.push(new Paragraph({ spacing: { before: spacing.topSpacing } }));
  if (config.englishLabel) {
    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT, bidirectional: false,
      indent: { right: padR, left: padL }, spacing: { after: 500 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.accent, space: 8 } },
      children: [new TextRun({ text: config.englishLabel.split("").join(" "), size: 18, sizeComplexScript: 18, color: C.accent, font: FA_FONT, characterSpacing: 40 })],
    }));
  }
  for (let i = 0; i < titleLines.length; i++) {
    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT, bidirectional: true,
      indent: { right: padR, left: padL },
      spacing: { after: i < titleLines.length - 1 ? 100 : 300, line: Math.ceil(titlePt * 23), lineRule: "atLeast" },
      children: [faRun(titleLines[i], { size: titleSize, bold: true, color: C.titleColor })],
    }));
  }
  if (config.subtitle) {
    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT, bidirectional: true,
      indent: { right: padR, left: padL }, spacing: { after: 800, line: 340, lineRule: "atLeast" },
      children: [faRun(config.subtitle, { size: 24, color: C.subtitleColor })],
    }));
  }
  for (const line of (config.metaLines || [])) {
    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT, bidirectional: true,
      indent: { right: padR + 200, left: padL }, spacing: { after: 80 },
      border: { right: accentRight },
      children: [faRun(line, { size: 24, color: C.metaColor })],
    }));
  }
  children.push(new Paragraph({ spacing: { before: spacing.bottomSpacing } }));
  children.push(new Paragraph({
    alignment: AlignmentType.RIGHT, bidirectional: true,
    indent: { right: padR, left: padL },
    border: { top: { style: BorderStyle.SINGLE, size: 2, color: C.accent, space: 8 } },
    spacing: { before: 200 },
    children: [
      faRun(config.footerRight || "", { size: 16, color: C.footerColor }),
      new TextRun({ text: "                                        ", font: FA_FONT, size: 16 }),
      faRun(config.footerLeft || "", { size: 16, color: C.footerColor }),
    ],
  }));
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: C.bg }, borders: noBorders,
        verticalAlign: "top",
        children,
      })],
    })],
  })];
}
// ── BODY CONTENT (Persian, Template A: analysis report) ──
const body = [];

// 1) خلاصه مدیریتی
body.push(h1("۱. خلاصه مدیریتی"));
body.push(faPara("این گزارش به درخواست بهره‌بردار («گزارش و تحقیق از عملکرد ماژول‌ها، یادگیری و ردیابی سیگنال‌ها») تهیه شده است و برخلاف دوره‌های قبل، ادعاها صرفاً بر پایه شواهد قابل بازبینی ارائه می‌شوند: ردیف‌های تسویه‌شده پایگاه داده، ژورنال تصمیم‌های گیت (gate-journal)، ژورنال وتوی سایه (shadow-veto) و آرتیفکت بک‌تست عامل جریان. پنجره ارزیابی، کل تاریخ اپوک دوم است؛ یعنی ۳۵ معامله تسویه‌شده از ۸ سپتامبر ۲۰۲۶ به بعد. در این پنجره، سیستم ۳۵ معامله را بسته است که فقط ۷ مورد آن سودده بوده (نرخ برد ۲۰٪) و خالص نتیجه پس از کارمزد، منفی ۹.۹۵ دلار است؛ حقوق حساب از حدود ۹۳ دلار به ۹۲.۲۸ دلار کاهش یافته است."));
body.push(faPara("نتیجه محوری تحقیق این است که شکایت بهره‌بردار دقیق و مستند است: ردیابی جریان هنوز «فیلتر دقیقی» تولید نکرده است. آرتیفکت بک‌تست داخلی خودِ سیستم برای عامل جریان، حکم نهایی FAIL صادر کرده است (در پنجره تست، ضرایب سود ۰.۲۵ تا ۰.۶۱ و امید ریاضی منفی). به بیان دیگر، لایه فیلتر از نظر مکانیکی فعال و سخت‌گیر است، اما ورودی آن یک موتور امتیازدهی با لبه سودآوری اثبات‌نشده است. سه یافته کلیدی دیگر نیز به این نتیجه وزن می‌دهند: وارونگی مدل اطمینان (معاملات با اطمینان ۷۵٪ به بالا، بدترین عملکرد را داشته‌اند)، خون‌ریزی سمت SHORT (منفی ۹.۶۹ دلار از کل ضرر)، و نشتی سود در خروج (۲۲.۹٪ معاملات که به سود شناور ۸٪ رسیده بودند، منفی بسته شدند)."));
body.push(faPara("در کنار این تشخیص‌ها، زیرساخت گزارش‌دهی و ارتباطی در همین دور ارتقا یافت: پل ارتباطی دوطرفه تلگرام (v8.3) فعال شد و چرخش روزانه بکگراند تصاویر تلگرام (v8.2) پیاده‌سازی و با خروجی گرافیکی اثبات شد. سلامت زیرساخت زمان‌بندی‌شده (keep-alive، اسنپ‌شات سه‌ساعته، گزارش روزانه) در طول دوره ۱۰۰٪ بدون خطا بوده است؛ بنابراین مسئله، پایداری عملیاتی نیست، مسئله «لبه معاملاتی» است."));

// 2) زمینه، اهداف و دامنه
body.push(h1("۲. زمینه، اهداف و دامنه ارزیابی"));
body.push(faPara("موتور NEXUS//SIGNALS در تاریخ ۸ سپتامبر ۲۰۲۶ به دستور بهره‌بردار («سیستم و بالانس ریست بشه») وارد اپوک دوم شد؛ تاریخ‌چه قبلی (۲۱۳ سیگنال) بایگانی و شمارنده‌ها صفر شدند. از آن پس مجموعه‌ای از ماژول‌ها فعال شده‌اند: گیت انتشار سیگنال با آستانه امتیاز و وتوی جریان، حاکم خودتنظیم (governor) برای تنظیم پارامترها، ناظر (supervisor) برای کشف ناهنجاری، هسته حکم (verdict-core) برای تولید «اطمینان»، کالیبراسیون وزن فاکتورها بر اساس امید ریاضی خالص، و بازوی داوری دوم «وتوی سایه» که پیش از انتشار، هر سیگنال را با دو بازوی مستقل مدل/هیوریستیک بررسی می‌کند."));
body.push(faPara("هدف این ارزیابی سه چیز است: نخست، اندازه‌گیری صادقانه عملکرد معاملاتی هر ماژول و هر استراتژی بر پایه ردیف‌های تسویه‌شده؛ دوم، پاسخ مستند به این پرسش که آیا «ردیابی جریان و فیلتر سیگنال» ارزش افزوده تولید کرده است یا نه؛ سوم، ارائه فهرست اقدامات اصلاحی اولویت‌بندی‌شده. روش‌شناسی، کاملاً فقط‌خواندنی است: هیچ ردیفی تغییر نکرده و همه آمارها با یک اسکریپت ممیزی تکرارپذیر (scripts/module-performance-audit-0911.ts) از پایگاه داده SQLite، فایل‌های ژورنال JSONL و آرتیفکت بک‌تست استخراج شده‌اند. خروجی خام ممیزی در scripts/module-audit-0911.json نگهداری می‌شود تا هر عدد این گزارش قابل ردیابی باشد."));

// 3) یافته‌های اصلی
body.push(h1("۳. یافته‌های اصلی عملکرد"));
body.push(faPara("جدول ۱ نمای کلان پنجره ۱۴ روزه را نشان می‌دهد. نسبت برد ۲۰٪ با میانگین برد ۰.۹۳ دلار در برابر میانگین باخت ۰.۵۹ دلار همراه است؛ این ترکیب برای سودآوری به نرخ برد حداقل حدود ۳۹٪ نیاز دارد، در حالی که فاصله واقعی تا این آستانه بسیار زیاد است. کارمزد و سواپ ۲.۲۳ دلار از ضرر ۹.۹۵ دلاری را تشکیل می‌دهد؛ یعنی حدود ۲۲٪ از خالص منفی، صرفاً هزینه معاملات است و با کاهش دفعات معامله کم‌کیفیت، مستقیماً قابل بازیابی است."));
body.push(tableCaption("جدول ۱ — آمار کلان پنجره ارزیابی (۱۴ روز، ۳۵ معامله تسویه‌شده)"));
body.push(dataTable(
  ["شاخص", "مقدار", "تفسیر"],
  [
    ["تعداد معاملات تسویه‌شده", "35", "کل تاریخ اپوک-۲"],
    ["نرخ برد", "20% (7 برد)", "آستانه سربه‌سر ≈ 39%"],
    ["خالص سود/زیان", "-$9.95", "پس از کسر کارمزد"],
    ["کارمزد + سواپ", "$2.23", "≈ 22% از خالص منفی"],
    ["میانگین برد / باخت", "+$0.93 / -$0.59", "نسبت R ≈ 1.6"],
    ["امید ریاضی هر معامله", "-$0.28", "منفی؛ لبه وجود ندارد"],
  ],
  [30, 25, 45]
));
body.push(faPara("تفکیک استراتژیک (جدول ۲) نشان می‌دهد بزرگ‌ترین خون‌ریز AI-SWING است که با ۱۳ معامله، منفی ۶.۱۱ دلار تولید کرده و انتظار هر معامله آن منفی ۰.۴۷ دلار است. جالب است که تنها استراتژی با نمونه مثبت معنادار، MOMENTUM است (۱ برد از ۱) و AI-SCALP با ۲۵٪ برد کمترین نرخ ضرر سرانه را دارد. BREAKOUT با صفر برد از ۲ معامله، عملاً غیرفعال‌ترین لبه است.", { before: 120 }));
body.push(tableCaption("جدول ۲ — عملکرد به تفکیک استراتژی"));
body.push(dataTable(
  ["استراتژی", "تعداد", "نرخ برد", "خالص", "امید/معامله"],
  [
    ["AI-SWING", "13", "15.4%", "-$6.11", "-$0.47"],
    ["AI-SCALP", "12", "25.0%", "-$1.85", "-$0.15"],
    ["MEAN-REVERT", "7", "14.3%", "-$1.63", "-$0.23"],
    ["BREAKOUT", "2", "0%", "-$0.84", "-$0.42"],
    ["MOMENTUM", "1", "100%", "+$0.48", "+$0.48"],
  ],
  [28, 14, 18, 20, 20]
));
body.push(faPara("دو شکاف ساختاری دیگر نیز در داده‌ها آشکار است. نخست، سمت SHORT با ۱۸ معامله و نرخ برد ۱۱.۱٪، منفی ۹.۶۹ دلار تولید کرده است؛ یعنی تقریباً تمام ضرر خالص سیستم از فروش در بازاری است که در این پنجره فشار بازخرید داشته است. دوم، جدول ۳ الگوی «سوزاندن سود» را مستند می‌کند: ۸ معامله (۲۲.۹٪ کل) به سود شناور ۸٪ یا بیشتر رسیده و در پایان منفی بسته شده‌اند؛ سود رهاشده این دسته حدود ۴.۷۳ دلار برآورد می‌شود. نمونه تکان‌دهنده، MARSCOINUSDT با سود شناور ۲۲٪ و بستن منفی ۵۹.۷٪ است که یعنی حد ضرر متحرک به نقطه سربه‌سر عملاً عمل نکرده است.", { before: 120 }));
body.push(tableCaption("جدول ۳ — نمونه‌های «سوزاندن سود» (MFE ≥ +8% و بستن منفی)"));
body.push(dataTable(
  ["نماد", "استراتژی", "جهت", "سود شناور", "پایانی", "وضعیت"],
  [
    ["PUMPUSDT", "AI-SWING", "SHORT", "+32.2%", "-2.0%", "SL"],
    ["MARSCOINUSDT", "AI-SWING", "SHORT", "+22.0%", "-59.7%", "SL"],
    ["ARBUSDT", "AI-SWING", "SHORT", "+22.0%", "-1.2%", "SL"],
    ["ZECUSDT", "AI-SWING", "LONG", "+17.8%", "-1.2%", "SL"],
    ["LITUSDT", "AI-SWING", "LONG", "+8.2%", "-25.2%", "SL"],
  ],
  [24, 20, 12, 16, 14, 14]
));

// 4) فیلتر و جریان
body.push(h1("۴. تحلیل فیلتر سیگنال و ردیابی جریان"));
body.push(faPara("ژورنال گیت در پنجره قابل مشاهده (حدود ۲ ساعت اخیر، پس از آخرین چرخش) ۱۶۰۶ ضربان TICK و ۲۸ تصمیم نماد-محور ثبت کرده است: ۲۸ مورد ورود به فهرست کوتاه، ۱۱ وتو (تماماً با علت FLOW-VETO) و صفر انتشار. این نشان می‌دهد لایه فیلتر از نظر فنی زنده و فعال است؛ اما دو نکته حیاتی دارد. اول، گاه‌شمار ژورنال کوتاه است و تاریخ بلندمدت تصمیم‌ها در دسترس نیست (فایل ظاهراً در چرخه‌های بازراه‌اندازی بازتولید شده است)؛ بنابراین قضاوت بلندمدت باید بر اساس خروجی معاملات و بک‌تست انجام شود. دوم، وقتی «همه» سیگنال‌های تسویه‌شده برچسب FLOW/VOL دارند، برچسب جریان عملاً قدرت تمایزی ندارد."));
body.push(faPara("شاهد تعیین‌کننده، آرتیفکت بک‌تست داخلی سیستم است (۲۰ نماد، داده واقعی بایننس، پنجره ۳۱ روزه ماه اوت با تفکیک آموزش/تست). همان‌طور که جدول ۴ نشان می‌دهد، پیکربندی پایه در پنجره تست نرخ برد ۱۶٪ و ضریب سود ۰.۲۵ دارد؛ بهترین پیکربندی گرید هم اگرچه در آموزش درخشان است (۷۷.۱٪ برد)، در تست به pf ۰.۶۱ و امید ریاضی منفی سقوط می‌کند و خودِ آرتیفکت هم پرچم adoptionOk=false و حکم نهایی FAIL را ثبت کرده است. خانواده‌های «مقاوم» یافته‌شده در بک‌تست، همگی اشتراک عجیبی دارند: حالت تراز HTF-CONFIRM و بستن مسیر breakeven-trail=0؛ در حالی که پیکربندی زنده فعلی دقیقاً برعکس است (beTrailPct=1 و rrScale=0.75). این ناسازگاری یعنی خروجی پژوهش هرگز روی موتور زنده اعمال نشده است."));
body.push(tableCaption("جدول ۴ — بک‌تست عامل جریان (حکم نهایی آرتیفکت: FAIL)"));
body.push(dataTable(
  ["پیکربندی", "آموزش (n · برد · امید)", "تست (n · برد · امید · pf)"],
  [
    ["پایه (minScore 35 · ALL)", "1153 · 24.4% · -3.5%", "150 · 16% · -5.1% · 0.25"],
    ["بهترین گرید (45 · HTF-CONFIRM)", "245 · 77.1% · +5.3%", "33 · 54.5% · -3.0% · 0.61"],
    ["خانواده برگزیده (45 · ALIGN3)", "223 · 76.2% · +6.1%", "≈34 · 50% · -3.6% · 0.56"],
  ],
  [34, 30, 36]
));
body.push(faPara("بازوی داوری دوم «وتوی سایه» نیز در این پنجره عملاً بی‌اثر بوده است: فقط ۱۲ رکورد وجود دارد که هر ۱۲ مورد اجازه (ALLOW) هستند و هیچ وتویی صادر نشده؛ نمونه آنقدر کوچک است که نمی‌توان ارزش محافظتی برای آن ادعا کرد. جمع‌بندی این بخش: ردیابی جریان فعلاً یک «فیلتر منفی» است (بعضی چیزها را وتو می‌کند) اما به هیچ معنایی «فیلتر دقیق سودساز» نیست، چون عامل امتیازدهی زیرین خود در آزمون واقعی رد شده است.", { before: 120 }));

// 5) یادگیری
body.push(h1("۵. وضعیت ماژول یادگیری و حلقه‌های خودکار"));
body.push(faPara("ماژول کالیبراسیون فعال است (۳۵ نمونه تسویه‌شده از هدف ۳۰) و معیار بهینه‌سازی آن «امید ریاضی خالص» است؛ اما سه مشکل اساسی دارد. اول، وزن هر سه فاکتور (EMA STACK، MACD MOMENTUM، RANGE BREAKOUT) روی ۰.۷ قفل شده و امید ریاضی اندازه‌گیری‌شده فاکتورها منفی ۶.۵٪ است؛ یعنی یادگیرنده روی مجموعه‌ای از سیگنال‌های با لبه منفی در حال «یادگیری» است. دوم، اندازه نمونه (۳۵) از نظر آماری برای جابه‌جایی وزن بسیار نازک است؛ بازه اطمینان ویلسون برای نرخ برد در چنین نمونه‌ای ۲۲ تا ۳۶٪ پهنا دارد. سوم، هسته حکم (۱۳۲ اجرا) در عمل وارونه عمل کرده است: معاملات با اطمینان ۷۵٪ به بالا، بدترین سبد را داشته‌اند (جدول ۵)؛ یعنی سیگنال اطمینان در وضعیت فعلی ضد-پیش‌بین است."));
body.push(tableCaption("جدول ۵ — رابطه اطمینان اعلام‌شده با نتیجه واقعی"));
body.push(dataTable(
  ["وضعیت اطمینان", "تعداد", "نرخ برد", "خالص", "امید/معامله"],
  [
    ["%75+ (بالا)", "29", "17.2%", "-$10.10", "-$0.35"],
    ["60–74", "6", "33.3%", "+$0.15", "+$0.03"],
  ],
  [30, 14, 18, 20, 18]
));
body.push(faPara("حلقه‌های خودکار هم به همین الگو خدمت می‌کنند: حاکم (governor) تاکنون ۸۹۷ چرخه اجرا کرده و ناظر (supervisor) با ۴۳۸۸ بررسی، امروز هشدار «خشک‌سالی سیگنال» (صفر انتشار در ۳ ساعت با آستانه MIN_SCORE=46) داده و حاکم را به تعدیل آستانه ترغیب کرده است. این چرخه — فشار برای انتشار بیشتر در نظامی با لبه منفی — در عمل یعنی تولید معاملات کم‌کیفیت بیشتر و پرداخت کارمزد بیشتر. در نقطه مقابل، سلامت زیرساخت بی‌نقص است: keep-alive هر ۱۵ دقیقه، اسنپ‌شات رمزنگاری‌شده هر ۳ ساعت و گزارش روزانه ۰۰:۰۰ تهران در کل دوره بدون حتی یک خطا اجرا شده‌اند.", { before: 120 }));

// 6) تشخیص ریشه‌ای
body.push(h1("۶. تشخیص ریشه‌ای"));
body.push(faPara("۱) کمبود لبه، نه خرابی فیلتر. لایه گیت کار خودش را می‌کند (وتوهای FLOW فعال‌اند)، اما عامل امتیازدهی زیرین در آزمون واقعی FAIL شده است؛ سخت‌گیرتر کردن فیلترِ یک لبه منفی فقط تعداد معاملات را کم می‌کند، ماهیت ضرر را عوض نمی‌کند. ۲) مدل اطمینان وارونه است: سبد ۷۵٪+ بدترین بوده؛ هر تصمیمی که روی «اطمینان» ساخته شود (حجم، اولویت، انتشار) در وضعیت فعلی جهت اشتباه را تقویت می‌کند. ۳) عدم تناسب سمت SHORT با رژیم بازار: در پنجره‌ای که بازار فشار بازخرید داشته، فروشهای معکوس (به‌ویژه MEAN-REVERT SHORT مانند NEAR با منفی ۲۶٪) به‌طور سیستماتیک کوبیده شده‌اند."));
body.push(faPara("۴) شکاف اجرایی حد سربه‌سر: پیکربندی اعلام می‌کند beTrailPct=1 اما معاملاتی مثل MARSCOIN از سود ۲۲٪ به منفی ۵۹.۷٪ رسیده‌اند؛ یعنی مکانیسم حفظ سود یا فعال نمی‌شود یا خیلی دیر فعال می‌شود. رویدادهای BE_TRAIL در ۷ روز فقط ۳ مورد است — با این تعداد معامله، این عدد به معنای «عمل نکردن» است. ۵) ناسازگاری پیکربندی زنده با پژوهش: پارامترهای پیشنهادی بک‌تست (slAtrMult=1.2، rrScale=1.15، beTrail=0، HTF-CONFIRM) دقیقاً برعکس مقادیر زنده (۱.۸، ۰.۷۵، ۱، بدون تراز صریح) است. ۶) حلقه یادگیری روی هدف اشتباه: وقتی فاکتورهای ورودی امید ریاضی منفی دارند و نمونه نازک است، هر چرخه کالیبراسیون فقط نویز را تقویت می‌کند."));

// 7) نتیجه‌گیری و توصیه‌ها
body.push(h1("۷. نتیجه‌گیری و توصیه‌های اجرایی"));
body.push(faPara("جمع‌بندی صادقانه: زیرساخت پایدار است، گزارش‌دهی شفاف است، اما موتور سیگنال فعلاً لبه سودآوری اثبات‌شده ندارد و فیلتر جریان هنوز «دقیق» نشده است. فهرست اقدامات زیر بر اساس نسبت «اثر مورد انتظار به هزینه اجرا» اولویت‌بندی شده و همه موارد قابل اجرای فوری هستند؛ ترتیب پیشنهادی اجرا از R1 است."));
body.push(tableCaption("جدول ۶ — برنامه اقدام اولویت‌بندی‌شده"));
body.push(dataTable(
  ["کد", "اقدام", "مبنای داده‌ای"],
  [
    ["R1", "توقف انتشار SHORT تا بهبود رژیم (یا الزام تراز HTF-DOM برای فروش)", "SHORT: برد ۱۱.۱٪، −$9.69 از −$9.95 کل"],
    ["R2", "اصلاح حفظ سود: فعال‌سازی قطعی BE در +۱.۵٪ و خروج زمانی زودتر", "۸ معامله سوزانده‌شده، ≈$4.73 سود رهاشده"],
    ["R3", "انجماد وزن اطمینان + بازتنظیم روی داده اپوک-۲", "سبد ۷۵٪+: برد ۱۷.۲٪، −$10.10"],
    ["R4", "عامل جریان فقط نقش وتو؛ حذف آن از امتیاز مثبت تا عبور آزمون", "حکم بک‌تست: FAIL (pf تست ≤ 0.61)"],
    ["R5", "اعمال پارامترهای هم‌راستا با پژوهش در حالت سایه", "slAtr 1.8 در برابر 1.2؛ rrScale 0.75 در برابر 1.15"],
    ["R6", "ممنوعیت جابه‌جایی وزن تا n≥100 نمونه", "Wilson-LB با n=35 بسیار پهن است"],
    ["R7", "الگوسازی خروج از وضعیت EXPIRED برای خروج زودتر از SL", "EXPIRED مثبت (+$2.66) در برابر SL (−$12.61)"],
  ],
  [10, 48, 42]
));
body.push(faPara("اگر فقط سه اقدام R1 تا R3 اجرا شوند، بر اساس همین داده‌ها، بخش عمده ضرر قابل توقف است: سمت SHORT (۹.۷ دلار)، سوزاندن سود (۴.۷ دلار) و سبد اطمینان بالا (۱۰.۱ دلار) همگی مستقیماً هدف‌گذاری شده‌اند. در مقابل، ادامه وضع موجود یعنی تکرار چرخه «انتشار کم‌کیفیت ← کارمزد ← حد ضرر» با بودجه‌ای که هر هفته حدود ۵ دلار از حقوق حساب می‌کاهد.", { before: 120 }));

// 8) پیوست
body.push(h1("۸. پیوست — پیکربندی زنده و تحویل‌های همین دور"));
body.push(faPara("جدول ۷ پیکربندی گیت در لحظه گزارش را ثبت می‌کند تا اثر اقدامات آتی قابل سنجش باشد. همچنین طبق درخواست‌های موازی بهره‌بردار، در همین دور دو زیرساخت جدید تحویل شد: (الف) پل ارتباطی دوطرفه تلگرام — دریافت خودکار پیام‌های بهره‌بردار (long-poll)، پاسخ خودکار NEXUS-AI با تله‌متری زنده و ارسال دستی از طریق POST /api/telegram/bridge با اکشن‌های send/sync/autoreply؛ (ب) چرخش روزانه بکگراند تصاویر تلگرام (ماژول daily-skin با ۷ پوسته هفتگی) که روی بنر سیگنال، پوستر روزانه و پوستر مینیمال اعمال شد و با نوار اثبات ۷ روزه به تلگرام تحویل گردید. تصویر خلاصه این گزارش نیز مطابق قانون «همه گزارش‌ها با تصویر» تولید و ارسال شد."));
body.push(tableCaption("جدول ۷ — پیکربندی گیت در لحظه گزارش (EngineSetting: gate)"));
body.push(dataTable(
  ["کلید", "مقدار", "کلید", "مقدار"],
  [
    ["minScore", "46", "slAtrMult", "1.8"],
    ["flowShortlist", "6", "rrScale", "0.75"],
    ["flowVetoScore", "15", "beTrailPct", "1"],
    ["universeSize", "40", "ttlNearTpPct", "1.5"],
    ["maxActive", "5", "ttlExtendMax", "1"],
    ["riskPerTrade", "1%", "regimeGuard", "2"],
  ],
  [26, 24, 26, 24]
));
body.push(faPara("واژه‌نامه: امید ریاضی (Expectancy) = میانگین سود/زیان خالص هر معامله؛ ضریب سود (pf) = جمع سودها تقسیم بر جمع زیان‌ها؛ MFE = بیشترین سود شناور دوره حیات معامله؛ Wilson-LB = کران پایین بازه اطمینان ویلسون برای نرخ برد؛ BE = انتقال حد ضرر به نقطه ورود (سربه‌سر).", { before: 120 }));

// ── footers / header ──
const romanFooter = new Footer({
  children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, font: FA_FONT, color: "808080" })] })],
});
const arabicFooter = new Footer({
  children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, font: FA_FONT, color: "808080" })] })],
});
const bodyHeader = new Header({
  children: [new Paragraph({
    bidirectional: true, alignment: AlignmentType.RIGHT,
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: P.table.innerLine, space: 4 } },
    children: [faRun("گزارش تحقیق عملکرد ماژول‌ها — NEXUS//SIGNALS", { size: 16, color: "8AA094" })],
  })],
});

// ── document assembly (3 sections: cover / TOC roman / body arabic) ──
const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: FA_FONT, size: 24, color: "000000" },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: { run: { font: FA_FONT, size: 32, bold: true, color: P.headingColor }, paragraph: { spacing: { before: 360, after: 160, line: 312 } } },
      heading2: { run: { font: FA_FONT, size: 28, bold: true, color: P.headingColor }, paragraph: { spacing: { before: 240, after: 120, line: 312 } } },
    },
  },
  sections: [
    { // 1) cover — margin 0, no header/footer
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
      children: buildCoverR1RTL({
        title: "گزارش تحقیق و ارزیابی عملکرد ماژول‌ها",
        englishLabel: "NEXUS-LIVE MODULE PERFORMANCE AUDIT",
        subtitle: "یادگیری ماشین، ردیابی سیگنال‌ها و فیلتر جریان — ارزیابی مستند بر داده‌های واقعی موتور",
        metaLines: [
          "تاریخ گزارش: 11 سپتامبر 2026 — تهران",
          "اپوک ارزیابی: EPOCH-2 (ریست 8 سپتامبر 2026)",
          "پنجره داده: 35 معامله تسویه‌شده — کارمزد $2.23",
          "حقوق حساب در پایان پنجره: $92.28",
        ],
        footerLeft: "NEXUS//SIGNALS · v8.3",
        footerRight: "OPERATOR COPY — CONFIDENTIAL",
        palette: { bg: P.bg, titleColor: P.cover.titleColor, subtitleColor: P.cover.subtitleColor, metaColor: P.cover.metaColor, footerColor: P.cover.footerColor, accent: P.accent },
      }),
    },
    { // 2) TOC — roman numerals
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1701, right: 1417 }, pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN } },
      },
      footers: { default: romanFooter },
      children: [
        new Paragraph({
          bidirectional: true, alignment: AlignmentType.RIGHT,
          spacing: { before: 200, after: 240, line: 400, lineRule: "atLeast" },
          children: [faRun("فهرست مطالب", { size: 36, bold: true, color: P.headingColor })],
        }),
        new TableOfContents("فهرست", { hyperlinks: true, headingStyleRange: "1-2" }),
        new Paragraph({
          bidirectional: true, alignment: AlignmentType.RIGHT, spacing: { before: 200 },
          children: [faRun("برای به‌روزرسانی شماره صفحات، روی فهرست راست‌کلیک کنید و Update Field را برگزینید.", { size: 18, italics: true, color: "8A8A8A" })],
        }),
      ],
    },
    { // 3) body — arabic reset to 1
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1701, right: 1417 }, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } },
      },
      headers: { default: bodyHeader },
      footers: { default: arabicFooter },
      children: body,
    },
  ],
});

const OUT = "/home/z/my-project/download/NEXUS-Module-Performance-Audit-FA-0911.docx";
Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log("written:", OUT, buf.length, "bytes");
});

