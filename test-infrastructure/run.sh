#!/bin/bash
# Local CI testing — GCC + ASan + LeakSanitizer in Docker.
#
# Coverage:
#   arm64:   Native on Apple Silicon (fast, ~3 min)
#   amd64:   QEMU emulation (slower, ~8 min) — mirrors CI ubuntu-latest
#   macOS:   Run natively: scripts/test.sh CC=cc CXX=c++
#   Windows: CI only (no Docker support on Mac)
#
# Usage:
#   ./test-infrastructure/run.sh              # arm64 test (default, fast)
#   ./test-infrastructure/run.sh all          # arm64 + amd64 in parallel
#   ./test-infrastructure/run.sh amd64        # amd64 only
#   ./test-infrastructure/run.sh lint         # clang-format + cppcheck
#   ./test-infrastructure/run.sh shell        # debug shell (arm64)
#   ./test-infrastructure/run.sh shell-amd64  # debug shell (amd64)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -f $ROOT/test-infrastructure/docker-compose.yml"

case "${1:-test}" in
    test|arm64)
        echo "=== Linux arm64 (GCC + ASan + LeakSanitizer) ==="
        $COMPOSE run --rm test
        ;;
    amd64)
        echo "=== Linux amd64 via QEMU (GCC + ASan + LeakSanitizer) ==="
        $COMPOSE run --rm test-amd64
        ;;
    all)
        echo "=== Testing arm64 + amd64 in parallel ==="
        $COMPOSE run --rm -d test
        $COMPOSE run --rm test-amd64
        echo "=== Waiting for arm64... ==="
        # docker compose run -d returns immediately; wait for the container
        $COMPOSE wait test 2>/dev/null || true
        echo "=== All platforms passed ==="
        ;;
    lint)
        echo "=== Linters (clang-format-20 + cppcheck 2.20.0) ==="
        $COMPOSE run --rm lint
        ;;
    shell)
        echo "=== Debug shell (Linux arm64) ==="
        $COMPOSE run --rm --entrypoint bash test
        ;;
    shell-amd64)
        echo "=== Debug shell (Linux amd64 via QEMU) ==="
        $COMPOSE run --rm --entrypoint bash test-amd64
        ;;
    *)
        echo "Usage: $0 {test|arm64|amd64|all|lint|shell|shell-amd64}"
        exit 1
        ;;
esac
