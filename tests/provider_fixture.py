"""Intercepted provider contracts for isolated tests. Never imported by the application."""

from datetime import datetime, timezone
import json
import httpx
import pandas as pd
from stockreplay.trading_calendar import calendar, latest_session


def completed(value):
    return httpx.Response(
        200,
        json={
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": json.dumps(value)}],
                }
            ],
        },
    )


def assessment(inputs):
    data = inputs["evidence"]

    def point(group, text):
        e = next((v for v in data if v["group"] == group), data[0])
        return {"text": text, "source": e["id"]}

    return {
        "buy_score": 72,
        "risk_score": 58,
        "confidence": "Moderate",
        "factors": {
            row["factor"]: {
                "buy": {
                    "direction": "Raises",
                    "reason": "This observation supports the investment case.",
                },
                "risk": {
                    "direction": "Mixed",
                    "reason": "The downside remains uncertain.",
                },
                "sources": [row["id"]],
            }
            for row in data
        },
        "summary": point("price", "The sourced price change was about 5%."),
        "positives": [
            point("company_news", "The dated company report supports the investment case.")
        ],
        "concerns": [point("risk", "Historical fluctuations increase the downside risk.")],
        "watch_for": point("estimates", "A change in the published target would affect this view."),
    }


def respond(request):
    assert request.url.host == "api.openai.com"
    if request.method == "GET":
        return httpx.Response(403, json={"error": {"message": "Model list scope unavailable."}})
    assert request.url.path == "/v1/responses"
    body = json.loads(request.content)
    assert body["store"] is False and body["text"]["format"]["strict"]
    name = body["text"]["format"]["name"]
    inputs = json.loads(body["input"])
    if name == "connection_check":
        return completed({"result": "ready"})
    if name == "future_price_scenario":
        fields=body["text"]["format"]["schema"]["properties"]
        sid=fields["near"]["properties"]["source"]["enum"][0]
        level={"tilt":"slightly_higher","source":sid}
        result={"near":level,"middle":level,"longer":level,"drivers":[fields["drivers"]["items"]["enum"][0]]}
        if "watch" in fields:result["watch"]=fields["watch"]["enum"][0]
        if "quarters" in fields:result["quarters"]={k:v["enum"][0] for k,v in fields["quarters"]["properties"].items()}
        return completed(result)
    if name == "stock_scores":
        return completed(assessment(inputs))
    if name == "stock_question":
        return completed(
            {
                "answer": "This source reports the current concern.",
                "citations": [inputs["evidence"][0]["ref"]],
            }
        )
    assert name == "app_assistant"
    msg = inputs["messages"][-1]["text"].lower()
    if "monthly review tab" in msg:
        actions = [
            {
                "tab": {
                    "operation": "create",
                    "name": "Monthly review",
                    "value": "",
                    "blocks": [
                        {"view": "scores", "value": "AAPL", "span": "1y"},
                        {"view": "chart", "value": "AAPL", "span": "1mo"},
                    ],
                }
            }
        ]
    elif "change block 2" in msg:
        actions = [
            {
                "tab": {
                    "operation": "edit_block",
                    "name": "",
                    "value": "2",
                    "blocks": [{"view": "chart", "value": "AAPL", "span": "5d"}],
                }
            }
        ]
    elif "chip stocks tab" in msg:
        actions = [
            {
                "tab": {
                    "operation": "create",
                    "name": "Chip stocks",
                    "value": "",
                    "blocks": [{"view": "chart", "value": "NVDA,AMD", "span": "1y"}],
                }
            }
        ]
    elif "watchlist" in msg:
        actions = [
            {"create_list": {"name": "Chat list"}},
            {"watch": {"name": "Chat list", "symbol": "MSFT"}},
        ]
    elif "alert" in msg:
        actions = [
            {
                "alert": {
                    "mode": "create",
                    "symbol": inputs["symbol"],
                    "direction": "above",
                    "threshold": 25,
                }
            }
        ]
    elif "save my chart" in msg:
        actions = [{"chart_control": {"symbol": inputs["symbol"], "command": "save"}}]
    elif "allocation" in msg:
        actions = [{"portfolio": {"view": "allocation"}}]
    elif "risk" in msg:
        actions = [{"research": {"symbol": inputs["symbol"], "question": msg}}]
    elif "dark" in msg:
        actions = [{"appearance": {"mode": "dark"}}]
    else:
        actions = [{"chart": {"symbols": ["NVDA", "MSFT"], "span": "1y"}}]
    return completed({"reply": "Here is the requested action.", "actions": actions, "links": []})


