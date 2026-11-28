"""A deterministic conditional share-price path from one instrument's observed history."""

from functools import lru_cache

import numpy as np
import pandas as pd

MIN_RETURNS = 63
MAX_ANALOG_SESSIONS = 252
NEIGHBORS = 12


def market_states(closes):
    logs = pd.Series(np.log(np.asarray(closes, dtype=float)))
    change = logs.diff()
    vols = change.rolling(21, min_periods=5).std()
    slower = change.rolling(63, min_periods=5).std()
    sigma = vols.clip(lower=1e-8)
    state = [change / sigma]
    for n in (5, 21, 63):
        window = change.rolling(n, min_periods=min(n, 5))
        state.append(window.sum() / (sigma * np.sqrt(window.count())))
    state.append(
        (logs - logs.rolling(63, min_periods=5).max()) / (slower.clip(lower=1e-8) * np.sqrt(63))
    )
    state.append(np.log(sigma / slower.clip(lower=1e-8)))
    features = np.clip(np.column_stack(state), -4, 4)
    changes = change.to_numpy()
    # Number of consecutive observed returns after each date. At each forecast/test
    # origin this is further restricted to the information available by that date.
    available = np.zeros(len(changes), dtype=int)
    for i in range(len(changes) - 2, -1, -1):
        if np.isfinite(changes[i + 1]):
            available[i] = available[i + 1] + 1
    return logs.to_numpy(), changes, features, vols.to_numpy(), available


def similar_days(distance, available, horizon):
    # Windows cannot overlap. A long rally can contribute one multi-month outcome,
    # even if many consecutive origins resembled today's market conditions.
    candidates = np.where(available >= horizon, distance, np.inf)
    candidates[~np.isfinite(candidates)] = np.inf
    separation = max(5, horizon)
    selected = []
    for _ in range(NEIGHBORS):
        i = int(np.argmin(candidates))
        if not np.isfinite(candidates[i]):
            break
        selected.append(i)
        candidates[max(0, i - separation + 1) : i + separation] = np.inf
    return np.asarray(selected, dtype=int)


