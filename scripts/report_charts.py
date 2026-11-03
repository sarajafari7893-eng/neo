#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Report charts (Persian labels, DS-1 palette) for the forensic docx."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.font_manager as fm
import matplotlib.pyplot as plt
import arabic_reshaper
from bidi.algorithm import get_display
import os

fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
plt.rcParams['font.sans-serif'] = ['DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

OUT = "/home/z/my-project/scripts/report-assets"
os.makedirs(OUT, exist_ok=True)

def fa(t):
    return get_display(arabic_reshaper.reshape(t))

DEEP = "#0B1C2C"; ACCENT = "#529286"; GREY = "#90989F"; RED = "#B0564F"; SAND = "#C9A84C"

# ── Chart 1: daily signals + TP rate (Oct 17 → Nov 3) ──
days = ["10-17","10-18","10-19","10-20","10-21","10-22","10-23","10-24","10-25",
        "10-26","10-27","10-28","10-29","10-30","10-31","11-01","11-02","11-03"]
n_sig =   [91,89,58,61,40,31,55,53,44,13,0,0,31,18,10,8,7,3]
tp_rate = [26.4,30.3,22.4,16.4,45.0,61.3,41.8,26.4,27.3,7.7,0,0,51.6,11.1,10.0,0.0,0.0,33.3]

fig, ax1 = plt.subplots(figsize=(9.2, 4.4), constrained_layout=True)
ax1.bar(days, n_sig, color=ACCENT, alpha=0.85, width=0.62, label=fa("تعداد سیگنال"))
ax1.set_ylabel(fa("سیگنال در روز"), fontsize=10)
ax1.tick_params(axis='x', rotation=60, labelsize=8)
ax1.set_ylim(0, 100)
ax2 = ax1.twinx()
ax2.plot(days, tp_rate, color=SAND, marker="o", ms=4, lw=1.8, label=fa("نرخ رسیدن به TP ٪"))
ax2.set_ylabel(fa("نرخ TP (٪)"), fontsize=10)
ax2.set_ylim(0, 70)
lines1, labels1 = ax1.get_legend_handles_labels()
lines2, labels2 = ax2.get_legend_handles_labels()
ax1.legend(lines1 + lines2, labels1 + labels2, loc="upper center",
           bbox_to_anchor=(0.5, 1.16), ncol=2, frameon=False, fontsize=10)
ax1.set_title(fa("شکل ۱ — سیگنال‌های روزانه و نرخ TP (حملهٔ ۲۵ اکتبر، گپ ۲۷–۲۸، سقوط پس از اتصال مجدد ۳۰ اکتبر)"),
              fontsize=10.5, color=DEEP, pad=26)
for spine in ("top",):
    ax1.spines[spine].set_visible(False); ax2.spines[spine].set_visible(False)
fig.savefig(f"{OUT}/chart1_daily.png", dpi=170)
plt.close(fig)

# ── Chart 2: two-stage delay chain ──
fig, (axa, axb) = plt.subplots(1, 2, figsize=(9.2, 4.0), constrained_layout=True)
weeks = ["هفتهٔ ۴۲", "هفتهٔ ۴۳", "هفتهٔ ۴۴"]
wk_avg = [166.8, 204.8, 309.7]
wk_over = [10.1, 47.5, 40.0]
bars = axa.bar(weeks, wk_avg, color=[ACCENT, SAND, RED], width=0.5)
axa.set_ylabel(fa("میانگین تأخیر رادار→سیگنال (ثانیه)"), fontsize=9)
axa.axhline(90, color=DEEP, ls="--", lw=1)
axa.text(2.35, 100, fa("سقف ۹۰ث"), fontsize=8, color=DEEP, ha="right")
for b, v in zip(bars, wk_avg):
    axa.text(b.get_x()+b.get_width()/2, v+8, f"{v:.0f}", ha="center", fontsize=9, color=DEEP)
axa.set_title(fa("مرحلهٔ ۱ — موتور (FillLedger)"), fontsize=10, color=DEEP)
axa.set_ylim(0, 360)

syms = ["NX3239", "NX3245", "NX3238", "NX3246\n(موتور)"]
secs = [2.5, 570, 3989, 2354]
colors = [ACCENT, SAND, RED, RED]
bars = axb.bar(syms, secs, color=colors, width=0.5)
axb.set_ylabel(fa("تأخیر تشخیص (ثانیه)"), fontsize=9)
axb.set_yscale("log")
axb.axhline(90, color=DEEP, ls="--", lw=1)
for b, v in zip(bars, secs):
    axb.text(b.get_x()+b.get_width()/2, v*1.15, f"{v:.0f}s" if v>=10 else f"{v:.1f}s", ha="center", fontsize=8.5, color=DEEP)
axb.set_title(fa("مرحلهٔ ۲ — پل (دیتکت) و بدترین مورد موتور"), fontsize=10, color=DEEP)
axb.set_ylim(1, 9000)
fig.suptitle(fa("شکل ۲ — زنجیرهٔ تأخیر دولایه: موتور دیر سیگنال می‌دهد، پل دیر می‌بیند"),
             fontsize=11, color=DEEP)
fig.savefig(f"{OUT}/chart2_delay.png", dpi=170)
plt.close(fig)
print("charts saved:", os.listdir(OUT))
