"""Local position statements. Raw files, account numbers and bank credentials are never stored."""

import csv
import hashlib
import hmac
import io
import json
import re
import secrets
from datetime import date
from decimal import Decimal, InvalidOperation
from uuid import uuid4

from bs4 import BeautifulSoup
from fastapi import HTTPException
from pydantic import Field

from .schema import Model
from .store import now


class Position(Model):
    symbol: str = Field(default="", max_length=60)
    description: str = Field(default="", max_length=300)
    quantity: float | None = None
    price: float | None = None
    value: float | None = None
    basis: float | None = None
    currency: str = Field(default="USD", pattern="^[A-Z]{3}$")
    as_of: date | None = None

    def checked(self):
        if not (self.symbol or self.description):
            raise ValueError("Enter a symbol or an investment description.")
        if self.value is None and self.price is not None and self.quantity is not None:
            self.value = round(self.price * self.quantity, 6)
        if self.value is None and self.quantity is None:
            raise ValueError("Supply a quantity or a statement value.")
        return self


class Statement(Model):
    institution: str = Field(min_length=1, max_length=80)
    account: str = Field(default="", max_length=80)
    as_of: date | None = None
    currency: str = Field(default="USD", pattern="^[A-Z]{3}$")
    content: str = Field(min_length=1, max_length=8_000_000)
    revisions: dict[str, str] = Field(default_factory=dict, max_length=1000)
    mapping: dict[str, str] = Field(default_factory=dict, max_length=12)


class AccountInput(Model):
    institution: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=100)


ALIASES = {
    "symbol": [
        "symbol",
        "ticker",
        "ticker symbol",
        "investment symbol",
        "security symbol",
        "cusip",
    ],
    "description": [
        "description",
        "security description",
        "investment name",
        "security name",
        "name",
    ],
    "quantity": [
        "quantity",
        "shares",
        "units",
        "qty",
        "share balance",
        "shares/units",
        "qty (quantity)",
        "quantity (shares)",
    ],
    "price": [
        "last price",
        "price",
        "share price",
        "unit price",
        "market price",
        "price per share",
        "price (market price)",
    ],
    "value": [
        "current value",
        "market value",
        "position value",
        "value",
        "market value (usd)",
        "market value (local)",
        "mkt val (market value)",
        "total value",
        "balance",
    ],
    "basis": [
        "cost basis total",
        "total cost basis",
        "cost basis",
        "total cost",
        "book value",
        "cost basis (total)",
    ],
    "currency": ["currency", "currency code", "local currency"],
    "account_number": [
        "account number",
        "account #",
        "account id",
        "account no.",
        "account",
    ],
    "account_name": ["account name", "account description", "account nickname"],
    "as_of": [
        "as of",
        "as of date",
        "price as of date",
        "valuation date",
        "statement date",
    ],
}


def amount(value):
    if value is None:
        return None
    raw = str(value).strip()
    if raw.casefold() in {"", "--", "—", "n/a", "na", "not available", "unknown"}:
        return None
    raw = raw.replace(",", "").replace("$", "").replace("€", "").replace("£", "").replace(" ", "")
    if raw.startswith("(") and raw.endswith(")"):
        raw = "-" + raw[1:-1]
    try:
        v = Decimal(raw)
        if not v.is_finite() or abs(v) > Decimal("1e20"):
            raise ValueError()
        return float(v)
    except (InvalidOperation, ValueError):
        raise ValueError("Invalid numeric value in the statement.") from None


def stamp(raw):
    if not raw:
        return None
    from datetime import datetime

    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y%m%d"):
        try:
            return datetime.strptime(raw.strip(), fmt).date()
        except ValueError:
            pass
    raise ValueError("Use a recognized date, such as YYYY-MM-DD.")


def normalized(raw):
    return " ".join(raw.strip().casefold().split())


