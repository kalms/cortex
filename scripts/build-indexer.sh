#!/usr/bin/env bash
# build-indexer.sh — Builds the native indexer (CBM) from internal/cbm/ and
# installs the resulting binary at bin/cortex-indexer. Invoked by npm postinstall.
#
# CBM's Makefile is not relocatable: rules reference src/ paths relative to
# the Makefile's own directory. We cd into internal/cbm/ to invoke it. The
# Makefile's `cbm` target produces a binary named `codebase-memory-mcp` at
# build/c/codebase-memory-mcp; we copy it to bin/cortex-indexer for Cortex.
#
# Skips the build if bin/cortex-indexer is already present and newer than
# anything in internal/cbm/src/ or the Makefile. Set CORTEX_FORCE_REBUILD=1
# to override.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEXER_SRC="$ROOT/internal/cbm"
INDEXER_BUILD="$INDEXER_SRC/build/c/codebase-memory-mcp"
INDEXER_DEST="$ROOT/bin/cortex-indexer"
MAKE_TARGET="cbm"

# Skip path: binary exists, no force, and no source file is newer than the binary
if [ -z "${CORTEX_FORCE_REBUILD:-}" ] && [ -x "$INDEXER_DEST" ]; then
  if ! find "$INDEXER_SRC/src" "$INDEXER_SRC/Makefile.cbm" \
        -newer "$INDEXER_DEST" -print -quit 2>/dev/null | grep -q .; then
    echo "cortex-indexer up to date at $INDEXER_DEST"
    exit 0
  fi
fi

# Build prerequisites
for tool in make cc; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found in PATH" >&2; exit 1; }
done

mkdir -p "$ROOT/bin"

echo "Building cortex-indexer from internal/cbm/ ..."
# Must invoke the Makefile from inside internal/cbm/ — its rules use
# Makefile-relative paths and don't tolerate -f from a parent directory.
(cd "$INDEXER_SRC" && make -f Makefile.cbm "$MAKE_TARGET")

if [ ! -x "$INDEXER_BUILD" ]; then
  echo "error: build succeeded but expected binary not found" >&2
  echo "expected: $INDEXER_BUILD" >&2
  exit 1
fi

cp "$INDEXER_BUILD" "$INDEXER_DEST.tmp"
chmod +x "$INDEXER_DEST.tmp"
mv "$INDEXER_DEST.tmp" "$INDEXER_DEST"
echo "cortex-indexer installed at $INDEXER_DEST"
