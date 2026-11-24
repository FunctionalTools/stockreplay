# Shared by setup, start and stop. These paths stay inside this checkout.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/.local/bin:$ROOT/.local/node/bin:$ROOT/.local/ollama/bin:$ROOT/.local/ollama:$PATH"
export UV_CACHE_DIR="${UV_CACHE_DIR:-$ROOT/.local/uv-cache}"
export UV_PYTHON_INSTALL_DIR="$ROOT/.local/python"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/.local/browsers}"
export npm_config_cache="${npm_config_cache:-$ROOT/.local/npm-cache}"
export STOCKREPLAY_HOME="${STOCKREPLAY_HOME:-$ROOT/.stockreplay}"
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_NO_CLOUD=1
export OLLAMA_NUM_PARALLEL=1
if [ -f "$STOCKREPLAY_HOME/model" ] && [ -z "${STOCKREPLAY_MODEL:-}" ]; then
  STOCKREPLAY_MODEL="$(cat "$STOCKREPLAY_HOME/model")"
  export STOCKREPLAY_MODEL
fi
