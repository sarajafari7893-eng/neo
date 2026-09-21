#!/usr/bin/env python3
"""Fast openssl-enc parameter sweep: decrypt only the first 16KB per combo.
Includes a self-test to validate the pipeline before the sweep."""
import subprocess, base64, urllib.parse, sys, os

ENC = "/home/z/my-project/upload/nexus-snapshot-20260908-193109.zip.enc"
TRUNC = "/home/z/my-project/upload/.enc-head.bin"
OUT = "/home/z/my-project/upload/.dec-head.bin"
PW_RAW = "BF0W9fnhkiws/89JoIrTW4yK1ZdO498k"

with open(ENC, "rb") as f:
    head = f.read(16384)
with open(TRUNC, "wb") as f:
    f.write(head)

pw_variants = {"raw": PW_RAW, "urldec": urllib.parse.unquote(PW_RAW), "stripped": PW_RAW.strip()}
try:
    pw_variants["b64dec"] = base64.b64decode(PW_RAW + "=" * (-len(PW_RAW) % 4)).decode("utf-8", "ignore")
except Exception:
    pass

def head4(cipher, extra, pw, src=TRUNC):
    cmd = ["openssl", "enc", "-d", f"-{cipher}", *extra, "-in", src, "-out", OUT, "-pass", f"pass:{pw}"]
    r = subprocess.run(cmd, capture_output=True, timeout=30)
    try:
        with open(OUT, "rb") as f:
            return f.read(4)
    except FileNotFoundError:
        return b""

# ── SELF-TEST: encrypt a known ZIP-like payload with each pipeline combo, decrypt back ──
test_src, test_enc, test_out = "/tmp/zt.zip", "/tmp/zt.zip.enc", "/tmp/zt.out"
with open(test_src, "wb") as f:
    f.write(b"PK\x03\x04" + b"A" * 4096)
ok = subprocess.run(["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-in", test_src, "-out", test_enc, "-pass", f"pass:{PW_RAW}"], capture_output=True)
back = subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-in", test_enc, "-out", test_out, "-pass", f"pass:{PW_RAW}"], capture_output=True)
with open(test_out, "rb") as f:
    assert f.read(4) == b"PK\x03\x04", "SELF-TEST FAILED — pipeline broken"
print("self-test OK (pbkdf2 round-trip verified)")

ciphers = ["aes-256-cbc", "aes-256-ctr", "aes-256-cfb", "aes-256-ofb", "aes-256-cfb1",
           "aes-256-cfb8", "aes-192-cbc", "aes-128-cbc", "aes-128-ctr",
           "camellia-256-cbc", "des3", "rc4", "chacha20", "seed-cbc", "bf-cbc", "cast5-cbc"]

trials, hit = 0, None
for it in (10000, 2048, 50000, 100000, 1000000, 1):
    for md in ("sha256", "sha1", "sha512"):
        for c in ciphers:
            for pname, pw in pw_variants.items():
                trials += 1
                if head4(c, ["-pbkdf2", "-iter", str(it), "-md", md], pw) == b"PK\x03\x04":
                    hit = f"pbkdf2 iter={it} md={md} cipher={c} pw={pname}"
                    break
            if hit: break
        if hit: break
    if hit: break
if not hit:
    for md in ("md5", "sha1", "sha256", "sha512", "sha384", "whirlpool"):
        for c in ciphers:
            for pname, pw in pw_variants.items():
                trials += 1
                if head4(c, ["-md", md], pw) == b"PK\x03\x04":
                    hit = f"legacy md={md} cipher={c} pw={pname}"
                    break
            if hit: break
        if hit: break
    # openssl 3.x sometimes needs -legacy for old ciphers (bf/cast/des)
    if not hit:
        for md in ("md5", "sha1"):
            for c in ("bf-cbc", "cast5-cbc", "des3", "des-cbc", "rc4", "rc2-cbc", "seed-cbc"):
                trials += 1
                if head4(c, ["-md", md, "-provider", "legacy"], pw_variants["raw"]) == b"PK\x03\x04":
                    hit = f"legacy-provider md={md} cipher={c}"
                    break

if hit:
    print(f"HIT after {trials}: {hit}")
else:
    print(f"NO HIT after {trials} combos")
sys.exit(0 if hit else 1)
