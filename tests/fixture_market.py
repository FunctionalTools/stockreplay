"""Deterministic imported CSV statements for isolated tests only."""

from pathlib import Path

from stockreplay.market import read_csv, store_frame
from stockreplay.schema import Experiment


def seed(db):
    for path in sorted((Path(__file__).parent / "fixtures" / "prices").glob("*.csv")):
        store_frame(db, path.stem, "csv", read_csv(path.read_text()))
    return Experiment(source="csv", start="2021-01-04", end="2024-12-31")
