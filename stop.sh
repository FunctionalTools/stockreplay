#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/paths.sh"
if [ ! -x .venv/bin/python ]; then echo "No project environment installed."; exit 0; fi
exec .venv/bin/python scripts/services.py stop
