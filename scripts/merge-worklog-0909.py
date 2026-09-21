#!/usr/bin/env python3
"""RESTORE-0909 worklog merge: the snapshot worklog (Sep 8 19:19, 411KB — the
TRUE pre-resync history) becomes the base; the current (reconstructed) worklog
contributes ONLY its post-resync sections, taken as the contiguous tail that
starts at the OP-ROLLBACK-RECOVERY-0909 section header.
Output: restore-staging/worklog.merged.md (installed by restore-0909-apply.sh)
"""
BASE = "/home/z/my-project/restore-staging/sep8/worklog.md"
CUR = "/home/z/my-project/worklog.md"
OUT = "/home/z/my-project/restore-staging/worklog.merged.md"
BOUNDARY = "Task ID: OP-ROLLBACK-RECOVERY-0909"

base = open(BASE, encoding="utf-8").read()
cur = open(CUR, encoding="utf-8").read()

assert BOUNDARY not in base, "boundary section unexpectedly already in snapshot worklog — refusing"

idx = cur.find(BOUNDARY)
assert idx != -1, "boundary section not found in current worklog"
# back up to the preceding '---' separator line so the appended block keeps its header
sep = cur.rfind("---", 0, idx)
tail = cur[sep:] if sep != -1 else cur[idx:]
if not tail.endswith("\n"):
    tail += "\n"

merged = base
if not merged.endswith("\n"):
    merged += "\n"
merged += "---\n" if not merged.rstrip().endswith("---") else ""
merged += "\n" + tail

open(OUT, "w", encoding="utf-8").write(merged)
print(f"base: {len(base)} chars | appended tail: {len(tail)} chars | merged: {len(merged)} chars")
print("appended sections:", [l for l in tail.splitlines() if l.startswith("Task ID:")])
