#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Post-process footers (ROMAN/arabic instrText) + strip empty pgNumType."""
import zipfile, shutil, re, sys, os

SRC = "/home/z/my-project/download/گزارش-مهندسی-NX3247-و-LIVE.docx"
TMP = "/tmp/docx-patch"

shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP)
with zipfile.ZipFile(SRC) as z:
    z.extractall(TMP)

# document.xml: remove empty pgNumType (cover section)
docp = os.path.join(TMP, "word", "document.xml")
xml = open(docp, encoding="utf-8").read()
n0 = xml.count("<w:pgNumType/>")
xml = xml.replace("<w:pgNumType/>", "")
open(docp, "w", encoding="utf-8").write(xml)
print(f"document.xml: removed {n0} empty pgNumType")

# footers: identify which footer belongs to which section is hard from file names
# alone; patch by inspecting sectPr order instead: docx-js emits footer2.xml.. per
# section in order. We patch ALL footer PAGE fields: determine format by matching
# the footer rIds in document.xml sectPr order (TOC=roman, body=arabic).
rels = open(os.path.join(TMP, "word", "_rels", "document.xml.rels"), encoding="utf-8").read()
rid2file = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="(footer\d+\.xml)"', rels))
sect_footers = re.findall(r'<w:footerReference w:type="default" r:id="(rId\d+)"/>', xml)
print("sect footers in order:", [(r, rid2file.get(r)) for r in sect_footers])
fmts = ["ROMAN", "arabic"]  # section2 (TOC) then section3 (body)
for i, rid in enumerate(sect_footers[:2]):
    f = rid2file.get(rid)
    if not f:
        continue
    fp = os.path.join(TMP, "word", f)
    fx = open(fp, encoding="utf-8").read()
    fx2, n = re.subn(r'(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)',
                     rf'\1 PAGE \\* {fmts[i]} \\* MERGEFORMAT \2', fx)
    open(fp, "w", encoding="utf-8").write(fx2)
    print(f"{f}: patched {n} PAGE fields -> {fmts[i]}")

# rezip
out = SRC
tmpzip = "/tmp/patched.docx"
if os.path.exists(tmpzip):
    os.remove(tmpzip)
with zipfile.ZipFile(tmpzip, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(TMP):
        for fn in files:
            full = os.path.join(root, fn)
            arc = os.path.relpath(full, TMP)
            z.write(full, arc)
shutil.move(tmpzip, out)
print("patched docx saved:", out)
