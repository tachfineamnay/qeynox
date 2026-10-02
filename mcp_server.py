#!/usr/bin/env python3
"""QeyNox MCP Server — expose la base GTM à tous vos agents (protocole MCP, stdio JSON-RPC 2.0).

Branchements:
    Claude Code : claude mcp add qeynox -- python3 /chemin/qeynox/mcp_server.py
    OpenClaw / Hermes / tout client MCP : command = python3, args = [mcp_server.py]

Outils exposés:
    list_stacks, get_stack_summary, get_keywords, get_signals, get_competitors,
    get_aeo, get_dossier, get_synthesis, launch_tool, propose_decision

Environnement : QEYNOX_ROOT (défaut: dossier parent de ce fichier).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sqlite3
import sys
from datetime import datetime, timezone

ROOT = os.environ.get("QEYNOX_ROOT") or os.path.dirname(os.path.abspath(__file__))
STACKS = os.path.join(ROOT, "stacks")
TOOLS = os.path.join(ROOT, "tools")
sys.path.insert(0, ROOT)

SERVER_INFO = {"name": "qeynox", "version": "1.0.0"}
PROTOCOL = "2024-11-05"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def db_rows(slug: str, sql: str, params: tuple = ()) -> list[dict]:
    path = os.path.join(STACKS, slug, "data", "gtm.db")
    if not os.path.exists(path):
        return []
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, params).fetchall()]
    finally:
        con.close()


def read_json(path: str) -> dict:
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def registry() -> list[dict]:
    p = os.path.join(STACKS, "registry.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else data.get("rows", [])
    return []


# ------------------------------------------------------------------ outils
def tool_list_stacks(_: dict) -> str:
    rows = registry()
    return json.dumps([{"slug": s.get("slug"), "name": s.get("name"), "status": s.get("status"),
                        "site": s.get("site_url")} for s in rows], ensure_ascii=False)


def tool_get_stack_summary(a: dict) -> str:
    slug = a["slug"]
    entry = next((s for s in registry() if s.get("slug") == slug), {})
    pipe = read_json(os.path.join(STACKS, slug, "pipeline.json"))
    ctx = read_json(os.path.join(STACKS, slug, "context", "repo-analysis.json"))
    kw = read_json(os.path.join(STACKS, slug, "research", "keywords.json"))
    sig = read_json(os.path.join(STACKS, slug, "research", "signals.json"))
    aeo = read_json(os.path.join(STACKS, slug, "research", "aeo.json"))
    return json.dumps({
        "slug": slug, "status": entry.get("status"), "brand": ctx.get("brand", {}).get("guess"),
        "site": ctx.get("site_url"), "prices": ctx.get("product", {}).get("prices"),
        "pipeline_status": pipe.get("status"),
        "n_keywords": len(kw.get("top", [])), "n_signals": len(sig.get("signals", [])),
        "aeo_score": aeo.get("score"), "aeo_max": aeo.get("max_score"),
    }, ensure_ascii=False)


def tool_get_keywords(a: dict) -> str:
    sql = "SELECT kw, intent, score, source FROM keywords"
    params: list = []
    if a.get("intent"):
        sql += " WHERE intent = ?"
        params.append(a["intent"])
    sql += " ORDER BY score DESC LIMIT ?"
    params.append(int(a.get("limit", 20)))
    return json.dumps(db_rows(a["slug"], sql, tuple(params)), ensure_ascii=False)


def tool_get_signals(a: dict) -> str:
    return json.dumps(db_rows(a["slug"],
                              "SELECT platform, title, url, snippet, score FROM signals ORDER BY score DESC, id DESC LIMIT ?",
                              (int(a.get("limit", 10)),)), ensure_ascii=False)


def tool_get_competitors(a: dict) -> str:
    data = read_json(os.path.join(STACKS, a["slug"], "research", "competitors.json"))
    return json.dumps({"category": data.get("category_query"),
                       "confidence": data.get("confidence", "ok"),
                       "competitors": data.get("competitors", [])}, ensure_ascii=False)


def tool_get_aeo(a: dict) -> str:
    return json.dumps(read_json(os.path.join(STACKS, a["slug"], "research", "aeo.json")), ensure_ascii=False)


def tool_get_dossier(a: dict) -> str:
    d = os.path.join(STACKS, a["slug"], "dossier")
    files = sorted(f for f in os.listdir(d) if f.endswith(".md")) if os.path.isdir(d) else []
    if not files:
        return "aucun dossier pour ce stack"
    with open(os.path.join(d, files[-1]), encoding="utf-8") as f:
        return f.read()[: int(a.get("max_chars", 20000))]


def tool_get_synthesis(a: dict) -> str:
    return json.dumps(read_json(os.path.join(STACKS, a["slug"], "research", "synthesis.json")), ensure_ascii=False)


def tool_launch_tool(a: dict) -> str:
    """Lance un outil du swarm en tâche de fond (keywords|social|competitors|serp|trends)."""
    slug, tool = a["slug"], a.get("tool", "keywords")
    scripts = {
        "keywords": (["keyword_research.py"], ["--seed"]),
        "social": (["social_pulse.py"], ["--q"]),
        "competitors": (["competitor_watch.py"], ["--scan"]),
        "serp": (["serp_rank.py"], ["--kw"]),
        "trends": (["trends_check.py"], ["--kw"]),
    }
    if tool not in scripts:
        return f"outil inconnu: {tool} (choix: {', '.join(scripts)})"
    script, flag = scripts[tool]
    args = [sys.executable, os.path.join(TOOLS, script[0])]
    items = a.get("seeds") or a.get("queries") or a.get("kws") or []
    if tool == "competitors":
        args.append("--scan")
    else:
        for it in (items or [])[:10]:
            args += [flag, str(it)]
        if tool == "serp":
            args = [sys.executable, os.path.join(TOOLS, "serp_rank.py"),
                    "--from-store", "--limit", str(int(a.get("limit", 20)))]
        if tool == "trends":
            args += ["--geo", str(a.get("geo", "FR"))]
    db = os.path.join(STACKS, slug, "data", "gtm.db")
    cwd = os.path.join(STACKS, slug)
    os.makedirs(cwd, exist_ok=True)
    os.makedirs(os.path.join(ROOT, "logs"), exist_ok=True)
    log_path = os.path.join(ROOT, "logs", f"mcp-{slug}-{tool}-{datetime.now().strftime('%H%M%S')}.log")
    env = {**os.environ, "GTM_DB": db, "GTM_LANG": "fr", "GTM_GL": "FR"}
    with open(log_path, "w") as log:
        subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    return f"{tool} lancé pour {slug} (log: {os.path.relpath(log_path, ROOT)})"


def tool_propose_decision(a: dict) -> str:
    """Un agent propose une décision → l'admin la retrouve dans les Rapports du stack."""
    slug = a["slug"]
    safe = re.sub(r"[^\wÀ-ÿ \-':!?]", "", str(a.get("title", "Proposition")))[:80]
    out = os.path.join(STACKS, slug, "output")
    os.makedirs(out, exist_ok=True)
    fn = f"decision-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.md"
    with open(os.path.join(out, fn), "w", encoding="utf-8") as f:
        f.write(f"# 🗳️ {safe}\n\n> Proposé via MCP — {now_iso()}\n\n{a.get('body_md', '')}\n")
    return f"décision enregistrée: stacks/{slug}/output/{fn} (en attente de validation admin)"


