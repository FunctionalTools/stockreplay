"""Intercepted provider contracts for isolated tests. Never imported by the application."""

from datetime import datetime, timezone
import json
import httpx
import pandas as pd
from stockreplay.trading_calendar import latest_session


def completed(value):
    return httpx.Response(
        200,
        json={
            "status": "completed",
            "output": [
                {"type": "message", "content": [{"type": "output_text", "text": json.dumps(value)}]}
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
    if "chip stocks tab" in msg:
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
    from stockreplay import desk

    end = latest_session()

    def chart(symbol, interval, span):
        dates = pd.bdate_range(end=end, periods=270)
        rows = []
        for i, d in enumerate(dates):
            p = 35 + i * 0.14 + (i % 8) * 0.39 + (len(symbol) % 3)
            rows.append(
                {
                    "time": int(d.tz_localize("UTC").timestamp()),
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
        return {
            "symbol": symbol,
            "bars": rows,
            "as_of": str(end),
            "source": "Yahoo Finance",
            "url": "https://finance.yahoo.com/quote/" + symbol + "/history/",
            "currency": "USD",
            "timezone": "America/New_York",
            "latest_completed_session": str(end),
        }

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
        {"period": "0m", "strongBuy": 3, "buy": 2, "hold": 2, "sell": 0, "strongSell": 0}
    ]

    def news(s, category):
        return [
            {
                "title": "Published " + category + " report",
                "url": "https://example.org/market/" + category,
                "published": datetime.now(timezone.utc).isoformat(),
                "category": category,
                "publisher": "Test publication",
                "excerpt": "A dated excerpt for the isolated browser test.",
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
