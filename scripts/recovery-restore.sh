#!/usr/bin/env python3
# ── NEXUS//SIGNALS RECOVERY-RESTORE (v10.16, audit task 4-g: FULL-TREE restore contract) ──
# Self-contained wipe-recovery: works on a FRESH sandbox (only python3 + openssl + unzip + internet).
#   MODE 1  local archive : recovery-restore.sh <snapshot.enc>      ← tokenless: needs ONLY BACKUP_PASSPHRASE
#   MODE 2  from channel  : recovery-restore.sh --from-channel <RECOVERY-INDEX.txt>   (asks TELEGRAM_BOT_TOKEN)
# Secrets (NEVER stored in the public channel, operator holds them):
#   TELEGRAM_BOT_TOKEN  — MODE 2 only (channel re-download)
#   BACKUP_PASSPHRASE   — both modes (AES-256-CBC/PBKDF2-200k decrypt)
# v10.16 contract (audit P1: v10.11 restored only db/.env/journals/scripts → `bun install` could
#   never work on the wiped tree): the snapshot zip carries the FULL environment (backup.sh v3.4
#   inventory — src, prisma, mini-services, docs, scripts, .zscripts, assets, all root configs,
#   Caddyfile), so the restore now rebuilds the WHOLE tree, guided by MANIFEST "expectInZip" +
#   a static inventory union. Optional items absent from the zip → [WARN]; core items absent
#   (src/prisma/scripts/package.json/next.config.ts/tsconfig.json) → [FAIL] + INCOMPLETE exit 1.
# Restore target: ${NEXUS_ROOT:-/home/z/my-project} (backs aside any existing db/custom.db first).
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = os.environ.get("NEXUS_ROOT", "/home/z/my-project")
STAGE = os.path.join(ROOT, "restore-staging", "recovery-" + time.strftime("%Y%m%d-%H%M%S"))
CHUNK = 1 << 20

