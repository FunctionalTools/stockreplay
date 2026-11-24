# Data, scores and privacy

## Prices and time

Daily charts request real Yahoo Finance history through the latest completed US exchange session, including holidays and early closes. The quote header uses nominal closing prices and the previous session’s close. The chart and historical return calculations use adjusted prices. Each chart names its source and the last date actually observed. Intraday quotes for watchlists and portfolio lookups may be delayed. If a publisher is unavailable, StockReplay can serve a previously retrieved observation with its original date.

## Published analyst ratings

Stock Analysis supplies its publicly visible firm ratings, consensus, analyst count, vote distribution and low, average and high targets where published. The forecast card credits the named data provider when identified on the page. Yahoo Finance supplies a separate consensus, counts, upgrades and downgrades, and company metrics. Coverage and reporting periods differ. The app displays the publishers separately and links directly to each. A lack of publication is visible in Research. StockReplay uses the public forecast page following Nasdaq’s refusal of automated ratings requests. [Stock Analysis](https://stockanalysis.com/stocks/) · [Yahoo Finance](https://finance.yahoo.com/research-hub/)

## OpenAI assessments

The selected model considers available observations for the stock, its sector ETF, the S&P 500 proxy, volatility, Treasury yields and dated company, sector and market news. Company inputs can include historical annualized volatility, maximum drawdown, beta, published ISS governance risk, earnings estimates and analyst targets. News carries the publisher’s title, available excerpt, publication time and original link. Recent news uses a rolling 30-day window. [Federal Reserve news](https://www.federalreserve.gov/newsevents.htm)

Historical volatility uses the sample standard deviation of daily log returns, annualized by the square root of 252. Maximum drawdown measures the largest peak-to-subsequent-trough decline in the observed window. ISS governance risk is on the publisher’s scale of 1 (low) to 10 (high). Analyst targets use the publisher’s reported figures.

OpenAI independently assigns two scores from 0 to 100. Buy score measures the strength of the investment case. Risk score measures uncertainty and potential downside. They are qualitative judgments over six to twelve months. Both can be high. Each supporting point cites a source supplied in the request. The service checks score ranges and source references before saving the answer. Assessments retain their original dated evidence when the feeds change. [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)

## Personal information

Accounts, statement values, quantities, cost basis, imports and watchlist groupings stay in the local database. Raw statement files are processed locally and discarded after parsing. Portfolio quote lookups send individual ticker symbols to the market provider. Portfolio totals, currency groupings and allocation charts are computed locally. A new statement refreshes the holdings snapshot for the applicable account after review.

The key is used by the local backend for HTTPS requests to OpenAI. The session option keeps it in memory. Persistent storage uses macOS Keychain. The browser never receives a saved key when it requests connection status. Stock assessments send public evidence. The assistant sends the messages you enter, the active page and ticker. Local action results such as account balances are rendered on the Mac and excluded from subsequent prompts. StockReplay requests `store: false` from OpenAI. [OpenAI API data controls](https://platform.openai.com/docs/guides/your-data)

## Attribution

Advanced charts use TradingView Lightweight Charts™ v4.2.3, Copyright © TradingView, Inc., distributed under the Apache 2.0 License. Self-hosted DM Sans and IBM Plex Mono retain their upstream font licenses. [Lightweight Charts](https://www.tradingview.com/lightweight-charts/) · [Fontsource](https://fontsource.org/)
