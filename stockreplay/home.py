"""Opening research context derived only from this Mac's saved positions."""

import re

# Local classification avoids sending statement details to a symbol lookup service.
_LISTED = re.compile(r"(?:[A-Z]{1,6}(?:[.-][A-Z0-9]{1,5})?|[0-9]{1,6}\.[A-Z]{1,3})")
_CASH_DESCRIPTION = re.compile(
    r"\b(money market|cash (?:balance|sweep|reserve|deposit)|core position|pending activity)\b",
    re.IGNORECASE,
)


def research_symbol(position):
    symbol = position.get("symbol", "").strip().upper()
    description = position.get("description", "")
    if (
        not _LISTED.fullmatch(symbol)
        or symbol in {"CASH", "FCASH", "SWEEP", "PENDING", position["currency"]}
        or (len(symbol) == 5 and symbol.endswith("XX"))
        or _CASH_DESCRIPTION.search(description)
        or not (position.get("quantity") or position.get("value"))
    ):
        return None
    return symbol


def portfolio_context(accounts):
    rows = [row for account in accounts for row in account["positions"]]
    totals = {}
    groups = {}
    for row in rows:
        currency, value = row["currency"], row.get("value")
        if value is not None:
            totals[currency] = totals.get(currency, 0.0) + abs(value)
        symbol = research_symbol(row)
        if symbol:
            groups.setdefault((symbol, currency), []).append(row)

    holdings = []
    for (symbol, currency), positions in groups.items():
        values = [p["value"] for p in positions if p.get("value") is not None]
        quantities = [p["quantity"] for p in positions if p.get("quantity") is not None]
        dates = sorted(p["as_of"] for p in positions if p.get("as_of"))
        gross = sum(abs(v) for v in values) if values else None
        holdings.append(
            {
                "symbol": symbol,
                "currency": currency,
                "gross_value": gross,
                "partial_value": len(values) < len(positions),
                "weight": gross / totals[currency]
                if gross is not None and totals[currency]
                else None,
                "quantity": sum(quantities) if len(quantities) == len(positions) else None,
                "first_date": dates[0] if dates else None,
                "last_date": dates[-1] if dates else None,
                "undated": len(dates) < len(positions),
            }
        )
    # Use the largest disclosed exposure within one currency. Dollar statements lead
    # when available. Never add or compare amounts denominated in different currencies.
    holdings.sort(
        key=lambda h: (
            not bool(h["gross_value"]),
            h["currency"] != "USD",
            h["currency"],
            -(h["gross_value"] or 0),
            h["symbol"],
        )
    )
    return {
        "portfolio_symbol": holdings[0]["symbol"] if holdings else None,
        "holdings": holdings,
        "position_count": len(rows),
    }
