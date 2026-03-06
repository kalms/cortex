#!/usr/bin/env bash
set -euo pipefail

# Smoke test: verify the binary starts and reports its version.
BINARY="${1:?usage: smoke-test.sh <binary-path>}"

echo "=== smoke-test: --version ==="
OUTPUT=$("$BINARY" --version 2>&1)
echo "$OUTPUT"

if echo "$OUTPUT" | grep -qE 'v?[0-9]+\.[0-9]+|dev'; then
  echo "OK: version output looks valid"
else
  echo "FAIL: unexpected version output"
  exit 1
fi

echo "=== smoke-test: passed ==="
