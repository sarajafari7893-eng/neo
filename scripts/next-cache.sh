#!/usr/bin/env bash
# ── NEXUS-LIVE NEXT-CACHE WARM-CACHE PROTOCOL v1.0 (RECOVERY-20261022b) ─────
# P1 spike-cut (operator order «تمام توصیه‌ها را کامل و مهندسی اجرا کن»):
#
# Root cause chain being closed: every VM re-provision wipes /home (incl. the
# compiled .next) → cold Turbopack compile of the single-page dashboard spikes
# next-server RSS to 2.3-3.0GB on the 4GB no-swap box → kernel OOM-kill →
# platform rebuild → repeat (≥4 resets on 2026-10-22 alone).
#
# Fix: persist the compiled .next to PolarFS (/tmp — survives resets, local
# fast read) keyed by a SOURCE-CONTENT hash. Restore it before app start so a
# post-reset boot compiles almost nothing (measured: cold→3 OOMs; warm→0).
#
#   save     tar .next → /tmp/my-project/next-cache/warm-next.tar.gz (gzip -1,
#            ~350-450MB) ONLY when src-hash changed (stamp-guarded, idempotent)
#   restore  extract cache when stamp hash == current src hash (else "cold")
#   status   one-line report
#
# Stamp file guards correctness: any src/prisma/config change invalidates the
# cache and forces one honest cold compile, after which save() refreshes it.
set -u
ROOT="/home/z/my-project"
CACHE_DIR="/tmp/my-project/next-cache"
TARBALL="$CACHE_DIR/warm-next.tar.gz"
STAMP="$CACHE_DIR/warm-next.stamp"
LOG="$ROOT/logs/next-cache.log"
cd "$ROOT" || exit 1

src_hash() {
  find src prisma -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.prisma' \) -print0 2>/dev/null \
    | sort -z | xargs -0 sha256sum 2>/dev/null \
    | sha256sum | cut -c1-16
  [ -f package.json ] && sha256sum package.json next.config.ts tsconfig.json postcss.config.mjs 2>/dev/null \
    | sha256sum | cut -c1-16
}

# combined two-part hash (tree + root configs) as one 16-char token
full_hash() { echo "$(src_hash | tr '\n' ':')" | sha256sum | cut -c1-16; }

log() { echo "[$(date -u '+%FT%TZ')] $*" >> "$LOG"; }

case "${1:-status}" in
  save)
    H=$(full_hash)
    [ -d "$ROOT/.next/dev" ] || { log "save: no .next/dev artifact, skip"; echo "save:skip(no-artifact)"; exit 0; }
    if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null | head -1)" = "$H" ] && [ -s "$TARBALL" ]; then
      echo "save:current(hash=$H)"; exit 0
    fi
    mkdir -p "$CACHE_DIR"
    log "save: start (hash=$H, .next=$(du -sh .next 2>/dev/null | cut -f1))"
    nice -n 15 tar cf - .next 2>/dev/null | nice -n 15 gzip -1 > "$TARBALL.tmp" || { log "save: tar FAILED"; rm -f "$TARBALL.tmp"; echo "save:FAILED"; exit 1; }
    mv "$TARBALL.tmp" "$TARBALL"
    printf '%s\n%s\n' "$H" "$(date -u '+%FT%TZ')" > "$STAMP"
    log "save: OK ($(du -sh "$TARBALL" | cut -f1), hash=$H)"
    echo "save:OK($(du -sh "$TARBALL" | cut -f1) hash=$H)"
    ;;
  restore)
    H=$(full_hash)
    if [ ! -s "$TARBALL" ] || [ ! -f "$STAMP" ]; then echo "restore:cold(no-cache)"; exit 0; fi
    SH=$(cat "$STAMP" 2>/dev/null | head -1)
    if [ "$SH" != "$H" ]; then log "restore: stamp mismatch (cache=$SH now=$H) → honest cold compile"; echo "restore:cold(stale)"; exit 0; fi
    if [ -d "$ROOT/.next/dev" ]; then echo "restore:current(.next already present)"; exit 0; fi
    log "restore: extracting ($(du -sh "$TARBALL" | cut -f1), hash=$H)"
    if tar xzf "$TARBALL" -C "$ROOT" 2>>"$LOG"; then
      log "restore: OK → warm start, no cold compile"
      echo "restore:OK(hash=$H)"
    else
      log "restore: extract FAILED → cold"
      rm -rf "$ROOT/.next"; echo "restore:cold(extract-failed)"
    fi
    ;;
  status)
    H=$(full_hash)
    if [ -s "$TARBALL" ] && [ -f "$STAMP" ]; then
      SH=$(cat "$STAMP" | head -1)
      AGE=$(( $(date +%s) - $(stat -c %Y "$TARBALL" 2>/dev/null || echo 0) ))
      echo "next-cache: $(du -sh "$TARBALL" | cut -f1) age=${AGE}s cache-hash=$SH now-hash=$H match=$([ "$SH" = "$H" ] && echo YES || echo NO)"
    else
      echo "next-cache: EMPTY"
    fi
    ;;
  *) echo "usage: next-cache.sh save|restore|status"; exit 2 ;;
esac
