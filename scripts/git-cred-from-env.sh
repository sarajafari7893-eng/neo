#!/usr/bin/env bash
# nexus credential helper — reads GITHUB_TOKEN from .env at auth time (v1, 2026-11-26)
# so replacing the token in .env heals the push chain with zero other changes.
case "$1" in
  get)
    TOKEN=$(grep -E '^GITHUB_TOKEN=' /home/z/my-project/.env | cut -d= -f2- | tr -d '"' | tr -d ' ')
    if [ -n "$TOKEN" ]; then
      printf 'username=x-access-token\n'
      printf 'password=%s\n' "$TOKEN"
    fi
    ;;
esac
exit 0
