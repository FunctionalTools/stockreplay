#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/scripts/paths.sh"
mkdir -p .local/bin "$STOCKREPLAY_HOME"
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in Darwin) ram="$(sysctl -n hw.memsize)"; node_os=darwin ;; Linux) ram="$(awk '/MemTotal/{printf "%.0f",$2*1024}' /proc/meminfo)"; node_os=linux
  if [ -r /sys/fs/cgroup/memory.max ]; then limit="$(cat /sys/fs/cgroup/memory.max)"; if [[ "$limit" =~ ^[0-9]+$ ]] && [ "$limit" -lt "$ram" ]; then ram="$limit"; fi; fi ;;
*) echo "Use macOS or Linux (including WSL2)."; exit 1 ;; esac
case "$arch" in arm64|aarch64) node_arch=arm64; ollama_arch=arm64 ;; x86_64|amd64) node_arch=x64; ollama_arch=amd64 ;; *) echo "Unsupported CPU architecture: $arch"; exit 1 ;; esac
echo "StockReplay setup · $os $arch · $((ram/1073741824)) GiB RAM"
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
  archive="node-$node_version-$node_os-$node_arch.tar.gz"
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
if [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ] && ! command -v chromium >/dev/null; then
  (cd frontend && ./node_modules/.bin/playwright install chromium)
fi
if [ "${STOCKREPLAY_SKIP_AI:-0}" = 1 ]; then echo "Builder setup complete. Run ./start.sh."; exit 0; fi
if ! command -v ollama >/dev/null && ! curl -fsS --max-time 2 "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
  if [ "$os" = Darwin ] && command -v brew >/dev/null; then
    brew install ollama
  else
    mkdir -p .local/ollama
    if [ "$os" = Darwin ]; then
      curl -fL --retry 2 https://ollama.com/download/ollama-darwin.tgz -o .local/ollama.tgz
      tar xzf .local/ollama.tgz -C .local/ollama
      rm .local/ollama.tgz
    else
      curl -fL --retry 2 "https://ollama.com/download/ollama-linux-$ollama_arch.tar.zst" -o .local/ollama.tar.zst
      if command -v zstd >/dev/null; then
        tar --zstd -xf .local/ollama.tar.zst -C .local/ollama
      else
        uv run --no-project --with zstandard python -c 'import zstandard,sys; zstandard.ZstdDecompressor().copy_stream(open(".local/ollama.tar.zst","rb"),sys.stdout.buffer)' | tar -xf - -C .local/ollama
      fi
      rm .local/ollama.tar.zst
    fi
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
