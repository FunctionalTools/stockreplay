"""Start, health-check and stop only processes launched by this checkout."""

import fcntl
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get("STOCKREPLAY_HOME", ROOT / ".stockreplay")).resolve()
STATE.mkdir(parents=True, exist_ok=True)
OLLAMA = "http://127.0.0.1:11434"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(url, data=None, timeout=2):
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with OPENER.open(req, timeout=timeout) as r:
        return json.load(r)


def healthy(url, field, value=None):
    try:
        result = request(url)
        return field in result and (value is None or result[field] == value)
    except (OSError, ValueError):
        return False


def identity(pid):
    proc = subprocess.run(
        ["ps", "-p", str(pid), "-o", "lstart=", "-o", "command="], capture_output=True, text=True
    )
    return proc.stdout.strip()


def tracked(name):
    try:
        data = json.loads((STATE / (name + ".pid.json")).read_text())
        if data["identity"] and data["identity"] == identity(data["pid"]):
            return data
    except (OSError, ValueError, KeyError):
        pass
    return None


def spawn(name, args, url, field, value=None):
    with (STATE / (name + ".log")).open("ab") as log:
        child = subprocess.Popen(
            args, cwd=ROOT, stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True
        )
    for _ in range(160):
        if child.poll() is not None:
            break
        if healthy(url, field, value):
            record = {"pid": child.pid, "identity": identity(child.pid), "url": url}
            (STATE / (name + ".pid.json")).write_text(json.dumps(record))
            return True
        time.sleep(0.25)
    if child.poll() is None:
        child.terminate()
    return False


def ollama():
    if healthy(OLLAMA + "/api/tags", "models"):
        return True
    binary = shutil.which("ollama")
    if not binary:
        return False
    if str(binary).startswith(str(ROOT / ".local")):
        os.environ.setdefault("OLLAMA_MODELS", str(ROOT / ".local/models"))
    return spawn("ollama", [binary, "serve"], OLLAMA + "/api/tags", "models")


def model():
    if not ollama():
        raise SystemExit(
            f"Ollama did not start. Check {STATE}/ollama.log and run ollama serve. The visual builder is available via ./start.sh."
        )
    name = os.environ.get("STOCKREPLAY_MODEL", "qwen2.5:7b")
    models = request(OLLAMA + "/api/tags")["models"]
    if name not in {m["name"] for m in models} and name + ":latest" not in {
        m["name"] for m in models
    }:
        print("Downloading " + name + " into the local Ollama installation.", flush=True)
        req = urllib.request.Request(
            OLLAMA + "/api/pull",
            data=json.dumps({"model": name, "stream": True}).encode(),
            headers={"Content-Type": "application/json"},
        )
        seen = ""
        with OPENER.open(req, timeout=600) as response:
            for line in response:
                part = json.loads(line)
                if "error" in part:
                    raise SystemExit(part["error"])
                if part.get("status") != seen:
                    seen = part.get("status")
                    print(seen, flush=True)
    if not any(
        m["name"] in (name, name + ":latest") for m in request(OLLAMA + "/api/tags")["models"]
    ):
        raise SystemExit("The requested model is missing. Retry ./setup.sh.")
    print("Ollama ready · " + name)


def start():
    ai = False if os.environ.get("STOCKREPLAY_SKIP_AI") == "1" else ollama()
    record = tracked("app")
    if record and healthy(record["url"], "application", "StockReplay"):
        url = record["url"].removesuffix("/api/health")
    else:
        port = int(os.environ.get("STOCKREPLAY_PORT", "8765"))
        if not 1 <= port <= 65535:
            raise SystemExit("Choose a port between 1 and 65535.")
        for candidate in range(port, min(65536, port + 20)):
            try:
                with socket.socket() as sock:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    sock.bind(("127.0.0.1", candidate))
            except OSError:
                continue
            url = f"http://127.0.0.1:{candidate}"
            if spawn(
                "app",
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "stockreplay.api:create_app",
                    "--factory",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(candidate),
                ],
                url + "/api/health",
                "application",
                "StockReplay",
            ):
                break
            raise SystemExit(f"The local app did not start. Check {STATE}/app.log")
        else:
            raise SystemExit("No free local port in the requested range. Set STOCKREPLAY_PORT.")
    if not ai:
        print("Ollama unavailable or skipped. The visual builder is ready.")
    elif not request(url + "/api/ai").get("ready"):
        print("Selected model unavailable. Check Settings or rerun ./setup.sh.")
    print("StockReplay is ready at " + url, flush=True)
    if os.environ.get("STOCKREPLAY_NO_BROWSER") != "1":
        webbrowser.open(url)


def stop():
    for name in ["app", "ollama"]:
        record = tracked(name)
        if record:
            try:
                os.kill(record["pid"], signal.SIGTERM)
            except ProcessLookupError:
                pass
            for _ in range(80):
                if not tracked(name):
                    break
                time.sleep(0.1)
            if tracked(name):
                print(f"{name} is still shutting down. Its process record was retained.")
                continue
            print("Stopped " + name)
        (STATE / (name + ".pid.json")).unlink(missing_ok=True)


if __name__ == "__main__":
    with (STATE / "services.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        {"start": start, "stop": stop, "model": model}[sys.argv[1]]()
