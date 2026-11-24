# Shared by setup, start and stop. These paths stay inside this checkout.
if [ "$(uname -s)" != Darwin ]; then
  echo "StockReplay requires macOS. Run this checkout on an Apple Silicon or Intel Mac." >&2
  exit 1
fi
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/.local/bin:$ROOT/.local/node/bin:$PATH"
export UV_CACHE_DIR="${UV_CACHE_DIR:-$ROOT/.local/uv-cache}"
export UV_PYTHON_INSTALL_DIR="$ROOT/.local/python"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/.local/browsers}"
export npm_config_cache="${npm_config_cache:-$ROOT/.local/npm-cache}"
export STOCKREPLAY_HOME="${STOCKREPLAY_HOME:-$ROOT/.stockreplay}"
