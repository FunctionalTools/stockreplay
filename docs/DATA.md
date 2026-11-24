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

The data manager displays each snapshot’s source, coverage dates, row count, retrieval time and CSV download. Workbench defaults cover a rolling three-year window ending at the latest completed XNYS session. Intraday, weekly and monthly views in Charts have independent interval limits. Chart headers identify the actual observation, currency and exchange timezone. Historical prices used for research are adjusted for corporate actions. The holdings quote comparison uses the reported nominal price.

## Public research and ratings

| Source | Observations | Dating and coverage |
| --- | --- | --- |
| Yahoo Finance | Adjusted bars, volume, corporate actions, nominal quotes, company fundamentals and market screen results. Company, sector ETF and SPY news headlines. | Bars and news display observation or publication dates. Quote and market screen data may be delayed. Fundamentals show retrieval dates. |
| Yahoo analyst data | Firm-level upgrades, downgrades, initiations, targets and rolling recommendation counts. | Actions have publisher dates. Consensus buckets run from the current month to earlier monthly responses. |
| Nasdaq analyst research | Published mean rating, coverage statement and list of contributing firms. | The original Nasdaq link and retrieval date appear alongside its consensus. |
| Stock Analysis | Each dated analyst row on the publicly accessible ratings table, including firm, named analyst when available, action, rating and target. | Coverage is limited to the rows the publisher makes accessible. Additional history can require a subscription. |
| Federal Reserve | Dated press-release headlines. | The research feed preserves the release link, publication time and source. |
| Saved public disclosures | User-supplied rating, publisher, date and original URL. | Stored per symbol on this Mac. They are included in the ratings page. |

Each feed retains its own provenance. Several sources may describe the same action. The page keeps source-specific records and displays the total as records, rather than interpreting it as a count of distinct analysts. A cached response retains its original retrieval date if a provider goes offline. [Yahoo Finance](https://finance.yahoo.com/) · [Nasdaq analyst research](https://www.nasdaq.com/market-activity/stocks/nvda/analyst-research) · [Stock Analysis ratings](https://stockanalysis.com/stocks/nvda/ratings/) · [Federal Reserve releases](https://www.federalreserve.gov/feeds/press_all.xml)

For news-based recommendations the service selects linked headlines published within the prior 30 days. It includes stock, sector ETF and SPY historical returns, available Cboe VIX and US ten-year Treasury yield observations, published analyst evidence, and StockReplay’s technical score. News headlines are supplied as headlines. Full articles, subscription reports and users’ private investments are outside the request payload.

## StockReplay technical rating

The score requires 200 or more matched stock and SPY sessions. Both histories use adjusted closes. Each factor receives its weight multiplied by its position between the floor and ceiling, clamped to the interval from zero to one.

| Factor | Measurement | Floor | Ceiling | Maximum points |
| --- | --- | ---: | ---: | ---: |
| Trend | Latest price relative to its 200-session simple moving average | −15% | +15% | 30 |
| Relative performance | 63-session stock return less the matched SPY return | −15 percentage points | +15 percentage points | 30 |
| Momentum | 21-session stock return | −10% | +10% | 20 |
| Drawdown | Latest price relative to its highest close over 126 sessions | −25% | 0% | 20 |

Contributions are rounded to hundredths of a point and summed to the nearest integer. Labels are Weak below 25, Cautious from 25, Mixed from 40, Constructive from 60 and Strong from 75. This is a technical score with a published formula. The OpenAI view and external analyst opinions have their own sources and dates.

## Portfolio statements

Fidelity CSV imports recognize account, security, shares, price, value and total cost basis. Generic CSV column mapping supports other institutions. OFX/QFX position statements map security identifiers using their security list. Bank and credit-card statements can supply a dated ledger balance. Statement values and currencies remain as reported. An empty cost basis stays unknown. If price and quantity exist without a value, the local importer multiplies them. Import preview displays every matched account and the number of positions that applying the file will replace. Reapplying an identical snapshot is idempotent. Concurrent edits invalidate the preview.

Unpriced positions are counted separately. Totals are per currency. An optional quote compares a public ticker’s latest nominal price with the statement quantity only when the currencies match. Statement dates and values stay available after quote lookup.

## Test fixtures and archived experiments

Generated market histories live exclusively in `tests/fixtures/prices/`. Deterministic tests explicitly import them as CSV into temporary databases. The production app has no demo-loading endpoint. Older portable experiments retain their original synthetic provenance and can be replayed from their pinned snapshots.

## Third-party components

TradingView Lightweight Charts™ v4.2.3, Copyright © 2025 TradingView, Inc., is distributed under Apache 2.0. The terminal includes a TradingView attribution link. Plotly.js is MIT licensed. The self-hosted DM Sans and IBM Plex Mono fonts retain their upstream OFL licenses in their packages. Additional dependency and model licenses remain with their respective authors. Ollama models are acquired separately under the selected model’s terms. [Lightweight Charts](https://tradingview.github.io/lightweight-charts/) · [Plotly.js](https://github.com/plotly/plotly.js) · [Fontsource](https://fontsource.org/) · [Qwen2.5 models](https://ollama.com/library/qwen2.5)
