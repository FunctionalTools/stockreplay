"""Ollama's hosted API uses bearer authentication and has no native schema output mode."""

import json
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from ipaddress import ip_address

import httpx
from fastapi import HTTPException
from pydantic import Field, SecretStr

from .openai_research import (
    InputTooLarge,
    KeyConnection,
    KeySettings,
    OpenAIResearch,
    checked_key,
)
from .schema import Model
from .source_reader import location
from .store import now

CLOUD_MODEL = "gpt-oss:20b"
CLOUD_MODEL_PATTERN = r"^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,149}$"


class CloudKeySettings(KeySettings):
    model: str = Field(default=CLOUD_MODEL, pattern=CLOUD_MODEL_PATTERN)


class FailedConnectionCheck(HTTPException):
    def __init__(self, generation, search):
        self.generation = generation.detail
        self.search = search.detail
        detail = (
            generation.detail
            if generation.status_code == search.status_code == 401
            else f"Generation: {generation.detail} Web search: {search.detail}"
        )
        super().__init__(generation.status_code, detail)


class ToolUnsupported(Exception):
    """The selected hosted model explicitly rejected function calling."""


def json_object(content):
    if isinstance(content, dict):
        return content
    if not isinstance(content, str):
        raise TypeError("Missing JSON")
    fenced = re.fullmatch(r"\s*```(?:json)?\s*(.*?)\s*```\s*", content, re.IGNORECASE | re.DOTALL)
    return json.loads(fenced[1] if fenced else content)


