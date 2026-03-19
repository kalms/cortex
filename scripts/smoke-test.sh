#!/usr/bin/env bash
set -euo pipefail

# Smoke test: verify the binary is fully operational.
#
# Phase 1: --version output
# Phase 2: Index a small multi-language project
# Phase 3: Verify node/edge counts, search, and trace
#
# Usage: smoke-test.sh <binary-path>

BINARY="${1:?usage: smoke-test.sh <binary-path>}"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

CLI_STDERR=$(mktemp)
cli() { "$BINARY" cli "$@" 2>"$CLI_STDERR"; }

echo "=== Phase 1: version ==="
OUTPUT=$("$BINARY" --version 2>&1)
echo "$OUTPUT"
if ! echo "$OUTPUT" | grep -qE 'v?[0-9]+\.[0-9]+|dev'; then
  echo "FAIL: unexpected version output"
  exit 1
fi
echo "OK"

echo ""
echo "=== Phase 2: index test project ==="

# Create a small multi-language project (Python + Go + JS)
mkdir -p "$TMPDIR/src/pkg"

cat > "$TMPDIR/src/main.py" << 'PYEOF'
from pkg import helper

def main():
    result = helper.compute(42)
    print(result)

class Config:
    DEBUG = True
    PORT = 8080
PYEOF

cat > "$TMPDIR/src/pkg/__init__.py" << 'PYEOF'
from .helper import compute
PYEOF

cat > "$TMPDIR/src/pkg/helper.py" << 'PYEOF'
def compute(x):
    return x * 2

def validate(data):
    if not data:
        raise ValueError("empty")
    return True
PYEOF

cat > "$TMPDIR/src/server.go" << 'GOEOF'
package main

import "fmt"

func StartServer(port int) {
    fmt.Printf("listening on :%d\n", port)
}

func HandleRequest(path string) string {
    return "ok: " + path
}
GOEOF

cat > "$TMPDIR/src/app.js" << 'JSEOF'
function render(data) {
    return `<div>${data}</div>`;
}

function fetchData(url) {
    return fetch(url).then(r => r.json());
}

module.exports = { render, fetchData };
JSEOF

cat > "$TMPDIR/config.yaml" << 'YAMLEOF'
server:
  port: 8080
  debug: true
database:
  host: localhost
YAMLEOF

# Index
RESULT=$(cli index_repository "{\"repo_path\":\"$TMPDIR\"}")
echo "$RESULT"

STATUS=$(echo "$RESULT" | python3 -c "import json,sys; d=json.loads(json.loads(sys.stdin.read())['content'][0]['text']); print(d.get('status',''))" 2>/dev/null || echo "")
if [ "$STATUS" != "indexed" ]; then
  echo "FAIL: index status is '$STATUS', expected 'indexed'"
  echo "--- stderr ---"
  cat "$CLI_STDERR"
  echo "--- end stderr ---"
  exit 1
fi

NODES=$(echo "$RESULT" | python3 -c "import json,sys; d=json.loads(json.loads(sys.stdin.read())['content'][0]['text']); print(d.get('nodes',0))" 2>/dev/null || echo "0")
EDGES=$(echo "$RESULT" | python3 -c "import json,sys; d=json.loads(json.loads(sys.stdin.read())['content'][0]['text']); print(d.get('edges',0))" 2>/dev/null || echo "0")

echo "nodes=$NODES edges=$EDGES"

if [ "$NODES" -lt 10 ]; then
  echo "FAIL: expected at least 10 nodes, got $NODES"
  exit 1
fi
if [ "$EDGES" -lt 5 ]; then
  echo "FAIL: expected at least 5 edges, got $EDGES"
  exit 1
fi
echo "OK: $NODES nodes, $EDGES edges"

echo ""
echo "=== Phase 3: verify queries ==="

# 3a: search_graph — find the compute function
PROJECT=$(echo "$RESULT" | python3 -c "import json,sys; d=json.loads(json.loads(sys.stdin.read())['content'][0]['text']); print(d.get('project',''))" 2>/dev/null || echo "")

SEARCH=$(cli search_graph "{\"project\":\"$PROJECT\",\"name_pattern\":\"compute\"}")
TOTAL=$(echo "$SEARCH" | python3 -c "import json,sys; d=json.loads(json.loads(sys.stdin.read())['content'][0]['text']); print(d.get('total',0))" 2>/dev/null || echo "0")
if [ "$TOTAL" -lt 1 ]; then
  echo "FAIL: search_graph for 'compute' returned 0 results"
  exit 1
fi
echo "OK: search_graph found $TOTAL result(s) for 'compute'"

# 3b: trace_call_path — verify compute has callers
TRACE=$(cli trace_call_path "{\"project\":\"$PROJECT\",\"function_name\":\"compute\",\"direction\":\"inbound\",\"max_depth\":1}")
CALLERS=$(echo "$TRACE" | python3 -c "import json,sys; d=json.loads(json.loads(sys.stdin.read())['content'][0]['text']); print(len(d.get('callers',[])))" 2>/dev/null || echo "0")
if [ "$CALLERS" -lt 1 ]; then
  echo "FAIL: trace_call_path found 0 callers for 'compute'"
  exit 1
fi
echo "OK: trace_call_path found $CALLERS caller(s) for 'compute'"

# 3c: get_graph_schema — verify labels exist
SCHEMA=$(cli get_graph_schema "{\"project\":\"$PROJECT\"}")
LABELS=$(echo "$SCHEMA" | python3 -c "import json,sys; d=json.loads(json.loads(sys.stdin.read())['content'][0]['text']); print(len(d.get('node_labels',[])))" 2>/dev/null || echo "0")
if [ "$LABELS" -lt 3 ]; then
  echo "FAIL: schema has fewer than 3 node labels"
  exit 1
fi
echo "OK: schema has $LABELS node labels"

# 3d: Verify __init__.py didn't clobber Folder node
FOLDERS=$(cli search_graph "{\"project\":\"$PROJECT\",\"label\":\"Folder\"}")
FOLDER_COUNT=$(echo "$FOLDERS" | python3 -c "import json,sys; d=json.loads(json.loads(sys.stdin.read())['content'][0]['text']); print(d.get('total',0))" 2>/dev/null || echo "0")
if [ "$FOLDER_COUNT" -lt 2 ]; then
  echo "FAIL: expected at least 2 Folder nodes (src, src/pkg), got $FOLDER_COUNT"
  exit 1
fi
echo "OK: $FOLDER_COUNT Folder nodes (init.py didn't clobber them)"

# 3e: delete_project cleanup
cli delete_project "{\"project_name\":\"$PROJECT\"}" > /dev/null

echo ""
echo "=== smoke-test: ALL PASSED ==="
