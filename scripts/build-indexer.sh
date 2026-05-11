#!/usr/bin/env bash
# build-indexer.sh — Builds the native indexer from internal/indexer/ and
# installs the resulting binary at bin/cortex-indexer. Invoked by npm postinstall.
#
# The indexer Makefile is not relocatable: rules reference src/ paths relative
# to the Makefile's own directory. We cd into internal/indexer/ to invoke it.
# The Makefile's `indexer` target produces a binary named `codebase-memory-mcp`
# at build/c/codebase-memory-mcp; we copy it to bin/cortex-indexer for Cortex.
# (The `codebase-memory-mcp` binary filename is a vestigial pre-rename label;
# renaming it is deferred to later CBM-removal tasks. The Makefile keeps `cbm`
# as a backwards-compatible alias for `indexer`.)
#
# Skips the build if bin/cortex-indexer is already present and newer than
# anything in internal/indexer/src/ or the Makefile. Set CORTEX_FORCE_REBUILD=1
# to override.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEXER_SRC="$ROOT/internal/indexer"
INDEXER_BUILD="$INDEXER_SRC/build/c/codebase-memory-mcp"
INDEXER_DEST="$ROOT/bin/cortex-indexer"
MAKE_TARGET="indexer"

# Skip path: binary exists, no force, and no source file is newer than the binary
if [ -z "${CORTEX_FORCE_REBUILD:-}" ] && [ -x "$INDEXER_DEST" ]; then
  if ! find "$INDEXER_SRC/src" "$INDEXER_SRC/Makefile.indexer" \
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

echo "Building cortex-indexer from internal/indexer/ ..."
# Inject the package version into the C build so `cortex-indexer --version`
# reports a real value instead of the "dev" fallback. We read it from
# package.json without requiring node/jq — the value is on a fixed line.
PKG_VERSION="$(awk -F'"' '/^[[:space:]]*"version":/ { print $4; exit }' "$ROOT/package.json")"
CFLAGS_EXTRA_VAL=""
if [ -n "${PKG_VERSION:-}" ]; then
  CFLAGS_EXTRA_VAL="-DCTX_VERSION=\"\\\"${PKG_VERSION}\\\"\""
fi
# Must invoke the Makefile from inside internal/indexer/ — its rules use
# Makefile-relative paths and don't tolerate -f from a parent directory.
(cd "$INDEXER_SRC" && make -f Makefile.indexer "$MAKE_TARGET" CFLAGS_EXTRA="$CFLAGS_EXTRA_VAL")

if [ ! -x "$INDEXER_BUILD" ]; then
  echo "error: build succeeded but expected binary not found" >&2
  echo "expected: $INDEXER_BUILD" >&2
  exit 1
fi

cp "$INDEXER_BUILD" "$INDEXER_DEST.tmp"
chmod +x "$INDEXER_DEST.tmp"
mv "$INDEXER_DEST.tmp" "$INDEXER_DEST"
echo "cortex-indexer installed at $INDEXER_DEST"
