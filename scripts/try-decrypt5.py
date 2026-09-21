#!/usr/bin/env python3
"""Password-mutation sweep on the 5 most plausible param configs."""
import subprocess, sys

TRUNC = "/home/z/my-project/upload/.enc-head.bin"
OUT = "/home/z/my-project/upload/.dec-head.bin"
PW = "BF0W9fnhkiws/89JoIrTW4yK1ZdO498k"

configs = [
    (["-pbkdf2", "-iter", "10000", "-md", "sha256"], "aes-256-cbc"),   # modern default
    (["-pbkdf2", "-iter", "10000", "-md", "sha256"], "aes-256-ctr"),
    (["-pbkdf2", "-iter", "100000", "-md", "sha256"], "aes-256-cbc"),
    (["-md", "sha256"], "aes-256-cbc"),                                 # legacy modern-digest
    (["-md", "md5"], "aes-256-cbc"),                                    # legacy openssl1 default
]

muts = {
    "raw": PW, "nl": PW + "\n", "crlf": PW + "\r\n", "space": " " + PW,
    "dropLast": PW[:-1], "dropFirst": PW[1:], "slashBack": PW.replace("/", "\\"),
    "urlEnc": PW.replace("/", "%2F"), "halfA": PW.split("/")[0], "halfB": PW.split("/")[1],
    "lower": PW.lower(), "upper": PW.upper(), "swapCase": PW.swapcase(),
    "noSlash": PW.replace("/", ""), "dotSlash": PW.replace("/", "."),
}

hit = None
trials = 0
for extra, c in configs:
    for mname, pw in muts.items():
        trials += 1
        subprocess.run(["openssl", "enc", "-d", f"-{c}", *extra, "-in", TRUNC, "-out", OUT, "-pass", f"pass:{pw}"],
                       capture_output=True, timeout=30)
        try:
            with open(OUT, "rb") as f:
                h = f.read(4)
        except FileNotFoundError:
            h = b""
        if h == b"PK\x03\x04":
            hit = f"cfg={extra} cipher={c} pw-mut={mname}"
            break
    if hit: break

print(f"HIT: {hit}" if hit else f"NO HIT after {trials} mutation-combos")
sys.exit(0 if hit else 1)
