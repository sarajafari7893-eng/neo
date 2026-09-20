#!/usr/bin/env python3
# ── NEXUS//SIGNALS RECOVERY-RESTORE (v10.11, operator mandate 2026-09-17: «دستورات بازیابی
# رو در جایی امن نگهدار تا با ریست شدن ویا پاک شدن سندباکس قابل استفاده و اجرای خودکار باشه») ──
# Self-contained wipe-recovery: works on a FRESH sandbox (only python3 + internet required).
#   MODE 1  local archive : recovery-restore.sh <snapshot.enc>
#   MODE 2  from channel  : recovery-restore.sh --from-channel <RECOVERY-INDEX.txt> [part-dir]
# Secrets (NEVER stored in the public channel, operator holds them):
#   TELEGRAM_BOT_TOKEN  +  BACKUP_PASSPHRASE   → env vars or prompted.
# Restore target: /home/z/my-project (backs aside any existing db/custom.db first).
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = "/home/z/my-project"
STAGE = "/home/z/my-project/restore-staging/recovery-" + time.strftime("%Y%m%d-%H%M%S")
CHUNK = 1 << 20


def ask(name: str) -> str:
    v = os.environ.get(name, "")
    if not v:
        import getpass

        v = getpass.getpass(f"{name}: ")
    return v.strip()


def api(token: str, method: str, **fields) -> dict:
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=120).read())


def download(token: str, file_id: str, dest: str) -> str:
    got = api(token, "getFile", file_id=file_id)
    if not got.get("ok"):
        raise RuntimeError(f"getFile failed: {got.get('description')}")
    fpath = got["result"]["file_path"]
    url = f"https://api.telegram.org/file/bot{token}/{fpath}"
    urllib.request.urlretrieve(url, dest)  # bot file API caps at 20MB — index parts are 19MB
    return dest


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def latest_index_block(path: str) -> dict:
    blocks = open(path, encoding="utf-8").read().split("=" * 48)
    for block in reversed(blocks):
        block = block.strip()
        if block.startswith("{"):
            return json.loads(block)
    raise RuntimeError("no index block found")