def fit_path(state, end, steps):
    logs, changes, features, vols, forward = state
    sample = changes[: end + 1]
    sample = sample[np.isfinite(sample)]
    if len(sample) < MIN_RETURNS:
        raise ValueError("Fewer than 63 observed consecutive-session returns are available.")
    if np.std(sample[-63:], ddof=1) <= 1e-12:
        raise ValueError(
            "Recent daily returns have too little variation to fit comparable periods."
        )
    if not np.isfinite(features[end]).all():
        raise ValueError(
            "Recent prices have gaps that prevent measuring current trading conditions."
        )
    distance = np.mean((features[:end] - features[end]) ** 2, axis=1)
    available = np.minimum(forward[:end], end - np.arange(end))
    cutoff = min(MAX_ANALOG_SESSIONS, len(sample) // 4)
    robust_lo, robust_hi = np.quantile(sample, [0.025, 0.975])
    winsorized = np.nan_to_num(np.clip(changes[: end + 1], robust_lo, robust_hi))
    # A difference yields an entire realized post-match log return without crossing
    # a price gap: available above guarantees a complete window for every peer.
    totals = np.cumsum(winsorized)
    checkpoints = sorted({1, 5, 10, 21, 42, 63, 126, 252, cutoff})
    cumulative = np.empty(steps)
    last_h = first_count = final_count = 0
    last_move = 0.0
    for horizon in checkpoints:
        if horizon > cutoff:
            break
        peers = similar_days(distance, available, horizon)
        if len(peers) < 2:
            break
        if horizon == 1:
            first_count = len(peers)
        final_count = len(peers)
        weights = np.exp(-distance[peers])
        scale = np.clip(max(vols[end], 1e-8) / np.maximum(vols[peers], 1e-8), 0.5, 2)
        # Six zero-return comparison windows regularize estimates toward today's
        # price. Sparse independent outcomes and poor matches get little influence.
        coeff = weights * scale / (weights.sum() + 6)
        offsets = np.arange(last_h, horizon + 1)
        realized = totals[peers[:, None] + offsets] - totals[peers, None]
        implied = coeff @ realized
        # The first part of the path uses the shorter-horizon comparisons. Blend
        # continuously into this horizon's complete, independently observed paths.
        part = implied + (last_move - implied[0]) * (horizon - offsets) / (horizon - last_h)
        take = min(horizon, steps) - last_h
        cumulative[last_h : last_h + take] = part[1 : take + 1]
        last_move = part[-1]
        last_h = horizon
        if last_h >= steps:
            break
    if last_h == 0:
        raise ValueError("Too few separate observed periods match current trading conditions.")
    if steps > last_h:
        cumulative[last_h:] = last_move
    sigma = np.std(sample[-63:], ddof=1)
    price_sample = logs[: end + 1]
    price_sample = price_sample[np.isfinite(price_sample)]
    spread = np.ptp(np.quantile(price_sample, [0.1, 0.9]))
    limit = max(1e-5, min(2.0, max(spread, sigma * np.sqrt(21))))
    center = limit * np.tanh(cumulative / limit)
    # A dispersion scale for older clients and bounded AI adjustments. These are
    # not fitted confidence levels and do not choose the displayed price.
    q10, q50, q90 = np.quantile(sample, [0.1, 0.5, 0.9])
    width = np.sqrt(np.arange(1, steps + 1))
    lower = 2 * np.tanh(max(q50 - q10, sigma * 0.1, 1e-9) * width / 2)
    upper = 2 * np.tanh(max(q90 - q50, sigma * 0.1, 1e-9) * width / 2)
    matches = {
        "comparable_origins": first_count,
        "independent_horizon_matches": final_count,
        "matched_horizon_sessions": last_h,
        "max_analogue_sessions": cutoff if last_h >= steps else last_h,
    }
    return np.column_stack((center - lower, center, center + upper)), matches


def walk_forward(state, horizon, limit):
    logs, changes, *_ = state
    errors = []
    flat_errors = []
    correct = directional = covered = 0
    for origin in range(
        len(logs) - 1 - horizon, max(-1, len(logs) - 1 - horizon * (limit + 1)), -horizon
    ):
        actual_window = changes[origin + 1 : origin + horizon + 1]
        if not np.isfinite(actual_window).all():
            continue
        try:
            envelope, _ = fit_path(state, origin, horizon)
        except ValueError:
            continue
        lo, center, hi = envelope[-1]
        actual = logs[origin + horizon] - logs[origin]
        covered += int(lo <= actual <= hi)
        errors.append(100 * abs(np.exp(center) - np.exp(actual)))
        flat_errors.append(100 * abs(np.expm1(actual)))
        if abs(actual) > 1e-12 and abs(center) > 1e-12:
            directional += 1
            correct += int((center > 0) == (actual > 0))
    return validation_metrics(errors, flat_errors, covered, correct, directional)


def validation_metrics(errors, flat_errors, covered, correct, directional):
    tested = len(errors)
    return {
        "tested_sessions": tested,
        "inside_band_sessions": covered,
        "observed_coverage_pct": 100 * covered / tested if tested else None,
        "model_mae_pct": float(np.mean(errors)) if errors else None,
        "flat_mae_pct": float(np.mean(flat_errors)) if flat_errors else None,
        "directional_accuracy_pct": 100 * correct / directional if directional else None,
        "correct_directions": correct,
        "compared_directions": directional,
    }


@lru_cache(maxsize=32)
def prepared(closes, sessions_per_year):
    state = market_states(closes)
    logs, changes, _, vols, _ = state
    sample = changes[np.isfinite(changes)]
    sigma = float(np.std(sample[-63:], ddof=1)) if len(sample) >= 2 else None

    def momentum(h):
        if len(logs) <= h or not np.isfinite(logs[-h - 1]):
            return None
        return float(100 * np.expm1(logs[-1] - logs[-h - 1]))

    m5, m21, m63 = (momentum(n) for n in (5, 21, 63))
    threshold = 100 * (sigma or 0) * np.sqrt(21) * 0.2
    trend = "Mixed trend"
    if m21 is not None and m63 is not None:
        if min(m21, m63) > threshold:
            trend = "Rising trend"
        elif max(m21, m63) < -threshold:
            trend = "Falling trend"
        elif max(abs(m21), abs(m63)) <= threshold:
            trend = "Sideways trend"
    inputs = {
        "momentum_5d_pct": m5,
        "momentum_21d_pct": m21,
        "momentum_63d_pct": m63,
        "drawdown_63d_pct": float(100 * np.expm1(logs[-1] - np.nanmax(logs[-63:]))),
        "volatility_21d_pct": float(100 * vols[-1] * np.sqrt(sessions_per_year))
        if np.isfinite(vols[-1])
        else None,
        "regime": trend,
    }
    return state, (100 * sigma * np.sqrt(sessions_per_year) if sigma is not None else None), inputs


@lru_cache(maxsize=32)
def validation(closes):
    state = market_states(closes)
    return tuple(walk_forward(state, h, limit) for h, limit in ((1, 63), (21, 12), (252, 4)))


@lru_cache(maxsize=32)
def scenario(closes, steps, sessions_per_year):
    state, volatility, inputs = prepared(closes, sessions_per_year)
    try:
        moves, matches = fit_path(state, len(closes) - 1, steps)
    except ValueError as exc:
        # A real observed anchor is a usable reference for an IPO or flat series.
        # Never assign fitted skill, probabilities or price variation to it.
        inputs = {
            **inputs,
            "kind": "last_price_reference",
            "reference_reason": str(exc),
            "comparable_origins": 0,
            "matched_horizon_sessions": 0,
            "independent_horizon_matches": 0,
            "max_analogue_sessions": 0,
        }
        prices = np.full((steps, 3), closes[-1])
        checks = tuple(validation_metrics([], [], 0, 0, 0) for _ in range(3))
    else:
        inputs = {**inputs, "kind": "conditional_history", **matches}
        prices = closes[-1] * np.exp(moves)
        checks = validation(closes)
    if not np.isfinite(prices).all() or (prices <= 0).any():
        raise ValueError("The observed history does not support a finite price path.")
    return prices, volatility, inputs, *checks
