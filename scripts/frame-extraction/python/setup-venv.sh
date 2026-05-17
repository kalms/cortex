#!/usr/bin/env bash
# setup-venv.sh — Create the Python venv used by the frame-extraction
# scripts. Idempotent: re-running is a no-op if the venv already has
# the pinned versions installed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VENV="$ROOT/.venv"
REQ="$ROOT/requirements.txt"

if [ ! -d "$VENV" ]; then
  echo "[setup-venv] creating venv at $VENV"
  python3 -m venv "$VENV"
fi

"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$REQ"

# Print versions so the user can sanity-check. hdbscan doesn't expose
# __version__; query it via importlib.metadata so the check works across
# package layouts.
"$VENV/bin/python" -c "import sklearn, numpy; from importlib.metadata import version; print(f'sklearn={sklearn.__version__} hdbscan={version(\"hdbscan\")} numpy={numpy.__version__}')"
echo "[setup-venv] ready"
