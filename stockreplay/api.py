import json
import logging
import threading
import uuid
from datetime import date
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import ENGINE_VERSION, ai
from .engine import analyze
from .exports import bundle, event_csv, import_bundle, report
from .market import MarketError, load_market, read_csv, search_symbols, store_frame
from .robustness import evaluate_robustness
from .schema import (
    Comparison,
    CsvUpload,
    Experiment,
    InterpretationRequest,
    NoteEdit,
    RobustnessRequest,
    RunRequest,
    SavedRun,
    Settings,
)
from .store import Store
from .terminal_api import register
from fastapi.exceptions import RequestValidationError

log = logging.getLogger("stockreplay")


def opening_config():
    return Experiment()


def create_app(root=None):
    app = FastAPI(title="StockReplay", version=ENGINE_VERSION)
    db = Store(root)
    app.state.store = db
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=["localhost", "127.0.0.1", "[::1]", "testserver"],
    )
    jobs, lock = {}, threading.Lock()
    opening_lock = threading.Lock()
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="stockreplay")
    with db.connect() as conn:
        conn.execute(
            "create table if not exists opening_runs(signature text primary key,run_id text references runs(id))"
        )
        conn.execute(
            "create table if not exists research(run_id text primary key references runs(id), robustness text, explanation text)"
        )

    @app.middleware("http")
    async def local_requests(request: Request, call_next):
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            if origin and urlsplit(origin).hostname not in {
                "localhost",
                "127.0.0.1",
                "::1",
            }:
                return JSONResponse(
                    {"detail": "Only the local application can change research data."},
                    status_code=403,
                )
        return await call_next(request)

    @app.exception_handler(ValueError)
    async def bad(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=422)

    @app.exception_handler(KeyError)
    async def missing(request, exc):
        return JSONResponse({"detail": str(exc.args[0])}, status_code=404)

    @app.exception_handler(ai.AIUnavailable)
    async def offline(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=503)

    @app.exception_handler(RequestValidationError)
    async def invalid(request, exc):
        # Validation errors must never reflect keys or statement contents.
        errors = [{"loc": e["loc"], "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
        return JSONResponse({"detail": errors}, status_code=422)

    def output(key):
        value = db.result(key)
        if "distribution" not in value:
            from .statistics import return_distribution

            value["distribution"] = return_distribution(value["events"])
        with db.connect() as conn:
            row = conn.execute("select * from research where run_id=?", (key,)).fetchone()
        if row:
            for field in ["robustness", "explanation"]:
                if row[field]:
                    value[field] = json.loads(row[field])
        return {**value, "id": key}

    def calculate(config, pins=None, update=lambda value: None):
        update("Loading market data")
        frames, meta = load_market(db, config, pins)
        update("Evaluating signals and statistics")
        result = analyze(config, frames)
        result["sources"] = meta
        return db.run(result)

    @app.get("/api/health")
    def health():
        return {"application": "StockReplay", "status": "ok", "engine": ENGINE_VERSION}

    @app.get("/api/defaults")
    def defaults():
        return Experiment()

    @app.post("/api/validate")
    def validate(config: Experiment):
        return config

    @app.get("/api/opening")
    def opening_run(config: Experiment = Depends(opening_config)):
        with opening_lock:
            signature = ENGINE_VERSION + config.model_dump_json()
            with db.connect() as conn:
                saved = conn.execute(
                    "select run_id from opening_runs where signature=?", (signature,)
                ).fetchone()
            if saved:
                return output(saved[0])
            try:
                key = calculate(config)
            except MarketError as exc:
                if config.source != "yahoo":
                    raise
                # An outage can still leave a fully covered, genuine historical run on disk.
                ends = [
                    {
                        s["last"]
                        for s in db.catalog()
                        if s["source"] == "yahoo"
                        and s["ticker"] == ticker
                        and s["first"] <= config.start.isoformat()
                        and s["last"] < config.end.isoformat()
                    }
                    for ticker in config.symbols()
                ]
                if not all(ends):
                    raise
                end = min(max(s) for s in ends)
                if end <= config.start.isoformat():
                    raise
                cached = config.model_copy(update={"end": date.fromisoformat(end)})
                key = calculate(cached)
                return {
                    **output(key),
                    "opening_notice": f"Requested through {config.end}. Showing available Yahoo history through {end}. {exc}",
                }
            with db.connect() as conn:
                conn.execute("insert or replace into opening_runs values(?,?)", (signature, key))
            return output(key)

    @app.get("/api/ai")
    def ai_status():
        return ai.status(db.model())

    @app.put("/api/settings")
    def settings(value: Settings):
        db.set_model(value.model)
        return ai.status(value.model)

    @app.post("/api/interpret")
    def interpret(request: InterpretationRequest):
        return ai.interpret(request, db.model())

    @app.post("/api/jobs", status_code=202)
    def submit(request: RunRequest):
        job = uuid.uuid4().hex
        with lock:
            active = sum(s["status"] in {"queued", "running"} for s in jobs.values())
            if active >= 8:
                raise HTTPException(429, "The local engine is busy. Retry when a run finishes.")
            if len(jobs) >= 128:
                for old in list(jobs):
                    if jobs[old]["status"] in {"complete", "error"}:
                        del jobs[old]
                        break
            jobs[job] = {"status": "queued", "message": "Queued"}

        def worker():
            def update(msg):
                with lock:
                    jobs[job] = {"status": "running", "message": msg}

            try:
                key = calculate(request.config, request.pins, update)
                state = {"status": "complete", "message": "Complete", "run": key}
            except (ValueError, KeyError) as exc:
                state = {"status": "error", "message": str(exc)}
            except Exception:
                log.exception("Experiment failed")
                state = {
                    "status": "error",
                    "message": "The engine encountered an unexpected error. See the server log.",
                }
            with lock:
                jobs[job] = state

        pool.submit(worker)
        return {"job": job}

    @app.get("/api/jobs/{key}")
    def job_status(key: str):
        with lock:
            if key not in jobs:
                raise KeyError("Job not found.")
            return jobs[key]

    @app.get("/api/runs/{key}")
    def get_run(key: str):
        return output(key)

    @app.post("/api/runs/{key}/explain")
    def explain(key: str):
        r = output(key)
        answer = ai.explain(r, db.model(), r.get("robustness"))
        with db.connect() as conn:
            previous = r.get("robustness")
            updated = conn.execute(
                """insert into research(run_id,explanation) values(?,?)
                   on conflict(run_id) do update set explanation=excluded.explanation
                   where research.robustness is ?""",
                (
                    key,
                    json.dumps(answer),
                    json.dumps(previous) if previous is not None else None,
                ),
            )
            if not updated.rowcount:
                raise HTTPException(
                    409,
                    "Robustness results changed during generation. Regenerate the explanation.",
                )
        return answer

    @app.post("/api/runs/{key}/robustness")
    def robustness(key: str, request: RobustnessRequest):
        db.result(key)  # Check that the parent experiment exists before running the grid.
        frames, meta = load_market(db, request.config, request.pins)
        result = evaluate_robustness(request, frames)
        result.update(parameters=request.model_dump(mode="json"), sources=meta)
        with db.connect() as conn:
            conn.execute(
                "insert into research(run_id,robustness) values(?,?) on conflict(run_id) do update set robustness=excluded.robustness,explanation=null",
                (key, json.dumps(result, allow_nan=False)),
            )
        return result

    @app.get("/api/symbols")
    def symbols(q: str = Query(default="", max_length=80), online: bool = False):
        return search_symbols(q, online)

    @app.get("/api/data")
    def catalog():
        return db.catalog()

    @app.post("/api/data/fetch")
    def refresh(request: RunRequest):
        _, meta = load_market(db, request.config, refresh=True)
        return list(meta.values())

    @app.post("/api/data/import")
    def ingest(request: CsvUpload):
        data = read_csv(request.csv)
        return {"snapshot": store_frame(db, request.ticker, "csv", data)}

    @app.get("/api/data/{key}/csv")
    def raw(key: str):
        meta, data = db.snapshot(key)
        return download(data, "text/csv", meta["ticker"] + ".csv")

    @app.get("/api/library")
    def library():
        return db.library()

    @app.post("/api/library", status_code=201)
    def save(request: SavedRun):
        return {"id": db.save(request.run_id, request.name, request.notes)}

    @app.patch("/api/library/{key}")
    def edit(key: str, request: NoteEdit):
        db.edit(key, request.name, request.notes, request.run_id)
        return {"id": key}

    @app.delete("/api/library/{key}")
    def delete(key: str):
        db.delete(key)
        return {"deleted": key}

    @app.get("/api/comparisons")
    def comparisons():
        return db.comparisons()

    @app.post("/api/comparisons", status_code=201)
    def compare(request: Comparison):
        if request.left == request.right:
            raise ValueError("Select two different runs.")
        rows = []
        for key in (request.left, request.right):
            r = db.result(key)
            rows.append(
                {
                    "run": key,
                    "config": r["config"],
                    "metrics": r["metrics"],
                    "sources": r["sources"],
                }
            )
        return {"id": db.add_comparison(request.name, rows), "payload": rows}

    @app.post("/api/import")
    def restore(doc: dict):
        config, pins = import_bundle(db, doc)
        return output(calculate(config, pins))

    @app.get("/api/runs/{key}/export/{kind}")
    def export(key: str, kind: str, saved: str | None = None):
        result = output(key)
        notes = ""
        if saved:
            match = next(
                (x for x in db.library() if x["id"] == saved and x["run_id"] == key),
                None,
            )
            if match:
                notes = match["notes"]
                result["config"] = {**result["config"], "name": match["name"]}
        prefix = "stockreplay-" + key[:8]
        if kind == "csv":
            return download(event_csv(result), "text/csv", prefix + "-events.csv")
        if kind == "config":
            return download(
                json.dumps(result["config"], indent=2),
                "application/json",
                prefix + "-config.json",
            )
        if kind == "bundle":
            return download(
                json.dumps(bundle(db, result)),
                "application/json",
                prefix + ".stockreplay.json",
            )
        if kind == "html":
            return download(report(result, notes), "text/html", prefix + ".html")
        raise KeyError("Unknown export format.")

    register(app, db)
    dist = Path(__file__).resolve().parents[1] / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="terminal")
    return app


def download(content, media, name):
    return Response(
        content,
        media_type=media,
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "X-Content-Type-Options": "nosniff",
        },
    )
