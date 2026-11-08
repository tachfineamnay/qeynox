"""Contrat BETA50 : cohérence docs/code/UI/flags et parcours HTTP de bout en bout.

Ce fichier est le garde-fou du contrat `docs/beta50/BETA50_CONTRACT.json` :
- la matrice de flags correspond exactement aux variables lues par le code ;
- les endpoints utilisés par l'UI existent et sont documentés ;
- les outils MCP annoncés existent ;
- le parcours réel onboarding → dossier → rapports → validation → mission → hook
  fonctionne sur le serveur HTTP embarqué, sans réseau externe.
"""
from __future__ import annotations

import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from engine import pipeline as pl
from engine import research
from engine import synthesize

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / "docs" / "beta50" / "BETA50_CONTRACT.json").read_text(encoding="utf-8"))
FIXTURE = ROOT / "tests" / "fixtures" / "mini-repo"
APP_JS = (ROOT / "web" / "static" / "app.js").read_text(encoding="utf-8")

ENV_GET = re.compile(r"os\.environ\.get\(\s*[\"']([A-Z0-9_]+)[\"']")
ENV_ITEM = re.compile(r"os\.environ\[\s*[\"']([A-Z0-9_]+)[\"']")
CODE_ROOTS = ("engine", "tools", "web", "scripts", "mcp_server.py", "qeynox.py")


# ------------------------------------------------------------------ helpers
def _code_env_flags() -> set[str]:
    found: set[str] = set()
    for root in CODE_ROOTS:
        path = ROOT / root
        files = [path] if path.is_file() else sorted(path.rglob("*.py"))
        for file in files:
            text = file.read_text(encoding="utf-8")
            found |= set(ENV_GET.findall(text))
            found |= set(ENV_ITEM.findall(text))
    return found


