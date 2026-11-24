import pytest
from pydantic import ValidationError

from stockreplay.schema import Experiment


@pytest.mark.parametrize(
    "patch",
    [
        {"tickers": ["../NVDA"]},
        {"tickers": ["SPY", "SPY"]},
        {"holding": 0},
        {"holding": 1.5},
        {"entry": {"rules": [{"indicator": "code"}]}},
        {"source": "automatic"},
        {"start": "2020-12-12", "end": "2019-01-01"},
        {"extra": "no"},
        {"entry": {"rules": [{"indicator": "cross_above", "window": 20, "slow": 10}]}},
        {"slippage_bps": float("nan")},
    ],
)
def test_strict_config(patch):
    with pytest.raises(ValidationError):
        Experiment.model_validate({**Experiment().model_dump(), **patch})
