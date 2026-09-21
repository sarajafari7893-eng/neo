#!/usr/bin/env python3
# docx skill post-process for the Persian audit report:
#  1) strip empty <w:pgNumType/> (WPS confusion) from all sectPr
#  2) patch footer PAGE fields: first footer-bearing sectPr (TOC) → ROMAN,
#     second (body) → arabic  (WPS ignores pgNumType fmt)
import re, sys, zipfile, shutil, os

path = sys.argv[1]
tmp = path + ".tmp"
shutil.copy(path, tmp)

with zipfile.ZipFile(tmp, "r") as z:
    names = z.namelist()
    data = {n: z.read(n) for n in names}

doc = data["word/document.xml"].decode("utf-8")

# 1) remove EMPTY pgNumType only (has no attributes)
before = doc
doc = doc.replace("<w:pgNumType/>", "")
removed = before.count("<w:pgNumType/>")

# footerReference ids in document order
fids = re.findall(r'<w:footerReference[^>]*r:id="(rId\d+)"', doc)
rels = data["word/_rels/document.xml.rels"].decode("utf-8")
id2file = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="(footer\d+\.xml)"', rels))

def patch_footer(fname, fmt):
    key = "word/" + fname
    xml = data[key].decode("utf-8")
    # docx-js emits <w:instrText xml:space="preserve">PAGE</w:instrText> (possibly split)
    patched = 0
    def repl(m):
        nonlocal patched
        patched += 1
        return m.group(1) + f"PAGE \\* {fmt} \\* MERGEFORMAT" + m.group(2)
    xml2 = re.sub(r'(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)', lambda m: (repl(m)), xml)
    data[key] = xml2.encode("utf-8")
    return patched

seen, results = [], []
for rid in fids:
    f = id2file.get(rid)
    if f and f not in seen:
        seen.append(f)
for i, f in enumerate(seen):
    fmt = "ROMAN" if i == 0 else "arabic"
    results.append((f, fmt, patch_footer(f, fmt)))

data["word/document.xml"] = doc.encode("utf-8")

with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
    for n in names:
        z.writestr(n, data[n])
os.remove(tmp)
print(f"pgNumType removed: {removed}; footers patched: {results}")
