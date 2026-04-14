#!/usr/bin/env bash
set -euo pipefail

# install-cbm.sh — Downloads the codebase-memory-mcp binary into Cortex's bin/ directory.
# Called by npm postinstall. Skips if binary already exists and is executable.

BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/bin"
DEST="$BIN_DIR/codebase-memory-mcp"

if [ -x "$DEST" ]; then
  echo "codebase-memory-mcp already installed at $DEST"
  exit 0
fi

REPO="DeusData/codebase-memory-mcp"
BASE_URL="https://github.com/${REPO}/releases/latest/download"

detect_os() {
  case "$(uname -s)" in
    Darwin)               echo "darwin" ;;
    Linux)                echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "error: unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
}

detect_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64)
      if [ "$(uname -s)" = "Darwin" ] && sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -qi apple; then
        echo "arm64"
      else
        echo "amd64"
      fi
      ;;
    *) echo "error: unsupported architecture: $arch" >&2; exit 1 ;;
  esac
}

OS=$(detect_os)
ARCH=$(detect_arch)

if [ "$OS" = "windows" ]; then
  ARCHIVE="codebase-memory-mcp-${OS}-${ARCH}.zip"
else
  ARCHIVE="codebase-memory-mcp-${OS}-${ARCH}.tar.gz"
fi

URL="${BASE_URL}/${ARCHIVE}"

echo "Downloading codebase-memory-mcp ($OS/$ARCH)..."

DLDIR=$(mktemp -d)
trap 'rm -rf "$DLDIR"' EXIT

curl -fSL --progress-bar -o "$DLDIR/$ARCHIVE" "$URL"

cd "$DLDIR"
if [ "$OS" = "windows" ]; then
  unzip -q "$ARCHIVE"
else
  tar -xzf "$ARCHIVE"
fi

if [ ! -f "$DLDIR/codebase-memory-mcp" ]; then
  echo "error: binary not found after extraction" >&2
  exit 1
fi

# macOS: fix signing
if [ "$OS" = "darwin" ]; then
  xattr -d com.apple.quarantine "$DLDIR/codebase-memory-mcp" 2>/dev/null || true
  codesign --sign - --force "$DLDIR/codebase-memory-mcp" 2>/dev/null || true
fi

mkdir -p "$BIN_DIR"
cp "$DLDIR/codebase-memory-mcp" "$DEST"
chmod 755 "$DEST"

VERSION=$("$DEST" --version 2>&1) || true
echo "Installed codebase-memory-mcp ${VERSION} to $DEST"
