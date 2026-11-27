"""Dated public policy sources used by the local market calendar."""

import calendar
import re
from datetime import date, timedelta
from urllib.parse import urlsplit
from xml.etree import ElementTree

from bs4 import BeautifulSoup

from .desk import fetch_url

FOMC = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
BUDGET = "https://www.govinfo.gov/link/uscode/2/631?link-type=html"
REGISTER = "https://www.federalregister.gov/api/v1/documents.json"
MONTH = {name[:3].lower(): i for i, name in enumerate(calendar.month_name) if i}
# Title/abstract, not the issuing department alone, must give a reason to match.
SECTORS = {
    "Technology": (
        "semiconductor|microelectronic|advanced computing|artificial intelligence|export controls?|electronic device|cybersecurity|broadband|spectrum licens",
        [
            "industry-and-security-bureau",
            "federal-communications-commission",
            "commerce-department",
        ],
    ),
    "Communication Services": (
        "broadband|telecommunicat|spectrum|wireless|broadcast|satellite",
        ["federal-communications-commission"],
    ),
    "Consumer Cyclical": (
        "motor vehicle|automobile|passenger car|fuel economy|retail|consumer product",
        [
            "national-highway-traffic-safety-administration",
            "consumer-product-safety-commission",
            "environmental-protection-agency",
        ],
    ),
    "Consumer Defensive": (
        "food|agricultur|beverage|consumer product|tobacco",
        [
            "food-and-drug-administration",
            "agriculture-department",
            "consumer-product-safety-commission",
        ],
    ),
    "Industrials": (
        "airworthiness|aviation|aircraft|railroad|freight|manufactur|industrial",
        [
            "federal-aviation-administration",
            "transportation-department",
            "environmental-protection-agency",
        ],
    ),
    "Financial Services": (
        "bank|securities|capital requirement|investment compan|broker.dealer|credit union|deposit insurance",
        [
            "securities-and-exchange-commission",
            "federal-reserve-system",
            "federal-deposit-insurance-corporation",
        ],
    ),
    "Healthcare": (
        "medicare|medicaid|prescription|medical device|medical equipment|nitrile glove|protective equipment|hospital|health insurance|clinical|pharmaceutical",
        ["centers-for-medicare-medicaid-services", "food-and-drug-administration"],
    ),
    "Energy": (
        "oil|petroleum|natural gas|pipeline|refiner|offshore drilling",
        [
            "energy-department",
            "federal-energy-regulatory-commission",
            "environmental-protection-agency",
        ],
    ),
    "Utilities": (
        "electric|power grid|transmission line|water system|utility|utilities",
        ["federal-energy-regulatory-commission", "environmental-protection-agency"],
    ),
    "Basic Materials": (
        "mineral|chemical|metal|steel|aluminum|lumber",
        ["environmental-protection-agency", "commerce-department"],
    ),
    "Real Estate": (
        "mortgage|housing|real estate|rental|building standard",
        ["housing-and-urban-development-department", "federal-housing-finance-agency"],
    ),
}
SENATE = "https://www.senate.gov/committees/hearings_meetings.htm"
SENATE_FEED = "https://www.senate.gov/general/committee_schedules/hearings.xml"
INDUSTRIES = (
    (
        r"semiconductor",
        r"semiconductor|microelectronic|advanced computing|integrated circuit|export controls?|advanced chips?",
    ),
    (
        r"auto manufactur|auto parts",
        r"motor vehicle|automobile|passenger car|fuel economy|vehicle safety|fuel.efficien|vehicle emissions|automotive",
    ),
    (
        r"consumer electronics",
        r"electronics|smartphone|mobile handsets?|connected devices?|electronic devices?|export controls?|consumer privacy",
    ),
    (
        r"drug manufactur|biotechnolog",
        r"pharmaceutical|medicine|prescription|drug approval|biotechnolog|medicare|clinical trials?",
    ),
)
BILL = re.compile(r"\b(?:H\.\s?R\.|[SH]\.\s?[Jj]\.?\s?[Rr]es\.|S\.)\s?\d+\b")
BROAD = ("securities-and-exchange-commission", "federal-reserve-system")


