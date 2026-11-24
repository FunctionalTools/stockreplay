import numpy as np
import pandas as pd
import pytest

from stockreplay.market import normalize, sessions
from stockreplay.schema import Condition, Experiment, Group


def make_frame(index, closes, opens=None, vols=None):
    close = np.asarray(closes, dtype=float)
    op = close.copy() if opens is None else np.asarray(opens, dtype=float)
    return normalize(
        pd.DataFrame(
            {
                "Open": op,
                "High": np.maximum(op, close) + 1,
                "Low": np.minimum(op, close) - 1,
                "Close": close,
                "Adj Close": close,
                "Volume": vols if vols is not None else 1000,
            },
            index=index,
        )
    )


@pytest.fixture
def frames():
    days = sessions("2023-01-03", "2023-01-13")[:8]
    return {
        "NVDA": make_frame(
            days, [100, 90, 92, 99, 88, 89, 90, 91], [100, 97, 120, 96, 98, 80, 92, 92]
        ),
        "SPY": make_frame(days, [100] * 8),
    }


@pytest.fixture
def config(frames):
    days = frames["NVDA"].index
    return Experiment(
        start=days[0].date(),
        end=days[-1].date(),
        source="csv",
        holding=2,
        cost_bps=0,
        slippage_bps=0,
        entry=Group(rules=[Condition(value=-5)]),
    )
