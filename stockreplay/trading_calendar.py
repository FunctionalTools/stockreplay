"""Exchange-aware daily defaults, including holidays and early closes."""

from datetime import date, datetime
from functools import lru_cache
from zoneinfo import ZoneInfo

import exchange_calendars as xc
import pandas as pd

NY = ZoneInfo("America/New_York")


@lru_cache(maxsize=2)
def _calendar(year):
    return xc.get_calendar("XNYS", start="1989-01-01", end=f"{year + 2}-12-31")


def calendar():
    return _calendar(datetime.now(NY).year)


def latest_session(at=None) -> date:
    instant = pd.Timestamp(at or datetime.now(NY))
    if instant.tz is None:
        raise ValueError("Supply a timestamp with its timezone.")
    local = instant.tz_convert(NY)
    cal = _calendar(local.year)
    session = cal.date_to_session(local.date(), direction="previous")
    if instant < cal.session_close(session):
        session = cal.previous_session(session)
    return session.date()


def history_start() -> date:
    return (pd.Timestamp(latest_session()) - pd.DateOffset(years=3)).date()
