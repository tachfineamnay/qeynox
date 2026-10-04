#!/usr/bin/env python3
"""QeyNox — Plateforme GTM swarm multi-stacks (serveur web, stdlib uniquement).

Onboardez un dépôt : analyse → deep research (mots-clés, signaux, concurrents, AEO/GEO)
→ dossier GTM → validation admin → lancement du swarm.

    python3 app.py                     # http://127.0.0.1:8765
    QEYNOX_BIND=0.0.0.0                # conteneur (exige QEYNOX_API_TOKEN)
    GTM_WEB_PORT=8765

Sécurité : loopback par défaut. Hors loopback sans jeton, le processus s'arrête.
Si un jeton est défini, toutes les routes /api/* sauf /api/health l'exigent.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEB_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(WEB_DIR, "static")
QEYNOX_ROOT = os.path.dirname(WEB_DIR)
TOOLS_DIR = os.path.join(QEYNOX_ROOT, "tools")
sys.path.insert(0, QEYNOX_ROOT)

from engine import pipeline as pl  # noqa: E402
from engine.paths import logs_dir, missions_file, stacks_dir  # noqa: E402
from engine import launch as launch_mod  # noqa: E402
from engine.repo_scan import is_git_url  # noqa: E402
from engine import repository as repo  # noqa: E402
from engine.runner import normalize_mission, run_tool  # noqa: E402
from engine.safety import (  # noqa: E402
    accepted_tokens,
    assert_bind_allowed,
    bind_host,
    is_loopback,
    safe_cli_value,
    safe_join,
    safe_slug,
    token_accepted,
    validate_git_url,
    validate_public_http_url,
)

PORT = int(os.environ.get("GTM_WEB_PORT", "8765"))
_lock = threading.Lock()
_missions: dict[int, dict] = {}

AGENTS = [
    {"id": "goc", "name": "GOC", "emoji": "🧭", "role": "Coordinateur GTM",
     "desc": "Consolide le dossier, délègue aux spécialistes, remonte les décisions admin.",
     "skills": ["gtm-report"]},
    {"id": "scout", "name": "SCOUT", "emoji": "🔎", "role": "Intelligence & signaux",
     "desc": "Mots-clés, tendances, concurrents, verbatims — la matière première.",
     "skills": ["gtm-research", "gtm-keywords"]},
    {"id": "scribe", "name": "SCRIBE", "emoji": "✍️", "role": "Contenu & SEO/AEO",
     "desc": "Articles, FAQ structurées pour l'AEO/GEO, email, landing pages.",
     "skills": ["gtm-content", "gtm-email"]},
    {"id": "signal", "name": "SIGNAL", "emoji": "📣", "role": "Social & créateurs",
     "desc": "Hooks courts, scripts vidéo, épingles, boucle verbatims → créas.",
     "skills": ["gtm-social"]},
    {"id": "pilot", "name": "PILOT", "emoji": "📊", "role": "Acquisition & mesure",
     "desc": "Micro-campagnes signaux, lifecycle, attribution — budget validé par l'admin.",
     "skills": ["gtm-ads"]},
]

MISSION_TYPES = {
    "keywords": {"label": "Expansion de mots-clés", "agent": "scout", "icon": "keywords",
                 "desc": "Autocomplete Google/DDG/YouTube → mots-clés scorés.", "fields": ["seeds", "rounds", "breadth"]},
    "social": {"label": "Scan signaux sociaux", "agent": "scout", "icon": "pulse",
               "desc": "Verbatims réels (SearXNG, sinon DDG).", "fields": ["queries"]},
    "competitors": {"label": "Veille concurrents", "agent": "scout", "icon": "radar",
                    "desc": "Snapshots pages + diff des changements.", "fields": []},
    "serp": {"label": "Positions SERP", "agent": "scout", "icon": "chart",
             "desc": "Positions du site sur les mots-clés stockés (SearXNG).", "fields": ["limit"]},
    "trends": {"label": "Tendances Google", "agent": "scout", "icon": "trend",
               "desc": "Intérêt 0-100 + requêtes associées.", "fields": ["kws", "geo"]},
}

AGENT_OF_TOOL = {"keyword_research": "scout", "trends_check": "scout", "serp_rank": "scout",
                 "competitor_watch": "scout", "social_pulse": "scout"}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def stack_db(slug: str) -> str:
    return os.path.join(stacks_dir(), safe_slug(slug), "data", "gtm.db")


def stack_output(slug: str) -> str:
    return os.path.join(stacks_dir(), safe_slug(slug), "output")


def load_missions() -> None:
    path = missions_file()
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                for m in json.load(f):
                    _missions[int(m["id"])] = m
        except Exception:
            pass


def save_missions() -> None:
    path = missions_file()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with _lock:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(sorted(_missions.values(), key=lambda m: m["id"]), f, ensure_ascii=False, indent=1)


def run_mission(mid: int) -> None:
    m = _missions[mid]
    slug = m.get("stack") or ""
    os.makedirs(logs_dir(), exist_ok=True)
    log_path = os.path.join(logs_dir(), f"mission-{mid:04d}.log")
    try:
        if slug:
            slug = safe_slug(slug)
        db = stack_db(slug) if slug and os.path.isdir(os.path.join(stacks_dir(), slug)) else os.environ.get("GTM_DB", os.path.join(TOOLS_DIR, "data", "gtm.db"))
        env = {**os.environ, "GTM_DB": db, "GTM_LANG": "fr", "GTM_GL": "FR", "PYTHONUNBUFFERED": "1"}
        tool_name, tool_params = normalize_mission(m["type"], m.get("params") or {})
        ran = run_tool(
            tool_name, tool_params, cwd=TOOLS_DIR, env=env, log_path=log_path,
            on_start=lambda pid: m.__setitem__("pid", pid),
        )
        m["status"] = "done" if ran.ok else "error"
        if ran.timed_out:
            with open(log_path, "a", encoding="utf-8") as log:
                log.write("\n[qeynox] timeout\n")
    except Exception as exc:  # noqa: BLE001
        m["status"] = "error"
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(f"\n[qeynox] erreur lanceur: {exc}\n")
    m["finished"] = now_iso()
    save_missions()


def db_path_for(slug: str) -> str:
    if slug:
        return stack_db(slug)
    return os.path.join(TOOLS_DIR, "data", "gtm.db")


class Handler(BaseHTTPRequestHandler):
    server_version = "QeyNox/1.5"

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _presented_token(self) -> str:
        auth = self.headers.get("Authorization") or ""
        if auth[:7].lower() == "bearer ":
            return auth[7:].strip()
        return (self.headers.get("X-Qeynox-Token") or self.headers.get("X-Lumira-Token") or "").strip()

    def _require_auth(self, path: str) -> bool:
        if path == "/api/health" or not path.startswith("/api/"):
            return True
        if not accepted_tokens() or token_accepted(self._presented_token()):
            return True
        self._json({"error": "authentification requise"}, 401)
        return False

    def _query_slug(self, qs: dict) -> str | None:
        raw = (qs.get("stack") or [""])[0]
        if not str(raw).strip():
            return ""
        try:
            return safe_slug(str(raw))
        except ValueError:
            self._json({"error": "stack invalide"}, 400)
            return None

    def _static(self, rel: str) -> None:
        rel = urllib.parse.unquote(rel)
        try:
            path = safe_join(STATIC_DIR, rel)
        except ValueError:
            return self._json({"error": "introuvable"}, 404)
        if not os.path.isfile(path):
            return self._json({"error": "introuvable"}, 404)
        ctype = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
                 ".png": "image/png", ".ico": "image/x-icon"}.get(os.path.splitext(path)[1], "application/octet-stream")
        with open(path, "rb") as f:
            self._send(200, f.read(), ctype)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 200_000:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def log_message(self, fmt, *args) -> None:  # noqa: A003
        sys.stderr.write("[qeynox] %s - %s\n" % (self.address_string(), fmt % args))

    # ------------------------------------------------------------- GET
    def do_GET(self) -> None:  # noqa: N802
        path, _, query = self.path.partition("?")
        path = urllib.parse.unquote(path)
        qs = urllib.parse.parse_qs(query)
        if not self._require_auth(path):
            return
        try:
            if path in ("/", "/index.html"):
                return self._static("index.html")
            if path.startswith("/static/"):
                return self._static(path[len("/static/"):])
            if path == "/favicon.ico":
                return self._static("favicon.svg")

            if path == "/api/health":
                from engine.research import searxng_available
                return self._json({"ok": True, "searxng": searxng_available(), "time": now_iso()})

            if path == "/api/state":
                slug = self._query_slug(qs)
                if slug is None:
                    return
                db_path = db_path_for(slug)
                runs = []
                for r in repo.recent_runs(db_path, limit=10):
                    r["agent"] = AGENT_OF_TOOL.get(r["tool"])
                    runs.append(r)
                running = [m for m in _missions.values() if m["status"] == "running"]
                return self._json({
                    "kpis": {
                        "keywords": repo.count_keywords(db_path),
                        "keywords_commercial": repo.count_keywords_intent(db_path, "commercial"),
                        "signals": repo.count_signals(db_path),
                        "serp_checks": repo.count_serp_runs(db_path),
                        "missions_running": len(running),
                    },
                    "recent_runs": runs,
                    "agents": AGENTS,
                })

            if path == "/api/stacks":
                rows = pl.load_registry()
                for s in rows:
                    pipe = pl.read_pipeline(s["slug"])
                    s["pipeline_status"] = (pipe or {}).get("status", "queued")
                    s["stages"] = [{"id": st["id"], "label": st["label"], "status": st["status"]} for st in (pipe or {}).get("stages", [])]
                    dossier_dir = os.path.join(stacks_dir(), s["slug"], "dossier", "data.json")
                    if os.path.exists(dossier_dir):
                        with open(dossier_dir, encoding="utf-8") as f:
                            s["dossier_data"] = json.load(f)
                return self._json({"rows": rows})

            m = re.match(r"^/api/stacks/([A-Za-z0-9][A-Za-z0-9_-]*)/pipeline$", path)
            if m:
                return self._json({"pipeline": pl.read_pipeline(m.group(1))})

            m = re.match(r"^/api/stacks/([A-Za-z0-9][A-Za-z0-9_-]*)/dossier$", path)
            if m:
                from engine.dossier import read_dossier_markdown
                found = read_dossier_markdown(m.group(1))
                if not found:
                    return self._json({"error": "pas de dossier"}, 404)
                name, content = found
                return self._json({"file": name, "content": content[:300_000]})

            m = re.match(r"^/api/stacks/([A-Za-z0-9][A-Za-z0-9_-]*)/context$", path)
            if m:
                p = os.path.join(stacks_dir(), m.group(1), "context", "repo-analysis.json")
                if not os.path.exists(p):
                    return self._json({"error": "pas d'analyse"}, 404)
                with open(p, encoding="utf-8") as f:
                    return self._json({"analysis": json.load(f)})

            if path == "/api/keywords":
                slug = self._query_slug(qs)
                if slug is None:
                    return
                intent = (qs.get("intent") or [""])[0]
                q = (qs.get("q") or [""])[0].lower()
                rows = repo.keywords_for_ui(db_path_for(slug))
                if intent:
                    rows = [r for r in rows if r["intent"] == intent]
                if q:
                    rows = [r for r in rows if q in r["kw"]]
                return self._json({"rows": rows})

            if path == "/api/signals":
                slug = self._query_slug(qs)
                if slug is None:
                    return
                return self._json({"rows": repo.signals_for_ui(db_path_for(slug))})

            if path == "/api/serp":
                slug = self._query_slug(qs)
                if slug is None:
                    return
                rows = repo.latest_serp(db_path_for(slug))
                rows.sort(key=lambda r: (r["position"] is None, r["position"] if r["position"] is not None else 0, r["kw"]))
                return self._json({"rows": rows[:200]})

            if path == "/api/competitors":
                slug = self._query_slug(qs)
                if slug is None:
                    return
                return self._json({"rows": repo.competitor_snapshots(db_path_for(slug))})

            if path == "/api/missions":
                ms = sorted(_missions.values(), key=lambda m: -m["id"])[:100]
                return self._json({"rows": ms, "types": MISSION_TYPES,
                                   "stacks": [{"slug": s["slug"], "name": s["name"], "status": s["status"]}
                                              for s in pl.load_registry() if s["status"] == "active"]})

            m = re.match(r"^/api/missions/(\d+)/log$", path)
            if m:
                mid = int(m.group(1))
                log_path = os.path.join(logs_dir(), f"mission-{mid:04d}.log")
                text = ""
                if os.path.exists(log_path):
                    with open(log_path, encoding="utf-8", errors="replace") as f:
                        text = f.read()[-40_000:]
                return self._json({"id": mid, "log": text, "status": _missions.get(mid, {}).get("status", "?")})

            if path == "/api/reports":
                slug = self._query_slug(qs)
                if slug is None:
                    return
                root = stack_output(slug) if slug else stacks_dir()
                reports = []
                if os.path.isdir(root):
                    for rdir, _dirs, files in os.walk(root):
                        if os.path.join("repo") + os.sep in rdir:
                            continue
                        for fn in files:
                            if fn.endswith((".md", ".csv")) and "logs" not in rdir:
                                fp = os.path.join(rdir, fn)
                                reports.append({"path": os.path.relpath(fp, root if slug else QEYNOX_ROOT),
                                                "stack": slug or os.path.relpath(rdir, QEYNOX_ROOT).split(os.sep)[1],
                                                "name": fn,
                                                "mtime": datetime.fromtimestamp(os.path.getmtime(fp), timezone.utc).isoformat(),
                                                "size": os.path.getsize(fp)})
                reports.sort(key=lambda r: r["mtime"], reverse=True)
                return self._json({"rows": reports[:200]})

            m = re.match(r"^/api/report$", path)
            if m:
                slug = self._query_slug(qs)
                if slug is None:
                    return
                rel = (qs.get("path") or [""])[0]
                root = os.path.abspath(stack_output(slug) if slug else stacks_dir())
                try:
                    fp = safe_join(root, rel)
                except ValueError:
                    return self._json({"error": "introuvable"}, 404)
                if not os.path.isfile(fp):
                    return self._json({"error": "introuvable"}, 404)
                with open(fp, encoding="utf-8", errors="replace") as f:
                    return self._json({"path": rel, "content": f.read()[:200_000]})

            if path == "/api/export/keywords.csv":
                import csv as _csv
                import io as _io
                slug = self._query_slug(qs)
                if slug is None:
                    return
                rows = repo.keywords_for_export(db_path_for(slug))
                buf = _io.StringIO()
                w = _csv.DictWriter(buf, fieldnames=["kw", "intent", "score", "source", "parent", "trend"])
                w.writeheader()
                w.writerows(rows)
                return self._send(200, buf.getvalue().encode("utf-8"), "text/csv; charset=utf-8",
                                  {"Content-Disposition": "attachment; filename=qeynox-keywords.csv"})

            return self._json({"error": "introuvable"}, 404)
        except Exception as exc:  # noqa: BLE001
            return self._json({"error": str(exc)}, 500)

    # ------------------------------------------------------------- POST
    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.unquote(self.path.split("?", 1)[0])
        if not self._require_auth(path):
            return
        try:
            if path == "/api/stacks":
                body = self._body()
                name = str(body.get("name", "")).strip()
                source = str(body.get("source", "")).strip()
                if not name or not source:
                    return self._json({"error": "nom et source requis"}, 400)
                if is_git_url(source):
                    try:
                        validate_git_url(source)
                    except ValueError as exc:
                        return self._json({"error": str(exc)}, 400)
                site = str(body.get("site_url", "")).strip()
                if site:
                    try:
                        validate_public_http_url(site, resolve=False)
                    except ValueError as exc:
                        return self._json({"error": str(exc)}, 400)
                seeds = []
                for raw in body.get("seeds", [])[:8]:
                    if isinstance(raw, str) and raw.strip():
                        seeds.append(safe_cli_value(raw, field="graine"))
                created = pl.create_stack(name, source, site, seeds)
                pl.init_pipeline(created["slug"])
                pl.start_pipeline_async(created["slug"], {"source": source, "name": name,
                                                          "site_url": site, "seeds": seeds})
                return self._json({"ok": True, "stack": created}, 201)

            m = re.match(r"^/api/stacks/([A-Za-z0-9][A-Za-z0-9_-]*)/validate$", path)
            if m:
                result = launch_mod.validate_stack(m.group(1))
                return self._json(result, 200 if result.get("ok") else 400)

            if path == "/api/missions":
                body = self._body()
                mtype = body.get("type", "")
                if mtype not in MISSION_TYPES:
                    return self._json({"error": "type de mission inconnu"}, 400)
                params = body.get("params", {}) or {}
                if mtype == "keywords" and not [s for s in params.get("seeds", []) if isinstance(s, str) and s.strip()]:
                    return self._json({"error": "au moins une graine requise"}, 400)
                if mtype == "trends" and not params.get("kws"):
                    return self._json({"error": "au moins un mot-clé requis"}, 400)
                stack = str(body.get("stack") or "")
                if stack:
                    try:
                        stack = safe_slug(stack)
                    except ValueError:
                        return self._json({"error": "stack invalide"}, 400)
                try:
                    normalize_mission(mtype, params)
                except ValueError as exc:
                    return self._json({"error": str(exc)}, 400)
                params["seeds"] = [s.strip() for s in params.get("seeds", []) if isinstance(s, str) and s.strip()]
                params["queries"] = [s.strip() for s in params.get("queries", []) if isinstance(s, str) and s.strip()]
                params["kws"] = [s.strip() for s in params.get("kws", []) if isinstance(s, str) and s.strip()]
                with _lock:
                    mid = (max(_missions, default=0)) + 1
                    mission = {"id": mid, "type": mtype, "label": MISSION_TYPES[mtype]["label"],
                               "agent": MISSION_TYPES[mtype]["agent"], "stack": stack,
                               "params": params, "status": "running", "started": now_iso(), "finished": None}
                    _missions[mid] = mission
                save_missions()
                threading.Thread(target=run_mission, args=(mid,), daemon=True).start()
                return self._json({"ok": True, "mission": mission}, 201)

            if path == "/api/hooks/agent":
                body = self._body()
                raw_slug = str(body.get("stack", "")).strip()
                slug = ""
                if raw_slug:
                    try:
                        slug = safe_slug(raw_slug)
                    except ValueError:
                        return self._json({"error": "stack invalide"}, 400)
                out_root = stack_output(slug) if slug else os.path.join(QEYNOX_ROOT, "output")
                os.makedirs(out_root, exist_ok=True)
                fn = f"agent-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.md"
                title = str(body.get("title", "Livrable agent"))[:200]
                agent = str(body.get("agent", "agent"))[:80]
                body_md = str(body.get("body_md", ""))[:100_000]
                with open(os.path.join(out_root, fn), "w", encoding="utf-8") as f:
                    f.write(f"# {title}\n\n> Poussé par **{agent}**\n\n{body_md}\n")
                return self._json({"ok": True, "file": fn}, 201)

            return self._json({"error": "introuvable"}, 404)
        except Exception as exc:  # noqa: BLE001
            return self._json({"error": str(exc)}, 500)


def main() -> None:
    assert_bind_allowed()
    load_missions()
    os.makedirs(logs_dir(), exist_ok=True)
    host = bind_host()
    srv = ThreadingHTTPServer((host, PORT), Handler)
    print(f"⬡ QeyNox — plateforme GTM swarm — http://{host}:{PORT}")
    if not accepted_tokens() and is_open_local(host):
        print("  auth : désactivée (loopback, pas de QEYNOX_API_TOKEN)")
    else:
        print("  auth : jeton requis sur /api/* (sauf /api/health)")
    srv.serve_forever()


def is_open_local(host: str) -> bool:
    return is_loopback(host) and not accepted_tokens()


if __name__ == "__main__":
    main()
