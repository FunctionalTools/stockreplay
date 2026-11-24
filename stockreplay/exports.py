import csv
import hashlib
import io
import json
from html import escape

from . import ENGINE_VERSION
from .market import read_csv
from .schema import Experiment

FORMAT = "stockreplay.experiment.v1"


def event_csv(result):
    output = io.StringIO()
    keys = [
        "ticker",
        "signal",
        "entry",
        "exit",
        "entry_price",
        "exit_price",
        "exit_at",
        "gross_pct",
        "return_pct",
        "benchmark_pct",
        "excess_pct",
        "success",
        "regime",
    ]
    writer = csv.DictWriter(output, fieldnames=keys, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(result["events"])
    return output.getvalue()


def bundle(db, result):
    return {
        "format": FORMAT,
        "engine": result["engine"],
        "config": result["config"],
        "snapshots": [
            {"id": m["id"], "ticker": t, "source": m["source"], "csv": db.snapshot(m["id"])[1]}
            for t, m in result["sources"].items()
        ],
    }


def import_bundle(db, doc):
    if doc.get("format") != FORMAT or doc.get("engine") != ENGINE_VERSION:
        raise ValueError("Unsupported experiment format or engine version.")
    c = Experiment.model_validate(doc.get("config"))
    records = doc.get("snapshots")
    if not isinstance(records, list) or len(records) != len(c.symbols()):
        raise ValueError("The file must contain one snapshot for every required symbol.")
    validated, pins = [], {}
    for row in records:
        if not isinstance(row, dict):
            raise ValueError("Invalid snapshot record.")
        ticker, source, data = row.get("ticker"), row.get("source"), row.get("csv")
        if (
            ticker not in c.symbols()
            or ticker in pins
            or source != c.source
            or not isinstance(data, str)
            or len(data) > 6000000
        ):
            raise ValueError("Invalid data source, ticker or snapshot size.")
        digest = hashlib.sha256((source + "|" + ticker + "|" + data).encode()).hexdigest()
        if digest != row.get("id"):
            raise ValueError("The data snapshot checksum does not match.")
        frame = read_csv(data)
        validated.append((ticker, source, data, frame.index.strftime("%Y-%m-%d").tolist()))
        pins[ticker] = digest
    for args in validated:
        db.put_frame(*args)
    return c, pins


def curve_svg(result):
    curve = result["curve"]
    if not curve:
        return "<p>No observations for a performance chart.</p>"
    values = [v[k] for v in curve for k in ["strategy", "benchmark"]] + [0]
    bottom, top = min(values), max(values)

    def points(key):
        return " ".join(
            f"{20 + 660 * n / max(len(curve) - 1, 1):.1f},{162 - 140 * (v[key] - bottom) / max(top - bottom, 0.01):.1f}"
            for n, v in enumerate(curve)
        )

    return f'<svg viewBox="0 0 700 185" role="img" aria-label="Strategy and benchmark return curve"><rect width="700" height="185" fill="#101a20"/><polyline points="{points("benchmark")}" fill="none" stroke="#9bacc4" stroke-width="2"/><polyline points="{points("strategy")}" fill="none" stroke="#63d6a6" stroke-width="3"/></svg>'


def report(result, notes=""):
    esc = lambda x: escape(str(x), quote=True)
    c = result["config"]
    m = result["metrics"]
    rows = "".join(
        f"<tr><td>{esc(e['ticker'])}</td><td>{e['signal']}</td><td>{e['entry']}</td><td>{e['exit']}</td><td>{e['entry_price']:.3f}</td><td>{e['exit_price']:.3f}</td><td>{e['return_pct']:+.2f}%</td><td>{e['benchmark_pct']:+.2f}%</td><td>{'Yes' if e['success'] else 'No'}</td></tr>"
        for e in result["events"]
    )
    from .ai import facts

    evidence = "".join(
        "<p>" + esc(s) + "</p>" for s in facts(result, result.get("robustness")).values()
    )
    return f"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{esc(c["name"])} | StockReplay</title><style>
    *{{box-sizing:border-box}}body{{max-width:1000px;margin:48px auto;padding:0 24px;color:#142922;font:16px/1.5 system-ui,sans-serif}}header{{border-top:4px solid #26916a}}svg{{width:100%;max-width:800px}}table{{border-collapse:collapse;font-size:.85rem}}th,td{{text-align:left;padding:6px;border-bottom:1px solid #ccd6d0}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf4f0;padding:16px}}.scroll{{overflow:auto}}</style><header><p>StockReplay · Research report · Engine {esc(result["engine"])}</p><h1>{esc(c["name"])}</h1><p>{esc(c["hypothesis"])}</p></header>
    <p>{esc(c["kind"])} study · {esc(c["source"])}{" (synthetic demonstration)" if c["source"] == "demo" else ""} · {result["first"]} through {result["last"]} · {m["count"]} observations</p>
    <h2>Evidence</h2>{evidence}<h2>{"Portfolio equity" if c["kind"] == "portfolio" else "Mean event path"}</h2><p>Strategy in green · {esc(c["benchmark"])} in gray · cumulative return (%)</p>{curve_svg(result)}
    <h2>Research notes</h2><p>{esc(notes)}</p><h2>All observations</h2><div class="scroll"><table><tr><th>Asset</th><th>Signal</th><th>Entry</th><th>Exit</th><th>Adj. entry</th><th>Adj. exit</th><th>Net return</th><th>Benchmark</th><th>Met objective</th></tr>{rows}</table></div>
    <h2>Parameters, metrics and provenance</h2><pre>{esc(json.dumps({k: result[k] for k in ["config", "metrics", "inference", "sources", "warnings", "robustness"] if k in result}, indent=2))}</pre></html>"""