def csv_positions(stmt):
    reader = csv.reader(io.StringIO(stmt.content.lstrip("\ufeff")), strict=True)
    headers = []
    for row in reader:
        names = [normalized(x) for x in row]
        if len(names) > 1 and (
            set(names) & set(ALIASES["symbol"] + ALIASES["description"] + ALIASES["value"])
            or any(normalized(x) in names for x in stmt.mapping.values())
        ):
            headers = [x.strip() for x in row]
            break
    if not headers:
        raise ValueError(
            "Could not find the positions header. Map the columns from your broker's CSV."
        )
    names = [normalized(x) for x in headers]
    mapped = {}
    for key, aliases in ALIASES.items():
        options = [normalized(stmt.mapping[key])] if stmt.mapping.get(key) else aliases
        found = next((v for v in options if v in names), None)
        if found is not None:
            if names.count(found) > 1:
                raise ValueError(
                    f"Duplicate column {found}. Rename duplicate headers before importing."
                )
            mapped[key] = names.index(found)
        elif stmt.mapping.get(key):
            raise ValueError(f"The mapped column for {key} is missing.")
    if not ({"symbol", "description"} & mapped.keys()) or not (
        {"value", "quantity"} & mapped.keys()
    ):
        raise ValueError("Map a symbol or description plus a quantity or market value.")
    records = []
    for row in reader:
        if not any(x.strip() for x in row):
            continue
        first = next((x.strip().casefold() for x in row if x.strip()), "")
        if len([x for x in row if x.strip()]) == 1 and first.startswith(
            (
                "this information",
                "the data",
                "date downloaded",
                "data downloaded",
                "as of ",
                "disclaimer",
                "securities ",
                "for informational",
            )
        ):
            continue
        if len(row) > len(headers) and any(x.strip() for x in row[len(headers) :]):
            raise ValueError(f"Row {reader.line_num} has too many columns. Check quoting.")
        fields = {k: row[col].strip() if col < len(row) else "" for k, col in mapped.items()}
        sym = fields.get("symbol", "").rstrip("*").strip()
        desc = fields.get("description", "")
        if sym.casefold() in {"account total", "total", "grand total"} or (
            not sym and desc.casefold() in {"total", "account total", "grand total"}
        ):
            continue
        try:
            pos = Position(
                symbol=sym,
                description=desc,
                currency=(fields.get("currency") or stmt.currency).upper(),
                as_of=stamp(fields.get("as_of")) or stmt.as_of,
                **{k: amount(fields.get(k)) for k in ("quantity", "price", "value", "basis")},
            ).checked()
        except (ValueError, TypeError) as exc:
            raise ValueError(
                f"Row {reader.line_num} could not be imported. {str(exc).split(chr(10))[0]}"
            ) from None
        records.append(
            (
                fields.get("account_number", ""),
                fields.get("account_name") or stmt.account,
                pos,
            )
        )
        if len(records) > 25000:
            raise ValueError("Import at most 25,000 positions at a time.")
    return records


def ofx_positions(stmt):
    # OFX 1.x permits implicit leaf closing tags; OFX 2.x uses explicit XML tags.
    soup = BeautifulSoup(stmt.content[stmt.content.lower().index("<ofx") :], "html.parser")

    def val(node, tag):
        el = node.find(tag) if node is not None else None
        return (
            str(next((t for t in el.children if isinstance(t, str) and t.strip()), "")).strip()
            if el
            else ""
        )

    securities = {
        val(sec, "uniqueid"): (val(sec, "ticker"), val(sec, "secname"))
        for sec in soup.find_all("secinfo")
    }
    out = []
    for statement in soup.find_all(["invstmtrs", "stmtrs", "ccstmtrs"]):
        acct = val(statement, "acctid")
        currency = (val(statement, "curdef") or stmt.currency).upper()
        for row in statement.find_all("invpos"):
            uid = val(row, "uniqueid")
            symbol, name = securities.get(uid, ("", uid))
            dt = val(row, "dtpriceasof") or val(statement, "dtasof")
            pos = Position(
                symbol=symbol,
                description=name or uid,
                quantity=amount(val(row, "units")),
                price=amount(val(row, "unitprice")),
                value=amount(val(row, "mktval")),
                currency=(val(row, "cursym") or currency).upper(),
                as_of=stamp(dt[:8]) if dt else stmt.as_of,
            ).checked()
            out.append((acct, stmt.account, pos))
        if statement.name in {"stmtrs", "ccstmtrs"}:
            bal = statement.find("ledgerbal")
            v = amount(val(bal, "balamt"))
            dt = val(bal, "dtasof")
            if v is not None:
                out.append(
                    (
                        acct,
                        stmt.account,
                        Position(
                            description="Statement balance",
                            value=v,
                            currency=currency,
                            as_of=stamp(dt[:8]) if dt else stmt.as_of,
                        ),
                    )
                )
        else:
            cash = amount(val(statement.find("invbal"), "availcash"))
            dt = val(statement, "dtasof")
            if cash is not None:
                out.append(
                    (
                        acct,
                        stmt.account,
                        Position(
                            description="Available cash",
                            value=cash,
                            currency=currency,
                            as_of=stamp(dt[:8]) if dt else stmt.as_of,
                        ),
                    )
                )
    return out


