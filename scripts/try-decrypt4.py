#!/usr/bin/env python3
"""Final sweep: multi-magic detection + first-bytes census across top combos."""
import subprocess, base64, urllib.parse, sys, collections

ENC = "/home/z/my-project/upload/nexus-snapshot-20260908-193109.zip.enc"
TRUNC = "/home/z/my-project/upload/.enc-head.bin"
OUT = "/home/z/my-project/upload/.dec-head.bin"
PW_RAW = "BF0W9fnhkiws/89JoIrTW4yK1ZdO498k"

MAGICS = {
    b"PK\x03\x04": "zip", b"\x1f\x8b": "gzip", b"7z\xbc\xaf\x27\x1c": "7z",
    b"\xfd7zXZ": "xz", b"BZh": "bzip2", b"\x28\xb5\x2f\xfd": "zstd",
    b"\x04\x22\x4d\x18": "lz4", b"Rar!": "rar",
}

pw_variants = {"raw": PW_RAW, "urldec": urllib.parse.unquote(PW_RAW), "stripped": PW_RAW.strip()}
try:
    pw_variants["b64dec"] = base64.b64decode(PW_RAW + "=" * (-len(PW_RAW) % 4)).decode("utf-8", "ignore")
except Exception:
    pass

def head_bytes(n=8):
    with open(OUT, "rb") as f:
        return f.read(n)

def try_combo(cipher, extra, pw):
    cmd = ["openssl", "enc", "-d", f"-{cipher}", *extra, "-in", TRUNC, "-out", OUT, "-pass", f"pass:{pw}"]
    subprocess.run(cmd, capture_output=True, timeout=30)
    return head_bytes()

ciphers = ["aes-256-cbc", "aes-256-ctr", "aes-256-cfb", "aes-256-ofb",
           "aes-192-cbc", "aes-128-cbc", "des3", "camellia-256-cbc"]

census = collections.defaultdict(list)
hit = None
trials = 0

def check(h, combo):
    for magic, name in MAGICS.items():
        if h.startswith(magic):
            return f"{name} | {combo}"
    return None

for it in (10000, 2048, 100000):
    for md in ("sha256", "sha1"):
        for c in ciphers:
            for pname, pw in pw_variants.items():
                trials += 1
                h = try_combo(c, ["-pbkdf2", "-iter", str(it), "-md", md], pw)
                r = check(h, f"pbkdf2 iter={it} md={md} c={c} pw={pname}")
                if r: hit = r; break
                census[h[:4].hex()[:12]].append(trials)
            if hit: break
        if hit: break
    if hit: break

if not hit:
    for md in ("md5", "sha1", "sha256"):
        for c in ciphers:
            for pname, pw in pw_variants.items():
                trials += 1
                h = try_combo(c, ["-md", md], pw)
                r = check(h, f"legacy md={md} c={c} pw={pname}")
                if r: hit = r; break
                census[h[:4].hex()[:12]].append(trials)
            if hit: break
        if hit: break

if hit:
    print(f"HIT: {hit}")
else:
    print(f"NO HIT after {trials}. Top first-byte patterns seen (garbage expected to be all-distinct):")
    for k, v in sorted(census.items(), key=lambda kv: -len(kv[1]))[:8]:
        print(f"  {k}: {len(v)}x (trial ids {v[:5]})")
sys.exit(0 if hit else 1)
