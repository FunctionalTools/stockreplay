# StockReplay for macOS

StockReplay runs a market research website on your Mac. The opening workbench tests a five-session NVIDIA hypothesis against real Yahoo Finance history. Its three-year window advances to the latest completed US trading session, including exchange holidays and early closes. The page displays the source and actual observation dates.

![StockReplay workbench with real NVIDIA and SPY market history](docs/screenshots/workbench.png)

## Launch on a Mac

```bash
git clone https://github.com/FunctionalTools/stockreplay.git
cd stockreplay
./setup.sh
./start.sh
```

You can also double-click **StockReplay.command** in Finder. It runs setup on the first launch. The app opens at **http://127.0.0.1:8765** or the next free port printed in Terminal. Use `./stop.sh` to stop this checkout’s services.

To update an existing checkout, run `./stop.sh`, `git pull --ff-only origin main`, `./setup.sh` and `./start.sh`. Your local database stays in `.stockreplay/`. For a lightweight installation using OpenAI or the visual builder, run `STOCKREPLAY_SKIP_AI=1 ./setup.sh` to skip the optional Ollama download.

## Research a stock

1. Open **Market research**, enter a ticker and choose **Open symbol**. Review company and sector headlines, broad-market concerns, Federal Reserve releases, historical returns and analyst evidence. Each item identifies a publisher, date and source link.
2. In **Settings → OpenAI API**, enter your API project key. Choose session-only storage or macOS Keychain, then choose **Test OpenAI connection**. The model must support the Responses API and structured outputs. The default is `gpt-4.1-mini`.
3. Return to **Market research → Generate recommendation** for a directional view, time horizon, catalysts, risks and conditions that would change the view. Each claim links to its evidence. Saved recommendations can be reopened on this Mac without another API call. Generation requires current price and sector coverage and a funded API account. OpenAI receives only the selected ticker’s public evidence when you request a recommendation.
4. Open **Investor ratings** for Yahoo analyst actions, Yahoo monthly recommendation counts, Nasdaq consensus and contributing firms, Stock Analysis named-analyst ratings, and StockReplay’s technical score. Filter the full history returned by the sources or add a separately published rating with a dated URL. The score shows each factor’s contribution and observation date.

The sources have different coverage and update schedules. A firm may appear in several publications. Some ratings and full analyst reports require subscriptions. Public-source failures and cached responses are labeled. [Data sources and rating methodology](docs/DATA.md)

## Markets and portfolios

| Page | What you can do |
| --- | --- |
| Charts | Explore minute through monthly bars, candles, OHLC, lines, areas, volume, SMA, EMA, Bollinger bands, RSI, MACD and corporate actions. Compare symbols, draw levels and trend lines, replay history, save local layouts and export a PNG. |
| Market screener | Browse six Yahoo screens, filter by name, price and capitalization, sort results, and add symbols to a watchlist. Quote dates appear with the results. |
| Watchlists | Create, rename and delete local lists. Follow symbols, open charts or ratings, and create threshold alerts checked while the app is running. |
| Holdings | Preview Fidelity positions CSVs, mapped CSVs from other institutions, and OFX/QFX investment positions or bank ledger balances. Add and edit accounts or positions manually. View statement totals separately by currency. |
| TradingView tools | Explicitly load a separate TradingView frame for advanced charting, screeners, stock/ETF/crypto heatmaps, economic calendars, technical gauges, news, financials and profiles. Full Supercharts opens on TradingView for Pine Script, paper trading, broker connections, social features and subscription feeds. |

### Add Fidelity or another account

In Fidelity **Positions**, download your current positions as CSV. Open **Holdings → Import statement**, choose the file and review the account names, position counts, currencies, values and any replacement of existing records. Select **Apply reviewed statement**. Reimport when you want to update the snapshot. For a CSV without account identifiers, use the same institution and nickname on later imports. The column-mapping panel accepts a broker’s exact headers. [Fidelity’s positions guide](https://www.fidelity.com/webxpress/help/topics/learn_portfolio_positions.shtml)

Holdings, quantities, basis, account names, watchlists, notes and layouts are stored on-device. StockReplay keeps a keyed local account identifier and the last four characters of imported account numbers. Raw statements remain outside the database. Requesting a quote sends the individual ticker to Yahoo. OpenAI keys can be forgotten in Settings. [Local storage and external connections](docs/ARCHITECTURE.md)

## Test a hypothesis

Enter a question such as “Does NVIDIA have a positive five-session return after a daily loss greater than 3%?” in **Workbench**. Ollama can interpret it locally, or you can edit the rules in **Builder**. Review the dates, benchmark, execution costs and objective, then choose **Run experiment**.

**All events** includes every qualifying observation. **Met objective** and **Counterexamples** show the two outcome groups. Each observation opens a chart with the signal, entry, exit, prices, benchmark and market regime. The default order for counterexamples shows the largest shortfall against the selected objective.

The workbench supports overlapping event studies, long-only portfolio backtests, shared-calendar comparisons, time-block bootstrap inference, sensitivity grids, chronological holdouts and expanding walk-forward evaluation. Save, duplicate, compare or export experiments and reproduce them offline from their pinned snapshots. [Statistical methodology](docs/METHODOLOGY.md)

## Verification and documentation

```bash
.venv/bin/python -m pytest -q
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run e2e
```

Browser tests use a temporary database. Deterministic tests inject their own CSV fixtures. Set `STOCKREPLAY_LIVE_TESTS=1` to exercise actual providers and a locally installed Ollama model. GitHub Actions runs installation, Keychain, Chromium, WebKit and launch/stop checks on Apple Silicon and Intel macOS 15 runners. [macOS verification](https://github.com/FunctionalTools/stockreplay/actions/workflows/macos.yml)

[Installation and troubleshooting](docs/INSTALLATION.md) · [Architecture](docs/ARCHITECTURE.md) · [Data and attribution](docs/DATA.md) · [Verification record](BUILD_LOG.md) · [MIT license](LICENSE)
