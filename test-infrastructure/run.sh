#!/bin/bash
# Quick runner for local Docker-based CI testing.
#
# Usage:
#   ./test-infrastructure/run.sh           # Run GCC tests (ASan + LeakSanitizer)
#   ./test-infrastructure/run.sh lint      # Run linters (clang-format + cppcheck)
#   ./test-infrastructure/run.sh both      # Lint then test
#   ./test-infrastructure/run.sh shell     # Drop into container shell for debugging

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -f $ROOT/test-infrastructure/docker-compose.yml"

case "${1:-test}" in
    test)
        echo "=== Running GCC + ASan + LeakSanitizer tests (mirrors Ubuntu CI) ==="
        $COMPOSE run --rm test
        ;;
    lint)
        echo "=== Running linters (clang-format-20 + cppcheck 2.20.0) ==="
        $COMPOSE run --rm lint
        ;;
    both)
        echo "=== Running linters ==="
        $COMPOSE run --rm lint
        echo "=== Running tests ==="
        $COMPOSE run --rm test
        ;;
    shell)
        echo "=== Dropping into test container shell ==="
        $COMPOSE run --rm --entrypoint bash test
        ;;
    *)
        echo "Usage: $0 {test|lint|both|shell}"
        exit 1
        ;;
esac
