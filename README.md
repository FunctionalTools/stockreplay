# StockReplay for macOS

StockReplay is a stock research website that runs on your Mac. Search a ticker to see its latest completed close, read the articles behind a stock assessment, and compare published analyst opinions. Your watchlists, portfolio statements, chart drawings and saved assessments live in a local SQLite database.

![StockReplay Research showing real NVIDIA price history and published analyst ratings](docs/screenshots/research.png)

## Open StockReplay

On an Apple Silicon or Intel Mac, clone the repository and launch the app.

```bash
git clone https://github.com/FunctionalTools/stockreplay.git
cd stockreplay
./StockReplay.command
```

You can also double-click **StockReplay.command** in Finder. The first launch installs the dependencies, builds the website and opens your browser. To update an existing checkout, run `git pull --ff-only origin main` and open **StockReplay.command** again. The launcher checks for changed application files and rebuilds as needed. Run `./stop.sh` to stop the local service. [Installation details](docs/INSTALLATION.md)

## Connect your OpenAI API key

Open **Settings**, paste a project API key, choose a model and click **Connect & test**. StockReplay verifies that the selected model can generate a structured response using the same OpenAI endpoint as the assessment and assistant. Verification uses a small billable API request. Keys stay in memory for the running session unless you select **Remember key in macOS Keychain**. The model menu can discover supported models available to your project. [OpenAI API keys](https://platform.openai.com/api-keys)

In **Research**, click **Generate scores**. The model determines an independent buy score and risk score on a 0–100 scale over a six-to-twelve-month horizon. Higher buy means a stronger investment case. Higher risk means more downside or uncertainty. Each reason links to the source it uses. The assessment includes its generation date, model and confidence. Earlier assessments remain available for comparison.

If a request fails, the error identifies whether OpenAI rejected the key, restricted model access, exhausted API credits, rate-limited requests, or could not be reached. A project needs access to create Responses for its selected model. API billing is managed in the OpenAI Platform. [API billing](https://platform.openai.com/settings/organization/billing/overview)

## Your workspace

- **Research** shows real price history, analyst vote distributions, published targets, searchable individual firm ratings, and company, sector and market news. The advanced chart adds candlesticks, indicators, replay, comparisons, drawings and chart export.
- **Watchlists** lets you create named lists, add tickers from Research, import a Symbol/Ticker CSV and set local price alerts.
- **Portfolio** imports current Fidelity and other brokerage or bank statements from CSV, OFX or QFX. Preview mapped positions before applying a statement, or enter accounts, holdings and balances manually. Import a separate daily price CSV to chart your own history.
- **Settings** controls the starting stock, display mode, theme, advanced trader tools, API model and key storage.

The assistant in the lower-right corner can create a watchlist, plot multiple stocks, answer a question with linked evidence, draw a chart annotation, change settings, or work with your portfolio. Try “Compare MSFT and AAPL over one year” or “Show my portfolio allocation.” Minimize it to keep working. Portfolio totals and graphs are assembled on your Mac. [Data, sources and privacy](docs/DATA.md)

## Verification

The macOS workflow tests the local API, generation contract, Keychain storage, Chromium and WebKit interfaces, and service lifecycle on Apple Silicon and Intel. A manually dispatched live check exercises public market sources. A dedicated OpenAI API key enables the optional billable integration test. [macOS verification](https://github.com/FunctionalTools/stockreplay/actions/workflows/macos.yml) · [Verification record](BUILD_LOG.md) · [Architecture](docs/ARCHITECTURE.md)