TOOLS = {
    "list_stacks": (tool_list_stacks, "Liste les stacks QeyNox (slug, nom, statut).", {"type": "object", "properties": {}}),
    "get_stack_summary": (tool_get_stack_summary, "Synthèse d'un stack: marque, site, prix, pipeline, compteurs, AEO.",
                          {"type": "object", "properties": {"slug": {"type": "string"}}, "required": ["slug"]}),
    "get_keywords": (tool_get_keywords, "Mots-clés scorés d'un stack (filtre intent: commercial|info|transactional|brand).",
                     {"type": "object", "properties": {"slug": {"type": "string"}, "intent": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["slug"]}),
    "get_signals": (tool_get_signals, "Verbatims/signaux de marché d'un stack.",
                    {"type": "object", "properties": {"slug": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["slug"]}),
    "get_competitors": (tool_get_competitors, "Concurrents détectés + confiance de la donnée.",
                        {"type": "object", "properties": {"slug": {"type": "string"}}, "required": ["slug"]}),
    "get_aeo": (tool_get_aeo, "Audit AEO/GEO (score, checks, recommandations).",
                {"type": "object", "properties": {"slug": {"type": "string"}}, "required": ["slug"]}),
    "get_dossier": (tool_get_dossier, "Le dossier GTM complet (markdown).",
                    {"type": "object", "properties": {"slug": {"type": "string"}, "max_chars": {"type": "integer"}}, "required": ["slug"]}),
    "get_synthesis": (tool_get_synthesis, "La synthèse stratégique LLM du stack.",
                      {"type": "object", "properties": {"slug": {"type": "string"}}, "required": ["slug"]}),
    "launch_tool": (tool_launch_tool, "Lance un outil du swarm en fond (keywords|social|competitors|serp|trends).",
                    {"type": "object", "properties": {"slug": {"type": "string"}, "tool": {"type": "string"},
                                                      "seeds": {"type": "array", "items": {"type": "string"}},
                                                      "queries": {"type": "array", "items": {"type": "string"}},
                                                      "kws": {"type": "array", "items": {"type": "string"}},
                                                      "geo": {"type": "string"}, "limit": {"type": "integer"}},
                     "required": ["slug", "tool"]}),
    "propose_decision": (tool_propose_decision, "Propose une décision à l'admin (human-in-the-loop). Elle apparaît dans ses Rapports.",
                         {"type": "object", "properties": {"slug": {"type": "string"}, "title": {"type": "string"}, "body_md": {"type": "string"}},
                          "required": ["slug", "title", "body_md"]}),
}


# ------------------------------------------------------------------ protocole
def handle(msg: dict) -> dict | None:
    method = msg.get("method", "")
    mid = msg.get("id")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": msg.get("params", {}).get("protocolVersion") or PROTOCOL,
            "capabilities": {"tools": {}}, "serverInfo": SERVER_INFO}}
    if method.startswith("notifications/"):
        return None
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": [
            {"name": n, "description": d, "inputSchema": s} for n, (_f, d, s) in TOOLS.items()]}}
    if method == "tools/call":
        params = msg.get("params", {})
        name, args = params.get("name", ""), params.get("arguments", {}) or {}
        entry = TOOLS.get(name)
        if not entry:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"outil inconnu: {name}"}}
        try:
            text = entry[0](args)
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": str(text)}], "isError": False}}
        except Exception as exc:  # noqa: BLE001
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": f"erreur: {exc}"}], "isError": True}}
    if mid is not None:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"méthode inconnue: {method}"}}
    return None


def serve() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        resp = handle(msg)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    serve()