class Holdings:
    def __init__(self, db):
        self.db = db
        with db.connect() as c:
            c.executescript("""
                create table if not exists account_salt(id integer primary key, key blob not null);
                create table if not exists accounts(id text primary key,institution text not null,name text not null,updated text not null);
                create table if not exists positions(id text primary key,account text references accounts(id) on delete cascade,payload text not null);
                create index if not exists by_account on positions(account);
            """)
            c.execute(
                "insert or ignore into account_salt values(1,?)",
                (secrets.token_bytes(32),),
            )
            self.salt = c.execute("select key from account_salt where id=1").fetchone()[0]

    def identity(self, institution, ref):
        return hmac.new(
            self.salt,
            (normalized(institution) + "\0" + normalized(ref)).encode(),
            hashlib.sha256,
        ).hexdigest()[:32]

    def parse(self, stmt):
        try:
            rows = (
                ofx_positions(stmt)
                if "<ofx" in stmt.content[:5000].lower()
                else csv_positions(stmt)
            )
        except csv.Error:
            raise ValueError("Invalid CSV quoting or field length.") from None
        if not rows:
            raise ValueError("No current positions or bank balances were found in the statement.")
        groups = {}
        for ref, name, pos in rows:
            if not ref and not name:
                raise ValueError("Enter an account nickname for this file.")
            key = self.identity(stmt.institution, ref or name)
            label = name if name and name != ref else "Account"
            if ref:
                label = label.replace(ref, "Account") if ref in label else label
                label += " ··" + ref[-4:]
            group = groups.setdefault(
                key,
                {
                    "id": key,
                    "institution": stmt.institution,
                    "name": label,
                    "positions": [],
                },
            )
            group["positions"].append(pos.model_dump(mode="json"))
        return list(groups.values())

    def import_statement(self, stmt, apply=False):
        groups = self.parse(stmt)
        with self.db.connect() as c:
            if apply:
                c.execute("begin immediate")
            for g in groups:
                existing = c.execute(
                    "select id,payload from positions where account=? order by rowid",
                    (g["id"],),
                ).fetchall()
                existing_name = c.execute(
                    "select name from accounts where id=?", (g["id"],)
                ).fetchone()
                signature = json.dumps(
                    [
                        g["id"],
                        g["positions"],
                        [tuple(r) for r in existing],
                        existing_name[0] if existing_name else None,
                    ],
                    sort_keys=True,
                ).encode()
                revision = hmac.new(self.salt, signature, hashlib.sha256).hexdigest()
                g["replaces"] = len(existing)
                g["revision"] = revision
                if apply:
                    if (
                        existing_name
                        and existing_name[0] == g["name"]
                        and [json.loads(r["payload"]) for r in existing] == g["positions"]
                    ):
                        continue
                    if not hmac.compare_digest(revision, stmt.revisions.get(g["id"], "")):
                        raise HTTPException(
                            409,
                            "The statement or account changed after preview. Preview it again to review the current replacement.",
                        )
                    c.execute(
                        "insert into accounts values(?,?,?,?) on conflict(id) do update set name=excluded.name,updated=excluded.updated",
                        (g["id"], g["institution"], g["name"], now()),
                    )
                    c.execute("delete from positions where account=?", (g["id"],))
                    c.executemany(
                        "insert into positions values(?,?,?)",
                        [
                            (uuid4().hex, g["id"], json.dumps(p, allow_nan=False))
                            for p in g["positions"]
                        ],
                    )
        return groups

    def all(self):
        with self.db.connect() as c:
            accounts = {
                a["id"]: {**dict(a), "positions": []}
                for a in c.execute("select * from accounts order by institution,name")
            }
            for r in c.execute("select * from positions order by rowid"):
                accounts[r["account"]]["positions"].append(
                    {"id": r["id"], **json.loads(r["payload"])}
                )
        return list(accounts.values())

    def create(self, a):
        key = self.identity(a.institution, a.name)
        with self.db.connect() as c:
            c.execute(
                "insert or ignore into accounts values(?,?,?,?)",
                (key, a.institution, a.name, now()),
            )
        return {"id": key}

    def position(self, account, pos, key=None):
        payload = pos.checked().model_dump_json()
        with self.db.connect() as c:
            if not c.execute("select 1 from accounts where id=?", (account,)).fetchone():
                raise KeyError("Account not found.")
            if key:
                if not c.execute(
                    "update positions set payload=? where id=? and account=?",
                    (payload, key, account),
                ).rowcount:
                    raise KeyError("Position not found.")
            else:
                key = uuid4().hex
                c.execute("insert into positions values(?,?,?)", (key, account, payload))
            c.execute("update accounts set updated=? where id=?", (now(), account))
        return {"id": key}

    def remove(self, account, key=None):
        with self.db.connect() as c:
            row = (
                c.execute("delete from positions where account=? and id=?", (account, key))
                if key
                else c.execute("delete from accounts where id=?", (account,))
            )
            if not row.rowcount:
                raise KeyError("Account or position not found.")
        return {"deleted": key or account}