def fomc_events():
    soup = BeautifulSoup(fetch_url(FOMC).content, "html.parser")
    rows = []
    for panel in soup.select(".panel"):
        heading = panel.select_one(".panel-heading")
        year = (
            re.search(r"\b(20\d\d) FOMC Meetings", heading.get_text(" ", strip=True))
            if heading
            else None
        )
        if not year:
            continue
        for meeting in panel.select(".fomc-meeting"):
            month, day = (
                meeting.select_one(".fomc-meeting__month"),
                meeting.select_one(".fomc-meeting__date"),
            )
            if not month or not day:
                continue
            months = month.get_text(strip=True).lower().split("/")
            days = re.fullmatch(
                r"(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\*?", day.get_text(strip=True)
            )
            if not days or not all(m[:3] in MONTH for m in months):
                continue
            first = date(int(year[1]), MONTH[months[0][:3]], int(days[1]))
            last = date(
                first.year + int(MONTH[months[-1][:3]] < first.month),
                MONTH[months[-1][:3]],
                int(days[2] or days[1]),
            )
            rows.append(
                dict(
                    date=first.isoformat(),
                    end_date=last.isoformat(),
                    title="Federal Reserve policy meeting",
                    kind="macro",
                    status="scheduled",
                    url=FOMC,
                    excerpt=f"{year[1]} FOMC meetings · {month.get_text(strip=True)} {day.get_text(strip=True)}.",
                    relevance="Scheduled US monetary policy meeting. Interest-rate decisions can affect borrowing costs and valuations. The outcome is unknown.",
                )
            )
    if not rows:
        raise ValueError(
            "The Federal Reserve calendar did not list readable meeting dates."
        )
    return rows


def budget_table():
    soup = BeautifulSoup(fetch_url(BUDGET).content, "html.parser")
    table = next(
        (
            t
            for t in soup.select("table")
            if "Action to be completed" in t.get_text(" ", strip=True)
        ),
        None,
    )
    if table is None:
        raise ValueError("The current statutory budget timetable could not be read.")
    rows = []
    for tr in table.select("tr"):
        cells = [c.get_text(" ", strip=True) for c in tr.select("td")]
        if len(cells) != 2:
            continue
        when, action = cells
        if (
            when == "First Monday in February"
            or re.fullmatch(r"[A-Za-z]+ \d{1,2}", when)
            and when[:3].lower() in MONTH
        ):
            rows.append([when, action])
    if not rows:
        raise ValueError("No calendar dates appeared in the statutory timetable.")
    return rows


def budget_events(rows, start, end):
    out = []
    for year in range(start.year, end.year + 1):
        for when, action in rows:
            if when == "First Monday in February":
                first = date(year, 2, 1)
                d = first + timedelta(days=(-first.weekday()) % 7)
            else:
                month, day = when.split()
                d = date(year, MONTH[month[:3].lower()], int(day))
            if start <= d <= end:
                out.append(
                    dict(
                        date=d.isoformat(),
                        title="Budget timetable · " + action.rstrip("."),
                        kind="legislative",
                        status="scheduled",
                        url=BUDGET,
                        excerpt=f"On or before {when}: {action}",
                        relevance="2 U.S.C. § 631 sets this federal budget timetable. It is a statutory target, not confirmation of a vote, funding change or market reaction.",
                    )
                )
    return out


def register_rules(agencies, start, end, issuer=None):
    fields = [
        "document_number",
        "title",
        "type",
        "abstract",
        "dates",
        "effective_on",
        "html_url",
        "agencies",
    ]
    params = {
        "conditions[type][]": "RULE",
        "conditions[effective_date][gte]": start.isoformat(),
        "conditions[effective_date][lte]": end.isoformat(),
        "fields[]": fields,
        "order": "newest",
        "per_page": 100,
    }
    if agencies:
        params["conditions[agencies][]"] = list(agencies)
    if issuer:
        params["conditions[term]"] = '"' + issuer.strip(' ."') + '"'
    records = []
    for page in (1, 2):
        data = fetch_url(REGISTER, {**params, "page": page}).json()
        if not isinstance(data.get("results"), list):
            raise ValueError("The Federal Register could not confirm effective dates.")
        for raw in data["results"]:
            url = raw.get("html_url") or ""
            link = urlsplit(url)
            d = raw.get("effective_on") or ""
            dates = BeautifulSoup(raw.get("dates") or "", "html.parser").get_text(
                " ", strip=True
            )
            if (
                raw.get("type") != "Rule"
                or not raw.get("title")
                or not dates
                or not start.isoformat() <= d <= end.isoformat()
                or link.scheme != "https"
                or link.hostname != "www.federalregister.gov"
                or not link.path.startswith("/documents/")
            ):
                continue
            records.append(
                dict(
                    date=d,
                    title=raw["title"],
                    kind="regulatory",
                    status="effective",
                    url=url,
                    excerpt=dates[:700],
                    agencies=[a.get("slug") for a in raw.get("agencies", [])],
                    abstract=BeautifulSoup(
                        raw.get("abstract") or "", "html.parser"
                    ).get_text(" ", strip=True)[:1800],
                )
            )
        if page >= data.get("total_pages", 1):
            break
    return {"rows": records, "partial": data.get("total_pages", 1) > 2}


