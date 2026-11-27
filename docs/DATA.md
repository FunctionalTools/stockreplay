# Data, scores and privacy

## Prices and time

Research shows the observation dates and price basis for the selected period. For 1D, it compares the prior session’s reported close with the latest available regular-session bar. For 5D, it compares the first and last available five-minute prices across up to five trading sessions. Intraday data can be delayed. Longer ranges use adjusted closes when available. YTD uses the previous year’s final close when available. Custom ranges include both entered dates and use the first and last actual observations inside that window. A missing baseline or a single observation leaves the percentage unavailable.

The percentage is `100 × (ending price ÷ starting price − 1)`. A chart opened later in a saved tab reads current provider data. A chart saved in a chat retains its original prices and dates. Historical adjustments can change after corporate actions. Cached observations retain their dates when a provider is unavailable.

## Published analyst ratings

Stock Analysis supplies its publicly visible firm ratings, consensus, analyst count, vote distribution and low, average and high targets where published. The forecast card credits the named data provider when identified on the page. Yahoo Finance supplies a separate consensus, counts, upgrades and downgrades, and company metrics. Coverage and reporting periods differ. The app displays the publishers separately and links directly to each. A lack of publication is visible in Research. StockReplay uses the public forecast page following Nasdaq’s refusal of automated ratings requests. [Stock Analysis](https://stockanalysis.com/stocks/) · [Yahoo Finance](https://finance.yahoo.com/research-hub/)

## OpenAI assessments

The selected model considers available observations for the stock, its sector ETF, the S&P 500 proxy, volatility, Treasury yields and dated company, sector and market news. Company inputs can include historical annualized volatility, maximum drawdown, beta, published ISS governance risk, earnings estimates and analyst targets. News carries the publisher’s title, available excerpt, publication time and original link. Recent news uses a rolling 30-day window. Assessments select dated observations across each available category. If the API rejects a request for its size, the app retries with fewer observations and shorter excerpts. The original source URLs remain attached to saved citations. [Federal Reserve news](https://www.federalreserve.gov/newsevents.htm)

Historical volatility uses the sample standard deviation of daily log returns, annualized by the square root of 252. Maximum drawdown measures the largest peak-to-subsequent-trough decline in the observed window. ISS governance risk is on the publisher’s scale of 1 (low) to 10 (high). Analyst targets use the publisher’s reported figures.

OpenAI independently assigns two scores from 0 to 100. Buy score measures the strength of the investment case. Risk score measures uncertainty and potential downside. They are qualitative judgments over six to twelve months. Both can be high. The saved breakdown records each factor’s effect on the buy score and on the risk score, with older observations and coverage gaps identified. Each supporting point cites a source supplied in the request. The service checks score ranges and source references before saving the answer. Assessments retain their original dated evidence when the feeds change. [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)

## Personal information

Accounts, statement values, quantities, cost basis, imports and watchlist groupings stay in the local database. Raw statement files are processed locally and discarded after parsing. Portfolio quote lookups send individual ticker symbols to the market provider. Portfolio totals, currency groupings and allocation charts are computed locally. When Research follows your portfolio, it selects an eligible holding and displays its weight within its statement currency, based on absolute reported position values. A fixed starting ticker or an explicit stock link can be used at any time. A new statement refreshes the holdings snapshot for the applicable account after review.

The key is used by the local backend for HTTPS requests to OpenAI. The session option keeps it in memory. Persistent storage uses macOS Keychain. The browser never receives a saved key when it requests connection status. Stock assessments send public evidence. Recognized navigation, chart-selection and preference commands can run locally. For requests that need the model, the assistant sends the conversation context, active page and ticker. Local action results such as account balances are rendered on the Mac and excluded from subsequent prompts. StockReplay requests `store: false` from OpenAI. [OpenAI API data controls](https://platform.openai.com/docs/guides/your-data)

## Saved conversations, articles and tabs

Conversations are stored in the same local SQLite database as your portfolio. A conversation stores the displayed messages, action receipts, navigation targets, cited sources and local results so you can reopen it later. While a save is pending, a draft stays in local browser storage until the database acknowledges the write. OpenAI receives the recent conversational context and public research evidence needed for the request. Portfolio rows returned by a local action stay on the Mac. Chat price charts are saved as dated observations and can be reopened without a fresh quote.

A custom tab stores its name, ordered sections, stock selections and notes. Market widgets on a tab read the latest available data when opened. A saved article stores its original URL, publisher, timestamp and supplied excerpt. StockReplay caches verified photos from the news feed’s supported media hosts on the Mac, up to 48 MiB. The browser displays a photo only after it decodes. Reading the full article opens the original publication.

## Attribution

Advanced charts use TradingView Lightweight Charts™ v4.2.3, Copyright © TradingView, Inc., distributed under the Apache 2.0 License. Self-hosted DM Sans and IBM Plex Mono retain their upstream font licenses. [Lightweight Charts](https://www.tradingview.com/lightweight-charts/) · [Fontsource](https://fontsource.org/)
