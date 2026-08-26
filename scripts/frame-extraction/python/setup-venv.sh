#!/usr/bin/env bash
# setup-venv.sh — Create the Python venv used by the frame-extraction
# scripts. Idempotent: re-running is a no-op if the venv already has
# the pinned versions installed.
#
# Venv location: $CORTEX_VENV if set, else ~/.cache/cortex-indexer/python-venv.
# (The default matches src/frame-extraction/venv.ts::venvDir().)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REQ="$ROOT/requirements.txt"
VENV="${CORTEX_VENV:-$HOME/.cache/cortex-indexer/python-venv}"

if [ -d "$VENV" ]; then
  # Existing venv: upgrade in place. A failure here leaves what was already
  # working alone.
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r "$REQ"
else
  echo "[setup-venv] creating venv at $VENV"
  mkdir -p "$(dirname "$VENV")"
  # Creation is all-or-nothing. `python3 -m venv` makes bin/python before pip
  # installs anything, so a run that dies partway would leave a venv that
  # exists and cannot cluster — worse than none, which at least skips cleanly
  # and gets retried. set -e means any failure below reaches this trap.
  trap 'rm -rf "$VENV"' EXIT
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r "$REQ"
  trap - EXIT
fi

# Print versions so the user can sanity-check. hdbscan doesn't expose
# __version__; query it via importlib.metadata so the check works across
# package layouts.
"$VENV/bin/python" -c "import sklearn, numpy; from importlib.metadata import version; print(f'sklearn={sklearn.__version__} hdbscan={version(\"hdbscan\")} numpy={numpy.__version__}')"
echo "[setup-venv] ready at $VENV"
