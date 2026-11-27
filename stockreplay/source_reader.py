"""Bounded reads of identified public publisher and regulator documents. No URL-input route."""

from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from ipaddress import ip_address
import re
import socket
from threading import Lock
from time import monotonic, sleep
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup
import httpx

CONTACT = "StockReplay/1.0 (+https://github.com/FunctionalTools/stockreplay/issues)"
PUBLISHERS = {
    "stockanalysis.com": ("Stock Analysis", r"/news/[\w-]+/?"),
    "www.tipranks.com": ("TipRanks", r"/news/(?:article/)?[\w-]+/?"),
    "www.reuters.com": (
        "Reuters",
        r"/(?:business|technology|markets|world|sustainability|legal)/[\w/-]+/?",
    ),
    "apnews.com": ("Associated Press", r"/article/[\w-]+/?"),
    "www.cnbc.com": ("CNBC", r"/\d{4}/\d{2}/\d{2}/[\w-]+\.html"),
    "www.theguardian.com": ("The Guardian", r"/[\w-]+/\d{4}/[a-z]{3}/\d{1,2}/[\w-]+"),
    "www.investopedia.com": ("Investopedia", r"/[\w-]+-\d+/?"),
    "www.bbc.com": ("BBC", r"/(?:news|business)/articles/[\w-]+"),
    "www.etftrends.com": ("ETF Trends", r"/[\w-]+/[\w-]+/?"),
    "techcrunch.com": ("TechCrunch", r"/\d{4}/\d{2}/\d{2}/[\w-]+/?"),
    "nypost.com": ("New York Post", r"/\d{4}/\d{2}/\d{2}/[\w-]+/[\w-]+/?"),
    "finance.yahoo.com": ("Yahoo Finance", r"/(?:news|markets/[\w/-]+/articles)/[\w-]+\.html"),
    "www.marketwatch.com": ("MarketWatch", r"/story/[\w-]+/?"),
    "www.businesswire.com": ("Business Wire", r"/news/home/\d+/en/[\w%-]+/?"),
    "www.globenewswire.com": ("GlobeNewswire", r"/news-release/[\w/.-]+/[\w%-]+\.html"),
    "www.prnewswire.com": ("PR Newswire", r"/news-releases/[\w-]+\.html"),
}
DATA_PATHS = {
    "www.sec.gov": r"/(?:files/company_tickers\.json|Archives/edgar/data/\d{1,10}/\d{18}/[\w.-]+\.html?)",
    "data.sec.gov": r"/(?:submissions/CIK\d{10}\.json|api/xbrl/companyconcept/CIK\d{10}/us-gaap/Assets\.json)",
    "efts.sec.gov": r"/LATEST/search-index",
    "api.gdeltproject.org": r"/api/v2/doc/doc",
    "stockanalysis.com": r"/(?:stocks|etf)/[a-z0-9.-]+/",
}
SEC_LOCK = Lock()
_sec_last = 0.0


def location(url):
    try:
        p = urlsplit(url)
        path = unquote(p.path)
        if (
            p.scheme != "https"
            or p.username is not None
            or p.password is not None
            or p.port not in (None, 443)
            or not p.hostname
            or len(url) > 1800
            or p.fragment
            or re.search(r"[\\\x00-\x20]", url)
            or ".." in path.split("/")
            or "\\" in path
            or "%" in path
        ):
            return "", ""
        return p.hostname, path
    except (AttributeError, TypeError, ValueError):
        return "", ""


def article_publisher(url):
    host, path = location(url)
    if host in PUBLISHERS and re.fullmatch(PUBLISHERS[host][1], path, re.I):
        return PUBLISHERS[host][0]
    return None


def read_public(url, *, limit=1_500_000, timeout=7, accept="text/html"):
    host, path = location(url)
    if not (
        article_publisher(url) or host in DATA_PATHS and re.fullmatch(DATA_PATHS[host], path, re.I)
    ):
        raise ValueError("This URL is outside the supported public sources.")
    if any(
        not ip_address(a[4][0]).is_global
        for a in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    ):
        raise ValueError("The public source did not resolve to a public address.")
    if host.endswith(".sec.gov"):
        global _sec_last
        with SEC_LOCK:
            sleep(max(0, 0.25 - (monotonic() - _sec_last)))
            _sec_last = monotonic()
    headers = {"User-Agent": CONTACT, "Accept": accept}
    with httpx.Client(
        timeout=httpx.Timeout(timeout, connect=min(timeout, 4)),
        headers=headers,
        follow_redirects=False,
    ) as client:
        deadline = monotonic() + timeout
        with client.stream("GET", url) as res:
            res.raise_for_status()
            content_type = res.headers.get("content-type", "").partition(";")[0].strip().lower()
            allowed = (
                {"text/html", "application/xhtml+xml"}
                if accept == "text/html"
                else {"application/json", "text/json", "text/plain"}
            )
            length = res.headers.get("content-length", "")
            if content_type not in allowed or length.isdecimal() and int(length) > limit:
                raise ValueError("The publisher returned an unsupported document.")
            body = bytearray()
            for chunk in res.iter_bytes(chunk_size=32768):
                if len(body) + len(chunk) > limit or monotonic() > deadline:
                    raise ValueError("The public document exceeded the reading limit.")
                body.extend(chunk)
            return bytes(body)


