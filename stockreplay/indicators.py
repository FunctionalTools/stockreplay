import numpy as np
import pandas as pd


def indicator(rule, series, asset, benchmark):
    ticker = {"ASSET": asset, "BENCHMARK": benchmark}.get(rule.ticker, rule.ticker)
    frame = series[ticker]
    close, vol = frame.Close, frame.Volume
    ret = close.pct_change(fill_method=None)
    w, name = rule.window, rule.indicator
    if name == "daily_return":
        return 100 * ret
    if name == "cumulative_return":
        return 100 * close.pct_change(w, fill_method=None)
    if name in {"positive_streak", "negative_streak"}:
        flag = ret.gt(0) if name == "positive_streak" else ret.lt(0)
        return flag.groupby((~flag).cumsum()).cumsum().where(ret.notna())
    if name == "sma_distance":
        return 100 * (close / close.rolling(w).mean() - 1)
    if name in {"cross_above", "cross_below"}:
        fast, slow = close.rolling(w).mean(), close.rolling(rule.slow).mean()
        sign = (fast - slow) * (1 if name == "cross_above" else -1)
        return (sign.gt(0) & sign.shift().le(0)).astype(float).where(sign.shift().notna())
    if name == "rsi":
        # Simple-window (Cutler) RSI; a flat window is neutral.
        diff = close.diff()
        up, down = diff.clip(lower=0).rolling(w).mean(), (-diff.clip(upper=0)).rolling(w).mean()
        total = up + down
        return (100 * up / total.replace(0, np.nan)).mask(total.eq(0), 50)
    if name == "volume":
        return vol
    if name == "relative_volume":
        return vol / vol.shift().rolling(w).mean().replace(0, np.nan)
    if name == "volatility":
        return 100 * np.sqrt(252) * ret.rolling(w).std(ddof=1)
    if name == "drawdown":
        return 100 * (close / close.rolling(w).max() - 1)
    if name == "relative_return":
        return 100 * (
            close.pct_change(w, fill_method=None)
            - series[benchmark].Close.pct_change(w, fill_method=None)
        )
    raise ValueError("Unknown indicator.")


def evaluate(group, series, asset, benchmark):
    predicates, readings = [], []
    for rule in group.rules:
        values = indicator(rule, series, asset, benchmark)
        readings.append(values)
        compare = {"lt": values.lt, "lte": values.le, "gt": values.gt, "gte": values.ge}[
            rule.operator
        ]
        predicates.append(compare(rule.value) & values.notna())
    flags = pd.concat(predicates, axis=1)
    return (flags.all(axis=1) if group.logic == "and" else flags.any(axis=1)), readings
