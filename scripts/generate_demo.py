"""Generate the redistributable synthetic market. No vendor data enters this file."""

from pathlib import Path

import numpy as np
import pandas as pd

from stockreplay.market import sessions


def generate():
    root = Path(__file__).resolve().parents[1] / "data" / "demo"
    root.mkdir(parents=True, exist_ok=True)
    days = sessions("2021-01-04", "2024-12-31")
    rng = np.random.default_rng(134)
    market = rng.normal(0.00036, 0.009, size=len(days)) + 0.0011 * np.sin(np.arange(len(days)) / 82)
    for symbol, initial, beta, noise in [
        ("SPY", 360, 1, 0.002),
        ("NVDA", 48, 1.4, 0.022),
        ("AAPL", 105, 0.95, 0.009),
        ("MSFT", 185, 1, 0.011),
    ]:
        close = initial * np.exp(np.cumsum(market * beta + rng.normal(0.00018, noise, len(days))))
        op = np.r_[initial, close[:-1]] * np.exp(rng.normal(0, 0.004, len(days)))
        wiggle = abs(rng.normal(0.008, 0.005, len(days)))
        df = pd.DataFrame(
            {
                "Open": op,
                "High": np.maximum(op, close) * (1 + wiggle),
                "Low": np.minimum(op, close) / (1 + wiggle),
                "Close": close,
                "Adj Close": close,
                "Volume": rng.lognormal(16, 0.45, len(days)).astype(int),
                "Dividends": 0,
                "Stock Splits": 0,
            },
            index=days,
        )
        df.to_csv(root / f"{symbol}.csv", index_label="Date", float_format="%.5f")


if __name__ == "__main__":
    generate()