def _json_request(base: str, method: str, path: str, body: dict | None = None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            ctype = response.headers.get("Content-Type", "")
            if "json" in ctype:
                return response.status, json.loads(raw.decode())
            return response.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors="replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw


def _install_offline_research(mp: pytest.MonkeyPatch) -> None:
    def fake_search(query, limit=10):
        return [
            {"title": f"{query} avis fiable", "url": "https://example.com/avis",
             "snippet": "avis fiable prix offre suivi gtm recommandation"},
            {"title": "Concurrent gtm", "url": "https://competitor.example/gtm",
             "snippet": "alternative prix comparatif suivi gtm"},
        ][:limit]

    def fake_fetch(url, timeout=15):
        return "Competitor GTM", "Offre 29 EUR suivi gtm avis fiable."

    class Resp:
        status_code = 200

        def __init__(self, text):
            self.text = text

    def fake_safe_get(url, timeout=20, headers=None):
        if url.rstrip("/").endswith(("/robots.txt", "/sitemap.xml", "/llms.txt")):
            return Resp("User-agent: *\nAllow: /\n" + "x" * 30)
        return Resp(
            """<!doctype html><html><head>
<title>Northstar Desk suivi gtm</title>
<meta name="description" content="meta description suffisamment longue pour depasser cinquante caracteres utiles.">
<link rel="canonical" href="https://example.com/">
<script type="application/ld+json">{"@type":"Organization"}</script>
</head><body><h1>Cockpit GTM</h1><h2>Comment suivre son go to market ?</h2></body></html>"""
        )

    mp.setattr(research, "searxng_available", lambda: False)
    mp.setattr(research, "_search", fake_search)
    mp.setattr(research, "fetch_text", fake_fetch)
    mp.setattr(research, "safe_get", fake_safe_get)
    mp.setattr(research.time, "sleep", lambda *_a, **_k: None)


# ------------------------------------------------------------------ contrat statique
def test_contract_declares_expected_milestone_and_no_open_contradiction():
    assert CONTRACT["milestone"] == "BETA50"
    assert CONTRACT["version"] >= 1
    statuses = {item["status"] for item in CONTRACT["contradictions"]}
    assert statuses <= {"fixed", "documented"}, statuses
    ids = {item["id"] for item in CONTRACT["contradictions"]}
    assert {"C1", "C2", "C3", "C4"} <= ids
    assert CONTRACT["exit_criteria"]


def test_contract_features_evidence_exists():
    assert CONTRACT["features"]
    for feature in CONTRACT["features"]:
        assert feature["status"] in {"in", "internal", "out"}, feature
        for rel in feature["evidence"]:
            assert (ROOT / rel).is_file(), f"{feature['id']} : fichier manquant {rel}"


def test_flags_match_code_and_env_example():
    code_flags = _code_env_flags()
    contract_flags = {flag["name"] for flag in CONTRACT["flags"]}
    missing = code_flags - contract_flags
    extra = contract_flags - code_flags
    assert not missing, f"flags lues par le code mais absentes du contrat : {sorted(missing)}"
    assert not extra, f"flags du contrat non lues par le code : {sorted(extra)}"

    env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
    for flag in CONTRACT["flags"]:
        if flag["kind"] == "user":
            assert flag["name"] in env_example, f"{flag['name']} absent de .env.example"

    reserved = {flag["name"] for flag in CONTRACT["reserved_flags"]}
    assert reserved.isdisjoint(code_flags), "un flag réservé ne doit pas être lu par le code"
    config_example = (ROOT / "tools" / "config.example.env").read_text(encoding="utf-8")
    for name in reserved:
        assert name in config_example, name


def test_ui_api_paths_are_contractual_and_well_formed():
    for entry in CONTRACT["apis"]:
        if not entry["ui"]:
            continue
        prefix = entry["path"].split("{")[0]
        assert prefix in APP_JS, f"{entry['method']} {entry['path']} absent de web/static/app.js"
    assert "function apiPath(" in APP_JS
    assert re.search(r"\$\{qs\(\)\}", APP_JS) is None, "concaténation qs()+'&' de retour : URLs malformées"
    assert "/api/keywords&" not in APP_JS
    assert "/api/report&" not in APP_JS


def test_mcp_tools_are_contractual():
    import mcp_server

    assert set(mcp_server.TOOLS) == set(CONTRACT["mcp_tools"])


def test_acceptance_commands_are_declared():
    commands = "\n".join(CONTRACT["acceptance_commands"])
    assert "ruff" in commands and "pytest" in commands and "compileall" in commands
    assert "tests/test_beta50_contract.py" in commands


# ------------------------------------------------------------------ runtime BETA50
@pytest.fixture(scope="module")
def beta(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    tmp = tmp_path_factory.mktemp("beta50")
    stacks = tmp / "stacks"
    stacks.mkdir()
    mp.setenv("QEYNOX_STACKS_DIR", str(stacks))
    mp.setenv("QEYNOX_LOGS_DIR", str(tmp / "logs"))
    mp.setenv("QEYNOX_MISSIONS_FILE", str(tmp / "missions.json"))
    mp.setenv("QEYNOX_LLM", "none")
    mp.setenv("QEYNOX_OFFLINE_SEARCH", "1")
    mp.delenv("QEYNOX_API_TOKEN", raising=False)
    mp.delenv("GTM_HOOK_TOKEN", raising=False)
    _install_offline_research(mp)

    created = pl.create_stack("Northstar Desk", str(FIXTURE), "https://example.com", ["suivi gtm"])
    slug = created["slug"]
    pl.init_pipeline(slug)
    pl.run_pipeline(slug, {"source": str(FIXTURE), "name": "Northstar Desk",
                           "site_url": "https://example.com", "seeds": ["suivi gtm"]})
    pipe = pl.read_pipeline(slug)
    assert pipe["status"] == "review", pipe

    from web.app import Handler

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield {"base": f"http://127.0.0.1:{srv.server_address[1]}", "slug": slug,
               "stacks": stacks, "tmp": tmp}
    finally:
        srv.shutdown()
        thread.join(timeout=5)
        mp.undo()


def test_beta50_boot_and_core_views(beta):
    base = beta["base"]
    status, health = _json_request(base, "GET", "/api/health")
    assert status == 200 and health["ok"] is True
    assert isinstance(health["searxng"], bool)

    status, stacks = _json_request(base, "GET", "/api/stacks")
    assert status == 200
    row = next(item for item in stacks["rows"] if item["slug"] == beta["slug"])
    assert row["stages"] and row["status"] in {"review", "ready_for_review", "active"}

    for suffix in ("pipeline", "dossier", "context"):
        status, payload = _json_request(base, "GET", f"/api/stacks/{beta['slug']}/{suffix}")
        assert status == 200, (suffix, payload)
    assert "content" in payload or "analysis" in payload

    status, state = _json_request(base, "GET", f"/api/state?stack={beta['slug']}")
    assert status == 200 and state["kpis"]["keywords"] > 0
    assert state["agents"]

    status, keywords = _json_request(base, "GET", f"/api/keywords?stack={beta['slug']}&intent=&q=")
    assert status == 200 and keywords["rows"]
    status, keywords = _json_request(base, "GET", f"/api/keywords?stack={beta['slug']}&intent=commercial&q=gtm")
    assert status == 200 and all(r["intent"] == "commercial" for r in keywords["rows"])

    for path in (f"/api/signals?stack={beta['slug']}", f"/api/competitors?stack={beta['slug']}",
                 f"/api/serp?stack={beta['slug']}", f"/api/reports?stack={beta['slug']}"):
        status, payload = _json_request(base, "GET", path)
        assert status == 200 and "rows" in payload

    status, missions = _json_request(base, "GET", "/api/missions")
    assert status == 200 and "types" in missions

    status, csv_body = _json_request(base, "GET", f"/api/export/keywords.csv?stack={beta['slug']}")
    assert status == 200 and csv_body.startswith(b"kw,intent,score")


def test_beta50_reports_cover_dossier_research_and_swarm(beta):
    base, slug = beta["base"], beta["slug"]
    status, _ = _json_request(base, "POST", f"/api/stacks/{slug}/validate")
    assert status == 200
    status, _ = _json_request(base, "POST", "/api/hooks/agent",
                              {"title": "Livrable agent", "agent": "scout", "body_md": "contenu", "stack": slug})
    assert status == 201

    status, payload = _json_request(base, "GET", f"/api/reports?stack={slug}")
    assert status == 200
    paths = {row["path"] for row in payload["rows"]}
    assert any(p.startswith("dossier/") and p.endswith(".md") for p in paths), paths
    assert "research/keywords.csv" in paths, paths
    assert any(p.startswith("swarm/") and p.endswith(".md") for p in paths), paths
    assert any(p.startswith("output/agent-") and p.endswith(".md") for p in paths), paths

    for rel in sorted(paths)[:12]:
        status, doc = _json_request(base, "GET", f"/api/report?stack={slug}&path={urllib.parse.quote(rel)}")
        assert status == 200, rel
        assert "content" in doc

    # Vue flotte (aucun stack sélectionné) : les chemins doivent être lisibles tels quels.
    status, fleet = _json_request(base, "GET", "/api/reports")
    assert status == 200
    fleet_paths = {row["path"] for row in fleet["rows"]}
    assert any(p.startswith(f"{slug}/dossier/") for p in fleet_paths), fleet_paths
    for rel in sorted(fleet_paths)[:12]:
        status, doc = _json_request(base, "GET", f"/api/report?path={urllib.parse.quote(rel)}")
        assert status == 200, rel
        assert "content" in doc


def test_beta50_mission_launch_and_hook(beta):
    base, slug = beta["base"], beta["slug"]
    status, payload = _json_request(base, "POST", "/api/missions",
                                    {"type": "keywords", "params": {"seeds": ["suivi gtm"]}, "stack": slug})
    assert status == 201
    mission_id = payload["mission"]["id"]

    for _ in range(60):
        status, missions = _json_request(base, "GET", "/api/missions")
        current = next(m for m in missions["rows"] if m["id"] == mission_id)
        if current["status"] != "running":
            break
        threading.Event().wait(0.25)
    assert current["status"] == "done", current

    status, log = _json_request(base, "GET", f"/api/missions/{mission_id}/log")
    assert status == 200 and log["id"] == mission_id

    status, rejected = _json_request(base, "POST", "/api/missions",
                                     {"type": "trends", "params": {}, "stack": slug})
    assert status == 400 and "error" in rejected


def test_beta50_llm_default_is_none(beta, monkeypatch):
    monkeypatch.delenv("QEYNOX_LLM", raising=False)
    called: list[str] = []
    monkeypatch.setattr(synthesize, "_try_ollama", lambda model: called.append("ollama"))
    monkeypatch.setattr(synthesize, "_try_openai", lambda model: called.append("openai"))
    result = synthesize.stage_synthese(beta["slug"], {})
    assert result["status"] == "skipped"
    assert called == [], "aucun fournisseur LLM ne doit être contacté par défaut"


def test_loops_status_is_explicit_without_tenant(monkeypatch, tmp_path, capsys):
    from engine import loops

    monkeypatch.setenv("QEYNOX_STACKS_DIR", str(tmp_path / "stacks"))
    loops.cmd_status()
    assert "Aucun stack suivi" in capsys.readouterr().out
