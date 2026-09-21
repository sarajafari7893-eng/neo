#!/usr/bin/env python3
"""Worklog merge for 1547-snapshot restore (2026-09-15).
Base   = tree/worklog.md  (continuous history through Sep-15 15:32Z — includes lost 11:00Z-15:47Z loop)
Append = current root worklog's post-rollback section, from the '---' line preceding
         'Task ID: ROLLBACK-RESTORE-20260915T1620Z' to EOF (rollback incident + recovery ops).
Result = root worklog.md  (full history + post-rollback ops record, no gap).
"""
import io, sys

ROOT = "/home/z/my-project"
base_path = f"{ROOT}/backups/.restore-1547/tree/worklog.md"
cur_path = f"{ROOT}/worklog.md"
marker = "Task ID: ROLLBACK-RESTORE-20260915T1620Z"

base = io.open(base_path, "r", encoding="utf-8").read()
cur = io.open(cur_path, "r", encoding="utf-8").read()

if marker not in cur:
    sys.exit(f"FATAL: marker {marker!r} not found in current worklog — aborting, no write.")

idx = cur.index(marker)
# walk back to the preceding '---' separator line
head = cur[:idx]
sep_pos = head.rfind("\n---\n")
if sep_pos == -1:
    sys.exit("FATAL: no '---' separator before rollback entry — aborting, no write.")
tail = cur[sep_pos + 1:]  # from '---' line to EOF

divider = (
    "\n<!-- ── MERGE 2026-09-15T18:5xZ: base restored from nexus-snapshot-20260915-154657.zip.enc "
    "(operator upload, continuous lineage through 15:32Z); post-rollback ops record re-appended below ── -->\n"
)

merged = base.rstrip("\n") + "\n" + divider + tail
io.open(f"{ROOT}/worklog.md", "w", encoding="utf-8").write(merged)

print(f"base bytes={len(base)} cur bytes={len(cur)} tail bytes={len(tail)} merged bytes={len(merged)}")
print("verify-marker-present:", marker in merged)
print("verify-lost-loop: ", end="")
lost = ["SUPERVISOR", "ARM-EPOCH", "real-keep", "informativePct"]
for k in lost:
    print(k, merged.count(k), end="; ")
print()
