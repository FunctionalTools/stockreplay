"""Coverage, provenance and freshness of the public inputs to an AI assessment."""

from datetime import date
from urllib.parse import urlsplit

# Labels also describe what is missing when a provider has no evidence for a stock.
FACTORS = {
    "trend": "Price trend and momentum",
    "relative": "Performance versus the market",
    "price_risk": "Volatility and past declines",
    "sensitivity": "Sensitivity to market moves",
    "valuation": "Valuation",
    "growth": "Sales and earnings growth",
    "profitability": "Margins and profitability",
    "balance_sheet": "Debt and liquidity",
    "cash_flow": "Cash generation",
    "governance": "Corporate governance risk",
    "earnings": "Earnings estimates",
    "targets": "Analyst price targets",
    "analysts": "Analyst opinions",
    "company_news": "Company news",
    "sector": "Sector conditions",
    "market": "Broad market conditions",
    "macro": "Rates, volatility and policy",
}
GROUPS = {
    "price": "trend",
    "technical": "trend",
    "fundamentals": "valuation",
    "risk": "price_risk",
    "estimates": "earnings",
    "sector_news": "sector",
    "market_news": "market",
    "macro_news": "macro",
}
CONTEXT = {"sector", "market", "macro"}
DIRECTIONS = ("Raises", "Lowers", "Mixed", "Neutral")


def factor_key(item):
    return item.get("factor") or GROUPS.get(item["group"], item["group"])


def usable(item):
    """Only dated, attributable public observations can be sent to the scoring model."""
    try:
        address = urlsplit(item["url"])
        date.fromisoformat(item["date"][:10])
        return bool(
            isinstance(item["id"], str)
            and item["id"].strip()
            and factor_key(item) in FACTORS
            and item.get("names_company") is not False
            and item["text"].strip()
            and item["source"].strip()
            and address.scheme in {"http", "https"}
            and address.hostname
            and not address.username
            and not address.password
        )
    except (ValueError, KeyError, TypeError, AttributeError):
        return False


def older(item, session):
    """Flag backfilled caches and aged observations relative to the saved assessment's session."""
    if item.get("stale"):
        return True
    day = date.fromisoformat(session[:10])
    if item.get("period_end") and (day - date.fromisoformat(item["period_end"])).days > 150:
        return True
    age = (day - date.fromisoformat(item["date"][:10])).days
    if item.get("date_kind") == "close":
        return age > 0
    if item.get("factor") == "governance" and item.get("date_kind") == "published":
        return age > 365
    return age > (
        14 if item["group"].endswith("_news") else 45 if item["group"] == "analysts" else 7
    )