# v10.16: core inventory — a tree missing any of these cannot `bun install && bunx prisma generate`
CORE_DIRS = ("src", "prisma", "scripts")
CORE_FILES = ("package.json", "next.config.ts", "tsconfig.json")
# v10.16: static inventory (backup.sh v3.4 zip list) — unioned with MANIFEST expectInZip
RESTORE_DIRS = ["src", "prisma", "scripts", "mini-services", "docs", "assets", ".zscripts", "public"]
RESTORE_FILES = [
    "package.json", "bun.lock", "next.config.ts", "tsconfig.json", "components.json",
    "eslint.config.mjs", "postcss.config.mjs", "Caddyfile",
]


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
    enc_path = sys.argv[1]
    part_dir = os.path.join(os.path.dirname(os.path.abspath(enc_path)), "parts")
    if enc_path == "--from-channel":
        # v10.16: the token ask lives ONLY in the channel branch — MODE 1 (local archive)
        # must run fully tokenless (no TELEGRAM_BOT_TOKEN env, no prompt).
        token = ask("TELEGRAM_BOT_TOKEN")
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

    # ── critical small files first (db aside-protected, secrets 0600) ──
    print("restoring into", ROOT)
    ts = time.strftime("%Y%m%d-%H%M%S")
    os.makedirs(f"{ROOT}/db", exist_ok=True)
    if os.path.exists(f"{ROOT}/db/custom.db"):
        shutil.copy2(f"{ROOT}/db/custom.db", f"{ROOT}/db/custom.db.pre-recovery-{ts}")
    shutil.copy2(db_src, f"{ROOT}/db/custom.db")
    shutil.copy2(env_src, f"{ROOT}/.env")
    os.chmod(f"{ROOT}/.env", 0o600)
    step(f"db/custom.db restored (pre-restore copy aside: custom.db.pre-recovery-{ts}) + .env 0600", True)

    # ── v10.16 FULL-TREE RESTORE — guided by MANIFEST "expectInZip", unioned with the
    # static backup.sh v3.4 inventory. dirs_exist_ok=True so it merges into (not nukes)
    # any pre-existing tree; copy2 preserves mtimes/perms.
    expect: list = []
    try:
        expect = json.load(open(man, encoding="utf-8")).get("expectInZip") or []
    except Exception:
        step("MANIFEST expectInZip unreadable — using static inventory only", True)
    for e in expect:
        e = e.replace("zscripts-marker:", "")  # hidden-dir marker convention in older manifests
        if e in (".env", "db/custom.db", "worklog.md"):
            continue  # already restored above / handled below explicitly
        if e.startswith("backups/") or e in ("MANIFEST.json", "calibration-latest.json"):
            continue  # manifests handled below explicitly
        if e.endswith("/"):
            d = e.rstrip("/")
            if d not in RESTORE_DIRS:
                RESTORE_DIRS.append(d)
        elif "/" in e:
            # relative-path file entry (e.g. prisma/schema.prisma) — restore at the same rel path
            if e not in RESTORE_FILES:
                RESTORE_FILES.append(e)
        else:
            f = os.path.basename(e)
            if f not in RESTORE_FILES:
                RESTORE_FILES.append(f)
    incomplete: list = []
    for d in RESTORE_DIRS:
        srcd = os.path.join(STAGE, d)
        if os.path.isdir(srcd):
            shutil.copytree(srcd, os.path.join(ROOT, d), dirs_exist_ok=True)
            n = sum(len(fn) for _, _, fn in os.walk(srcd))
            step(f"restored dir {d}/ ({n} files)", True)
        elif d in CORE_DIRS:
            step(f"restored dir {d}/", False, "CORE dir absent from snapshot zip")
            incomplete.append(d + "/")
        else:
            print(f"[WARN] {d}/ absent in snapshot zip — optional, skipped")
    for f in RESTORE_FILES:
        srcf = os.path.join(STAGE, f)
        if os.path.isfile(srcf):
            dst = os.path.join(ROOT, f)
            os.makedirs(os.path.dirname(dst) or ROOT, exist_ok=True)
            shutil.copy2(srcf, dst)
            step(f"restored file {f}", True)
        elif f in CORE_FILES:
            step(f"restored file {f}", False, "CORE file absent from snapshot zip")
            incomplete.append(f)
        else:
            print(f"[WARN] {f} absent in snapshot zip — optional, skipped")

    # .data state journals — INCLUDING rotated .old / .old.<ts> rings (glob)
    os.makedirs(f"{ROOT}/.data", exist_ok=True)
    jrn = 0
    for src in glob.glob(os.path.join(STAGE, ".data", "*")):
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(ROOT, ".data", os.path.basename(src)))
            jrn += 1
    if jrn > 0:
        step(f".data journals restored ({jrn} files, incl. rotated .old rings)", True)
    else:
        print("[WARN] .data journals absent in snapshot zip — optional, skipped")

    # manifests + calibration + worklog (evidence chain)
    for rel in ("backups/MANIFEST.json", "backups/calibration-latest.json", "worklog.md"):
        src = os.path.join(STAGE, rel)
        if os.path.isfile(src):
            dst = os.path.join(ROOT, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            step(f"restored {rel}", True)
        else:
            print(f"[WARN] {rel} absent in snapshot zip — optional, skipped")

    if incomplete:
        print(f"RESTORE INCOMPLETE — core items absent from snapshot zip: {', '.join(incomplete)}")
        print(f"Everything else WAS restored; staging kept at {STAGE} — inspect the archive inventory. DO NOT boot this tree.")
        return 1

    print(f"next steps (machine with bun): cd {ROOT} && bun install && bunx prisma generate && bash scripts/dev-up.sh")
    print("then verify canaries: /api/pulse /api/advisor /api/terminal /api/rawcal all 200 (see RECOVERY-RUNBOOK.md §5)")
    print("RECOVERY COMPLETE — staging kept at", STAGE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