class OllamaCloudResearch(OpenAIResearch):
    provider = "ollama_cloud"
    label = "Ollama Cloud"
    settings_table = "ollama_cloud_settings"
    default_model = CLOUD_MODEL
    keychain_service = "org.functionaltools.stockreplay.ollama-cloud"
    origin = "https://ollama.com/api/"

    def __init__(self, db, transport=None):
        super().__init__(db, transport)
        self.web_check = {"verified": False, "verified_at": None}
        self.generation_detail = None

    def connection_details(self):
        return {
            "web_search": dict(self.web_check),
            **(
                {"generation_detail": self.generation_detail}
                if self.generation_detail and not self.verified
                else {}
            ),
        }

    def apply_checks(self, checks):
        self.verified = checks.get("verified_at")
        self.web_check = checks.get("web_search", {"verified": False, "verified_at": None})
        self.generation_detail = checks.get("generation_detail")

    def record_outcome(self, key, model, detail):
        with self.lock:
            if not self.matches_current(key, model):
                return
            stamp = None if detail else now()
            if model is not None:
                self.verified = stamp
                self.generation_detail = detail
            else:
                self.web_check = {
                    "verified": bool(stamp),
                    "verified_at": stamp,
                    **({"detail": detail} if detail else {}),
                }

    @contextmanager
    def observe(self, key, model=None):
        try:
            yield
        except HTTPException as exc:
            self.record_outcome(key, model, exc.detail)
            raise
        else:
            self.record_outcome(key, model, None)

    def request(self, key, method, path, payload=None):
        if (method, path) != ("POST", "web_search"):
            return self._request(key, method, path, payload)
        with self.observe(key):
            data = self._request(key, method, path, payload)
            # An empty list is a legitimate response to an authenticated query.
            if not isinstance(data.get("results"), list):
                raise HTTPException(502, "Ollama web search returned an unreadable results list.")
            return data

    def _request(self, key, method, path, payload):
        if (method, path) not in {
            ("GET", "tags"),
            ("POST", "chat"),
            ("POST", "web_search"),
            ("POST", "web_fetch"),
        }:
            raise ValueError("Unknown Ollama Cloud operation.")
        if path in {"web_search", "web_fetch"}:
            target = (payload or {}).get("query" if path == "web_search" else "url")
            if not isinstance(target, str) or not target.strip() or (key and key in target):
                raise ValueError(
                    "Use a public research topic or article address without credentials."
                )
            if path == "web_fetch":
                host, _ = location(target)
                if (
                    not host
                    or "." not in host
                    or host.endswith((".local", ".localhost", ".internal", ".test", ".invalid"))
                ):
                    raise ValueError("Choose a public HTTPS article address.")
                try:
                    address = ip_address(host)
                except ValueError:
                    address = None
                if address is not None and not address.is_global:
                    raise ValueError("Choose a public HTTPS article address.")
        try:
            client = self.client()
            req = client.build_request(
                method,
                path,
                headers={"Authorization": "Bearer " + key} if key else {},
                **({"json": payload} if payload is not None else {}),
            )
            req.headers.pop("cookie", None)
            response = client.send(req)
        except httpx.TimeoutException:
            raise HTTPException(
                504, "Ollama Cloud took too long to respond. Try again shortly."
            ) from None
        except httpx.HTTPError:
            raise HTTPException(
                502, "This Mac could not reach ollama.com securely. Check the network and retry."
            ) from None
        try:
            data = response.json()
        except ValueError:
            data = {}
        err = data.get("error") if isinstance(data, dict) else None
        if response.is_success and isinstance(data, dict) and not err:
            return data
        # Classify diagnostic text internally. Never echo provider text, prompts, keys or headers.
        message = str(err or "").lower()
        scope = "web research" if path in {"web_search", "web_fetch"} else "generation"
        status = response.status_code
        if status == 401:
            raise HTTPException(
                401,
                "Ollama rejected this API key. Use a current website API key from ollama.com/settings/keys.",
            )
        if status == 402 or (
            status in {400, 403, 429}
            and any(
                term in message
                for term in (
                    "insufficient credit",
                    "insufficient balance",
                    "payment required",
                    "out of credits",
                )
            )
        ):
            raise HTTPException(
                402,
                f"Ollama requires billing or available credits for {scope} on this account. Check your Ollama usage and billing.",
            )
        if status == 403:
            raise HTTPException(
                403,
                f"This Ollama account or key does not have access to the requested {scope}. Check its permissions and model availability.",
            )
        if status == 404:
            raise HTTPException(
                404,
                "This hosted model or endpoint is unavailable. Refresh the Ollama Cloud model list in Settings.",
            )
        if status in (413, 400, 422) and (
            status == 413
            or any(
                s in message
                for s in (
                    "context length",
                    "context window",
                    "request too large",
                    "too many tokens",
                )
            )
        ):
            raise InputTooLarge(
                413,
                "The request exceeds this Ollama model’s context limit. Try a shorter request or a larger-context model.",
            )
        if (
            status in (400, 422)
            and path == "chat"
            and payload
            and payload.get("tools")
            and "tool" in message
        ):
            raise ToolUnsupported()
        if status in (502, 503, 529) or (
            status in (400, 429, 500)
            and any(
                s in message
                for s in (
                    "overloaded",
                    "capacity",
                    "too busy",
                    "temporarily unavailable",
                    "high demand",
                )
            )
        ):
            raise HTTPException(
                503,
                f"Ollama Cloud has no available {scope} capacity right now. Retry later or choose another hosted model.",
            )
        if status == 429:
            raise HTTPException(
                429,
                f"Ollama Cloud reports an account usage or rate limit for {scope}. Check your Ollama plan and retry after its limit resets.",
            )
        if status in (400, 422):
            raise HTTPException(
                422,
                "Ollama Cloud rejected this model request. Refresh models in Settings and try another supported model.",
            )
        raise HTTPException(502, "Ollama Cloud returned an unexpected response. Try again shortly.")

    def models(self, discover=True, candidate=None):
        # The hosted catalog itself is public. Finding a model here does not verify an account.
        key = checked_key(candidate.get_secret_value(), self.label) if candidate else None
        records = self.request(key, "GET", "tags").get("models")
        if not isinstance(records, list):
            raise HTTPException(502, "Ollama Cloud returned no readable model catalog.")
        names = sorted(
            {
                row["name"]
                for row in records
                if isinstance(row, dict)
                and isinstance(row.get("name"), str)
                and re.fullmatch(CLOUD_MODEL_PATTERN, row["name"])
                and (not row.get("capabilities") or "completion" in row["capabilities"])
            },
            key=lambda name: (name != CLOUD_MODEL, name),
        )
        return {"source": "ollama_cloud", "models": [{"id": n, "label": n} for n in names]}

    def structured(self, key, model, name, schema, instructions, inputs, budget=3500):
        with self.observe(key, model):
            return self._generate(key, model, name, schema, instructions, inputs, budget)

    def _generate(self, key, model, name, schema, instructions, inputs, budget):
        # Cloud models don't accept local Ollama's format:<JSON schema>. Give them one
        # return-only tool; no model-supplied function name is ever executed.
        from .local_ai import expand_refs, valid_shape

        shape = expand_refs(schema, schema.get("$defs", {}))
        function = "submit_" + name
        input_json = json.dumps(inputs, ensure_ascii=False, separators=(",", ":"))
        messages = [
            {
                "role": "system",
                "content": instructions
                + " Return the requested result once using the supplied function.",
            },
            {"role": "user", "content": input_json},
        ]
        tool = {
            "type": "function",
            "function": {
                "name": function,
                "description": "Return the requested result for validation. This function has no side effects.",
                "parameters": shape,
            },
        }
        for attempt in range(2):
            if attempt:
                messages = [
                    {
                        "role": "system",
                        "content": instructions
                        + " Return one complete JSON object matching this schema. No Markdown or commentary. Schema: "
                        + json.dumps(shape, separators=(",", ":")),
                    },
                    {"role": "user", "content": input_json},
                ]
            body = {
                "model": model,
                "stream": False,
                # The gpt-oss default is medium reasoning. A tiny connection test or
                # routing request can use up its token allowance before returning a tool.
                **(
                    {"think": "low"}
                    if model.startswith("gpt-oss:")
                    and name in {"connection_check", "app_assistant"}
                    else {}
                ),
                "messages": messages,
                "options": {"num_predict": budget * (1 + attempt)},
                **({"tools": [tool]} if not attempt else {}),
            }
            try:
                result = self.request(key, "POST", "chat", body)
            except ToolUnsupported:
                continue
            try:
                if result.get("done") is False or result.get("done_reason") == "length":
                    raise ValueError()
                msg = result["message"]
                calls = msg.get("tool_calls") or []
                if calls:
                    if attempt or len(calls) != 1 or calls[0]["function"]["name"] != function:
                        raise ValueError()
                    output = json_object(calls[0]["function"]["arguments"])
                else:
                    output = json_object(msg["content"])
                if not valid_shape(output, shape):
                    raise ValueError()
            except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
                continue
            return output
        raise HTTPException(
            502,
            "The selected Ollama Cloud model did not return a complete, valid result. Try another hosted model.",
        )

    def probe_search(self, key):
        self.request(
            key,
            "POST",
            "web_search",
            {"query": "Ollama web search documentation", "max_results": 1},
        )

    def check_connection(self, key, model):
        errors = {}
        with ThreadPoolExecutor(max_workers=2) as pool:
            checks = {
                "generation": pool.submit(self.probe, key, model),
                "web_search": pool.submit(self.probe_search, key),
            }
            for scope, check in checks.items():
                try:
                    check.result()
                except HTTPException as exc:
                    errors[scope] = exc
        if len(errors) == 2:
            # Failed checks must not overwrite a working key or switch providers.
            raise FailedConnectionCheck(errors["generation"], errors["web_search"])
        stamp = now()
        return {
            "verified_at": None if "generation" in errors else stamp,
            **(
                {"generation_detail": errors["generation"].detail} if "generation" in errors else {}
            ),
            "web_search": {
                "verified": "web_search" not in errors,
                "verified_at": None if "web_search" in errors else stamp,
                **({"detail": errors["web_search"].detail} if "web_search" in errors else {}),
            },
        }

    def test(self):
        with self.lock:
            revision = self.revision
        try:
            return super().test()
        except FailedConnectionCheck as failure:
            with self.lock:
                if self.revision == revision:
                    self.apply_checks(
                        {
                            "generation_detail": failure.generation,
                            "web_search": {
                                "verified": False,
                                "verified_at": None,
                                "detail": failure.search,
                            },
                        }
                    )
            raise

    def set(self, settings):
        if settings.key is None and "remember" not in settings.model_fields_set:
            settings = settings.model_copy(update={"remember": self.config()[1]})
        return super().set(settings)


