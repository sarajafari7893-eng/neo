#!/usr/bin/env python3
"""Patch docx per toc.md: footer PAGE format switches (ROMAN/arabic) + strip empty pgNumType."""
import re, shutil, sys, zipfile, os

path = sys.argv[1]
tmp = path + ".patch.zip"

with zipfile.ZipFile(path, "r") as zin:
    names = zin.namelist()
    data = {n: zin.read(n) for n in names}

doc = data["word/document.xml"].decode("utf-8")

# 1) strip empty pgNumType (cover section confusion in WPS)
doc_before = doc
doc = re.sub(r"<w:pgNumType/>", "", doc)

# 2) footerReference rIds in document order
ref_ids = re.findall(r'<w:footerReference[^>]*r:id="(rId\d+)"', doc)
rels = data["word/_rels/document.xml.rels"].decode("utf-8")
rid_to_target = dict(re.findall(r'<Relationship[^>]*Id="(rId\d+)"[^>]*Target="([^"]+)"', rels))

ordered_targets = []
for rid in ref_ids:
    t = rid_to_target.get(rid)
    if t and t not in ordered_targets:
        ordered_targets.append(t)

if not ordered_targets:
    print("WARN: no footerReference found"); sys.exit(0)

fmt_switches = ["ROMAN"] + ["arabic"] * (len(ordered_targets) - 1)

for target, fmt in zip(ordered_targets, fmt_switches):
    fname = "word/" + target.lstrip("/")
    if fname not in data:
        print("WARN: missing", fname); continue
    xml = data[fname].decode("utf-8")
    patched = re.sub(
        r"(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)",
        lambda m: m.group(1) + " PAGE \\* " + fmt + " \\* MERGEFORMAT " + m.group(2),
        xml,
    )
    if patched != xml:
        data[fname] = patched.encode("utf-8")
        print("PATCHED", fname, "->", fmt)
    else:
        print("NO-PAGE-FIELD", fname)

data["word/document.xml"] = doc.encode("utf-8")
if doc != doc_before:
    print("REMOVED empty pgNumType")

with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for n in names:
        zout.writestr(n, data[n])
shutil.move(tmp, path)
print("OK", path)