def topic_match(profile, body):
    sector = profile.get("sector")
    if sector not in SECTORS:
        return None
    industry = profile.get("industry") or ""
    for industry_name, topics in INDUSTRIES:
        if re.search(industry_name, industry, re.I):
            return re.search(topics, body, re.I)
    return re.search(SECTORS[sector][0], body, re.I)


def same_company(profile, text):
    # A bare product/common noun (e.g. apple) is not evidence a rule names its issuer.
    name = (profile.get("name") or "").strip(" ,.")
    return len(name) >= 4 and re.search(r"\b" + re.escape(name) + r"\b", text, re.I)


def rule_scope(rule, profiles):
    body = rule["title"] + " " + rule["abstract"]
    direct, sectors = [], {}
    for s, profile in profiles.items():
        if same_company(profile, body):
            direct.append(s)
        sector = profile.get("sector")
        if (
            sector in SECTORS
            and set(SECTORS[sector][1]).intersection(rule["agencies"])
            and topic_match(profile, body)
        ):
            sectors.setdefault(profile.get("industry") or sector, []).append(s)
    symbols = sorted(set(direct).union(*sectors.values()))
    notes = []
    if direct:
        notes.append(
            "The published rule names the company associated with "
            + ", ".join(direct)
            + "."
        )
    if sectors:
        notes.append(
            "The rule addresses "
            + ", ".join(sorted(sectors))
            + " sector activity. Applicability depends on each company's US operations and the rule's scope."
        )
    if (
        not notes
        and set(BROAD).intersection(rule["agencies"])
        and re.search(
            r"issuer disclosure|securities market|monetary policy|capital requirement|financial reporting",
            body,
            re.I,
        )
    ):
        notes.append(
            "US securities or monetary policy context for the selected investments."
        )
    return symbols, " ".join(notes)


def senate_agendas():
    root = ElementTree.fromstring(fetch_url(SENATE_FEED).content)
    if root.tag != "css_meetings_scheduled":
        raise ValueError("The Senate meeting schedule could not be read.")
    rows = []
    for meeting in root.findall("meeting"):
        kind = (meeting.findtext("type") or "").strip()
        matter = " ".join((meeting.findtext("matter") or "").split())
        committee = (meeting.findtext("committee") or "").strip()
        stamp = meeting.findtext("date_iso_8601") or ""
        if (
            not meeting.findtext("identifier")
            or not committee
            or not matter
            or not kind
            or not re.fullmatch(r"20\d\d-\d\d-\d\d", stamp)
            or re.search(
                r"cancel[le]+d|postponed indefinitely", kind + " " + matter, re.I
            )
        ):
            continue
        bills = list(BILL.finditer(matter))
        if bills:
            # Each bill carries only its own agenda description, unrelated nominations follow the bills.
            for i, bill in enumerate(bills):
                snippet = matter[
                    bill.start() : bills[i + 1].start()
                    if i + 1 < len(bills)
                    else len(matter)
                ]
                snippet = re.split(
                    r",? and (?:the )?nominations? of ", snippet, maxsplit=1, flags=re.I
                )[0].strip(", .")
                rows.append(
                    dict(
                        date=stamp,
                        title=bill[0] + " · Senate committee agenda",
                        text=snippet,
                        committee=committee,
                        meeting=kind,
                    )
                )
        elif "nomination" not in matter.lower():
            title = re.sub(
                r"^(?:Oversight )?hearings? to (?:examine|consider) ",
                "",
                matter,
                flags=re.I,
            ).rstrip(".")
            rows.append(
                dict(
                    date=stamp,
                    title="Senate hearing · " + title[:125],
                    text=matter,
                    committee=committee,
                    meeting=kind,
                )
            )
    return rows


def senate_event(agenda, profiles):
    body = agenda["text"]
    selected = []
    topics = []
    for s, profile in profiles.items():
        match = topic_match(profile, body)
        if same_company(profile, body) or match:
            selected.append(s)
            if match:
                topics.append(match[0].lower())
    if not selected and not re.search(
        r"debt limit|federal budget|monetary policy|securities markets?", body, re.I
    ):
        return None
    explanation = (
        "The agenda discusses " + ", ".join(dict.fromkeys(topics)) + ". "
        if topics
        else ""
    )
    return selected, dict(
        date=agenda["date"],
        title=agenda["title"],
        kind="legislative",
        status="scheduled",
        url=SENATE,
        excerpt=(agenda["committee"] + " · " + agenda["meeting"] + ". " + body)[:750],
        relevance=explanation
        + "The Senate published this committee agenda. It schedules consideration only and does not establish passage, a floor vote or enactment.",
    )
