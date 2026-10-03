#!/usr/bin/env python3
"""QeyNox — Plateforme GTM swarm multi-stacks (serveur web, stdlib uniquement).

Onboardez un dépôt : analyse → deep research (mots-clés, signaux, concurrents, AEO/GEO)
→ dossier GTM → validation admin → lancement du swarm.

    python3 app.py                     # http://127.0.0.1:8765  (GTM_WEB_HOST / GTM_WEB_PORT)

Sécurité : prévu pour tourner en local/VPS derrière une auth (proxy/Tailscale).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEB_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(WEB_DIR, "static")
QEYNOX_ROOT = os.path.dirname(WEB_DIR)
TOOLS_DIR = os.path.join(QEYNOX_ROOT, "tools")
STACKS_DIR = os.path.join(QEYNOX_ROOT, "stacks")
sys.path.insert(0, QEYNOX_ROOT)

from engine import pipeline as pl  # noqa: E402
from engine import launch as launch_mod  # noqa: E402

PORT = int(os.environ.get("GTM_WEB_PORT", "8765"))
DEFAULT_HOST = "127.0.0.1"
HOOK_TOKEN = os.environ.get("GTM_HOOK_TOKEN", "")
MISSIONS_FILE = os.path.join(WEB_DIR, "missions.json")
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


def normalize_slug(raw: str | None) -> str | None:
    raw = "" if raw is None else str(raw)
    if raw == "":
        return ""
    if re.fullmatch(r"[\w-]+", raw):
        return raw
    return None


def contained(root: str, candidate: str) -> bool:
    root_a = os.path.normcase(os.path.abspath(root))
    cand_a = os.path.normcase(os.path.abspath(candidate))
    try:
        return os.path.commonpath([root_a, cand_a]) == root_a
    except ValueError:
        return False


def resolve_under(root: str, rel: str | None) -> str | None:
    if rel is None or not str(rel).strip():
        return None
    root_abs = os.path.abspath(root)
    fp = os.path.normpath(os.path.join(root_abs, str(rel)))
    if not contained(root_abs, fp) or not os.path.isfile(fp):
        return None
    return fp


def bind_address() -> tuple[str, int]:
    return (os.environ.get("GTM_WEB_HOST", DEFAULT_HOST), PORT)


def mission_cwd(slug: str) -> str | None:
    """cwd du tool : dossier du stack, ou None si le slug sort de stacks/."""
    if not slug:
        return TOOLS_DIR
    if normalize_slug(slug) is None:
        return None
    stack = os.path.join(STACKS_DIR, slug)
    if os.path.isdir(stack):
        return stack
    return TOOLS_DIR


def mission_env(slug: str, db: str) -> dict:
    env = {**os.environ, "GTM_DB": db, "GTM_LANG": "fr", "GTM_GL": "FR", "PYTHONUNBUFFERED": "1"}
    if not slug or normalize_slug(slug) is None:
        return env
    brand = slug
    ctx_path = os.path.join(STACKS_DIR, slug, "context", "repo-analysis.json")
    if os.path.exists(ctx_path):
        try:
            with open(ctx_path, encoding="utf-8") as fh:
                ctx = json.load(fh)
            brand = ((ctx.get("brand") or {}).get("guess")) or slug
        except (OSError, json.JSONDecodeError):
            pass
    site = str((pl.get_stack(slug) or {}).get("site_url") or "")
    host = urllib.parse.urlparse(site).netloc.lower().removeprefix("www.")
    env["GTM_BRAND"] = brand
    env["GTM_BRAND_ALIASES"] = brand
    if host:
        env["GTM_DOMAIN"] = host
    return env


def stack_db(slug: str) -> str:
    return os.path.join(STACKS_DIR, slug, "data", "gtm.db")


def stack_output(slug: str) -> str:
    return os.path.join(STACKS_DIR, slug, "output")


def load_missions() -> None:
    if os.path.exists(MISSIONS_FILE):
        try:
            with open(MISSIONS_FILE, encoding="utf-8") as f:
                for m in json.load(f):
                    _missions[int(m["id"])] = m
        except Exception:
            pass


def save_missions() -> None:
    with _lock:
        with open(MISSIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(sorted(_missions.values(), key=lambda m: m["id"]), f, ensure_ascii=False, indent=1)


def build_args(mtype: str, p: dict) -> list[str]:
    if mtype == "keywords":
        args = ["keyword_research.py"]
        for s in p.get("seeds", [])[:10]:
            args += ["--seed", s]
        args += ["--rounds", str(int(p.get("rounds", 1))), "--breadth", str(int(p.get("breadth", 6)))]
        return args
    if mtype == "social":
        args = ["social_pulse.py"]
        for q in p.get("queries", [])[:8]:
            args += ["--q", q]
        return args
    if mtype == "competitors":
        return ["competitor_watch.py", "--scan"]
    if mtype == "serp":
        return ["serp_rank.py", "--from-store", "--limit", str(int(p.get("limit", 20)))]
    if mtype == "trends":
        args = ["trends_check.py"]
        for k in p.get("kws", [])[:5]:
            args += ["--kw", k]
        return args + ["--geo", (p.get("geo") or "FR").upper()]
    raise ValueError(mtype)


def run_mission(mid: int) -> None:
    m = _missions[mid]
    slug = m.get("stack") or ""
    cwd = mission_cwd(slug)
    if cwd is None:
        m["status"] = "error"
        m["finished"] = now_iso()
        save_missions()
        return
    os.makedirs(os.path.join(QEYNOX_ROOT, "logs"), exist_ok=True)
    log_path = os.path.join(QEYNOX_ROOT, "logs", f"mission-{mid:04d}.log")
    db = stack_db(slug) if slug and os.path.isdir(os.path.join(STACKS_DIR, slug)) else os.environ.get("GTM_DB", os.path.join(TOOLS_DIR, "data", "gtm.db"))
    env = mission_env(slug, db)
    args = build_args(m["type"], m.get("params", {}))
    script = os.path.join(TOOLS_DIR, args[0])
    try:
        with open(log_path, "w", encoding="utf-8") as log:
            proc = subprocess.Popen([sys.executable, script, *args[1:]],
                                    cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
            m["pid"] = proc.pid
            code = proc.wait()
        m["status"] = "done" if code == 0 else "error"
    except Exception as exc:  # noqa: BLE001
        m["status"] = "error"
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(f"\n[qeynox] erreur lanceur: {exc}\n")
    m["finished"] = now_iso()
    save_missions()


# ---------------------------------------------------------------- DB helpers
def db_rows(slug: str, sql: str, params: tuple = ()) -> list[dict]:
    import sqlite3
    path = stack_db(slug) if slug else os.path.join(TOOLS_DIR, "data", "gtm.db")
    if not os.path.exists(path):
        return []
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, params).fetchall()]
    finally:
        con.close()


def db_scalar(slug: str, sql: str, params: tuple = ()) -> int:
    import sqlite3
    path = stack_db(slug) if slug else os.path.join(TOOLS_DIR, "data", "gtm.db")
    if not os.path.exists(path):
        return 0
    con = sqlite3.connect(path)
    try:
        return int(con.execute(sql, params).fetchone()[0])
    except Exception:
        return 0
    finally:
        con.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "QeyNox/1.0"

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

    def _static(self, rel: str) -> None:
        path = resolve_under(STATIC_DIR, rel.lstrip("/"))
        if not path:
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
        qs = urllib.parse.parse_qs(query)
        if qs.get("stack") and normalize_slug(qs["stack"][0]) is None:
            return self._json({"error": "stack invalide"}, 400)
        try:
            if path in ("/", "/index.html"):
                return self._static("index.html")
            if path.startswith("/static/"):
                return self._static(path[len("/static/"):])
            if path == "/favicon.ico":
                return self._static("favicon.svg")

            if path == "/api/health":
                from engine.research import searxng_available
                return self._json({"searxng": searxng_available(), "time": now_iso()})

            if path == "/api/state":
                slug = (qs.get("stack") or [""])[0]
                runs = []
                for r in db_rows(slug, "SELECT tool, args, started_at, status FROM runs ORDER BY id DESC LIMIT 10"):
                    r["agent"] = AGENT_OF_TOOL.get(r["tool"])
                    runs.append(r)
                running = [m for m in _missions.values() if m["status"] == "running"]
                return self._json({
                    "kpis": {
                        "keywords": db_scalar(slug, "SELECT COUNT(*) FROM keywords"),
                        "keywords_commercial": db_scalar(slug, "SELECT COUNT(*) FROM keywords WHERE intent='commercial'"),
                        "signals": db_scalar(slug, "SELECT COUNT(*) FROM signals"),
                        "serp_checks": db_scalar(slug, "SELECT COUNT(*) FROM serp_runs"),
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
                    dossier_dir = os.path.join(STACKS_DIR, s["slug"], "dossier", "data.json")
                    if os.path.exists(dossier_dir):
                        with open(dossier_dir, encoding="utf-8") as f:
                            s["dossier_data"] = json.load(f)
                return self._json({"rows": rows})

            m = re.match(r"^/api/stacks/([\w-]+)/pipeline$", path)
            if m:
                return self._json({"pipeline": pl.read_pipeline(m.group(1))})

            m = re.match(r"^/api/stacks/([\w-]+)/dossier$", path)
            if m:
                slug = m.group(1)
                dossier_dir = os.path.join(STACKS_DIR, slug, "dossier")
                files = sorted(f for f in os.listdir(dossier_dir) if f.endswith(".md")) if os.path.isdir(dossier_dir) else []
                if not files:
                    return self._json({"error": "pas de dossier"}, 404)
                with open(os.path.join(dossier_dir, files[-1]), encoding="utf-8") as f:
                    return self._json({"file": files[-1], "content": f.read()[:300_000]})

            m = re.match(r"^/api/stacks/([\w-]+)/context$", path)
            if m:
                p = os.path.join(STACKS_DIR, m.group(1), "context", "repo-analysis.json")
                if not os.path.exists(p):
                    return self._json({"error": "pas d'analyse"}, 404)
                with open(p, encoding="utf-8") as f:
                    return self._json({"analysis": json.load(f)})

            if path == "/api/keywords":
                slug = (qs.get("stack") or [""])[0]
                intent = (qs.get("intent") or [""])[0]
                q = (qs.get("q") or [""])[0].lower()
                rows = db_rows(slug, "SELECT kw, intent, score, source, parent, trend, last_seen FROM keywords ORDER BY score DESC LIMIT 1000")
                if intent:
                    rows = [r for r in rows if r["intent"] == intent]
                if q:
                    rows = [r for r in rows if q in r["kw"]]
                return self._json({"rows": rows})

            if path == "/api/signals":
                return self._json({"rows": db_rows((qs.get("stack") or [""])[0],
                                                   "SELECT platform, title, url, snippet, score, seen_at FROM signals ORDER BY score DESC, id DESC LIMIT 200")})

            if path == "/api/serp":
                rows = db_rows((qs.get("stack") or [""])[0],
                               """SELECT kw, position, url, checked_at FROM serp_runs s
                                  WHERE id IN (SELECT MAX(id) FROM serp_runs GROUP BY kw)""")
                rows.sort(key=lambda r: (r["position"] is None, r["position"] if r["position"] is not None else 0, r["kw"]))
                return self._json({"rows": rows[:200]})

            if path == "/api/competitors":
                return self._json({"rows": db_rows((qs.get("stack") or [""])[0],
                                                   """SELECT name, url, MAX(fetched_at) AS last_at, COUNT(*) AS versions
                                                      FROM snapshots GROUP BY name ORDER BY name""")})

            if path == "/api/missions":
                ms = sorted(_missions.values(), key=lambda m: -m["id"])[:100]
                return self._json({"rows": ms, "types": MISSION_TYPES,
                                   "stacks": [{"slug": s["slug"], "name": s["name"], "status": s["status"]}
                                              for s in pl.load_registry() if s["status"] == "active"]})

            m = re.match(r"^/api/missions/(\d+)/log$", path)
            if m:
                mid = int(m.group(1))
                log_path = os.path.join(QEYNOX_ROOT, "logs", f"mission-{mid:04d}.log")
                text = ""
                if os.path.exists(log_path):
                    with open(log_path, encoding="utf-8", errors="replace") as f:
                        text = f.read()[-40_000:]
                return self._json({"id": mid, "log": text, "status": _missions.get(mid, {}).get("status", "?")})

            if path == "/api/reports":
                slug = (qs.get("stack") or [""])[0]
                root = stack_output(slug) if slug else STACKS_DIR
                reports = []
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
                slug = (qs.get("stack") or [""])[0]
                rel = (qs.get("path") or [""])[0]
                root = stack_output(slug) if slug else STACKS_DIR
                fp = resolve_under(root, rel)
                if not fp:
                    return self._json({"error": "introuvable"}, 404)
                with open(fp, encoding="utf-8", errors="replace") as f:
                    return self._json({"path": rel, "content": f.read()[:200_000]})

            if path == "/api/export/keywords.csv":
                import csv as _csv
                import io as _io
                slug = (qs.get("stack") or [""])[0]
                rows = db_rows(slug, "SELECT kw, intent, score, source, parent, trend FROM keywords ORDER BY score DESC")
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
        try:
            if self.path == "/api/stacks":
                body = self._body()
                name = str(body.get("name", "")).strip()
                source = str(body.get("source", "")).strip()
                if not name or not source:
                    return self._json({"error": "nom et source requis"}, 400)
                seeds = [s.strip() for s in body.get("seeds", []) if isinstance(s, str) and s.strip()][:8]
                created = pl.create_stack(name, source, str(body.get("site_url", "")).strip(), seeds)
                pl.init_pipeline(created["slug"])
                pl.start_pipeline_async(created["slug"], {"source": source, "name": name,
                                                          "site_url": body.get("site_url", ""), "seeds": seeds})
                return self._json({"ok": True, "stack": created}, 201)

            m = re.match(r"^/api/stacks/([\w-]+)/validate$", self.path)
            if m:
                result = launch_mod.validate_stack(m.group(1))
                return self._json(result, 200 if result.get("ok") else 400)

            if self.path == "/api/missions":
                body = self._body()
                mtype = body.get("type", "")
                if mtype not in MISSION_TYPES:
                    return self._json({"error": "type de mission inconnu"}, 400)
                params = body.get("params", {}) or {}
                if mtype == "keywords" and not [s for s in params.get("seeds", []) if s.strip()]:
                    return self._json({"error": "au moins une graine requise"}, 400)
                if mtype == "trends" and not params.get("kws"):
                    return self._json({"error": "au moins un mot-clé requis"}, 400)
                params["seeds"] = [s.strip() for s in params.get("seeds", []) if isinstance(s, str) and s.strip()]
                params["queries"] = [s.strip() for s in params.get("queries", []) if isinstance(s, str) and s.strip()]
                params["kws"] = [s.strip() for s in params.get("kws", []) if isinstance(s, str) and s.strip()]
                stack = str(body.get("stack") or "")
                if normalize_slug(stack) is None:
                    return self._json({"error": "stack invalide"}, 400)
                with _lock:
                    mid = (max(_missions, default=0)) + 1
                    m = {"id": mid, "type": mtype, "label": MISSION_TYPES[mtype]["label"],
                         "agent": MISSION_TYPES[mtype]["agent"], "stack": stack,
                         "params": params, "status": "running", "started": now_iso(), "finished": None}
                    _missions[mid] = m
                save_missions()
                threading.Thread(target=run_mission, args=(mid,), daemon=True).start()
                return self._json({"ok": True, "mission": m}, 201)

            if self.path == "/api/hooks/agent":
                if HOOK_TOKEN and self.headers.get("X-Lumira-Token") != HOOK_TOKEN:
                    return self._json({"error": "token invalide"}, 401)
                body = self._body()
                slug = re.sub(r"[^\w-]", "", str(body.get("stack", "")))
                out_root = stack_output(slug) if slug else os.path.join(QEYNOX_ROOT, "output")
                os.makedirs(out_root, exist_ok=True)
                fn = f"agent-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.md"
                with open(os.path.join(out_root, fn), "w", encoding="utf-8") as f:
                    f.write(f"# {body.get('title', 'Livrable agent')}\n\n> Poussé par **{body.get('agent','agent')}**\n\n{body.get('body_md','')}\n")
                return self._json({"ok": True, "file": fn}, 201)

            return self._json({"error": "introuvable"}, 404)
        except Exception as exc:  # noqa: BLE001
            return self._json({"error": str(exc)}, 500)


def main() -> None:
    load_missions()
    os.makedirs(os.path.join(QEYNOX_ROOT, "logs"), exist_ok=True)
    host, port = bind_address()
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"⬡ QeyNox — plateforme GTM swarm — http://{host}:{port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
