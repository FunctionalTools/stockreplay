from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .trading_calendar import history_start, latest_session

Symbol = Annotated[str, Field(min_length=1, max_length=12, pattern=r"^[A-Z^][A-Z0-9.^=-]*$")]
Indicator = Literal[
    "daily_return",
    "cumulative_return",
    "positive_streak",
    "negative_streak",
    "sma_distance",
    "cross_above",
    "cross_below",
    "rsi",
    "volume",
    "relative_volume",
    "volatility",
    "drawdown",
    "relative_return",
]
Source = Literal["yahoo", "csv", "demo"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, str_strip_whitespace=True)


class Condition(Model):
    indicator: Indicator = "daily_return"
    ticker: Symbol = "ASSET"
    operator: Literal["lt", "lte", "gt", "gte"] = "lt"
    value: float = Field(default=-3, ge=-1e15, le=1e15)
    window: int = Field(default=20, ge=1, le=504, strict=True)
    slow: int = Field(default=50, ge=2, le=756, strict=True)

    @model_validator(mode="after")
    def windows(self):
        if self.indicator in {"cross_above", "cross_below"} and self.slow <= self.window:
            raise ValueError("The slow moving average must exceed the fast moving average.")
        if self.indicator in {"volatility", "rsi"} and self.window < 2:
            raise ValueError("Volatility and RSI need at least two sessions.")
        return self


class Group(Model):
    logic: Literal["and", "or"] = "and"
    rules: list[Condition] = Field(min_length=1, max_length=8)


class Statistics(Model):
    confidence: float = Field(default=0.95, ge=0.8, le=0.99)
    samples: int = Field(default=1000, ge=200, le=5000, strict=True)
    block_sessions: int = Field(default=0, ge=0, le=252, strict=True)
    seed: int = Field(default=42, ge=0, le=2147483647, strict=True)


class Experiment(Model):
    name: str = Field(default="Post-decline rebound", min_length=1, max_length=100)
    hypothesis: str = Field(
        default="Does NVIDIA gain over the five sessions after a daily loss of more than 3%?",
        min_length=3,
        max_length=2000,
    )
    kind: Literal["event", "portfolio"] = "event"
    tickers: list[Symbol] = Field(default_factory=lambda: ["NVDA"], min_length=1, max_length=8)
    benchmark: Symbol = "SPY"
    start: date = Field(default_factory=history_start)
    end: date = Field(default_factory=latest_session)
    source: Source = "yahoo"
    entry: Group = Field(default_factory=lambda: Group(rules=[Condition()]))
    exit: Group | None = None
    holding: int = Field(default=5, ge=1, le=252, strict=True)
    objective: Literal["positive", "negative", "outperform", "underperform", "recovery"] = (
        "positive"
    )
    cost_bps: float = Field(default=2, ge=0, le=500)
    slippage_bps: float = Field(default=3, ge=0, le=500)
    regime: Literal["all", "bull", "bear"] = "all"
    stats: Statistics = Field(default_factory=Statistics)

    @field_validator("tickers")
    @classmethod
    def unique_assets(cls, v):
        if len(v) != len(set(v)) or set(v) & {"ASSET", "BENCHMARK"}:
            raise ValueError("Use distinct exchange symbols for assets.")
        return v

    @model_validator(mode="after")
    def valid_dates(self):
        if self.start >= self.end or self.start < date(1990, 1, 1) or self.end > date.today():
            raise ValueError("Use a completed date range from 1990 through today.")
        if self.benchmark in {"ASSET", "BENCHMARK"}:
            raise ValueError("Choose a traded benchmark symbol.")
        return self

    def symbols(self):
        symbols = {self.benchmark, *self.tickers}
        for group in [self.entry, self.exit]:
            if group:
                symbols.update(
                    r.ticker for r in group.rules if r.ticker not in {"ASSET", "BENCHMARK"}
                )
        return sorted(symbols)


class RunRequest(Model):
    config: Experiment
    pins: dict[Symbol, Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]] | None = None


class RobustnessRequest(RunRequest):
    thresholds: list[float] = Field(min_length=1, max_length=5)
    holdings: list[Annotated[int, Field(ge=1, le=252)]] = Field(min_length=1, max_length=5)
    split: float = Field(default=0.7, ge=0.5, le=0.85)
    folds: int = Field(default=3, ge=2, le=5)
    costs: list[Annotated[float, Field(ge=0, le=500)]] = Field(
        default_factory=lambda: [0, 5, 10], max_length=5
    )


class SavedRun(Model):
    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(min_length=1, max_length=100)
    notes: str = Field(default="", max_length=12000)


class NoteEdit(Model):
    run_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    name: str = Field(min_length=1, max_length=100)
    notes: str = Field(max_length=12000)


class CsvUpload(Model):
    ticker: Symbol
    csv: str = Field(min_length=10, max_length=6_000_000)


class Comparison(Model):
    left: str = Field(pattern=r"^[a-f0-9]{32}$")
    right: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(min_length=1, max_length=120)
