from collections import defaultdict
import numpy as np

from . import ENGINE_VERSION
from .indicators import evaluate
from .market import adjusted
from .statistics import block_inference, portfolio_metrics, return_distribution

WARNINGS = [
    "Today’s selected symbols can introduce survivorship bias.",
    "Repeated searches and parameter choices can overfit. In-sample p-values are unadjusted for multiple testing.",
    "An observed association does not establish causation. Historical returns do not establish future returns.",
]


def friction(config):
    fee, slip = config.cost_bps / 10000, config.slippage_bps / 10000
    return (1 + slip) * (1 + fee), (1 - slip) * (1 - fee)


def analyze(config, frames, *, bounds=None, detail=True):
    series = {t: adjusted(f) for t, f in frames.items()}
    index = series[config.benchmark].index
    lo, hi = bounds or (0, len(index) - 1)
    if hi < lo or lo < 0 or hi >= len(index):
        raise ValueError("The evaluation period contains no sessions.")
    dates = index.strftime("%Y-%m-%d").tolist()
    bench = series[config.benchmark]
    bo, bc = bench.Open.to_numpy(), bench.Close.to_numpy()
    buy, sell = friction(config)
    regime = (bench.Close / bench.Close.rolling(200).mean() - 1).to_numpy()
    events, sleeves = [], []
    paths, benchpaths = defaultdict(list), defaultdict(list)
    skipped, boundary = 0, 0
    for asset in config.tickers:
        frame = series[asset]
        op, cl = frame.Open.to_numpy(), frame.Close.to_numpy()
        entries, readings = evaluate(config.entry, series, asset, config.benchmark)
        exits = (
            evaluate(config.exit, series, asset, config.benchmark)[0].to_numpy()
            if config.exit
            else None
        )
        flags = entries.to_numpy().copy()
        if config.regime != "all":
            flags &= regime >= 0 if config.regime == "bull" else regime < 0
        wallet, busy, cursor = 1.0, -1, lo
        equity = np.ones(hi - lo + 1)
        for signal in np.flatnonzero(flags):
            if signal < lo or signal > hi:
                continue
            entry, exit_at = signal + 1, signal + config.holding
            if exit_at > hi or (config.objective == "recovery" and signal == 0):
                boundary += 1
                continue
            if config.kind == "portfolio" and entry <= busy:
                skipped += 1
                continue
            at_open = False
            if exits is not None:
                triggers = np.flatnonzero(exits[entry:exit_at])
                if len(triggers):
                    exit_at = int(entry + triggers[0] + 1)
                    at_open = True
            price = op[exit_at] if at_open else cl[exit_at]
            bp = bo[exit_at] if at_open else bc[exit_at]
            net = price * sell / (op[entry] * buy)
            bnet = bp * sell / (bo[entry] * buy)
            ret, br = 100 * (net - 1), 100 * (bnet - 1)
            effect = {
                "positive": ret,
                "negative": -ret,
                "outperform": ret - br,
                "underperform": br - ret,
            }.get(config.objective)
            if effect is None:
                observed = cl[entry : exit_at + (0 if at_open else 1)]
                recovered = bool(np.any(observed >= cl[signal - 1]))
                effect = 100.0 if recovered else 0.0
            e = {
                "ticker": asset,
                "signal": dates[signal],
                "entry": dates[entry],
                "exit": dates[exit_at],
                "entry_price": float(op[entry]),
                "exit_price": float(price),
                "exit_at": "open" if at_open else "close",
                "return_pct": float(ret),
                "benchmark_pct": float(br),
                "excess_pct": float(ret - br),
                "gross_pct": float(100 * (price / op[entry] - 1)),
                "effect": float(effect),
                "success": bool(effect > 0),
                "regime": "unclassified"
                if np.isnan(regime[signal])
                else ("bull" if regime[signal] >= 0 else "bear"),
                "readings": [
                    None if not np.isfinite(v.iat[signal]) else float(v.iat[signal])
                    for v in readings
                ],
            }
            events.append(e)
            if config.kind == "portfolio":
                equity[cursor - lo : entry - lo] = wallet
                shares = wallet / (op[entry] * buy)
                equity[entry - lo : exit_at - lo] = shares * cl[entry:exit_at]
                wallet *= net
                equity[exit_at - lo] = wallet
                cursor, busy = exit_at + 1, exit_at
            elif detail:
                for day in range(config.holding):
                    j = entry + day
                    paths[day].append(net if j >= exit_at else cl[j] * sell / (op[entry] * buy))
                    benchpaths[day].append(
                        bnet if j >= exit_at else bc[j] * sell / (bo[entry] * buy)
                    )
        if config.kind == "portfolio":
            equity[cursor - lo :] = wallet
            sleeves.append(equity)
    events.sort(key=lambda e: (e["signal"], e["ticker"]))

    def mean(key):
        return float(np.mean([e[key] for e in events])) if events else None

    metrics = {
        "count": len(events),
        "mean": mean("return_pct"),
        "median": float(np.median([e["return_pct"] for e in events])) if events else None,
        "win_rate": 100 * mean("success") if events else None,
        "benchmark": mean("benchmark_pct"),
        "excess": mean("excess_pct"),
        "effect": mean("effect"),
        "best": max((e["return_pct"] for e in events), default=None),
        "worst": min((e["return_pct"] for e in events), default=None),
        "failures": sum(not e["success"] for e in events),
        "overlaps_skipped": skipped,
        "boundary_skipped": boundary,
    }
    curve = []
    if sleeves:
        portfolio = np.mean(sleeves, axis=0)
        benchmark = bc[lo : hi + 1].copy() / (bo[lo] * buy)
        benchmark[-1] *= sell
        metrics.update(portfolio_metrics(portfolio, benchmark, index[lo : hi + 1]))
        if detail:
            curve = [
                {"x": d, "strategy": float((v - 1) * 100), "benchmark": float((b - 1) * 100)}
                for d, v, b in zip(dates[lo : hi + 1], portfolio, benchmark)
            ]
    elif detail and events:
        curve = [
            {
                "x": str(day + 1),
                "strategy": float(100 * (np.mean(paths[day]) - 1)),
                "benchmark": float(100 * (np.mean(benchpaths[day]) - 1)),
            }
            for day in sorted(paths)
        ]
    if not detail:
        return metrics
    candles = {}
    for t in config.tickers:
        f = series[t]
        candles[t] = [
            {
                "time": dates[i],
                "open": float(o),
                "high": float(h),
                "low": float(l),
                "close": float(c),
            }
            for i, (o, h, l, c) in enumerate(
                f[["Open", "High", "Low", "Close"]].itertuples(index=False, name=None)
            )
            if lo <= i <= hi
        ]
    warnings = WARNINGS.copy()
    if len(events) < 30:
        warnings.insert(
            0,
            "Fewer than 30 observations qualify. The estimated effect may change substantially with more data.",
        )
    return {
        "engine": ENGINE_VERSION,
        "config": config.model_dump(mode="json"),
        "metrics": metrics,
        "inference": block_inference(events, index[lo : hi + 1], config),
        "curve": curve,
        "events": events,
        "distribution": return_distribution(events),
        "candles": candles,
        "warnings": warnings,
        "first": dates[lo],
        "last": dates[hi],
    }
