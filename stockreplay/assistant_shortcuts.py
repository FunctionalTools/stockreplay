"""Exact, local shortcuts. Ambiguous or compound requests go to the selected model."""

import re

from .symbols import NAMES

PERIODS = {
    "1d": ("1d", "1 day", "one day", "today", "daily"),
    "5d": ("5d", "5 days", "five days", "five trading days"),
    "1w": ("1w", "1wk", "1 week", "one week"),
    "1mo": ("1mo", "1m", "1 month", "one month"),
    "3mo": ("3mo", "3m", "3 months", "three months"),
    "6mo": ("6mo", "6m", "6 months", "six months"),
    "ytd": ("ytd", "year to date", "year-to-date", "this year"),
    "1y": ("1y", "1 year", "one year"),
    "2y": ("2y", "2 years", "two years"),
    "5y": ("5y", "5 years", "five years"),
    "10y": ("10y", "10 years", "ten years"),
    "max": ("max", "all time", "all history", "maximum"),
}
ALIASES = {alias: preset for preset, aliases in PERIODS.items() for alias in aliases}
RANGE_WORDS = "|".join(re.escape(a) for a in sorted(ALIASES, key=len, reverse=True))
RANGE = rf"(?:{RANGE_WORDS}|(?:from )?\d{{4}}-\d{{2}}-\d{{2}}(?:/| (?:to|through|until) )\d{{4}}-\d{{2}}-\d{{2}})"
PERIOD_PREFIX = r"(?:(?:for|over|from|to) )?(?:(?:the )?(?:last|past) )?"
KNOWN = {**{n.casefold(): s for s, n in NAMES.items()}, **{s.lower(): s for s in NAMES}}


def symbol(text, current):
    if text.lower() in ("this stock", "this ticker", "current stock", "current ticker"):
        return current
    if text.casefold() in KNOWN:
        return KNOWN[text.casefold()]
    # Unknown lowercase words may be company names or commands. Only explicit symbols bypass the model.
    if text.startswith("$"):
        text = text[1:].upper()
    if re.fullmatch(r"[A-Z0-9^][A-Z0-9.^=\-]{0,19}", text):
        return text
    return None


def period(raw):
    if raw.lower() in ALIASES:
        return ALIASES[raw.lower()]
    return "/".join(re.findall(r"\d{4}-\d{2}-\d{2}", raw))


def preference(text, current):
    match = re.fullmatch
    if match(
        r"(?:expand|enlarge) (?:the |my )?(?:assistant|chat|chatbot)(?: window)?|make (?:the |my )?(?:assistant|chat|chatbot)(?: window)? (?:large|larger|bigger)",
        text,
        re.I,
    ):
        return {"kind": "chat_size", "size": "large"}
    if match(
        r"(?:shrink|reset) (?:the |my )?(?:assistant|chat|chatbot)(?: window)?(?: size)?|make (?:the |my )?(?:assistant|chat|chatbot)(?: window)? (?:compact|small|smaller)",
        text,
        re.I,
    ):
        return {"kind": "chat_size", "size": "compact"}
    if m := match(
        r"(?:(?:set|switch|change|use|enable)(?: (?:the )?(?:theme|appearance|display|mode))?(?: to)? )?(dark|light|system)(?: mode| theme| appearance)?",
        text,
        re.I,
    ):
        return {"kind": "appearance", "mode": m[1].lower()}
    if m := match(
        r"(?:(?:set|switch|change|use)(?: (?:the )?(?:accent|theme|color))?(?: to)? )?(forest|ocean|violet|amber)(?: accent| theme)?",
        text,
        re.I,
    ):
        return {"kind": "accent", "color": m[1].lower()}
    if m := match(
        r"(enable|disable|turn on|turn off) advanced(?: trader)?(?: tools| mode| charts)?",
        text,
        re.I,
    ):
        return {"kind": "advanced", "enabled": m[1].lower() in ("enable", "turn on")}
    if match(
        r"(?:use|set|make) (?:my )?(?:portfolio|holdings) (?:as |to )?(?:my |the )?(?:home|homepage|home page|starting view)",
        text,
        re.I,
    ) or match(
        r"(?:set|switch|change) (?:my |the )?(?:home|homepage|home page|starting view) to (?:my )?(?:portfolio|holdings)",
        text,
        re.I,
    ):
        return {"kind": "home_portfolio"}
    if m := match(
        r"(?:set|change|switch) (?:my |the )?(?:starting stock|starting ticker|home stock|home ticker|home|home page|homepage) to (.+)",
        text,
        re.I,
    ):
        if asset := symbol(m[1], current):
            return {"kind": "home_stock", "symbol": asset}
    if m := match(
        r"(?:make|use) (.+?) (?:as )?(?:my |the )?(?:home|homepage|home page|starting stock|starting ticker)",
        text,
        re.I,
    ):
        if asset := symbol(m[1], current):
            return {"kind": "home_stock", "symbol": asset}
    return None


