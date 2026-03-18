#!/bin/bash
# Local CI testing — mirrors GitHub Actions for all Docker-capable platforms.
#
# Coverage:
#   arm64:   Native on Apple Silicon (fast, ~3 min)
#   amd64:   QEMU emulation (slower, ~8 min) — mirrors CI ubuntu-latest
#   macOS:   Run natively: scripts/test.sh CC=cc CXX=c++
#   Windows: CI only (no Docker support on Mac)
#
# Usage:
#   ./test-infrastructure/run.sh              # test + build arm64 (default)
#   ./test-infrastructure/run.sh all          # test + build, arm64 + amd64
#   ./test-infrastructure/run.sh test         # test only (ASan + LeakSan)
#   ./test-infrastructure/run.sh build        # production build only (-O2 -Werror)
#   ./test-infrastructure/run.sh amd64        # test + build amd64 only
#   ./test-infrastructure/run.sh lint         # clang-format + cppcheck
#   ./test-infrastructure/run.sh shell        # debug shell (arm64)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -f $ROOT/test-infrastructure/docker-compose.yml"

case "${1:-full}" in
    full)
        echo "=== Linux arm64: test (ASan+LeakSan) + production build (-O2) ==="
        $COMPOSE run --rm test
        $COMPOSE run --rm build
        ;;
    test)
        echo "=== Linux arm64: test (ASan + LeakSanitizer) ==="
        $COMPOSE run --rm test
        ;;
    build)
        echo "=== Linux arm64: production build (-O2 -Werror) ==="
        $COMPOSE run --rm build
        ;;
    amd64)
        echo "=== Linux amd64 via QEMU: test + build ==="
        $COMPOSE run --rm test-amd64
        $COMPOSE run --rm build-amd64
        ;;
    all)
        echo "=== All platforms: test + build ==="
        echo "--- arm64 test ---"
        $COMPOSE run --rm test
        echo "--- arm64 build ---"
        $COMPOSE run --rm build
        echo "--- amd64 test ---"
        $COMPOSE run --rm test-amd64
        echo "--- amd64 build ---"
        $COMPOSE run --rm build-amd64
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
    *)
        echo "Usage: $0 {full|test|build|amd64|all|lint|shell}"
        exit 1
        ;;
esac
