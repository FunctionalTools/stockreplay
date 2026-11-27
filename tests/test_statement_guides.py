from pathlib import Path

import pytest

from stockreplay.holdings import Holdings, Statement
from stockreplay.store import Store


@pytest.mark.parametrize(
    "header",
    [
        "Account ID,Alias,Symbol,Quantity,Mark Price,Position Value,Cost Basis Money,Currency,Report Date",
        "ClientAccountID,AccountAlias,Symbol,Quantity,MarkPrice,PositionValue,CostBasisMoney,CurrencyPrimary,ReportDate",
    ],
)
def test_ibkr_guide_fields_and_cross_account_grouping(tmp_path, header):
    holdings = Holdings(Store(tmp_path))
    statement = Statement(
        institution="Interactive Brokers",
        content=header + "\nU87654321,Retirement,ABC,2,15,30,25,EUR,20261125"
        "\nU87654322,Savings,ABC,1,15,15,12,EUR,20261125",
    )
    first, second = holdings.import_statement(statement)
    position = first["positions"][0]
    assert (position["quantity"], position["price"], position["value"], position["basis"]) == (
        2,
        15,
        30,
        25,
    )
    assert (position["currency"], position["as_of"]) == ("EUR", "2026-11-25")
    assert (first["name"], second["name"]) == ("Retirement ··4321", "Savings ··4322")
    assert holdings.all() == []


@pytest.mark.parametrize(
    "content",
    [
        "Date,Description,Debits,Credits,Balance\n2026-11-24,Transfer,100,,2000",
        "Posting Date,Description,Amount,Running Balance\n2026-11-24,Deposit,500,2000",
        "Run Date,Action,Symbol,Description,Quantity,Price,Amount ($)\n2026-11-24,Bought,ABC,Stock,10,20,200",
    ],
)
def test_transaction_exports_cannot_be_counted_as_positions(tmp_path, content):
    holdings = Holdings(Store(tmp_path))
    with pytest.raises(ValueError, match="transaction activity"):
        holdings.import_statement(
            Statement(institution="My Bank", account="Checking", content=content)
        )
    assert holdings.all() == []


def test_local_balance_template_handles_each_account_and_its_currency(tmp_path):
    holdings = Holdings(Store(tmp_path))
    template = (
        Path(__file__).resolve().parents[1]
        / "frontend/public/stockreplay-bank-balances-template.csv"
    )
    statement = Statement(
        institution="My Bank",
        content=template.read_text().strip()
        + "\nSpending,Closing balance,(4.10),USD,2026-11-24"
        + "\nSavings,Closing balance,0,CAD,2026-11-25",
    )
    preview = holdings.import_statement(statement)
    assert holdings.all() == []
    statement.revisions = {a["id"]: a["revision"] for a in preview}
    holdings.import_statement(statement, apply=True)
    accounts = {a["name"]: a["positions"][0] for a in holdings.all()}
    assert (accounts["Spending"]["value"], accounts["Spending"]["currency"]) == (-4.10, "USD")
    assert (accounts["Savings"]["value"], accounts["Savings"]["as_of"]) == (0, "2026-11-25")
