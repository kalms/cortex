#!/bin/bash
# lint.sh — Run all CI linters (clang-format + cppcheck).
#
# Usage:
#   scripts/lint.sh                                    # Default tools
#   scripts/lint.sh CLANG_FORMAT=clang-format-20       # Override formatter
#
# This script is the SINGLE source of truth for CI linting.
# clang-tidy is intentionally excluded (platform-dependent, pre-commit only).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Forward overrides from args (e.g. CLANG_FORMAT=clang-format-20)
MAKE_ARGS=()
for arg in "$@"; do
    MAKE_ARGS+=("$arg")
done

echo "=== lint.sh: running clang-format + cppcheck ==="

# Run format and cppcheck in parallel
make -j2 -f Makefile.cbm lint-ci "${MAKE_ARGS[@]+"${MAKE_ARGS[@]}"}"

echo "=== All linters passed ==="
