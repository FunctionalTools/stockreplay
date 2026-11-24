"""Bind explicit user-supplied units and literals when validating a model interpretation."""

import re

from .symbols import NAMES

NUMBERS = dict(
    zip(
        "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(),
        range(1, 21),
    )
)
NUMBER = r"(?:\d+|" + "|".join(NUMBERS) + r")"
HORIZON = re.compile(
    r"\b(?:over|within|for|in|next|holding(?: period)?(?: of)?|hold for)\s+(?:the\s+)?(?:next\s+)?("
    + NUMBER
    + r")[ -]+(?:trading[ -]+)?(?:days?|sessions?)\b",
    re.I,
)
PREFIX_HORIZON = re.compile(
    r"\b("
    + NUMBER
    + r")[ -]+(?:trading[ -]+)?(?:days?|sessions?)[ -]+(?:return|hold|later|after)\b",
    re.I,
)
MOVEMENT = re.compile(
    r"\b(falls?|falling|drops?|dropping|loss|declines?|declining|gains?|rises?|rising|increase[sd]?)\s+(?:of\s+|by\s+)?(more than|greater than|at least|over|exceeding)\s+(\d+(?:\.\d+)?)\s*(?:%|percent\b)",
    re.I,
)
MISSING = [
    (
        r"\b(tweets?|twitter|news|headlines?|sentiment|social media)\b",
        "timestamped news or social-media data",
    ),
    (
        r"\b(earnings|revenue|fundamentals?|insider (?:trades|buying)|p/e ratio)\b",
        "point-in-time corporate fundamentals or disclosures",
    ),
    (r"\b(intraday|minute bars?|hourly|premarket|after.hours)\b", "intraday price bars"),
]


def missing_data(question):
    for pattern, description in MISSING:
        if re.search(pattern, question, re.I):
            return (
                "This hypothesis requires "
                + description
                + ". Available datasets contain daily prices, volume and corporate actions."
            )
    return None


def literals(question):
    found = {}
    horizon = HORIZON.search(question) or PREFIX_HORIZON.search(question)
    if horizon:
        suffix = question[horizon.end() :].lower().lstrip(" -")
        prefix = question[: horizon.start()].lower()
        after_trigger = bool(re.search(r"\b(after|when|if)\b", prefix))
        explicit_future = re.search(r"\b(next|hold|holding|later)\b", horizon.group(), re.I)
        if (not after_trigger or explicit_future) and not suffix.startswith(
            ("moving", "average", "lookback", "volatility", "rsi")
        ):
            n = horizon.group(1).lower()
            found["holding"] = int(n) if n.isdigit() else NUMBERS[n]
    movements = list(MOVEMENT.finditer(question))
    if len(movements) == 1:
        word, comparison, amount = movements[0].groups()
        negative = word.lower().startswith(("fall", "drop", "loss", "declin"))
        inclusive = comparison.lower() == "at least"
        found["movement"] = {
            "value": float(amount) * (-1 if negative else 1),
            "operator": ("lt" if negative else "gt") + ("e" if inclusive else ""),
        }
    return found


ALIASES = {
    **{name: symbol for symbol, name in NAMES.items()},
    **{symbol: symbol for symbol in NAMES},
    "S&P 500": "SPY",
    "S&P500": "SPY",
    "Google": "GOOGL",
    "Facebook": "META",
    "Meta": "META",
    "the Nasdaq 100": "QQQ",
}


def mentioned(text, symbol):
    names = [symbol] + [name for name, ticker in ALIASES.items() if ticker == symbol]
    return any(
        re.search(
            r"(?<![\w.^=-])" + re.escape(name) + r"(?!\w|[.-]\w)",
            text,
            0 if len(name) <= 2 else re.I,
        )
        for name in names
    )


def trigger_symbol(question, symbols):
    moves = list(MOVEMENT.finditer(question))
    if len(moves) != 1:
        return None
    subject = question[: moves[0].start()].rstrip()
    names = {**{s: s for s in symbols}, **ALIASES}
    for name, ticker in sorted(names.items(), key=lambda pair: -len(pair[0])):
        if re.search(
            r"(?<![\w.^=-])" + re.escape(name) + r"(?:['’]s)?(?: (?:stock|shares))?$", subject, re.I
        ):
            return ticker
    explicit_ticker = re.search(r"(?:^|[\s$])([A-Z][A-Z0-9.^=-]{0,11})(?: shares)?$", subject)
    return explicit_ticker.group(1) if explicit_ticker else None


def clarify_semantics(question, tickers):
    if any(not mentioned(question, s) for s in tickers):
        return "Which exchange ticker or tickers should be traded? Include the symbol in your question so the study can identify the intended security."
    if re.search(r"\b(?:unusually|unusual|abnormally)\b", question, re.I) and not re.search(
        r"\d|twice|double|triple", question, re.I
    ):
        return "What numerical threshold and lookback window define the unusual move or volume?"
    if re.search(r"\brecover(?:s|y)?\b", question, re.I) and not re.search(
        r"pre[- ]?(?:drop|decline|signal)|previous close|positive (?:net )?return|regain",
        question,
        re.I,
    ):
        return "Does recovery mean a positive net return, or regaining the closing price immediately before the decline?"
    return None


def sole_daily_trigger(question, symbols):
    """Recognize one explicit daily move following a conditional, with no further qualifiers."""
    moves = list(MOVEMENT.finditer(question))
    if len(moves) != 1:
        return None
    move = moves[0]
    markers = list(re.finditer(r"\b(?:when|after|if)\b", question[: move.start()], re.I))
    if not markers:
        return None
    subject = question[markers[-1].end() : move.start()].strip()
    tail = question[move.end() :].strip(" ?.!").casefold()
    if tail and not re.fullmatch(
        r"(?:in|over|on) (?:a |one |a single |the same )?(?:trading )?(?:session|day)", tail
    ):
        return None
    names = {**{s: s for s in symbols}, **ALIASES}
    ticker = "ASSET"
    for name, value in sorted(names.items(), key=lambda x: -len(x[0])):
        match = re.match(
            re.escape(name) + r"(?:['’]s)?(?: (?:stock|shares))?(?:\s+|$)", subject, re.I
        )
        if match:
            ticker = value
            subject = subject[match.end() :]
            break
    if not re.fullmatch(
        r"(?:(?:it|the stock|the asset)\s*)?(?:(?:has|suffers|experiences)\s*)?(?:(?:a|an)\s*)?(?:daily|single[ -]session|one[ -]day)?",
        subject.strip(),
        re.I,
    ):
        return None
    return ticker
