#!/usr/bin/env python3
"""QeyNox — Orchestration du pipeline d'onboarding + registre des stacks.

Pipeline : clone → scan → keywords → signals → competitors → aeo → dossier
Chaque stage : status = running | done | error | skipped, log capturé dans pipeline.json.
"""
from __future__ import annotations

import json
import os
import re
import threading
import traceback
from datetime import datetime, timezone

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
STACKS_DIR = os.path.join(ENGINE_DIR, "..", "stacks")
REGISTRY = os.path.join(STACKS_DIR, "registry.json")

_pipeline_lock = threading.Lock()  # un pipeline à la fois (outils partagés)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40]
    return s or "stack"


def redact_source(source: str) -> str:
    """Retire les credentials HTTP(S) d'une source avant persistance/log."""
    return re.sub(r"(?i)^(https?://)[^/@\\s]+@", r"\\1", str(source or ""))


def load_registry() -> list[dict]:
    if os.path.exists(REGISTRY):
        with open(REGISTRY, encoding="utf-8") as f:
            return json.load(f)
    return []


def save_registry(rows: list[dict]) -> None:
    os.makedirs(STACKS_DIR, exist_ok=True)
    with open(REGISTRY, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)


def get_stack(slug: str) -> dict | None:
    for s in load_registry():
        if s["slug"] == slug:
            return s
    return None


def pipeline_path(slug: str) -> str:
    return os.path.join(STACKS_DIR, slug, "pipeline.json")


def init_pipeline(slug: str) -> dict:
    stages = [
        ("clone", "Récupération du dépôt"),
        ("scan", "Analyse statique & contexte produit"),
        ("keywords", "Deep research — univers de mots-clés"),
        ("signals", "Deep research — signaux & verbatims"),
        ("competitors", "Deep research — concurrents"),
        ("aeo", "Audit AEO/GEO du site"),
        ("synthese", "Synthèse stratégique IA (LLM)"),
        ("dossier", "Consolidation du dossier GTM"),
    ]
    pipe = {"slug": slug, "status": "running", "updated": now_iso(),
            "stages": [{"id": sid, "label": label, "status": "pending",
                        "started": None, "finished": None, "log": ""} for sid, label in stages]}
    write_pipeline(slug, pipe)
    return pipe


def write_pipeline(slug: str, pipe: dict) -> None:
    pipe["updated"] = now_iso()
    with open(pipeline_path(slug), "w", encoding="utf-8") as f:
        json.dump(pipe, f, ensure_ascii=False, indent=1)


def read_pipeline(slug: str) -> dict | None:
    if os.path.exists(pipeline_path(slug)):
        with open(pipeline_path(slug), encoding="utf-8") as f:
            return json.load(f)
    return None


