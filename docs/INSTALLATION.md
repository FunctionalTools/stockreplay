# Installation on macOS

Open **StockReplay.command** in Finder or run `./StockReplay.command` from the checkout. StockReplay supports Apple Silicon and Intel Macs. The launcher uses a project-local Python environment and Node build. It can download a compatible Python and the official Node distribution if needed.

The service binds to the loopback address. The default port is 8765. The launcher prints the chosen local URL and can select a nearby free port. Set `STOCKREPLAY_PORT` for a different starting port or `STOCKREPLAY_NO_BROWSER=1` to start the service without opening a browser. Run `./stop.sh` to stop the tracked process.

## Updating

In your existing checkout run `git pull --ff-only origin main`, then reopen **StockReplay.command**. The launcher checks a fingerprint of the application and dependency files. It rebuilds and restarts a previous tracked version when necessary. An update preserves the SQLite file and its holdings, watchlists, chart layouts, key settings and saved assessments. A session-only key must be re-entered after the service restarts. A saved Keychain entry can be reverified in Settings.

## Connecting the API

In Settings, enter an OpenAI API key, pick a model and click **Connect & test**. A check creates a small structured response. Use **Find models for this key** to load your project’s model choices before connecting. A key restricted to generating responses can work even if model discovery is unavailable. The model menu retains suggested models in that case. A failed replacement leaves the previous key and model selected.

For a billing error, check the API project’s available balance or limit. For a model-access error, select a model your project can use and check the key’s Responses write permission. The service uses the Mac process’s HTTPS proxy and trust settings. When a provider supplies a request ID, the interface includes it in the error. [API project settings](https://platform.openai.com/settings/organization/projects)

## Local files and testing

StockReplay stores data under `.stockreplay/` in this checkout. To back it up, stop the app and copy the directory. Set `STOCKREPLAY_HOME` to use another location. The login Keychain entry is associated with the database path. Market source caches may be restored with the rest of the database.

For browser tests, install the test browser with `STOCKREPLAY_INSTALL_BROWSERS=1 ./setup.sh`, then run `npm --prefix frontend run e2e`. Normal installation only needs your existing browser. [Workflow and test record](../BUILD_LOG.md)
