# Verification record

The homepage forecast can be checked on a fresh Apple silicon runner by enabling `live_forecast`. It reads live public data, calls an installed model and verifies the resulting chart, sources and saved forecast. Browser tests cover the exact clipped conversation, line placement, period selection and the custom Future date flow. Authenticated Ollama website tests accept separate, opt-in credentials for search and metered inference.

The free local integration check downloads a pinned Ollama runtime and runs the recommended model on an Apple silicon runner. It exercises the same local model selector, generation check, free source search, Buy and Risk assessment, local archive and cited chat routes as the website. Dispatch the macOS workflow with `live_ollama` and `live_providers` enabled to reproduce it. The deterministic suite also covers offline sources, model selection, forecast paths, calendar events and keyboard replay.


Research opens Past and Future on the same stock price card. Watchlists, Portfolio and Settings share the same local workspace. Prices, published ratings, historical risk metrics and source links are generated from provider responses. The application ships without a sample portfolio, research score or news feed.

## Tests

- Python exercises score generation after a successful Responses API probe, restricted model discovery, independent scores, citation validation, incomplete outputs, authentication, model access, quotas and rates. It also tests transactional watchlist and holdings imports, storage privacy and the archival research engine.
- The browser tests paste a test credential into Settings and generate scores through the actual local service. Only the upstream OpenAI transport is intercepted. They also exercise assistant actions, comparison charts, saved advanced drawings, local imports, appearance, persistence and mobile navigation.
- Chat and workspace tests also exercise transcript restart and revision handling, original price-chart snapshots, assistant-created tabs, portfolio import guides, saved articles and broken-media fallback.
- The macOS jobs exercise Apple Silicon and Intel, including a real temporary Keychain, production installation, startup, Chromium and WebKit. The live public check reads current prices, news, forecast distributions, company risk metrics and targets for NVDA and opens an explicitly selected Apple ticker in the browser. Separate live checks compare 1D, 5D and custom-range percentages to their observed baselines, including a US market holiday.
- Setting a dedicated `STOCKREPLAY_TEST_OPENAI_KEY` enables a billable end-to-end test of the selected model, stock scores and assistant chart action. The test is explicitly skipped when that credential is absent.

```bash
STOCKREPLAY_INSTALL_BROWSERS=1 ./setup.sh
.venv/bin/python -m pytest -q
npm --prefix frontend test
npm --prefix frontend run e2e
STOCKREPLAY_PUBLIC_LIVE=1 .venv/bin/python -m pytest -q -s tests/test_terminal.py::test_live_public_sources tests/test_live_research.py
```

[Native macOS workflow runs](https://github.com/FunctionalTools/stockreplay/actions/workflows/macos.yml) · [Research screenshot](docs/screenshots/research.png) · [Mobile screenshot](docs/screenshots/mobile.png) · [Settings screenshot](docs/screenshots/settings.png)
