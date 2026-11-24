import math

import numpy as np
from scipy.stats import scoreatpercentile


def block_inference(events, index, config):
    """Resample whole calendar blocks, retaining contemporaneous and overlapping positions."""
    n = len(index)
    block = min(n, max(config.holding, config.stats.block_sessions, math.ceil(n ** (1 / 3))))
    label = "recovery rate (%)" if config.objective == "recovery" else "mean objective return (%)"
    result = {
        "estimate": None,
        "low": None,
        "high": None,
        "p_value": None,
        "block": block,
        "confidence": config.stats.confidence,
        "quantity": label,
        "replicates": 0,
    }
    if not events:
        return result
    amounts, counts = np.zeros(n), np.zeros(n)
    lookup = {d: i for i, d in enumerate(index.strftime("%Y-%m-%d"))}
    for e in events:
        i = lookup[e["signal"]]
        amounts[i] += e["effect"]
        counts[i] += 1
    estimate = amounts.sum() / counts.sum()
    result["estimate"] = float(estimate)
    if counts.sum() < 8 or np.count_nonzero(counts) < 5 or n < 3 * block:
        return result
    rng = np.random.default_rng(config.stats.seed)

    # Prefix sums give O(replicates * number_of_blocks), independent of block width.
    def prefix(a):
        return np.r_[0.0, np.cumsum(np.r_[a, a])]

    pa, pc = prefix(amounts), prefix(counts)
    widths = np.full(math.ceil(n / block), block)
    widths[-1] = n - (len(widths) - 1) * block
    boot = []
    for start in range(0, config.stats.samples, 64):
        picks = rng.integers(n, size=(min(64, config.stats.samples - start), len(widths)))
        totals = (pa[picks + widths] - pa[picks]).sum(axis=1)
        sample_counts = (pc[picks + widths] - pc[picks]).sum(axis=1)
        valid = sample_counts > 0
        boot.extend(totals[valid] / sample_counts[valid])
    if len(boot) < config.stats.samples * 0.8 or np.ptp(boot) < 1e-10:
        return result
    null = 50 if config.objective == "recovery" else 0
    alpha = 50 * (1 - config.stats.confidence)
    p = (1 + np.count_nonzero(np.abs(np.asarray(boot) - estimate) >= abs(estimate - null))) / (
        1 + len(boot)
    )
    return {
        **result,
        "low": float(scoreatpercentile(boot, alpha)),
        "high": float(scoreatpercentile(boot, 100 - alpha)),
        "p_value": float(p),
        "replicates": len(boot),
    }


def portfolio_metrics(curve, benchmark, index):
    wealth, bench = np.r_[1.0, curve], np.r_[1.0, benchmark]
    returns = wealth[1:] / wealth[:-1] - 1
    days = (index[-1] - index[0]).days + 1
    sd = returns.std(ddof=1) if len(returns) > 1 else 0.0
    return {
        "total_return": float(100 * (wealth[-1] - 1)),
        "benchmark_total": float(100 * (bench[-1] - 1)),
        "annualized": float(100 * (wealth[-1] ** (365.2425 / days) - 1)) if days >= 365 else None,
        "drawdown": float(100 * (wealth / np.maximum.accumulate(wealth) - 1).min()),
        "sharpe": float(np.sqrt(252) * returns.mean() / sd)
        if sd > 1e-12 and len(returns) >= 252
        else None,
    }


def return_distribution(events):
    values = [e["return_pct"] for e in events]
    if not values:
        return []
    bins = min(40, max(1, int(np.ceil(np.sqrt(len(values))))))
    counts, edges = np.histogram(values, bins=bins)
    return [
        {"low": float(lo), "high": float(hi), "count": int(count)}
        for lo, hi, count in zip(edges[:-1], edges[1:], counts)
    ]
