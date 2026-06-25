#!/usr/bin/env bash
# Shared helper for the post-merge / post-checkout hooks.
#
# bin/cortex prefers a compiled dist/ over src/ when dist/ exists. dist/ is a
# gitignored local artifact that `git pull` never rebuilds, so without this the
# CLI silently runs stale code after every pull (observed: 1.0.2 frame-labeler
# change didn't reach `cortex index` until a manual `npm run build`).
#
# This rebuilds dist/ after a ref move, but ONLY when:
#   - dist/ already exists (if it doesn't, bin/cortex falls back to tsx src/,
#     which is always current — nothing to rebuild), and
#   - tracked compiled inputs (src/, tsconfig*, package.json) actually changed
#     between the two refs (otherwise it's a fast no-op).
# Best-effort: never blocks the git operation; a failed build just prints a hint.
#
# Usage: lib-rebuild-dist.sh <from-ref> <to-ref>
set -u
FROM="${1:-}"; TO="${2:-}"
[ -n "$FROM" ] && [ -n "$TO" ] || exit 0
[ "$FROM" = "$TO" ] && exit 0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -d "$ROOT/dist" ] || exit 0

if git diff --name-only "$FROM" "$TO" 2>/dev/null \
     | grep -qE '^(src/|tsconfig[^/]*\.json$|package\.json$)'; then
  echo "[cortex] compiled sources changed — rebuilding dist/ so the CLI isn't stale…"
  if ( cd "$ROOT" && npm run build >/dev/null 2>&1 ); then
    echo "[cortex] dist/ rebuilt."
  else
    echo "[cortex] dist/ rebuild failed — run 'npm run build' manually before using the cortex CLI."
  fi
fi