def asks_for_future_view(raw):
    text = " ".join(raw.lower().replace("’", "'").strip().rstrip("?! .").split())
    return bool(re.fullmatch(
        r"(?:where(?:'s|s| is| can i (?:find|see|view)| do i (?:find|see|view))|"
        r"(?:which|what) (?:tab|page|view) (?:shows|has|contains)) (?:the )?"
        r"(?:(?:tab|page|view) (?:where i can (?:see|view)|for|with|that shows) )?"
        r"(?:future(?: (?:tab|view))?|(?:future )?(?:stock price |stock |price )?"
        r"(?:predictions?|projections?|forecasts?))(?: (?:tab|page|view))?",
        text,
    ))


def forecast_command(text, current, question):
    # Only a whole imperative can dispatch the billable generation endpoint.
    command = r"(?P<verb>generate|regenerate|update|refresh|open|view|show|display) (?:me )?(?:a |the |my )?(?:saved )?"
    noun = r"(?:(?:stock |AI )?(?:price )?forecast|(?:stock )?price prediction)"
    match = re.fullmatch(
        command + noun + rf" for (?P<asset>.+?) (?:for |over |from )(?P<span>{RANGE})", text, re.I
    ) or re.fullmatch(
        command + rf"(?:(?P<span>{RANGE}) )?" + noun + r"(?: for (?P<asset>.+))?", text, re.I
    )
    if not match:
        return None
    asset = symbol(match["asset"], current) if match["asset"] else current
    if not asset:
        return None
    span = period(match["span"] or "6mo")
    if match["verb"].lower() in {"open", "view", "show", "display"}:
        focus = "future_custom_" + span.replace("/", "_") if "/" in span else "future_" + span
        return {"kind": "navigate", "symbol": asset, "page": "Research", "focus": focus}
    return None if question else {"kind": "forecast", "symbol": asset, "span": span}


def forecast_question_symbol(raw, current):
    # Product and price-forecast questions can open the saved chart without running inference.
    text = raw.strip().rstrip("?.!")
    if not re.match(r"(?:please )?(?:where|what|how|when|why|which|can|could|would|should|is|are|do|does|generate|regenerate|update|refresh)\b", text, re.I):
        return None
    if not re.search(r"\b(?:forecasts?|(?:stock |price )(?:predictions?|projections?))\b", text, re.I):
        return None
    if re.search(r"\b(?:earnings|revenue|sales|cash flow|EPS|filings?|research online|news|weather)\b", text, re.I):
        return None
    mentioned = re.search(r"\bfor (.+)$", text, re.I)
    return (symbol(mentioned[1], current) if mentioned else None) or current


