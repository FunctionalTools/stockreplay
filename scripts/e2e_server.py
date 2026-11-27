"""Run browser tests against a separate temporary account and intercepted OpenAI transport."""

import os
import sys
import tempfile
from pathlib import Path
import httpx
import uvicorn

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
os.chdir(root)
with tempfile.TemporaryDirectory(prefix="stockreplay-browser-") as state:
    os.environ["STOCKREPLAY_HOME"] = state
    from stockreplay.api import create_app
    from tests.provider_fixture import install_market, respond

    if os.getenv("STOCKREPLAY_LIVE_TESTS") != "1":
        install_market()
    app = create_app()
    app.state.terminal.openai.transport = httpx.MockTransport(respond)
    if os.getenv("STOCKREPLAY_LIVE_OLLAMA") != "1":
        # Browser fixtures represent a fresh Mac independently of models installed on the test host.
        app.state.terminal.ai.ollama.transport = httpx.MockTransport(
            lambda _: httpx.Response(503, json={"error": "Ollama is closed in this fixture"})
        )
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
