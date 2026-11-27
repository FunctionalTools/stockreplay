"""Calendar transports for the isolated offline browser server."""

from datetime import date, timedelta


def install():
    from stockreplay import (
        company_events as company,
        event_policy as policy,
        market_events as feed,
    )

    day = date.today()
    target = (day + timedelta(days=7)).isoformat()
    feed.sec_tickers = lambda: {}
    policy.senate_agendas = lambda: []
    company.yahoo_calendar = lambda s: {
        "url": "https://finance.yahoo.com/quote/" + s + "/",
        "name": s,
        "sector": "Technology",
        "window": [target],
        "confirmed": False,
        "ex_dividend": None,
        "dividend": None,
    }
    company.fetch_statistics = lambda s: {
        "url": "https://stockanalysis.com/",
        "facts": {},
    }

    def statements(s):
        ends = [(3, 31), (6, 30), (9, 30), (12, 31)]
        periods = [
            (d.isoformat(), i + 1, y)
            for y in (day.year - 1, day.year)
            for i, (m, n) in enumerate(ends)
            if (d := date(y, m, n)) <= day
        ]
        return {
            "url": company.stock_analysis(s) + "financials/?p=quarterly",
            "periods": periods,
            "source": "Stock Analysis financial statements",
        }

    company.fetch_quarters = statements
    policy.fomc_events = lambda: [
        {
            "date": target,
            "end_date": target,
            "title": "Federal Reserve policy meeting",
            "kind": "macro",
            "status": "scheduled",
            "url": policy.FOMC,
            "excerpt": "Test calendar meeting.",
            "relevance": "US monetary policy.",
        }
    ]
    policy.budget_table = lambda: [
        [
            "April 15",
            "Congress completes action on concurrent resolution on the budget.",
        ]
    ]
    policy.register_rules = lambda agencies, start, end, issuer=None: {
        "rows": [],
        "partial": False,
    }
