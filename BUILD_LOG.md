# Verification record

The stock research interface has three primary pages and a separate Settings screen. Prices, published ratings, historical risk metrics and source links are generated from provider responses. The application ships without a sample portfolio, research score or news feed.

## Tests

- Python exercises score generation after a successful Responses API probe, restricted model discovery, independent scores, citation validation, incomplete outputs, authentication, model access, quotas and rates. It also tests transactional watchlist and holdings imports, storage privacy and the archival research engine.
- The browser tests paste a test credential into Settings and generate scores through the actual local service. Only the upstream OpenAI transport is intercepted. They also exercise assistant actions, comparison charts, saved advanced drawings, local imports, appearance, persistence and mobile navigation.
- The macOS jobs exercise Apple Silicon and Intel, including a real temporary Keychain, production installation, startup, Chromium and WebKit. The live public check reads current prices, news, forecast distributions, company risk metrics and targets for NVDA and opens Research in the browser.
- Setting a dedicated `STOCKREPLAY_TEST_OPENAI_KEY` enables a billable end-to-end test of the selected model, stock scores and assistant chart action. The test is explicitly skipped when that credential is absent.

```bash
STOCKREPLAY_INSTALL_BROWSERS=1 ./setup.sh
.venv/bin/python -m pytest -q
npm --prefix frontend test
npm --prefix frontend run e2e
STOCKREPLAY_PUBLIC_LIVE=1 .venv/bin/python -m pytest -q -s tests/test_terminal.py -k live_public_sources
```

[Native macOS workflow runs](https://github.com/FunctionalTools/stockreplay/actions/workflows/macos.yml) · [Research screenshot](docs/screenshots/research.png) · [Mobile screenshot](docs/screenshots/mobile.png) · [Settings screenshot](docs/screenshots/settings.png)
