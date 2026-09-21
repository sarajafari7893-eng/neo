#!/usr/bin/env python3
# ── RECOVERY DRILL 2026-09-17 — exercises the wipe-recovery path end-to-end
# WITHOUT touching live files: index → getFile part downloads → reassembly →
# sha256 verify → AES decrypt → unzip staging → MANIFEST/db integrity.
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request

ROOT = "/home/z/my-project"
STAGE = "/tmp/recovery-drill-" + str(os.getpid())
CHUNK = 1 << 20


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(CHUNK), b""):
            h.update(c)
    return h.hexdigest()


env = {}
with open(f"{ROOT}/.env") as f:
    for line in f:
        if "=" in line and not line.startswith("#"):
            k, v = line.strip().split("=", 1)
            env[k] = v
TOKEN = env["TELEGRAM_BOT_TOKEN"]
PASS = env["BACKUP_PASSPHRASE"]

blocks = open(f"{ROOT}/backups/RECOVERY-INDEX-latest.txt").read().split("=" * 48)
idx = None
for b in reversed(blocks):
    b = b.strip()
    if b.startswith("{"):
        idx = json.loads(b)
        break
assert idx, "no index block"
print(f"[1] index: stamp={idx['stamp']} encFile={idx['encFile']} parts={len(idx['parts'])}")

os.makedirs(STAGE, exist_ok=True)
parts = []
ok_all = True
for i, p in enumerate(idx["parts"], 1):
    got = json.loads(urllib.request.urlopen(
        urllib.request.Request(
            f"https://api.telegram.org/bot{TOKEN}/getFile",
            data=f"file_id={p['fileId']}".encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        ), timeout=120).read())
    fp = got["result"]["file_path"]
    dest = f"{STAGE}/.part-{i}"
    urllib.request.urlretrieve(f"https://api.telegram.org/file/bot{TOKEN}/{fp}", dest)
    s = sha256(dest)
    ok = s == p["sha256"]
    ok_all &= ok
    print(f"[2] part {i}: {p['name']} sha256 {'MATCH' if ok else 'MISMATCH'} ({len(p['sha256'])} hex)")
    parts.append(dest)
assert ok_all, "part sha mismatch"

enc = f"{STAGE}/{idx['encFile']}"
with open(enc, "wb") as out:
    for d in parts:
        with open(d, "rb") as f:
            shutil.copyfileobj(f, out, CHUNK)
re_sha = sha256(enc)
print(f"[3] reassembled: {re_sha[:12]}… vs index {idx['encSha256'][:12]}… → {'MATCH' if re_sha == idx['encSha256'] else 'MISMATCH'}")
assert re_sha == idx["encSha256"]

e = dict(os.environ, BACKUP_PASSPHRASE=PASS)
r = subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000",
                    "-in", enc, "-out", f"{STAGE}/snapshot.zip", "-pass", "env:BACKUP_PASSPHRASE"],
                   env=e, capture_output=True)
print(f"[4] decrypt: rc={r.returncode} size={os.path.getsize(f'{STAGE}/snapshot.zip')}")
assert r.returncode == 0
r = subprocess.run(["unzip", "-q", "-o", f"{STAGE}/snapshot.zip", "-d", f"{STAGE}/x"], capture_output=True)
print(f"[5] unzip: rc={r.returncode}")
for req in ("x/db/custom.db", "x/.env", "x/backups/MANIFEST.json", "x/backups/calibration-latest.json",
            "x/worklog.md", "x/.data/shadow-veto.jsonl", "x/scripts/recovery-restore.sh",
            "x/.data/rawcal-run-heartbeat.txt"):
    ok = os.path.isfile(f"{STAGE}/{req}")
    ok_all &= ok
    print(f"[6] {'PASS' if ok else 'FAIL'} {req}")
env_sha = subprocess.run(["sha256sum", f"{STAGE}/x/.env"], capture_output=True, text=True).stdout.split()[0]
man = json.load(open(f"{STAGE}/x/backups/MANIFEST.json"))
print(f"[7] .env sha vs MANIFEST envSha256: {'MATCH' if env_sha == man.get('envSha256') else 'MISMATCH'}")
ok_all &= env_sha == man.get("envSha256")
shutil.rmtree(STAGE, ignore_errors=True)
print("DRILL", "PASS — autonomous wipe-recovery path VERIFIED" if ok_all else "FAIL")
sys.exit(0 if ok_all else 1)
