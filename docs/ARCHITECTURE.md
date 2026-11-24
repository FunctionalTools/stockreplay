# Architecture

The production app serves a built React terminal and its FastAPI API from one loopback origin. SQLite is embedded in the Python service. Ollama interprets hypotheses locally. An explicitly requested stock recommendation uses OpenAI’s Responses API. Vite is used during development and for the production build.

```mermaid
flowchart LR
    UI[React research terminal] --> API[FastAPI]
    API --> Desk[Public market research]
    Desk --> Sources[Yahoo, Nasdaq, Stock Analysis, Federal Reserve]
    Desk --> OpenAI[Opt-in Responses API]
    API --> Local[Local holdings, watchlists and alerts]
    Local --> DB
    API --> AI[Ollama on localhost]
    AI --> Schema[Pydantic validation]
    Schema --> UI
    API --> Market[Market data and session checks]
    Market --> Yahoo[Yahoo Finance via yfinance]
    Market <--> DB[(SQLite snapshots and research)]
    Market --> Engine[Deterministic event and portfolio engine]
    Engine --> Stats[Block inference and robustness]
    Stats --> DB
    DB --> Report[Grounded explanations and exports]
    Report --> UI
```

| Module | Responsibility |
| --- | --- |
| `stockreplay/schema.py`, `language.py`, `ai.py` | Validate experiment and model outputs, bind explicit literal amounts and horizons, request clarification or missing data, compose explanations from verified evidence |
| `market.py` | Normalize OHLCV, corporate actions and dates, identify required symbols, check NYSE sessions, download or read cached data |
| `indicators.py`, `engine.py` | Evaluate predefined logical conditions, execute realistic event or portfolio accounting and produce chart series |
| `statistics.py`, `robustness.py` | Time-block bootstrap, portfolio metrics, sensitivity grids and chronological evaluation |
| `store.py` | SQLite snapshots, run payloads, saved records, notes, model preference and comparison reports |
| `desk.py`, `public_cache.py`, `trading_calendar.py` | Public provider adapters, exchange-aware defaults, per-source timestamps and stale-on-error caching |
| `holdings.py`, `terminal_api.py` | Atomic statement preview/apply, account editing, watchlists, background price alerts, ratings and local chart layouts |
| `openai_research.py` | Keychain or session key storage, explicit public-evidence payloads, strict Responses API output and citation validation |
| `exports.py` | CSV, config JSON, self-contained HTML, portable snapshot bundles and checked import |
| `api.py` | Local API, bounded execution queue, health, experiment library, cached robustness/AI evidence and static frontend |
| `frontend/src/` | Typed React terminal, visual builder, charts, explorer, library, comparisons, data management and settings |
| `scripts/services.py` | Health-checked process startup, port selection, logging and scoped shutdown |

## Interpretation and explanation

Ollama receives the user’s question and the displayed defaults through `/api/chat` with a JSON schema, deterministic sampling settings and a fixed seed. Pydantic validates the model’s plan and the fully materialized experiment. Explicit signed price moves, named trigger symbols and unambiguous holding-period literals are bound during validation. A traded symbol must be grounded in the question through its exchange symbol or a recognized company name. Other company names prompt for their ticker. Two correction retries are available after the initial attempt. Unsupported data and unresolved questions have explicit response states. The builder exposes the actual JSON for review before running.

An experiment contains only whitelisted indicators, comparisons, typed fields and logical groups. The model cannot submit executable code, SQL, tools or remote URLs. At explanation time, the server builds supported assessments and alternative evidence clauses from computed results. The local model selects an assessment, phrasing and sequence. The renderer resolves the selected clauses against engine evidence. Invalid selections retry and then use an explicitly identified engine summary. There is no free-form numerical output path.

## Data and reproducibility

Each snapshot is identified by SHA-256 over its source identifier, ticker and canonical CSV bytes. SQLite stores compressed raw observations and acquisition metadata. Multiple versions of the same ticker and period can coexist. A run records the exact input hashes, resolved parameters, engine version, seed, prices, event ledger, metrics and chart data. Saved research links a name and notes to a completed run. Rerunning a compatible saved configuration reuses its pinned snapshots. A broader date range or another provider requires the corresponding inputs.

A portable `.stockreplay.json` file includes the experiment configuration, engine version and all required input series. Import checks structure, data checksums and OHLCV validity, then calculates a fresh run. The portable file contains JSON and CSV. Its checksum detects changed snapshot contents. Original vendor authentication requires a separate trusted source. Lockfiles fix dependency resolution for repeatable installation.

Interactive jobs expose queued, loading, calculating, completed and failed states. The service retains up to 128 recent status entries and persists completed runs in SQLite. Two worker threads execute runs with up to eight pending or active jobs. Queue status is process-local; after restarting, previously saved research can be reopened from SQLite.

## OpenAI, account records and external connections

The API listens on loopback. Credentials enter through the local Settings form. Keys remain in the Python process unless the user selects macOS Keychain. SQLite saves the model and storage preference. The service calls only `https://api.openai.com/v1/` for OpenAI. A model-access check is separate from paid generation.

The market recommendation endpoint accepts a symbol. It constructs an allowlisted payload containing that symbol, session date and public evidence items. It never receives account IDs, watchlist contents, statements, holdings, cost basis, research notes or custom source URLs from the client. Requests set `store: false`. The server checks the structured result, every citation ID, coverage across company/sector/market/price evidence, and literal numerical claims against the cited items. Successful recommendations and cited evidence are archived in local SQLite by symbol and generation time. Provider retention and billing depend on the OpenAI API project. [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create) · [OpenAI data controls](https://platform.openai.com/docs/guides/your-data)

Holdings import validation and commit run locally. A per-workspace random secret derives pseudonymous account identifiers. Imported account labels expose only a last-four suffix. Statement previews include revisions covering the positions to replace. Applying a stale revision fails atomically, even for a multi-account file. Manual edits and repeat imports share the same database. Local data files use owner-only permissions.

TradingView embeds are created only after **Load TradingView tool**. The iframe belongs to TradingView’s separate origin, has a restricted sandbox and omits the referrer. StockReplay loads its React code, fonts and native charts locally. TradingView account services remain on TradingView’s origin. [TradingView widget documentation](https://www.tradingview.com/widget-docs/widgets/charts/advanced-chart/)

## Development

```bash
.venv/bin/python -m uvicorn stockreplay.api:create_app --factory --host 127.0.0.1 --port 8765
# In a second terminal
npm --prefix frontend run dev
```

Vite proxies `/api` to the local backend. Lightweight Charts renders candlesticks, and a lazy-loaded Plotly basic bundle renders lines and histogram bars. Fonts and JavaScript assets are served locally. The opening workbench fetches live history. Market pages fetch the selected public symbol, watchlist quote requests send individual tickers, and saved alerts poll those symbols while the service runs.
