# Build and verification record

## macOS release

StockReplay now launches from Finder or Terminal on macOS. Both launch paths use a loopback server and the checkout’s local database. GitHub Actions verifies the macOS installation, application lifecycle and browser workflows. The native Keychain test uses a temporary keychain, reopens the saved credential in a new service instance, then removes it.

The macOS 15 run on November 24, 2026 passed setup, TypeScript and Vite compilation, 71 Python checks, eight frontend unit checks, nine Chromium scenarios, four WebKit scenarios, loopback startup and scoped shutdown. A subsequent native run exercised live public evidence and rendered TradingView’s hosted chart inside the local application on Apple Silicon. The workflow continues running on each main-branch push. [Native run](https://github.com/FunctionalTools/stockreplay/actions/runs/45501790876) · [Live provider and browser verification](https://github.com/FunctionalTools/stockreplay/actions/runs/45503015427) · [Current main verification](https://github.com/FunctionalTools/stockreplay/actions/workflows/macos.yml)

## Live provider observations

On November 24, 2026 the opening NVIDIA study covered November 24, 2023 through November 24, 2026 using Yahoo Finance. It returned 85 qualifying events. Intraday retrieval returned 390 five-minute bars over five sessions. Yahoo supplied 980 dated analyst actions. Stock Analysis supplied eight publicly displayed rows, including a named analyst action dated November 24. Nasdaq supplied a Buy consensus based on 39 analysts. These are observations from that run. The application calculates current values at request time.

The live research check retrieved 64 evidence items, including stock and sector performance, company and sector news, Federal Reserve releases, VIX and Treasury observations. Publisher access can differ by network. In a separate GitHub-hosted run, Nasdaq was unavailable while Yahoo returned prices and firm-level actions. The product shows provider failures alongside the sources that responded.

A live Python run passed 77 checks, including the Ollama language cases and current public-feed assertions. The macOS-only Keychain test ran on the native runner. Browser verification exercised CSV portfolio import/edit/reopen, screeners, alerts, issuer ratings, chart studies, replay, drawing persistence and the workbench’s real Ollama-to-Yahoo workflow.

## OpenAI and private accounts

The credential-free OpenAI test intercepts HTTP at the transport boundary. It verifies the official hostname, model, bearer authentication, Responses schema, disabled response storage, public-field allowlist, rejection of unknown citations and unsupported numerical claims, and local key removal. It exercises both a complete recommendation and failure paths. An authenticated paid generation requires the operator’s own funded API key.

Holdings tests use isolated statements for Fidelity, mapped CSV, OFX 1.x investment positions and OFX bank balances. They cover separate accounts and currencies, incomplete valuations, masking of identifiers, repeated imports, manual corrections and transaction rollback after a stale multi-account preview. Production startup reads genuine public data. CSV price fixtures are isolated under tests.

## Reproduction

Run the verification commands in the README. To exercise current public providers on macOS, dispatch the macOS verification workflow with the live-providers input enabled. The live browser workflow needs network access. The uncredentialed regression suite runs locally with explicitly imported fixtures. Readers can reproduce a historical experiment by opening its portable bundle with its pinned snapshots.

[Workbench](docs/screenshots/workbench.png) · [Market research](docs/screenshots/market-research.png) · [Native charts](docs/screenshots/charts.png) · [Investor ratings](docs/screenshots/investor-ratings.png) · [Counterexamples](docs/screenshots/counterexample.png) · [Robustness](docs/screenshots/robustness.png) · [Mobile](docs/screenshots/mobile.png)
