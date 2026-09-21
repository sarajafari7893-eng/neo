#!/usr/bin/env python3
# ── NEXUS-LIVE v10.11 — Telegram multipart upload helper (channel recovery tier) ──
# Usage: python3 scripts/tg-upload.py <chat_id|@channel> <file_path> [caption]
# Reads TELEGRAM_BOT_TOKEN from .env. Prints one JSON line: {"ok":..,"message_id":..,"error":..}
# Why not curl: curl -F multipart file-read broke in-shell (exit 26, 2026-09-17) —
# python urllib multipart is drill-verified reliable for files up to the 50MB bot cap.
import json
import os
import sys
import urllib.request
import uuid


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: tg-upload.py <chat_id> <file> [caption]"}))
        return 2
    chat_id, file_path = sys.argv[1], sys.argv[2]
    caption = sys.argv[3] if len(sys.argv) > 3 else ""
    env = {}
    with open("/home/z/my-project/.env") as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                env[k] = v
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    if not token or not os.path.isfile(file_path):
        print(json.dumps({"ok": False, "error": "missing token or file"}))
        return 2
    boundary = uuid.uuid4().hex
    fn = os.path.basename(file_path)
    with open(file_path, "rb") as f:
        blob = f.read()
    parts = []
    for name, val in (("chat_id", chat_id), ("caption", caption)):
        if val:
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{val}\r\n'.encode()
            )
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="document"; filename="{fn}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
        + blob
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendDocument",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        raw = urllib.request.urlopen(req, timeout=180).read()
        d = json.loads(raw)
        res = d.get("result") or {}
        out = {
            "ok": bool(d.get("ok")),
            "message_id": res.get("message_id"),
            "chat": (res.get("chat") or {}).get("username") or str((res.get("chat") or {}).get("id", "")),
            "file_id": (res.get("document") or {}).get("file_id") or "",
            "error": d.get("description"),
        }
    except Exception as e:  # noqa: BLE001 — report any upload failure as JSON
        out = {"ok": False, "error": str(e)[:200]}
    print(json.dumps(out))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