def install_market():
    from tests.fixture_events import install as install_calendar
    install_calendar()
    from stockreplay import forecast_evidence
    forecast_evidence.quarterly_consensus = lambda symbol: []
    from stockreplay import desk
    desk.PublicResearch.lookup = lambda self, symbol, profile, question="", refresh=False, public_topic=False: {
        "symbol":symbol,"query":symbol,"checked":datetime.now(timezone.utc).isoformat(),"evidence":[],"coverage":[]
    }

    completed_day = latest_session()

    def chart(symbol, interval, span, start=None, end=None):
        cal = calendar()
        days = cal.sessions_window(completed_day, -269)
        if span == "custom":
            dates = (
                cal.sessions_in_range(start, min(end, completed_day))
                if start <= completed_day
                else []
            )
        elif interval == "5m":
            dates = [
                bar
                for session in days[-5:]
                for bar in pd.date_range(
                    cal.session_open(session),
                    cal.session_close(session),
                    freq="5min",
                    inclusive="left",
                )
            ]
        else:
            dates = days
        rows = []
        for i, d in enumerate(dates):
            p = 35 + i * 0.14 + (i % 8) * 0.39 + (len(symbol) % 3)
            rows.append(
                {
                    "time": int((d if d.tz else d.tz_localize("UTC")).timestamp()),
                    "date": str(d.date()),
                    "open": p,
                    "close": p + 0.5,
                    "raw_close": p + 0.5,
                    "high": p + 1.1,
                    "low": p - 0.4,
                    "volume": 1000 + i,
                    "split": 0,
                    "dividend": 0,
                }
            )
        if not rows:
            raise ValueError("No observations in the selected period.")
        return {
            "symbol": symbol,
            "bars": rows,
            "as_of": rows[-1]["date"],
            "source": "Yahoo Finance",
            "url": "https://finance.yahoo.com/quote/" + symbol + "/history/",
            "currency": "USD",
            "timezone": "America/New_York",
            "adjusted": True,
            "exchange": "NMS",
            "instrument_type": "EQUITY",
            "latest_completed_session": str(completed_day),
        }

    end = completed_day
    desk.chart_data = chart
    desk.company = lambda s: {
        "longName": s + " Test Company",
        "shortName": s + " Test Company",
        "sector": "Technology",
        "currency": "USD",
        "beta": 1.3,
        "overallRisk": 6,
        "targetLowPrice": 74,
        "targetMeanPrice": 90,
        "targetHighPrice": 102,
        "forwardEps": 4.5,
        "forwardPE": 17.5,
        "trailingPE": 20.0,
        "earningsGrowth": 0.18,
        "revenueGrowth": 0.12,
        "profitMargins": 0.14,
        "debtToEquity": 36.5,
        "recommendationKey": "buy",
    }
    desk.forecast = lambda s: {
        "grade": "Buy",
        "count": 7,
        "targets": {"low": 74, "average": 90, "high": 102},
        "votes": {"Strong Buy": 3, "Buy": 2, "Hold": 2, "Sell": 0, "Strong Sell": 0},
        "source": "Stock Analysis",
        "provider": "S&P Global",
        "period": str(end),
        "summary": "Seven test panelists published a Buy consensus.",
        "url": "https://stockanalysis.com/stocks/" + s.lower() + "/forecast/",
    }
    desk.consensus = lambda s: [
        {
            "period": "0m",
            "strongBuy": 3,
            "buy": 2,
            "hold": 2,
            "sell": 0,
            "strongSell": 0,
        }
    ]

    def news(s, category):
        return [
            {
                "title": "Published " + category + " report",
                "url": "https://example.org/market/" + category,
                "published": datetime.now(timezone.utc).isoformat(),
                "category": category,
                "publisher": "Test publication",
                "excerpt": f"A dated excerpt mentioning {s} for the isolated browser test.",
            }
        ]

    desk.stories = news
    desk.rss = lambda u, g: news("SPY", g)

    def grades(s):
        return [
            {
                "date": str(end),
                "firm": "Test research firm",
                "analyst": "A. Analyst",
                "grade": "Buy",
                "target": 90,
                "action": "Maintained",
                "source": "Stock Analysis",
                "url": "https://stockanalysis.com/stocks/" + s.lower() + "/ratings/",
            }
        ]

    desk.stockanalysis = grades
    desk.analyst_history = lambda s: []
