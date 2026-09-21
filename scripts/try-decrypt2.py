#!/usr/bin/env python3
"""Wider openssl enc parameter sweep against the .enc NEXUS snapshot backup.
Success = first 4 decrypted bytes are 'PK\\x03\\x04'."""
import subprocess, itertools, base64, urllib.parse, os, sys

ENC = "/home/z/my-project/upload/nexus-snapshot-20260908-193109.zip.enc"
OUT = "/home/z/my-project/upload/decrypted-test.zip"
PW_RAW = "BF0W9fnhkiws/89JoIrTW4yK1ZdO498k"

pw_variants = {
    "raw": PW_RAW,
    "urldec": urllib.parse.unquote(PW_RAW),
    "b64dec": base64.b64decode(PW_RAW + "==").decode("utf-8", "ignore"),
    "stripped": PW_RAW.strip(),
}

ciphers = [
    "aes-256-cbc", "aes-256-ctr", "aes-256-cfb", "aes-256-ofb",
    "aes-256-cfb1", "aes-256-cfb8", "aes-192-cbc", "aes-128-cbc",
    "aes-128-ctr", "camellia-256-cbc", "des3", "rc4", "chacha20",
]

def run_decrypt(cipher, extra, pw):
    cmd = ["openssl", "enc", "-d", f"-{cipher}", *extra,
           "-in", ENC, "-out", OUT, "-pass", f"pass:{pw}"]
    try:
        subprocess.run(cmd, capture_output=True, timeout=60)
    except subprocess.TimeoutExpired:
        return False
    try:
        with open(OUT, "rb") as f:
            return f.read(4) == b"PK\x03\x04"
    except FileNotFoundError:
        return False

trials = 0
# 1) pbkdf2 with varied iter counts and digests
for it in (10000, 2048, 50000, 100000, 1000000):
    for md in ("sha256", "sha1", "sha512"):
        for c in ciphers:
            for pname, pw in pw_variants.items():
                trials += 1
                if run_decrypt(c, ["-pbkdf2", "-iter", str(it), "-md", md], pw):
                    print(f"HIT: pbkdf2 iter={it} md={md} cipher={c} pw={pname}")
                    sys.exit(0)
# 2) legacy EVP_BytesToKey (openssl 1.x default) with digests
for md in ("md5", "sha1", "sha256", "sha512"):
    for c in ciphers:
        for pname, pw in pw_variants.items():
            trials += 1
            if run_decrypt(c, ["-md", md], pw):
                print(f"HIT: legacy md={md} cipher={c} pw={pname}")
                sys.exit(0)

print(f"NO HIT after {trials} combos")
sys.exit(1)