class SearchKeySettings(Model):
    key: SecretStr | None = None
    remember: bool = False


class OllamaSearchConnection(KeyConnection):
    """A website key expressly enabled for web search, independently of any model selection."""

    provider = "ollama_search"
    label = "Ollama"
    settings_table = "ollama_search_settings"
    default_model = "web_search"
    keychain_service = "org.functionaltools.stockreplay.ollama-web-search"

    def __init__(self, db, cloud):
        super().__init__(db)
        self.cloud = cloud

    def status(self):
        info = super().status()
        return {k: info[k] for k in ("configured", "verified", "verified_at", "storage")}

    def probe(self, key, model):
        self.cloud.probe_search(key)

    def configure(self, item):
        remember = (
            self.config()[1]
            if item.key is None and "remember" not in item.model_fields_set
            else item.remember
        )
        with self.lock:
            revision = self.revision
        try:
            return self.set(KeySettings(key=item.key, model=self.default_model, remember=remember))
        except HTTPException:
            if item.key is None:
                with self.lock:
                    if self.revision == revision:
                        self.verified = None
            raise

    def search(self, query, max_results=5):
        if type(max_results) is not int or not 1 <= max_results <= 10:
            raise ValueError("Request between one and ten web results.")
        key, _ = self.credentials()
        return self.cloud.request(
            key, "POST", "web_search", {"query": query, "max_results": max_results}
        )
