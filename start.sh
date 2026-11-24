#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/paths.sh"
if [ ! -x .venv/bin/python ] || [ ! -f frontend/dist/index.html ] || [ "$(.venv/bin/python scripts/build_id.py)" != "$(cat .local/build-id 2>/dev/null || true)" ]; then
  ./setup.sh
fi
exec .venv/bin/python scripts/services.py start
