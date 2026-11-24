# StockReplay build and verification

## Release environment

November 24, 2026. The connected development machine ran x86-64 Linux on an AMD EPYC CPU, with five visible CPUs, a four-core cgroup quota, 16 GiB of cgroup memory and about 30 GiB of available workspace disk at initial inspection. Python 3.12.14, Node 24.22.3, npm 11.19.1, uv and system Chromium were available. A macOS host was unavailable for execution.

The repository started at its initial README commit on the existing main branch. All application code, synthetic series, local scripts, lockfiles, tests and screenshots were created for this build. Downloaded vendor prices, model weights, databases, browser traces and dependency trees were excluded from Git.

## Implemented decisions

- The local Python engine owns prices, signals, statistics, position accounting and chart values. The React terminal shows the actual run and its data source.
- Ollama produces schema-constrained plans. Literal thresholds and horizons are validated before the user reviews the complete config. The assistant composes an explanation from assessments and evidence clauses grounded in the stored results.
- Event studies retain overlaps. Backtests isolate capital per symbol and prevent overlapping positions. Time-block resampling preserves simultaneous events. Training selections and holdout evaluation use separate chronological periods.
- SQLite stores versioned, content-addressed price snapshots. Portable files embed their inputs and reproduce calculations without the provider. Rendering HTML reports requires no external assets.
- The default landing study uses labeled synthetic series. New experiments default to Yahoo Finance. A provider failure stays visible to the researcher.

## Actual integration runs

The official Linux Ollama binary (0.40.18) was installed in the workspace. Its local service answered the tags and chat APIs. Both Qwen2.5 3B and 7B were downloaded. Early 3B tests misread the sign of a loss and the number of holding sessions. The build added explicit-literal checks and chose Qwen2.5 7B for this memory tier. Inference used CPU and required no cloud AI credentials. Live cross-stock checks also exposed a trigger assigned to the traded asset and an unspecified ticker inferred from a prompt example. The validator now binds named trigger stocks and asks for clarification when the traded ticker is ungrounded. Live regression questions covered MSFT reacting to NVDA, an unnamed stock, and a question requiring unavailable social-media data.

The provider returned 502 daily bars each for NVDA and SPY from January 3, 2023 through December 31, 2024. A separate real-data run spanning January 4, 2021 through December 31, 2024 tested a fall greater than 3%, a five-session hold and 2 bps commission plus 3 bps slippage per side. It found **143 events**, **59 counterexamples**, and a **+1.15% mean net return**. The matched SPY windows averaged **+0.16%**. The 95% time-block interval for mean directional return was **−0.22% to +2.78%**, which includes zero. These values describe the fetched historical snapshot. An exported and reimported experiment reproduced the complete event ledger and metrics from both embedded snapshots.

A separate installation in a clean source directory created its own virtual environment, installed the locked npm packages, built the terminal and discovered the installed model. With port 8765 occupied, the launcher chose 8766. A second start reused that instance. Stopping it left the independently running service on 8765 and Ollama available. A repeated setup reused installed dependencies. A separate lifecycle check stopped both the app and a project-managed Ollama, confirmed that both ports closed, then restarted both services with the app at 8765. The startup probe allows immediate reuse of a recently closed port.

## Browser verification

Chromium exercised natural-language entry, local interpretation, inspection of the signed threshold and holding period, Yahoo download, engine execution and an evidence-grounded explanation. It opened an individual counterexample, ran a chronological sensitivity study, saved the experiment and downloaded a self-contained report. Other scenarios covered portfolio equity, event paths, distributions, chart exports, CSV ingestion, library edits and duplication, side-by-side comparisons, portable import and mobile navigation.

Visual inspection caught an empty histogram and an initially over-wide counterexample chart. The engine now supplies histogram bins and counts directly, and the event chart shows a local candle window with distinct signal, entry and exit markers. Screenshots were captured from the running app and are included below.

[Workbench](docs/screenshots/workbench.png) · [Counterexample](docs/screenshots/counterexample.png) · [Robustness lab](docs/screenshots/robustness.png) · [Mobile](docs/screenshots/mobile.png)

## Final automated results

| Check | Actual result |
| --- | --- |
| `STOCKREPLAY_LIVE_TESTS=1 .venv/bin/python -m pytest -q` | 64 passed in 111.74 seconds. All live tests ran, including four installed-model language cases and fresh Yahoo acquisition with cached replay |
| `npm --prefix frontend test` | 6 Vitest tests passed |
| `npm --prefix frontend run build` | TypeScript checking and Vite production build completed |
| `STOCKREPLAY_LIVE_TESTS=1 STOCKREPLAY_SCREENSHOTS=1 npm --prefix frontend run e2e` | 6 Playwright scenarios passed in 2.3 minutes, including the real Ollama-to-Yahoo workflow and verified model-generated evidence selection |
| CSV regression | The 12-test ingestion suite passed. The focused Chromium CSV import/export workflow passed again after duplicate-header validation was tightened |
| Local lifecycle and portability | Fresh setup, repeated setup, occupied-port startup, repeated start, scoped stop, restart and checksum-pinned real-data replay verified |

The Python suite reported seven upstream deprecation warnings from exchange-calendars and the Starlette test client. Vite reported the size of the lazy-loaded Plotly bundle. These notices did not prevent the production build or tests from completing.

## Scope

Testing was performed on Linux and Chromium. The macOS installer paths, Homebrew integration and other browsers remain unverified on their native platforms. Market coverage is restricted to daily US sessions, with long-only cash portfolios and stocks or ETFs supplied by the selected source. First-time installation, model pulls and fresh Yahoo downloads require network access. Cached data and portable experiments can be used offline.
