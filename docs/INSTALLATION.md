# Installation and troubleshooting

## Requirements

StockReplay targets macOS and Linux on arm64 or x86-64. The local AI runtime also requires a platform supported by the installed Ollama release. Setup checks the system, CPU architecture, available memory, disk space, Python, Node, npm and Ollama. The tested machine is described in the build log.

Allow space for Python packages, the web build, Chromium, Ollama and the model. A 7B model is approximately 4.7 GB before inference overhead. The Linux Ollama distribution and its extracted libraries require additional disk space. Initial installation and new market downloads use the network.

## Setup

```bash
./setup.sh
./start.sh
```

Setup reuses compatible tools. It installs uv locally when needed, finds or installs a supported Python, and synchronizes the isolated `.venv` from `uv.lock`. If Node or npm is missing, setup retrieves an official Node binary and checks its archive digest. It installs the locked frontend dependencies and builds the production UI. System Chromium can be used on Linux, otherwise setup installs Chromium through Playwright.

On macOS, setup uses an existing Homebrew installation for a missing Ollama binary. Without Homebrew, it unpacks the official macOS CLI distribution under `.local/ollama`. On Linux, it uses Ollama’s official binary distribution for the detected architecture. An existing Ollama service on 127.0.0.1:11434 is reused. Downloaded binaries, npm packages, browser binaries and weights are excluded from Git.

Setup selects a Qwen2.5 instruction model using the machine's available memory limit. The defaults are 7B at 13 GiB or above, 3B at 7 GiB or above, and 1.5B on smaller machines. Smaller models can need more human correction. Model speed depends on memory bandwidth, CPU and available acceleration. No NVIDIA hardware is required.

```bash
STOCKREPLAY_MODEL=qwen2.5:3b ./setup.sh
STOCKREPLAY_NO_BROWSER=1 ./start.sh
```

**Settings** displays the local service, installed model names and active selection. A saved model preference in SQLite takes precedence over the installation default. To switch to a new model, download it through setup, select it in Settings and save the preference. A project-managed Ollama keeps model weights in `.local/models`. An existing Ollama installation uses its configured model store. Ollama may create a local identity in `~/.ollama` as part of ordinary startup.

### Builder-only setup

```bash
STOCKREPLAY_SKIP_AI=1 ./setup.sh
STOCKREPLAY_SKIP_AI=1 ./start.sh
```

Use **Builder** to choose rules and data. The numerical engine, visualizations, robustness lab, library and exports require only local application dependencies. To add AI later, rerun normal setup.

## Launch and storage

The launcher serves the frontend and API together on loopback. It tries the requested port and then the next nineteen ports. It prints the selected URL, verifies the health endpoint and normally opens the system browser. Repeated starts reuse the tracked healthy application. Stop uses recorded process identity to avoid terminating an independently running Ollama or another checkout.

| Setting | Purpose |
| --- | --- |
| `STOCKREPLAY_HOME` | SQLite, process records and logs. Defaults to `.stockreplay` in the checkout |
| `STOCKREPLAY_PORT` | Preferred HTTP port. Defaults to 8765 |
| `STOCKREPLAY_MODEL` | Installation or launch default, e.g. `qwen2.5:7b` |
| `STOCKREPLAY_NO_BROWSER=1` | Start and print the URL without opening a browser |
| `STOCKREPLAY_SKIP_AI=1` | Skip AI installation or startup |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Absolute path to an existing Chromium executable for browser tests |

The app serves its OpenAPI interface at `/docs` and its health check at `/api/health`. Application logs are in `.stockreplay/app.log`. A project-started Ollama writes to `.stockreplay/ollama.log`.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Ollama offline or port 11434 busy | Check `curl http://127.0.0.1:11434/api/tags`. Start the installed Ollama app or run `ollama serve` when the port is free. Press **Check connection** in Settings |
| Model missing or insufficient memory | Choose an installed model in Settings or run `STOCKREPLAY_MODEL=qwen2.5:1.5b ./setup.sh`. Use the builder while changing models |
| Permission error creating Ollama identity | Run Ollama under a user account with write access to its own `~/.ollama` directory |
| Yahoo refuses a download or rate-limits requests | Use a covered cached period, wait before retrying, or explicitly select and import CSV data. **Market data → Fetch from Yahoo** requests a refreshed snapshot |
| Missing trading sessions | Check listing dates, trading calendar and symbol. Import a complete dataset or shorten the range. Required sessions are reported in the error |
| No observations or confidence interval | Inspect the rule units, moving-average warm-up, period length, signal frequency and block length |
| Launch port differs from 8765 | Use the URL printed by the launcher or choose `STOCKREPLAY_PORT=8900 ./start.sh` |
| Browser runtime lacks Linux system libraries | On a supported Debian/Ubuntu system, run `cd frontend && ./node_modules/.bin/playwright install-deps chromium` with the requested administrator authorization, or use an existing Chromium via the environment variable |
| Browser did not open | Visit the printed loopback URL directly |
| Network unavailable during installation | Restore network access for the first dependency/model download. Subsequent research can use cached or imported data |

## Re-run verification

From the repository root, use the commands in the README. The browser tests automatically find Chromium installed by setup. Live integration tests default to `qwen2.5:7b`; set `STOCKREPLAY_MODEL` to test a different installed model. Set `STOCKREPLAY_SCREENSHOTS=1` to update the checked-in screenshots from the browser suite. Tests use a temporary database and a dedicated port (18765 by default).

Official installation resources are maintained by the respective projects. [uv](https://docs.astral.sh/uv/getting-started/installation/) · [Node.js](https://nodejs.org/en/download) · [Ollama](https://ollama.com/download) · [Playwright](https://playwright.dev/docs/browsers)