def stage_from_channel(token: str, idx: dict, part_dir: str) -> str:
    os.makedirs(part_dir, exist_ok=True)
    enc_path = os.path.join(part_dir, idx["encFile"])
    parts = []
    for i, p in enumerate(idx["parts"], 1):
        dest = os.path.join(part_dir, f".part-{i:03d}")
        print(f"  part {i}/{len(idx['parts'])}: {p['name']}")
        download(token, p["fileId"], dest)
        s = sha256(dest)
        if p.get("sha256") and s != p["sha256"]:
            raise RuntimeError(f"part {i} sha256 mismatch")
        parts.append(dest)
    with open(enc_path, "wb") as out:
        for dest in parts:
            with open(dest, "rb") as f:
                shutil.copyfileobj(f, out, CHUNK)
            os.remove(dest)
    got = sha256(enc_path)
    if got != idx["encSha256"]:
        raise RuntimeError(f"reassembled sha256 mismatch: {got[:12]}… != {idx['encSha256'][:12]}…")
    print(f"reassembled {idx['encFile']} — sha256 verified ({idx['encSha256'][:12]}…)")
    return enc_path


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    token = ask("TELEGRAM_BOT_TOKEN")
    enc_path = sys.argv[1]
    part_dir = os.path.join(os.path.dirname(os.path.abspath(enc_path)), "parts")
    if enc_path == "--from-channel":
        idx_path = sys.argv[2] if len(sys.argv) > 2 else "RECOVERY-INDEX.txt"
        idx = latest_index_block(idx_path)
        print(f"index block: {idx['stamp']} · {idx['encFile']} ({idx.get('encBytes', '?')} bytes)")
        enc_path = stage_from_channel(token, idx, part_dir)
    if not os.path.isfile(enc_path):
        print(f"ABORT: {enc_path} not found")
        return 1
    passphrase = ask("BACKUP_PASSPHRASE")

    def step(name: str, ok: bool, detail: str = "") -> bool:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}{' — ' + detail if detail else ''}")
        return ok

    os.makedirs(STAGE, exist_ok=True)
    env = dict(os.environ, BACKUP_PASSPHRASE=passphrase)
    plain = os.path.join(STAGE, "snapshot.zip")
    r = subprocess.run(
        ["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000",
         "-in", enc_path, "-out", plain, "-pass", "env:BACKUP_PASSPHRASE"],
        env=env, capture_output=True,
    )
    if not step("decrypt AES-256-CBC/PBKDF2-200k", r.returncode == 0 and os.path.getsize(plain) > 1_000_000):
        return 1
    r = subprocess.run(["unzip", "-q", "-o", plain, "-d", STAGE], capture_output=True)
    if not step("unzip", r.returncode == 0):
        return 1
    man = os.path.join(STAGE, "backups/MANIFEST.json")
    ok = os.path.isfile(man)
    step("MANIFEST present", ok)
    if not ok:
        return 1
    env_src = os.path.join(STAGE, ".env")
    ok = os.path.isfile(env_src) and os.path.getsize(env_src) > 0
    step(".env present (secrets chain)", ok)
    if not ok:
        return 1
    os.chmod(env_src, 0o600)
    db_src = os.path.join(STAGE, "db/custom.db")
    ok = os.path.isfile(db_src) and os.path.getsize(db_src) > 1_000_000
    step("db/custom.db present", ok)
    if not ok:
        return 1

    print("restoring into", ROOT)
    ts = time.strftime("%Y%m%d-%H%M%S")
    os.makedirs(f"{ROOT}/db", exist_ok=True)
    if os.path.exists(f"{ROOT}/db/custom.db"):
        shutil.copy2(f"{ROOT}/db/custom.db", f"{ROOT}/db/custom.db.pre-recovery-{ts}")
    shutil.copy2(db_src, f"{ROOT}/db/custom.db")
    shutil.copy2(env_src, f"{ROOT}/.env")
    os.chmod(f"{ROOT}/.env", 0o600)
    for rel in ("backups/MANIFEST.json", "backups/calibration-latest.json", "worklog.md"):
        src = os.path.join(STAGE, rel)
        if os.path.isfile(src):
            dst = os.path.join(ROOT, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    for rel in (
        "shadow-veto.jsonl", "shadow-veto-latest.json", "shadow-veto-telemetry.json",
        "shadow-veto-telemetry.jsonl", "fourpack-journal.jsonl", "fourpack-latest.json",
        "gate-journal.jsonl", "rawcal-telemetry.jsonl", "rawcal-run-heartbeat.txt",
        "sv-cohort-freeze.json",
    ):
        src = os.path.join(STAGE, ".data", rel)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(ROOT, ".data", rel))
    for ring in ("shadow-veto.jsonl.old", "fourpack-journal.jsonl.old"):
        g = os.path.join(STAGE, ".data", ring)
        for src in [g] + [os.path.join(STAGE, ".data", f) for f in os.listdir(os.path.join(STAGE, ".data")) if f.startswith(ring + ".")] if os.path.isdir(os.path.join(STAGE, ".data")) else []:
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(ROOT, ".data", os.path.basename(src)))
    step("db + .env + .data journals + manifest restored", True)

    if os.path.isdir(os.path.join(STAGE, "scripts")):
        shutil.copytree(os.path.join(STAGE, "scripts"), os.path.join(ROOT, "scripts"), dirs_exist_ok=True)
        step("scripts dir refreshed", True)
    print("next steps (machine with bun): cd", ROOT, "&& bun install && bash scripts/dev-up.sh")
    print("then verify canary: pulse/advisor/terminal/rawcal all 200 (see RECOVERY-RUNBOOK.md §5)")
    print("RECOVERY COMPLETE — staging kept at", STAGE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
