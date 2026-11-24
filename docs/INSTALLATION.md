# Installation on macOS

StockReplay supports Apple Silicon and Intel Macs. The setup and lifecycle scripts check for Darwin before installing or starting the service. Run the app under your regular macOS user account.

## First launch

Double-click **StockReplay.command** in the checkout, or run the commands below in Terminal.

```bash
./setup.sh
./start.sh
```

Setup reuses compatible Python, uv, Node and npm installations. If needed, it installs uv, a supported Python and a checksum-verified Darwin Node binary in this checkout. It synchronizes the locked dependencies, builds the UI and installs Playwright Chromium for verification. The native CI matrix exercises Apple Silicon and Intel macOS 15 with Chromium and WebKit.

Ollama is optional for public market research, OpenAI recommendations, holdings, visual strategy construction and replay. To skip its initial installation, run `STOCKREPLAY_SKIP_AI=1 ./setup.sh`. Regular setup reuses a local Ollama installation, installs it via existing Homebrew, or downloads the official Darwin distribution. Setup selects Qwen2.5 7B for systems with at least 13 GiB RAM, 3B for 7 GiB or more, or 1.5B on smaller Macs. The 7B weights require roughly 4.7 GB of disk space.

```bash
STOCKREPLAY_MODEL=qwen2.5:3b ./setup.sh
```

Use **Settings → OpenAI API** to add an API key. Session-only is the default. Select **Remember in macOS Keychain** to retain it across restarts. **Test OpenAI connection** checks access to the model. **Remove API key** removes the session credential and its saved Keychain entry.

## Lifecycle and storage

| Setting | Effect |
| --- | --- |
| `STOCKREPLAY_HOME` | Local research database, snapshots, account positions and process logs. Defaults to `.stockreplay` in this checkout. |
| `STOCKREPLAY_PORT` | Preferred HTTP port, default 8765. The launcher checks up to twenty loopback ports. |
| `STOCKREPLAY_NO_BROWSER=1` | Start the service without opening the default browser. |
| `STOCKREPLAY_SKIP_AI=1` | Skip local Ollama installation during setup or startup during launch. |
| `STOCKREPLAY_MODEL` | Select the local Ollama model. OpenAI model selection is independent and lives in Settings. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Optional path to a compatible Chromium build for tests. |

Running `./start.sh` again reuses a healthy service from the checkout. `./stop.sh` checks process identity and stops only services launched by this checkout. To back up the complete SQLite database, stop StockReplay and copy `.stockreplay/` to storage you control. The Mac login Keychain is managed separately. SQLite data uses ordinary macOS file permissions. FileVault provides encryption of the Mac’s storage.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Current data or a rating is missing | Inspect the named provider and source date, then choose **Refresh sources**. Company and sector coverage varies. The daily default advances after the NYSE closes, including early closes. |
| OpenAI declines the request | Check the selected model, project access, API billing and rate limits. Test the key in Settings. A paid ChatGPT plan has separate billing. |
| Keychain access was declined | Unlock the login Keychain or use session-only storage. Remove a saved key through Settings before deleting a checkout. |
| Ollama is offline | Check `curl http://127.0.0.1:11434/api/tags`, start the installed Ollama app or run setup, and use **Check connection**. |
| An imported statement will replace positions | Review the account and every position in the preview. Apply once satisfied. Re-preview if that account was edited in the meantime. |
| No symbol in a bank or private investment record | Supply its description and value manually, import an OFX/QFX ledger balance or map the description and market-value columns of a CSV. |
| Port 8765 is occupied | Open the loopback address printed by the launcher, or set `STOCKREPLAY_PORT=8900`. |
| Browser did not open | Visit the printed loopback address in Safari or Chromium. |

Official installation resources are available from the projects. [uv](https://docs.astral.sh/uv/getting-started/installation/) · [Node.js](https://nodejs.org/en/download) · [Ollama](https://ollama.com/download) · [Playwright](https://playwright.dev/docs/browsers)
