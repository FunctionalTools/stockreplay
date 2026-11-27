"""Provider-independent, ticker-specific public search. No portfolio data or API keys enter a search."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from functools import partial
import hashlib
import json
import re
from threading import Lock
from urllib.parse import quote, urlencode, urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup

from .sec_research import sec_lookup
from .source_reader import (
    article_document,
    article_publisher,
    best_passage,
    normalize,
    published,
    read_public,
)
from .store import now
from .symbols import NAMES

# Only public topic words and an issuer name leave the Mac. The raw question, URLs and account details do not.
TOPICS = (
    "earnings",
    "revenue",
    "growth",
    "profit",
    "margin",
    "cost",
    "cash flow",
    "debt",
    "liquidity",
    "risk",
    "forecast",
    "guidance",
    "valuation",
    "dividend",
    "buyback",
    "acquisition",
    "merger",
    "competition",
    "supply",
    "demand",
    "tariff",
    "inflation",
    "rates",
    "regulation",
    "antitrust",
    "lawsuit",
    "litigation",
    "export",
    "chip",
    "semiconductor",
    "cloud",
    "artificial intelligence",
    "data center",
    "product",
    "outage",
    "cybersecurity",
    "sales",
    "layoff",
    "investment",
    "capacity",
    "contract",
    "policy",
    "trial",
    "approval",
)
DEFAULT_WORDS = ("earnings", "risk", "growth", "demand", "revenue", "forecast", "cost")


def topics(question, explicit_topic=False):
    text = question.casefold()
    standard = [t for t in TOPICS if re.search(r"\b" + t + r"(?:s|es|ing)?\b", text)]
    # Chat sends only known public topics or phrases the user explicitly quotes for search.
    # The separate public-topic field can send the words entered in that field after its disclosure.
    quoted = re.findall(r'["“]([a-z][a-z0-9 -]{1,45})["”]', text)
    if explicit_topic and re.fullmatch(r"[a-z][a-z0-9 -]{1,90}", text) and len(text.split()) <= 8:
        other = [
            w
            for w in text.split()
            if w not in standard
            and w not in {"for", "and", "in", "the", "a", "on", "of", "about", "or"}
        ]
        quoted.extend(other)
    custom = [
        w.strip()
        for w in quoted
        if w.strip()
        and not re.search(r"\d{4,}|\b(?:account|password|secret|private|address|key)\b", w)
    ]
    return tuple(dict.fromkeys([*custom, *standard]))[:4]


def public_name(symbol, profile):
    name = NAMES.get(symbol) or profile.get("shortName") or profile.get("longName") or symbol
    name = re.sub(
        r"[, ]+\b(?:corp(?:oration)?|inc(?:orporated)?|plc|limited|ltd)\.?$",
        "",
        str(name),
        flags=re.I,
    )
    return normalize(re.sub(r"[^\w &.-]", " ", name))[:75] or symbol


def news_index(name, terms):
    since = "3months" if terms else "1month"
    query = '"' + name + '" ' + " ".join('"' + t + '"' for t in terms) + " sourcelang:english"
    url = "https://api.gdeltproject.org/api/v2/doc/doc?" + urlencode(
        {
            "query": query,
            "mode": "artlist",
            "format": "json",
            "maxrecords": 24,
            "timespan": since,
            "sort": "datedesc",
        }
    )
    try:
        rows = json.loads(read_public(url, accept="application/json", timeout=5)).get(
            "articles", []
        )
    except json.JSONDecodeError:
        raise ValueError("The news index returned no readable results.") from None
    return [
        {
            "text": r.get("title"),
            "url": r.get("url"),
            "date": published(r.get("seendate")),
            "date_origin": "GDELT first indexed",
            "discovered_via": "GDELT news search",
        }
        for r in rows
        if isinstance(r, dict)
    ]


def ticker_index(symbol, is_etf):
    listing = (
        "https://stockanalysis.com/"
        + ("etf" if is_etf else "stocks")
        + "/"
        + quote(symbol.lower(), safe="")
        + "/"
    )
    soup = BeautifulSoup(read_public(listing), "html.parser")
    rows = []
    for link in soup.select("h3 a[href]"):
        card = link.parent.parent
        stamp = next(
            (d for tag in card.select("[title]") if (d := published(tag.get("title")))), None
        )
        if stamp and len(card.select("h3")) == 1:
            rows.append(
                {
                    "text": normalize(link.get_text(" ", strip=True)),
                    "url": urljoin(listing, link["href"]),
                    "date": stamp,
                    "date_origin": "Stock Analysis publication listing",
                    "discovered_via": "Stock Analysis ticker news",
                }
            )
    return rows[:35]


def canonical(url):
    if not isinstance(url, str):
        return None
    try:
        p = urlsplit(url)
        # Drop tracking parameters before storage or retrieval. Never follow redirect wrappers.
        url = urlunsplit((p.scheme, p.netloc, p.path, "", ""))
        return url if article_publisher(url) else None
    except ValueError:
        return None


def mentions(text, symbol, name):
    return any(
        re.search(
            r"(?<!\w)" + re.escape(term) + r"(?!\w)", text, flags=re.I if len(term) > 2 else 0
        )
        for term in {symbol, name}
        if term
    )


class PublicResearch:
    def __init__(self, cache):
        self.cache = cache
        self.recent = {}
        self.lock = Lock()
        self.locks = [Lock() for _ in range(19)]

    def lookup(self, symbol, profile, question="", refresh=False, public_topic=False):
        terms = topics(question, explicit_topic=public_topic)
        name = public_name(symbol, profile)
        cache_key = (symbol, name, terms)
        with self.locks[hash(cache_key) % len(self.locks)]:
            stamp = datetime.now(timezone.utc)
            with self.lock:
                old = self.recent.get(cache_key)
            if old and not refresh and stamp - old[0] < timedelta(minutes=5):
                return old[1]
            result = self._search(symbol, name, profile.get("quoteType") == "ETF", terms, refresh)
            with self.lock:
                if len(self.recent) >= 128:
                    del self.recent[next(iter(self.recent))]
                self.recent[cache_key] = (stamp, result)
            return result

    def _search(self, symbol, name, is_etf, terms, refresh):
        key = hashlib.sha256(json.dumps([name, terms]).encode()).hexdigest()[:24]
        tasks = {
            "GDELT news search": partial(
                self.cache.get, "web/gdelt/" + key, 1800, lambda: news_index(name, terms), refresh
            ),
            "Stock Analysis ticker news": partial(
                self.cache.get,
                "web/ticker/" + symbol,
                1800,
                lambda: ticker_index(symbol, is_etf),
                refresh,
            ),
            "SEC EDGAR": partial(sec_lookup, symbol, terms, self.cache, refresh),
        }
        evidence, coverage, candidates = [], [], {}
        checked = now()
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = {p: pool.submit(fn) for p, fn in tasks.items()}
            for provider, future in futures.items():
                status = {
                    "provider": provider,
                    "status": "Checked",
                    "count": 0,
                    "checked": checked,
                    "note": "",
                }
                coverage.append(status)
                try:
                    packet = future.result()
                    if provider == "SEC EDGAR":
                        records, notes = packet
                        evidence.extend(records)
                        status.update(count=len(records), note=" ".join(dict.fromkeys(notes)))
                        if not records and any(
                            "unavailable" in n.lower() or "publisher" in n.lower() for n in notes
                        ):
                            status["status"] = "Unavailable"
                        elif any(r.get("stale") for r in records):
                            status["status"] = "Cached"
                        continue
                    status.update(
                        checked=packet.get("fetched") or checked,
                        note=packet.get("error") or "",
                        status="Cached"
                        if packet["stale"]
                        else "Unavailable"
                        if packet["error"]
                        else "Checked",
                    )
                    for item in packet["data"] or []:
                        url = canonical(item.get("url"))
                        if not url or not item.get("date") or not item.get("text"):
                            continue
                        age = datetime.now(timezone.utc) - datetime.fromisoformat(item["date"])
                        if not -timedelta(minutes=5) <= age <= timedelta(days=120):
                            continue
                        candidates.setdefault(
                            url,
                            {
                                **item,
                                "url": url,
                                "checked": status["checked"],
                                "stale": packet["stale"],
                            },
                        )
                except Exception:
                    status.update(status="Unavailable", note="The source could not be read.")

        def priority(item):
            return (
                sum(t in item["text"].lower() for t in terms),
                mentions(item["text"], symbol, name),
                item["discovered_via"] == "GDELT news search",
                item["date"],
            )

        choices = sorted(candidates.values(), key=priority, reverse=True)[:5]

        def read(item):
            url = item["url"]
            digest = hashlib.sha256(url.encode()).hexdigest()
            doc = self.cache.get(
                "web/article/v1/" + digest, 21600, lambda: article_document(url), refresh
            )
            material = doc["data"] or {}
            paragraphs = material.get("paragraphs", [])
            words = [name, *terms] if terms else [name, *DEFAULT_WORDS]
            passage = best_passage(paragraphs, words)
            # An issuer list often includes adjacent companies. Require a named connection in the evidence.
            if not mentions(item["text"] + " " + passage, symbol, name):
                return None
            return {
                **item,
                "excerpt": passage or None,
                "source": article_publisher(url),
                "group": "web_news",
                "factor": "company_news",
                "date_kind": "published"
                if material.get("date") or item["date_origin"] != "GDELT first indexed"
                else "indexed",
                "date": material.get("date") or item["date"],
                "date_origin": "Publisher publication date"
                if material.get("date")
                else item["date_origin"],
                "scope": "Article passage" if passage else "Headline only",
                "checked": doc["fetched"] or item["checked"],
                "stale": item["stale"] or doc["stale"],
                "read_note": doc["error"] or "",
            }

        with ThreadPoolExecutor(max_workers=3) as pool:
            for result in pool.map(read, choices):
                if result:
                    evidence.append(result)
                    next(c for c in coverage if c["provider"] == result["discovered_via"])[
                        "count"
                    ] += 1
        for e in evidence:
            e.setdefault("date_kind", "published")
            e["id"] = hashlib.sha256(
                "|".join([e["group"], e["url"], e["date"], e.get("excerpt") or ""]).encode()
            ).hexdigest()[:14]
        return {
            "symbol": symbol,
            "query": " ".join([name, *terms]),
            "checked": checked,
            "coverage": coverage,
            "evidence": evidence,
        }