def run_pipeline(slug: str, cfg: dict) -> None:
    """Exécute tout le pipeline d'onboarding (bloquant — à lancer en thread/CLI)."""
    from engine import repo_scan, research, dossier as dossier_mod, synthesize  # imports tardifs

    with _pipeline_lock:
        reg = get_stack(slug)
        pipe = read_pipeline(slug) or init_pipeline(slug)
        pipe["status"] = "running"
        write_pipeline(slug, pipe)
        stack_dir = os.path.join(STACKS_DIR, slug)
        os.makedirs(stack_dir, exist_ok=True)

        def mark(stage_id: str, status: str, log: str = "") -> None:
            for st in pipe["stages"]:
                if st["id"] == stage_id:
                    st["status"] = status
                    st["finished"] = now_iso()
                    if status == "running":
                        st["started"] = now_iso()
                    if log:
                        st["log"] = log[-8000:]
            write_pipeline(slug, pipe)

        analysis = None
        try:
            # 1. récupération du dépôt
            mark("clone", "running")
            repo_path, repo_mode = repo_scan.prepare_repo(cfg["source"], os.path.join(stack_dir, "repo"))
            mark("clone", "done", f"{repo_path} (mode: {repo_mode})")

            # 2. analyse statique
            mark("scan", "running")
            analysis = repo_scan.scan_repo(repo_path)
            analysis["source"] = redact_source(cfg["source"])
            analysis["source_mode"] = repo_mode
            if cfg.get("name"):  # le nom donné par l'admin est la marque de référence
                analysis["brand"]["guess"] = cfg["name"]
                analysis["brand"]["admin_provided"] = True
            ctx_dir = os.path.join(stack_dir, "context")
            os.makedirs(ctx_dir, exist_ok=True)
            with open(os.path.join(ctx_dir, "repo-analysis.json"), "w", encoding="utf-8") as f:
                json.dump(analysis, f, ensure_ascii=False, indent=1)
            mark("scan", "done", f"marque: {analysis['brand']['guess']} · {analysis.get('n_files', 0)} fichiers · stack: {', '.join(analysis.get('manifests', {}).get('frameworks', [])[:5]) or '—'}")

            # site_url fourni par l'admin > détection
            if cfg.get("site_url"):
                analysis["site_url"] = cfg["site_url"]
                with open(os.path.join(stack_dir, "context", "repo-analysis.json"), "w", encoding="utf-8") as f:
                    json.dump(analysis, f, ensure_ascii=False, indent=1)

            # 3-6. deep research
            seeds = cfg.get("seeds") or []
            for sid, fn in [("keywords", research.stage_keywords), ("signals", research.stage_signals),
                            ("competitors", research.stage_competitors), ("aeo", research.stage_aeo)]:
                mark(sid, "running")
                try:
                    if sid == "keywords":
                        res = fn(slug, analysis, seeds)
                        mark(sid, "done", f"{len(res.get('top', []))} mots-clés · graines: {', '.join(res.get('seeds', []))}")
                    elif sid == "signals":
                        res = fn(slug, analysis, seeds)
                        mark(sid, "done", f"{len(res.get('signals', []))} signaux via {res.get('engine')}")
                    elif sid == "competitors":
                        res = fn(slug, analysis, seeds)
                        mark(sid, "done", f"{len(res.get('competitors', []))} concurrents analysés")
                    else:
                        res = fn(slug, analysis)
                        mark(sid, "done" if res.get("reachable") else "skipped",
                             f"score {res.get('score', '?')}/{res.get('max_score', '?')}")
                except Exception as exc:
                    mark(sid, "error", "".join(traceback.format_exception_only(type(exc), exc))[:500])

            # 6bis. synthèse IA (skippée proprement si aucun LLM configuré)
            mark("synthese", "running")
            try:
                res_s = synthesize.stage_synthese(slug, analysis)
                mark("synthese", res_s.get("status", "done"), res_s.get("note", ""))
            except Exception as exc:
                mark("synthese", "error", str(exc)[:300])

            # 7. dossier
            mark("dossier", "running")
            out = dossier_mod.build_dossier(slug, cfg.get("name", slug))
            mark("dossier", "done", os.path.relpath(out["path"], stack_dir))

            pipe["status"] = "review"  # dossier prêt → attend la validation admin
            write_pipeline(slug, pipe)
            # registre
            rows = load_registry()
            for s in rows:
                if s["slug"] == slug:
                    s["status"] = "ready_for_review"
                    s["aeo_score"] = out["data"].get("aeo_score")
                    s["counts"] = {k: out["data"].get(k) for k in ("n_keywords", "n_signals", "n_competitors")}
                    s["brand"] = out["data"].get("brand")
                    s["site_url"] = out["data"].get("site")
            save_registry(rows)
        except Exception as exc:
            pipe["status"] = "error"
            pipe["error"] = str(exc)[:500]
            write_pipeline(slug, pipe)
            rows = load_registry()
            for s in rows:
                if s["slug"] == slug:
                    s["status"] = "error"
            save_registry(rows)


def start_pipeline_async(slug: str, cfg: dict) -> None:
    threading.Thread(target=run_pipeline, args=(slug, cfg), daemon=True).start()


def create_stack(name: str, source: str, site_url: str = "", seeds: list[str] | None = None) -> dict:
    base = slugify(name)
    slug, i = base, 2
    while get_stack(slug):
        slug = f"{base}-{i}"
        i += 1
    rows = load_registry()
    rows.append({
        "slug": slug, "name": name, "source": redact_source(source), "site_url": site_url,
        "seeds": seeds or [], "status": "queued", "created_at": now_iso(),
    })
    save_registry(rows)
    os.makedirs(os.path.join(STACKS_DIR, slug), exist_ok=True)
    return {"slug": slug, "name": name}