def local_actions(raw, current, provider=None):
    text = re.sub(r"^please\s+", "", " ".join(raw.split()), flags=re.I).rstrip(".!?").strip()
    if not text:
        return None
    if requested := forecast_command(text, current, raw.strip().endswith("?")):
        return [requested]
    if (
        re.match(
            r"^(?:search (?:the )?(?:web|internet|online)|research online|read (?:the )?(?:latest )?SEC filings?)\b",
            text,
            re.I,
        )
        and len(text) <= 1600
        and not re.search(
            r"\b(?:then|and (?:open|save|add|create|change|remove|plot|draw|compare))\b", text, re.I
        )
    ):
        explicit = {
            ticker
            for alias, ticker in KNOWN.items()
            if re.search(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", text, re.I)
        }
        explicit.update(
            m
            for m in re.findall(r"(?:\$|(?<!\w))([A-Z][A-Z0-9.-]{0,9})(?!\w)", text)
            if m not in {"SEC", "ETF", "AI", "GDP", "US", "CEO", "EPS", "Q", "I", "RISK"}
        )
        if len(explicit) == 1:
            return [{"kind": "research", "symbol": explicit.pop(), "question": text}]
        if not explicit and re.search(
            r"\b(?:this stock|this ticker|current stock|its filings)\b", text, re.I
        ):
            return [{"kind": "research", "symbol": current, "question": text}]
    if m := re.fullmatch(
        r"(?:open|show|view|go to) (?:the )?(?:future(?: view| tab)?|(?:stock |price )?(?:projections|predictions))(?: for (.+))?",
        text, re.I,
    ):
        asset = symbol(m[1], current) if m[1] else current
        if asset:
            return [{"kind": "navigate", "page": "Research", "focus": "future", "symbol": asset}]
    if m := re.fullmatch(
        r"(?:open|show|view|go to) (?:the |my )?(?:forecast |stock )?calendar(?: for (.+))?",
        text,
        re.I,
    ):
        asset = symbol(m[1], current) if m[1] else current
        if asset:
            return [{"kind": "navigate", "page": "Calendar", "symbol": asset}]
    # Combine complete settings commands only. Never execute a partial match or discard a clause.
    clauses = re.split(r",\s*(?:and )?| and |;\s*", text, flags=re.I)
    prefs = [preference(s, current) for s in clauses]
    if len(prefs) <= 8 and all(prefs):
        return prefs
    if m := re.fullmatch(
        r"(?:open|show|go to|take me to) (?:the |my )?(settings|ai settings|api settings|research|portfolio|watchlists)",
        text,
        re.I,
    ):
        page = m[1].capitalize()
        return [{"kind": "navigate", "page": "Settings" if page.endswith("settings") else page}]
    if m := re.fullmatch(
        r"(?:set|use|change|switch) (?:the |my )?(?:(local|ollama|openai|api) )?model(?: to)? ([a-z0-9][a-z0-9._:/-]{0,119})",
        text,
        re.I,
    ):
        requested = (m[1] or "").lower()
        if (requested in {"local", "ollama"} and provider == "openai") or (
            requested == "openai" and provider == "ollama"
        ):
            return [{"kind": "navigate", "page": "Settings"}]
        return [{"kind": "model", "model": m[2]}]
    if re.fullmatch(
        r"(?:add|change|replace|set|connect|update) (?:my |the )?(?:openai |chatgpt )?api key",
        text,
        re.I,
    ):
        return [{"kind": "navigate", "page": "Settings"}]
    if m := re.fullmatch(r"(?:open|show|view) (?:the )?(ratings|news)(?: for (.+))?", text, re.I):
        if asset := (symbol(m[2], current) if m[2] else current):
            return [{"kind": m[1].lower(), "symbol": asset}]
    if m := re.fullmatch(
        rf"(?:(?:change|set|switch|show) (?:the |my )?(?:homepage |home |chart )?(?:range|time ?frame)(?: to)? |show (?:the |my )?(?:homepage|home chart) ){PERIOD_PREFIX}({RANGE})",
        text,
        re.I,
    ):
        return [{"kind": "range", "symbol": current, "span": period(m[1])}]
    if m := re.fullmatch(
        rf"(?:show|open|view) (?:the |my )?({RANGE}) (?:price |performance )?(?:chart|graph|performance)(?: (?:for|of) (.+))?",
        text,
        re.I,
    ):
        if asset := (symbol(m[2], current) if m[2] else current):
            return [{"kind": "range", "symbol": asset, "span": period(m[1])}]
    if m := re.fullmatch(rf"(?:show|open|view) (.+?) {PERIOD_PREFIX}({RANGE})", text, re.I):
        if asset := symbol(m[1], current):
            return [{"kind": "range", "symbol": asset, "span": period(m[2])}]
    if m := re.fullmatch(
        rf"(?:plot|chart|graph|compare) (.+?)(?: {PERIOD_PREFIX}({RANGE}))?", text, re.I
    ):
        assets = [
            symbol(s.strip(), current)
            for s in re.split(r",\s*| and | vs\.? | versus ", m[1], flags=re.I)
        ]
        if 1 <= len(assets) <= 4 and all(assets):
            return [
                {
                    "kind": "chart",
                    "symbols": list(dict.fromkeys(assets)),
                    "span": period(m[2]) if m[2] else "1y",
                }
            ]
    if m := re.fullmatch(
        r"(?:generate|calculate|refresh) (?:the |new )?(?:buy and risk scores|scores)(?: for (.+))?",
        text,
        re.I,
    ):
        if asset := (symbol(m[1], current) if m[1] else current):
            return [{"kind": "score", "symbol": asset}]
    if m := re.fullmatch(
        r"(?:what (?:are|is) (?:the |today.s )?(?:risks?|outlook|news|market concerns?) (?:for|around|affecting) |why (?:did|is) )(.+?)(?: (?:fall|rise|drop|move|falling|rising)(?: today)?)?",
        text,
        re.I,
    ):
        if asset := symbol(m[1], current):
            return [{"kind": "research", "symbol": asset, "question": raw.strip()}]
    if m := re.fullmatch(
        r"(?:open|show|view|research|switch to|(?:switch|set|change) (?:the |my )?(?:stock|ticker) to) (.+)",
        text,
        re.I,
    ):
        if asset := symbol(m[1], current):
            return [{"kind": "open_stock", "symbol": asset}]
    if asset := symbol(text, current):
        return [{"kind": "open_stock", "symbol": asset}]
    return None
