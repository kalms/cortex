#!/bin/bash
# test.sh — Clean build + run all C tests with ASan + UBSan.
#
# Usage: scripts/test.sh [CC=gcc-14] [CXX=g++-14]
#
# This script is the SINGLE source of truth for running tests.
# Used identically in local development and CI workflows.
#
# Steps:
#   1. Clean all build artifacts (forced fresh compile)
#   2. Build test-runner with sanitizers
#   3. Run all test suites

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Detect parallelism
NPROC=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

# Forward CC/CXX from env or args (e.g. scripts/test.sh CC=gcc-14)
for arg in "$@"; do
    export "${arg?}"
done

echo "=== test.sh: compiler=${CC:-default} cores=$NPROC ==="

# Step 1: Clean
scripts/clean.sh

# Step 2 + 3: Build and run tests
make -j"$NPROC" -f Makefile.cbm test

echo "=== All tests passed ==="
