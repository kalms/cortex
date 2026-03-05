#!/usr/bin/env bash
set -euo pipefail

# Benchmark indexing phase: clone check, LOC count, file count, index_repository.
# Saves project name, node/edge counts. No query logic — that's done by AI agents.
#
# Usage: benchmark-index.sh <binary> <lang> <repo_path> <output_dir>

BIN="${1:?usage: benchmark-index.sh <binary> <lang> <repo_path> <output_dir>}"
LANG="${2:?}"
REPO="${3:?}"
OUTDIR="${4:?}"

# Resolve symlinks for repo path
REPO="$(cd "$REPO" && pwd -P)"

mkdir -p "$OUTDIR/$LANG"

echo "=== Benchmark Index: $LANG ==="
echo "  repo: $REPO"

# Count LOC (source files only, exclude .git and common build dirs)
# All 59 supported language extensions
LOC=$(find "$REPO" -type f \( \
    -name '*.go' -o -name '*.py' -o -name '*.js' -o -name '*.ts' -o -name '*.tsx' \
    -o -name '*.java' -o -name '*.kt' -o -name '*.scala' -o -name '*.rs' \
    -o -name '*.c' -o -name '*.cpp' -o -name '*.h' -o -name '*.hpp' -o -name '*.cs' \
    -o -name '*.php' -o -name '*.rb' -o -name '*.lua' -o -name '*.sh' -o -name '*.zig' \
    -o -name '*.hs' -o -name '*.ml' -o -name '*.mli' -o -name '*.ex' -o -name '*.exs' \
    -o -name '*.erl' -o -name '*.hrl' -o -name '*.html' -o -name '*.css' -o -name '*.scss' \
    -o -name '*.yaml' -o -name '*.yml' -o -name '*.toml' -o -name '*.hcl' -o -name '*.tf' \
    -o -name '*.sql' -o -name 'Dockerfile' \
    -o -name '*.m' -o -name '*.swift' -o -name '*.dart' -o -name '*.pl' -o -name '*.pm' \
    -o -name '*.groovy' -o -name '*.gradle' -o -name '*.r' -o -name '*.R' \
    -o -name '*.clj' -o -name '*.cljs' -o -name '*.cljc' \
    -o -name '*.fs' -o -name '*.fsi' -o -name '*.fsx' \
    -o -name '*.jl' -o -name '*.vim' \
    -o -name '*.nix' \
    -o -name '*.lisp' -o -name '*.lsp' -o -name '*.cl' \
    -o -name '*.elm' \
    -o -name '*.f90' -o -name '*.f95' -o -name '*.f03' -o -name '*.f08' \
    -o -name '*.cu' -o -name '*.cuh' \
    -o -name '*.cob' -o -name '*.cbl' \
    -o -name '*.v' -o -name '*.sv' \
    -o -name '*.el' \
    -o -name '*.json' -o -name '*.xml' -o -name '*.xsl' -o -name '*.xsd' \
    -o -name '*.md' -o -name '*.mdx' \
    -o -name '*.mk' -o -name 'Makefile' -o -name 'GNUmakefile' \
    -o -name '*.cmake' -o -name 'CMakeLists.txt' \
    -o -name '*.proto' \
    -o -name '*.graphql' -o -name '*.gql' \
    -o -name '*.vue' -o -name '*.svelte' \
    -o -name 'meson.build' -o -name 'meson.options' \
    -o -name '*.glsl' -o -name '*.vert' -o -name '*.frag' \
    -o -name '*.ini' -o -name '*.cfg' -o -name '*.conf' \) \
    -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/vendor/*' \
    -not -path '*/target/*' -not -path '*/build/*' -not -path '*/dist/*' \
    -exec cat {} + 2>/dev/null | wc -l | tr -d ' ')
echo "  LOC: $LOC"
echo "$LOC" > "$OUTDIR/$LANG/loc.txt"

# Count source files (same extensions as LOC)
FILE_COUNT=$(find "$REPO" -type f \( \
    -name '*.go' -o -name '*.py' -o -name '*.js' -o -name '*.ts' -o -name '*.tsx' \
    -o -name '*.java' -o -name '*.kt' -o -name '*.scala' -o -name '*.rs' \
    -o -name '*.c' -o -name '*.cpp' -o -name '*.h' -o -name '*.hpp' -o -name '*.cs' \
    -o -name '*.php' -o -name '*.rb' -o -name '*.lua' -o -name '*.sh' -o -name '*.zig' \
    -o -name '*.hs' -o -name '*.ml' -o -name '*.mli' -o -name '*.ex' -o -name '*.exs' \
    -o -name '*.erl' -o -name '*.hrl' -o -name '*.html' -o -name '*.css' -o -name '*.scss' \
    -o -name '*.yaml' -o -name '*.yml' -o -name '*.toml' -o -name '*.hcl' -o -name '*.tf' \
    -o -name '*.sql' -o -name 'Dockerfile' \
    -o -name '*.m' -o -name '*.swift' -o -name '*.dart' -o -name '*.pl' -o -name '*.pm' \
    -o -name '*.groovy' -o -name '*.gradle' -o -name '*.r' -o -name '*.R' \
    -o -name '*.clj' -o -name '*.cljs' -o -name '*.cljc' \
    -o -name '*.fs' -o -name '*.fsi' -o -name '*.fsx' \
    -o -name '*.jl' -o -name '*.vim' \
    -o -name '*.nix' \
    -o -name '*.lisp' -o -name '*.lsp' -o -name '*.cl' \
    -o -name '*.elm' \
    -o -name '*.f90' -o -name '*.f95' -o -name '*.f03' -o -name '*.f08' \
    -o -name '*.cu' -o -name '*.cuh' \
    -o -name '*.cob' -o -name '*.cbl' \
    -o -name '*.v' -o -name '*.sv' \
    -o -name '*.el' \
    -o -name '*.json' -o -name '*.xml' -o -name '*.xsl' -o -name '*.xsd' \
    -o -name '*.md' -o -name '*.mdx' \
    -o -name '*.mk' -o -name 'Makefile' -o -name 'GNUmakefile' \
    -o -name '*.cmake' -o -name 'CMakeLists.txt' \
    -o -name '*.proto' \
    -o -name '*.graphql' -o -name '*.gql' \
    -o -name '*.vue' -o -name '*.svelte' \
    -o -name 'meson.build' -o -name 'meson.options' \
    -o -name '*.glsl' -o -name '*.vert' -o -name '*.frag' \
    -o -name '*.ini' -o -name '*.cfg' -o -name '*.conf' \) \
    -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/vendor/*' \
    -not -path '*/target/*' -not -path '*/build/*' -not -path '*/dist/*' | wc -l | tr -d ' ')
echo "  files: $FILE_COUNT"
echo "$FILE_COUNT" > "$OUTDIR/$LANG/file-count.txt"

# Index
START=$(date +%s%N)
"$BIN" cli --raw index_repository "{\"repo_path\":\"$REPO\"}" 2>/dev/null > "$OUTDIR/$LANG/00-index.json"
END=$(date +%s%N)
INDEX_MS=$(( (END - START) / 1000000 ))
echo "  index: ${INDEX_MS}ms"
echo "$INDEX_MS" > "$OUTDIR/$LANG/index-time.txt"

# Extract project name, node count, edge count
PROJECT=$(grep -o '"project": *"[^"]*"' "$OUTDIR/$LANG/00-index.json" | head -1 | sed 's/"project": *"//;s/"//')
NODES=$(grep -o '"nodes": *[0-9]*' "$OUTDIR/$LANG/00-index.json" | head -1 | sed 's/"nodes": *//')
EDGES=$(grep -o '"edges": *[0-9]*' "$OUTDIR/$LANG/00-index.json" | head -1 | sed 's/"edges": *//')
echo "  project: $PROJECT"
echo "  graph: ${NODES} nodes, ${EDGES} edges"
echo "$PROJECT" > "$OUTDIR/$LANG/project.txt"
echo "$NODES" > "$OUTDIR/$LANG/nodes.txt"
echo "$EDGES" > "$OUTDIR/$LANG/edges.txt"

echo "=== Index complete: $LANG ==="