def published(value):
    """Normalize dates from a publisher or index; never substitute today's date."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            if value.endswith((" EST", " EDT")):
                dt = datetime.strptime(value[:-4], "%b %d, %Y, %I:%M %p").replace(
                    tzinfo=ZoneInfo("America/New_York")
                )
            else:
                dt = parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.isoformat() if dt <= datetime.now(timezone.utc) + timedelta(minutes=5) else None


def normalize(text):
    return " ".join(str(text or "").split())


def best_passage(paragraphs, words):
    def topic_weight(text):
        return sum(
            (1 if w in {"risk", "investment"} else 3)
            for w in words
            if re.search(r"\b" + re.escape(w) + r"\w*\b", text, re.I)
        )

    candidates = []
    for i, paragraph in enumerate(paragraphs):
        paragraph = normalize(paragraph)
        if not 75 <= len(paragraph) <= 9000 or re.search(
            r"actual results.{0,30}may differ|enable javascript|sign up (?:for|to)|subscribe (?:now|to)|terms of use|cookie policy|table of contents|forward-looking statements",
            paragraph,
            re.I,
        ):
            continue

        context_weight = topic_weight(paragraph)
        sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z“\"0-9])", paragraph)
        for start in range(len(sentences)):
            block = sentences[start]
            if len(block) < 135 and start + 1 < len(sentences):
                block += " " + sentences[start + 1]
            if len(block) < 65:
                continue
            candidates.append(
                (
                    topic_weight(block),
                    context_weight,
                    bool(
                        re.search(
                            r"\b(?:increase|decrease|adverse|decline|invest|grew|contract|outage|forecast|margin|sold|spending)\w*\b",
                            block,
                            re.I,
                        )
                    ),
                    -i,
                    -start,
                    block,
                )
            )
    if not candidates:
        return ""
    selected = max(candidates)[-1]
    return selected if len(selected) <= 760 else selected[:757].rsplit(" ", 1)[0] + "…"


def article_document(url):
    soup = BeautifulSoup(read_public(url, limit=2_500_000), "html.parser")
    for unwanted in soup.select("aside, nav, footer, figure, script, style, [hidden]"):
        unwanted.decompose()
    nodes = soup.select(
        '[itemprop="articleBody"] p, .ArticleBody-articleBody p, .article-body p, .article__body p, .prose p, article p'
    )
    paragraphs = list(dict.fromkeys(normalize(n.get_text(" ", strip=True)) for n in nodes))[:100]
    if not best_passage(paragraphs, ()):
        raise ValueError("The publisher did not expose a readable article passage.")
    date = soup.select_one(
        'meta[property="article:published_time"],meta[itemprop="datePublished"],time[itemprop="datePublished"]'
    )
    return {
        "paragraphs": paragraphs,
        "date": published(date.get("content") or date.get("datetime")) if date else None,
    }


class FilingParagraphs(HTMLParser):
    """SEC inline XBRL often puts narrative paragraphs in div/span; omit tables and hidden facts."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = []
        self.parts = []
        self.paragraphs = []

    def flush(self):
        text = normalize("".join(self.parts))
        if 75 <= len(text) <= 9000:
            self.paragraphs.append(text)
        self.parts.clear()

    def handle_starttag(self, tag, attrs):
        if tag in {"table", "script", "style", "head", "ix:hidden", "ix:header"}:
            self.skip.append(tag)
        if not self.skip and tag in {"div", "p", "br", "li"}:
            self.flush()

    def handle_endtag(self, tag):
        if self.skip and self.skip[-1] == tag:
            self.skip.pop()
        if not self.skip and tag in {"div", "p", "li"}:
            self.flush()

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def filing_document(url):
    parser = FilingParagraphs()
    parser.feed(read_public(url, limit=9_000_000, timeout=12).decode("utf-8", errors="replace"))
    parser.close()
    parser.flush()
    if not parser.paragraphs:
        raise ValueError("No filing narrative could be read.")
    return parser.paragraphs
