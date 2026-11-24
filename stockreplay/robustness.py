import numpy as np

from .engine import analyze
from .schema import Experiment


def variant(config, threshold=None, holding=None, cost=None):
    data = config.model_dump()
    if threshold is not None:
        data["entry"]["rules"][0]["value"] = threshold
    if holding is not None:
        data["holding"] = holding
    if cost is not None:
        data["cost_bps"] = cost
    return Experiment.model_validate(data)


def evaluate_robustness(request, frames):
    c = request.config
    index = frames[c.benchmark].index
    split = int(len(index) * request.split)
    if min(split, len(index) - split) < request.folds:
        raise ValueError("Choose a longer range for chronological testing.")
    candidates = [
        (t, h, variant(c, t, h))
        for t in dict.fromkeys(request.thresholds)
        for h in dict.fromkeys(request.holdings)
    ]

    def measure(v, lo, hi):
        metrics = analyze(v, frames, bounds=(lo, hi), detail=False)
        # All selections maximize the same directional objective. Require evidence on training data.
        return {
            "effect": metrics["effect"],
            "count": metrics["count"],
            "mean": metrics["mean"],
            "win_rate": metrics["win_rate"],
            "total_return": metrics.get("total_return"),
        }

    def choose(rows):
        eligible = [r for r in rows if r["train"]["count"] >= 5]
        return max(eligible, key=lambda r: r["train"]["effect"]) if eligible else None

    cells = [
        {
            "threshold": t,
            "holding": h,
            "train": measure(v, 0, split - 1),
            "test": measure(v, split, len(index) - 1),
        }
        for t, h, v in candidates
    ]
    folds = []
    edges = np.linspace(split, len(index), request.folds + 1, dtype=int)
    for a, b in zip(edges, edges[1:]):
        trained = [
            {"threshold": t, "holding": h, "train": measure(v, 0, a - 1)} for t, h, v in candidates
        ]
        best = choose(trained)
        folds.append(
            {
                "train_end": str(index[a - 1].date()),
                "start": str(index[a].date()),
                "end": str(index[b - 1].date()),
                "selected": best,
                "test": measure(variant(c, best["threshold"], best["holding"]), a, b - 1)
                if best
                else None,
            }
        )
    costs = [
        {"bps": k, "test": measure(variant(c, cost=k), split, len(index) - 1)}
        for k in request.costs
    ]
    return {
        "train_end": str(index[split - 1].date()),
        "test_start": str(index[split].date()),
        "cells": cells,
        "selected": choose(cells),
        "folds": folds,
        "costs": costs,
        "quantity": "recovery frequency (%)"
        if c.objective == "recovery"
        else "mean directional effect (%)",
    }
