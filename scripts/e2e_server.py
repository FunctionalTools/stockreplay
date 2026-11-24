"""Run browser tests against an isolated temporary SQLite database."""

import os
import sys
import tempfile
from pathlib import Path
import uvicorn

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
os.chdir(root)
with tempfile.TemporaryDirectory(prefix="stockreplay-browser-") as state:
    os.environ["STOCKREPLAY_HOME"] = state
    from stockreplay.api import create_app, opening_config

    app = create_app()
    if os.getenv("STOCKREPLAY_LIVE_TESTS") != "1":
        from tests.fixture_market import seed

        initial = seed(app.state.store)
        app.dependency_overrides[opening_config] = lambda: initial
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(sys.argv[1]),
        log_level="warning",
    )
