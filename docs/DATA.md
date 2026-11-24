# Data and attribution

## Yahoo Finance

The Yahoo provider uses the open-source yfinance client to request daily OHLCV, adjusted close, dividends and stock splits for explicitly requested tickers and periods. Dates in the UI include both endpoints. The adapter translates the final date to the provider’s exclusive end convention. It checks US trading sessions and reports missing bars, stale coverage, delisted or unavailable symbols, and upstream failures. Requests for different Yahoo symbols are sequential.

Yahoo Finance data is supplied under its own terms for personal research. No downloaded Yahoo dataset or model weights are included in this repository. Only share a portable file or raw CSV when you have the necessary data rights. [yfinance](https://ranaroussi.github.io/yfinance/) · [Yahoo terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html)

## CSV data

**Market data → Import daily CSV** accepts one ticker per file, up to 6 MB and 15,000 daily rows. Headers are case-insensitive. Dates use YYYY-MM-DD. Prices must be positive and finite, high and low must encompass open and close, and volume and actions must be nonnegative. Duplicate dates and nonnumeric or missing observations are rejected. Optional action columns default to zero. The importer accepts a series with a gap, but execution checks every required trading session before calculating results.

```csv
Date,Open,High,Low,Close,Adj Close,Volume,Dividends,Stock Splits
2023-01-03,100,103,99,102,102,1500000,0,0
2023-01-04,102,104,100,101,101,1600000,0,0
```

This two-row example illustrates the format with synthetic numbers. For genuinely unadjusted input, supply a documented adjusted close series. For a known already-adjusted OHLC series, the same adjusted value may be used for both Close and Adj Close. Verify the corporate-action adjustment convention before use.

The data manager shows the source, first and last session, row count, last fetch time and CSV download for each snapshot. Reading a cached run or switching to a pinned version does not require a provider connection. Fetching new real data is an explicit action. The app never fills unavailable real prices with demo values.

## Bundled synthetic demonstration

`data/demo/` contains 1,005 XNYS sessions for each of NVDA, AAPL, MSFT and SPY from January 4, 2021 through December 31, 2024. The ticker labels identify independently simulated series. A seeded NumPy generator combines a common market process with independent price and volume innovations. The preparation script contains the seed and all parameters. No price series was downloaded to produce the demonstration.

Regenerate under the locked environment with `.venv/bin/python -m scripts.generate_demo`. The synthetic series and generation script are covered by this repository’s MIT license.

## Third-party components

TradingView Lightweight Charts™ v4.2.3, Copyright © 2025 TradingView, Inc., is distributed under Apache 2.0. The terminal includes a TradingView attribution link. Plotly.js is MIT licensed. The self-hosted DM Sans and IBM Plex Mono fonts retain their upstream OFL licenses in their packages. Additional dependency and model licenses remain with their respective authors. Ollama models are acquired separately under the selected model’s terms. [Lightweight Charts](https://tradingview.github.io/lightweight-charts/) · [Plotly.js](https://github.com/plotly/plotly.js) · [Fontsource](https://fontsource.org/) · [Qwen2.5 models](https://ollama.com/library/qwen2.5)
