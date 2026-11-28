# Installation on macOS

Open **StockReplay.command** in Finder or run `./StockReplay.command` from the checkout. StockReplay supports Apple Silicon and Intel Macs. The launcher uses a project-local Python environment and Node build. It can download a compatible Python and the official Node distribution if needed.

The service binds to the loopback address. The default port is 8765. The launcher prints the chosen local URL and can select a nearby free port. Set `STOCKREPLAY_PORT` for a different starting port or `STOCKREPLAY_NO_BROWSER=1` to start the service without opening a browser. Run `./stop.sh` to stop the tracked process.

## Updating

In your existing checkout run `git pull --ff-only origin main`, then reopen **StockReplay.command**. Use the same checkout that contains your data and reopen its launcher. It opens a build-specific URL and the browser revalidates the launch page. The launcher checks a fingerprint of the application and dependency files. It rebuilds and restarts a previous tracked version when necessary. An update preserves the SQLite file and its holdings, watchlists, chart layouts, key settings and saved assessments. A session-only key must be re-entered after the service restarts. A saved Keychain entry can be reverified in Settings.

## Use an Ollama website API key

Open **Settings → AI connection → Ollama website API**. Choose **Get an Ollama API key**, sign in and create a key. Paste it into **Ollama website API key**, pick a model and click **Connect & test**. The website connects directly to Ollama’s hosted service. Your Mac needs only StockReplay and an internet connection for this option. Select **Remember key in macOS Keychain** to keep the key after a restart. [Create an Ollama key](https://ollama.com/settings/keys) · [Cloud API](https://docs.ollama.com/cloud)

**Model generation** reports whether the selected model produced a response. **Web search** reports whether Ollama returned web results. A key can pass one check while the other reports a limit or unavailable feature. For a generation limit, check your account’s usage or select another available model and test again. Once generation passes, look up a stock in Research. Future automatically draws the prediction and shows the scores used. You can also generate a full assessment or open the assistant. Choosing **Remember key in macOS Keychain** lets a verified hosted connection generate after StockReplay restarts. A session-only key needs to be entered again when the service restarts. Hosted generation is billed per token, including the small test request. Individual accounts include a free search allowance. [Account usage](https://ollama.com/settings) · [Model prices](https://ollama.com/pricing) · [Web search limits](https://ollama.com/blog/web-search)

## OpenAI API

In **Settings → AI connection**, select **OpenAI API**, enter an OpenAI API key, pick a model and click **Connect & test**. A check creates a small structured response. Use **Find models for this key** to load your project’s model choices before connecting. A key restricted to generating responses can work even if model discovery is unavailable. The model menu retains suggested models in that case. A failed replacement leaves the previous key and model selected.

For a billing error, check the API project’s available balance or limit. For a model-access error, select a model your project can use and check the key’s Responses write permission. The service uses the Mac process’s HTTPS proxy and trust settings. When a provider supplies a request ID, the interface includes it in the error. [API project settings](https://platform.openai.com/settings/organization/projects)

## Free local AI on a MacBook

1. Open **Apple menu → About This Mac** and check the macOS version, chip and available storage. Ollama requires macOS 14 Sonoma or later. Apple silicon uses GPU acceleration. Intel Macs use their CPU. [Mac requirements](https://docs.ollama.com/macos)
2. Download the Mac installer from Ollama, drag Ollama into Applications and open it. Accept its prompt to install the Terminal command. Keep the app running while using StockReplay’s AI. [Download Ollama](https://ollama.com/download/mac)
3. Open **Applications → Utilities → Terminal** and run `ollama pull qwen2.5:3b`. The model download is about 1.9 GB. Allow additional memory for macOS and the running model. Run `ollama ls` to confirm the download. [Model library](https://ollama.com/library/qwen2.5:3b)
4. Open **StockReplay.command → Settings**, select **On this Mac**, click **Refresh models**, select the installed tag and click **Connect & test**. Keep the window open while Ollama loads the weights. StockReplay checks the local model by generating a structured answer.
5. Look up a ticker in Research. **Future** shows the price-history prediction while the local model reads current evidence. When generation finishes, the line and the Buy and Risk scores update together. Open the calculation details for the scores’ sources. The assistant uses the same provider. Public prices and event dates are available before model setup.

The local path needs no subscription, account, remote model or paid key. StockReplay fetches publicly available research online. Ollama runs locally at `127.0.0.1:11434`. If Settings shows no models, open Ollama, finish the download and refresh. Test the service with `curl http://127.0.0.1:11434/api/tags`. If the app is closed, `ollama serve` in a separate Terminal window starts the service. Reopen Terminal after installing the CLI if the command is unavailable. Public sources can withhold or delay data. Check the evidence timestamp and coverage for the selected stock. [Ollama troubleshooting](https://docs.ollama.com/troubleshooting)

Under **Add web search to your local model**, you can paste an Ollama website key and click **Test web search**. This sends a search to Ollama while the local model continues to generate scores, forecasts and chat responses on your Mac. [Web search documentation](https://docs.ollama.com/capabilities/web-search)

## Local files and testing

StockReplay stores data under `.stockreplay/` in this checkout. To back it up, stop the app and copy the directory. Set `STOCKREPLAY_HOME` to use another location. The login Keychain entry is associated with the database path. Market source caches may be restored with the rest of the database.

For browser tests, install the test browser with `STOCKREPLAY_INSTALL_BROWSERS=1 ./setup.sh`, then run `npm --prefix frontend run e2e`. Normal installation only needs your existing browser. [Workflow and test record](../BUILD_LOG.md)

## Starting ticker after an update

Earlier releases saved NVDA even when you had only changed the appearance. On upgrade, that old value starts in **Follow my holdings** mode. If NVDA was your own choice, select it once in the Research ticker picker to pin it again. Other previously saved tickers stay pinned.
