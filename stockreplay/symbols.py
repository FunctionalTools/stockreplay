"""Offline names for ticker search and grounding explicit references."""

import re


def ticker(raw):
    value = raw.strip().upper()
    if not re.fullmatch(r"[A-Z0-9^][A-Z0-9.^=\-]{0,19}", value):
        raise ValueError("Enter a valid market symbol.")
    return value


NAMES = {
    "NVDA": "NVIDIA",
    "AAPL": "Apple",
    "MSFT": "Microsoft",
    "SPY": "SPDR S&P 500 ETF",
    "QQQ": "Invesco QQQ",
    "AMD": "Advanced Micro Devices",
    "SOXX": "iShares Semiconductor ETF",
    "SMH": "VanEck Semiconductor ETF",
    "TSLA": "Tesla",
    "AMZN": "Amazon",
    "META": "Meta Platforms",
    "GOOGL": "Alphabet",
    "IWM": "iShares Russell 2000",
    "DIA": "SPDR Dow Jones ETF",
}
