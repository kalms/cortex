#!/bin/bash
# build.sh — Clean build of production binary (standard or with UI).
#
# Usage:
#   scripts/build.sh                    # Standard binary
#   scripts/build.sh --with-ui          # Binary with embedded UI
#   scripts/build.sh --version v0.8.0   # With version stamp
#
# This script is the SINGLE source of truth for building release binaries.
# Used identically in local development and CI workflows.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Detect parallelism
NPROC=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

# Parse arguments
WITH_UI=false
VERSION=""
EXTRA_MAKE_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --with-ui)
            WITH_UI=true
            shift
            ;;
        --version)
            VERSION="$2"
            shift 2
            ;;
        CC=*|CXX=*)
            export "${1?}"
            EXTRA_MAKE_ARGS+=("$1")
            shift
            ;;
        *)
            EXTRA_MAKE_ARGS+=("$1")
            shift
            ;;
    esac
done

# Version flag
CFLAGS_EXTRA=""
if [[ -n "$VERSION" ]]; then
    CLEAN_VERSION="${VERSION#v}"
    CFLAGS_EXTRA="-DCBM_VERSION=\"\\\"$CLEAN_VERSION\\\"\""
fi

echo "=== build.sh: compiler=${CC:-default} ui=$WITH_UI version=${VERSION:-dev} cores=$NPROC ==="

# Step 1: Clean C build artifacts only (not node_modules — npm ci handles that)
rm -rf "$ROOT/build/c"

# Step 2: Build
if $WITH_UI; then
    make -j"$NPROC" -f Makefile.cbm cbm-with-ui \
        CFLAGS_EXTRA="$CFLAGS_EXTRA" "${EXTRA_MAKE_ARGS[@]+"${EXTRA_MAKE_ARGS[@]}"}"
else
    make -j"$NPROC" -f Makefile.cbm cbm \
        CFLAGS_EXTRA="$CFLAGS_EXTRA" "${EXTRA_MAKE_ARGS[@]+"${EXTRA_MAKE_ARGS[@]}"}"
fi

echo "=== Build complete: build/c/codebase-memory-mcp ==="
