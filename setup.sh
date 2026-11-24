#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/paths.sh"
mkdir -p .local/bin "$STOCKREPLAY_HOME"
arch="$(uname -m)"
ram="$(sysctl -n hw.memsize)"
case "$arch" in arm64) node_arch=arm64 ;; x86_64) node_arch=x64 ;; *) echo "Unsupported Mac processor: $arch"; exit 1 ;; esac
echo "StockReplay setup · macOS $(sw_vers -productVersion) · $arch · $((ram/1073741824)) GiB RAM"
df -h "$ROOT" | tail -1
command -v curl >/dev/null || { echo "Install curl to download official releases."; exit 1; }
if ! command -v uv >/dev/null; then
  curl -fsSL --retry 2 https://astral.sh/uv/install.sh -o .local/install-uv.sh
  UV_UNMANAGED_INSTALL="$ROOT/.local/bin" sh .local/install-uv.sh
fi
if command -v python3 >/dev/null && python3 -c 'import sys; sys.exit(not ((3,11)<=sys.version_info[:2]<(3,15)))'; then
  pybin="$(command -v python3)"
else
  uv python install 3.12
  pybin="$(uv python find --managed-python 3.12)"
fi
uv sync --locked --python "$pybin"
if ! command -v node >/dev/null || ! command -v npm >/dev/null || ! node -e 'process.exit(+process.versions.node.split(".")[0]>=20?0:1)'; then
  node_version=v22.16.0
  archive="node-$node_version-darwin-$node_arch.tar.gz"
  curl -fsSL --retry 2 "https://nodejs.org/dist/$node_version/$archive" -o ".local/$archive"
  curl -fsSL --retry 2 "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -o .local/node-shasums
  .venv/bin/python - "$archive" <<'PY'
import hashlib,pathlib,sys
name=sys.argv[1]
checks=dict((line.split()[1],line.split()[0]) for line in pathlib.Path(".local/node-shasums").read_text().splitlines() if len(line.split())==2)
if hashlib.sha256(pathlib.Path(".local",name).read_bytes()).hexdigest()!=checks.get(name):
    raise SystemExit("Node archive checksum mismatch.")
PY
  mkdir -p .local/node
  tar xzf ".local/$archive" -C .local/node --strip-components=1
  rm ".local/$archive"
fi
echo "Using $(.venv/bin/python --version), Node $(node --version), npm $(npm --version)"
stamp="$(.venv/bin/python -c 'import hashlib;print(hashlib.sha256(open("frontend/package-lock.json","rb").read()).hexdigest())')-$(node -p 'process.versions.modules')"
if [ ! -x frontend/node_modules/.bin/vite ] || [ "$stamp" != "$(cat .local/npm-stamp 2>/dev/null || true)" ]; then
  npm --prefix frontend ci --no-audit --no-fund
  echo "$stamp" > .local/npm-stamp
fi
npm --prefix frontend run build
if [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ]; then
  (cd frontend && ./node_modules/.bin/playwright install chromium)
fi
if [ "${STOCKREPLAY_SKIP_AI:-0}" = 1 ]; then echo "Market workspace ready. Run ./start.sh."; exit 0; fi
if ! command -v ollama >/dev/null && ! curl -fsS --max-time 2 "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
  if command -v brew >/dev/null; then
    brew install ollama
  else
    mkdir -p .local/ollama
    curl -fL --retry 2 https://ollama.com/download/ollama-darwin.tgz -o .local/ollama.tgz
    tar xzf .local/ollama.tgz -C .local/ollama
    rm .local/ollama.tgz
  fi
fi
if [ -z "${STOCKREPLAY_MODEL:-}" ]; then
  if [ "$ram" -ge 13958643712 ]; then STOCKREPLAY_MODEL=qwen2.5:7b
  elif [ "$ram" -ge 7516192768 ]; then STOCKREPLAY_MODEL=qwen2.5:3b
  else STOCKREPLAY_MODEL=qwen2.5:1.5b; fi
fi
export STOCKREPLAY_MODEL
echo "$STOCKREPLAY_MODEL" > "$STOCKREPLAY_HOME/model"
.venv/bin/python scripts/services.py model
echo "Setup complete. Run ./start.sh."
