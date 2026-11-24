from concurrent.futures import ThreadPoolExecutor
import pytest

from stockreplay import market
from stockreplay.exports import bundle, import_bundle
from stockreplay.market import MarketError, load_market, read_csv, store_frame
from stockreplay.store import Store


@pytest.mark.parametrize(
    "mutation", ["nan", "zero", "high", "duplicate", "volume", "date", "adjustment"]
)
def test_malformed_csv(mutation, frames):
    df = frames["NVDA"].reset_index()
    if mutation == "nan":
        df.loc[0, "Close"] = float("nan")
    if mutation == "zero":
        df.loc[0, "Open"] = 0
    if mutation == "high":
        df.loc[0, "High"] = 1
    if mutation == "duplicate":
        df.loc[1, "Date"] = df.loc[0, "Date"]
    if mutation == "volume":
        df.loc[1, "Volume"] = -1
    if mutation == "date":
        df = df.rename(columns={"Date": "Unknown"})
    if mutation == "adjustment":
        df = df.drop(columns=["Adj Close"])
    with pytest.raises(MarketError):
        read_csv(df.to_csv(index=False))


def test_yahoo_ingestion_cache_refresh_and_offline(config, frames, tmp_path, monkeypatch):
    calls = []

    class Ticker:
        def __init__(self, s):
            self.s = s

        def history(self, **kw):
            calls.append(kw)
            return frames[self.s]

    monkeypatch.setattr(market.yf, "Ticker", Ticker)
    c = config.model_copy(update={"source": "yahoo"})
    db = Store(tmp_path)
    loaded, meta = load_market(db, c)
    assert len(calls) == 2 and calls[0]["auto_adjust"] is False and calls[0]["actions"]
    assert len(loaded["SPY"]) == 8 and calls[0]["end"] == "2023-01-13"
    pins = {t: m["id"] for t, m in meta.items()}

    def unavailable(*a, **k):
        raise AssertionError("network accessed")

    monkeypatch.setattr(market, "yahoo", unavailable)
    assert load_market(Store(tmp_path), c, pins)[1] == meta
    assert load_market(db, c)[1] == meta
    with pytest.raises(ValueError, match="wrong symbol"):
        load_market(db, c, {"NVDA": pins["SPY"], "SPY": pins["NVDA"]})


def test_missing_sessions_provider_failure(config, frames, tmp_path, monkeypatch):
    db = Store(tmp_path)
    for t, f in frames.items():
        store_frame(db, t, "csv", f.drop(f.index[3]) if t == "NVDA" else f)
    with pytest.raises(MarketError, match="missing 1"):
        load_market(db, config)

    class Broken:
        def __init__(self, ticker):
            pass

        def history(self, **kw):
            raise RuntimeError("rate limited")

    monkeypatch.setattr(market.yf, "Ticker", Broken)
    with pytest.raises(MarketError, match="rate limited"):
        load_market(db, config.model_copy(update={"source": "yahoo"}))
    assert all(x["source"] == "csv" for x in db.catalog())


def test_pins_survive_new_import_and_concurrency(config, frames, tmp_path):
    db = Store(tmp_path)
    for t, f in frames.items():
        store_frame(db, t, "csv", f)
    _, meta = load_market(db, config)
    pins = {t: m["id"] for t, m in meta.items()}
    f = frames["NVDA"].copy()
    f["Volume"] *= 2
    with ThreadPoolExecutor(max_workers=4) as pool:
        result = list(pool.map(lambda _: store_frame(db, "NVDA", "csv", f), range(8)))
    assert len(set(result)) == 1
    assert load_market(db, config, pins)[1]["NVDA"]["id"] == pins["NVDA"]
    assert load_market(db, config)[1]["NVDA"]["id"] == result[0]


def test_portable_digest_and_actions(config, frames, tmp_path):
    db = Store(tmp_path / "a")
    for t, f in frames.items():
        f.loc[f.index[0], "Dividends"] = 1
        f.loc[f.index[1], "Stock Splits"] = 2
        store_frame(db, t, "csv", f)
    original, meta = load_market(db, config)
    data = bundle(
        db, {"config": config.model_dump(mode="json"), "engine": "1.0.0", "sources": meta}
    )
    second = Store(tmp_path / "b")
    c, pins = import_bundle(second, data)
    assert load_market(second, c, pins)[0]["NVDA"].equals(original["NVDA"])
    data["snapshots"][0]["csv"] += "\n"
    with pytest.raises(ValueError, match="checksum"):
        import_bundle(second, data)


def test_duplicate_column_names_are_checked_before_dataframe_parsing(frames):
    csv_text = frames["NVDA"].to_csv().replace("High,Low", "Close,Low")
    with pytest.raises(MarketError, match="column must appear exactly once"):
        read_csv(csv_text)
