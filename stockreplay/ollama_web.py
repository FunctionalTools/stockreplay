"""Ollama's hosted web_search and web_fetch. Only the two fixed APIs receive the credential."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
import hashlib
import re
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup
from fastapi import HTTPException

from .source_reader import article_document, article_publisher, best_passage, normalize, published
from .store import now

PROVIDER = "Ollama Web Search"
SCOPES = {"headline": "Headline only", "snippet": "Search excerpt", "page": "Article passage"}
EXTRA_READERS = {
    "www.sec.gov": r"/(?:Archives/edgar/data/\d+/\d{18}/[\w.-]+\.html?|newsroom/press-releases/[\w-]+)",
    "www.federalreserve.gov": r"/newsevents/pressreleases/[\w-]+\.htm",
    "www.apple.com": r"/newsroom/\d{4}/\d{2}/[\w-]+/?",
    "news.microsoft.com": r"/(?:source/)?[\w/-]+/?",
    "blogs.microsoft.com": r"/blog/\d{4}/\d{2}/\d{2}/[\w-]+/?",
    "nvidianews.nvidia.com": r"/news/[\w-]+/?",
    "investor.nvidia.com": r"/news/press-release-details/\d{4}/[\w/-]+/?",
}
PRIVATE_PARAM = re.compile(
    r"(?:token|password|secret|signature|api[_-]?key|credential|authorization|session)", re.I
)


def source_url(value):
    """Public citation URL. Only a narrower set of known article paths is eligible for fetching."""
    if (
        not isinstance(value, str)
        or len(value) > 1800
        or re.search(r"[\\\x00-\x20]", unquote(value))
    ):
        return None
    try:
        p = urlsplit(value)
        host = p.hostname
        if (
            p.scheme != "https"
            or not host
            or p.username is not None
            or p.password is not None
            or p.port not in (443, None)
            or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", host)
            or host.rsplit(".", 1)[-1]
            in {"internal", "localhost", "local", "invalid", "test", "onion", "lan", "arpa"}
            or PRIVATE_PARAM.search(p.path)
            and re.search(r"[=;]", p.path)
        ):
            return None
        params = parse_qsl(p.query, keep_blank_values=True, max_num_fields=32)
        if any(PRIVATE_PARAM.search(k) for k, _ in params):
            return None
        query = urlencode(
            [
                (k, v)
                for k, v in params
                if not k.lower().startswith("utm_")
                and k.lower() not in {"gclid", "fbclid", "mc_cid", "mc_eid"}
            ]
        )
        return urlunsplit(("https", host, p.path or "/", query, ""))
    except (TypeError, ValueError, UnicodeError):
        return None


def fetchable(url):
    p = urlsplit(url)
    return not p.query and bool(
        article_publisher(url) or re.fullmatch(EXTRA_READERS.get(p.hostname, r"(?!)"), p.path, re.I)
    )


def plaintext(value, limit):
    if not isinstance(value, str):
        return ""
    value = value[:limit]
    if re.search(r"<(?:p|div|span|section|a|br|script)\b", value, re.I):
        soup = BeautifulSoup(value, "html.parser")
        for tag in soup(["script", "style", "nav"]):
            tag.decompose()
        value = soup.get_text("\n", strip=True)
    return re.sub(r"\[([^\]\n]{1,160})\]\(https?://[^)\n]{1,1800}\)", r"\1", value).strip()


def publication_stamp(body):
    # Search and fetch responses carry no publication timestamp. Accept an explicit publisher label only.
    match = re.search(
        r"(?im)^\s*(?:\*{1,2})?(?:date published|publication date|published)(?:\s+(?:on|at))?(?:\*{1,2})?[ \t]*[:|]?[ \t]*(?:\*{1,2})?(\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\b",
        body[:3500],
    )
    if not match:
        return None
    value = match[1]
    for fmt in ("%Y-%m-%d", "%B %d, %Y", "%b %d, %Y"):
        try:
            return published(datetime.strptime(value, fmt).date().isoformat())
        except ValueError:
            continue
    return None


@dataclass(repr=False)
class SearchAccess:
    """Credentials stay inside the provider callbacks, outside the public cache and result packets."""

    mode: str
    revision: object
    search: Callable | None
    fetch: Callable | None = None
    contains_secret: Callable = lambda text: False


def search_access(providers):
    selected = providers.active()
    mode = getattr(selected, "provider", None)
    if mode == "ollama_cloud":
        try:
            secret, _ = selected.credentials()
        except HTTPException:
            return SearchAccess(mode, None, None)
        return SearchAccess(
            mode,
            getattr(selected, "revision", 0),
            lambda query, limit: selected.request(
                secret, "POST", "web_search", {"query": query, "max_results": limit}
            ),
            lambda url: selected.request(secret, "POST", "web_fetch", {"url": url}),
            lambda text: bool(secret and secret in text),
        )
    if mode == "ollama":
        service = getattr(providers, "ollama_search", None)
        if service:
            status = service.status()
            if status.get("configured"):
                return SearchAccess(
                    "local_with_search",
                    getattr(service, "revision", status.get("verified_at")),
                    lambda query, limit: service.search(query, max_results=limit),
                    contains_secret=service.contains_secret,
                )
    return None


def post(call, *args):
    try:
        result = call(*args)
    except HTTPException as exc:
        detail = {
            401: "Ollama rejected the search credential. Check the key in Settings.",
            403: "This Ollama account does not have permission for this search operation.",
            429: "The Ollama account has reached its search limit. Try again later.",
            503: "Ollama's search service is temporarily busy.",
        }.get(exc.status_code, "Ollama's search service is unavailable.")
        raise ValueError(detail) from None
    if not isinstance(result, dict):
        raise ValueError("Ollama returned an unreadable search response.")
    return result


def search_results(access, symbol, name, terms, matches):
    if not access.search:
        raise ValueError(
            "Connect an Ollama API key in Settings or unlock its saved Keychain entry."
        )
    query = f"{name} ({symbol}) " + (
        " ".join(terms) if terms else "latest company news earnings guidance risks estimates"
    )
    response = post(access.search, query, 5)
    rows = response.get("results")
    if not isinstance(rows, list):
        raise ValueError("Ollama did not return a list of search results.")
    kept = {}
    for row in rows[:5]:
        if not isinstance(row, dict):
            continue
        url = source_url(row.get("url"))
        title = normalize(plaintext(row.get("title"), 420))
        raw = plaintext(row.get("content"), 7000)
        snippet = best_passage(raw.splitlines(), [name, *terms]) or normalize(raw)[:760]
        if (
            not url
            or not title
            or access.contains_secret("\n".join((unquote(url), title, raw)))
            or not matches(title + " " + snippet, symbol, name)
        ):
            continue
        kept.setdefault(
            url,
            {
                "text": title,
                "url": url,
                "excerpt": snippet,
                "source": article_publisher(url) or urlsplit(url).hostname,
            },
        )
    return list(kept.values())


def fetch_material(access, url):
    # Only URLs selected from this API's search results, and recognized original publishers, reach here.
    if not access.fetch or not fetchable(url):
        raise ValueError("This result is available as a search excerpt.")
    record = post(access.fetch, url)
    body = plaintext(record.get("content"), 65_536)
    if not body or access.contains_secret(body):
        raise ValueError("No readable public text was returned.")
    paragraphs = [s.strip()[:8000] for s in body.splitlines() if len(s.strip()) >= 65][:100]
    if not best_passage(paragraphs, ()):
        raise ValueError("The publisher did not expose a readable article passage.")
    return {"paragraphs": paragraphs, "published": publication_stamp(body)}


def hosted_sources(cache, access, symbol, name, terms, matches, refresh=False):
    """Query the account's hosted search and preserve dated, attributed, last-known public observations."""
    digest = hashlib.sha256("\x1f".join((symbol, name, *terms)).encode()).hexdigest()
    key = "web/ollama/v1/" + digest
    # If a key has been removed, do not re-use a response as evidence of a working connection.
    packet = cache.get(
        key,
        900,
        lambda: search_results(access, symbol, name, terms, matches),
        refresh or not access.search,
    )
    errors = [packet["error"]] if packet["error"] else []
    evidence = []
    remaining_fetches = 1
    for row in packet["data"] or []:
        item = {
            **row,
            "scope": SCOPES["snippet"] if row["excerpt"] else SCOPES["headline"],
            "checked": packet["fetched"],
            "date": packet["fetched"],
            "date_kind": "retrieved",
            "date_origin": "Search checked; publication date unavailable",
            "group": "ollama_web_news",
            "factor": "company_news",
            "stale": packet["stale"],
            "discovered_via": PROVIDER,
        }
        url = row["url"]
        public_reader = access.mode == "local_with_search" and article_publisher(url)
        if fetchable(url) and (access.fetch or public_reader):
            prefix = "web/article/v1/" if public_reader else "web/ollama/page/"
            page_key = prefix + hashlib.sha256(url.encode()).hexdigest()
            page = cache.read(page_key)
            if remaining_fetches and not packet["error"]:
                remaining_fetches -= 1
                # Local mode contacts recognized original publishers directly, without the website key.
                reader = (
                    (lambda: article_document(url))
                    if public_reader
                    else (lambda: fetch_material(access, url))
                )
                page = cache.get(page_key, 21600, reader, refresh)
            if page and page["error"]:
                errors.append(page["error"])
            doc = (page or {}).get("data") or {}
            passage = best_passage(doc.get("paragraphs", []), [name, *terms])
            if passage and matches(row["text"] + " " + passage, symbol, name):
                stamp = doc.get("published") or doc.get("date")
                filing = url.startswith("https://www.sec.gov/Archives/edgar/data/")
                item.update(
                    scope="Filing passage" if filing else SCOPES["page"],
                    group="company_filings" if filing else item["group"],
                    factor="filings" if filing else item["factor"],
                    excerpt=passage,
                    checked=page["fetched"],
                    date=stamp or page["fetched"],
                    date_kind="published" if stamp else "retrieved",
                    date_origin="Publisher publication date"
                    if stamp
                    else "Page checked; publication date unavailable",
                    stale=bool(page["stale"] or packet["stale"]),
                    discovered_via=PROVIDER,
                )
        evidence.append(item)
    return evidence, {
        "provider": PROVIDER,
        "status": "Cached" if packet["stale"] else "Unavailable" if packet["error"] else "Checked",
        "count": len(evidence),
        "checked": packet["fetched"] or now(),
        "note": " ".join(dict.fromkeys(errors)),
    }
