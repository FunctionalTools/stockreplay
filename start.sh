#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/paths.sh"
if [ ! -x .venv/bin/python ] || [ ! -f frontend/dist/index.html ]; then
  echo "Install the local environment with ./setup.sh first."
  exit 1
fi
exec .venv/bin/python scripts/services.py start
