#!/usr/bin/env python3
"""QeyNox — Stage « Synthèse IA » : le LLM transforme la recherche brute en stratégie.

Chaîne de fournisseurs (config par env, aucune clé obligatoire) :
    QEYNOX_LLM = auto | ollama | openai | none     (défaut: auto → ollama si joignable, sinon skip)
    QEYNOX_LLM_MODEL   (ollama: défaut "mistral" ; openai-compat: défaut "gpt-4o-mini")
    QEYNOX_OLLAMA_URL  (défaut http://127.0.0.1:11434)
    QEYNOX_LLM_BASEURL (openai-compat, défaut https://api.openai.com/v1)
    QEYNOX_LLM_API_KEY

Entrée : research/*.json + context/repo-analysis.json
Sortie : research/synthesis.json  (consommé par dossier.py → section « Synthèse stratégique IA »)
Sans LLM configuré → status "skipped", le dossier reste 100 % déterministe.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
STACKS_DIR = os.path.join(ENGINE_DIR, "..", "stacks")


def _load(stack: str, name: str) -> dict:
    p = os.path.join(STACKS_DIR, stack, "research", f"{name}.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return {}


def _context(stack: str) -> dict:
    p = os.path.join(STACKS_DIR, stack, "context", "repo-analysis.json")
    ctx = {}
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            ctx = json.load(f)
    return ctx


def _clip(text: str, n: int) -> str:
    return (text or "")[:n]


def build_prompt(stack: str) -> str:
    ctx = _context(stack)
    kw = _load(stack, "keywords")
    sig = _load(stack, "signals")
    comp = _load(stack, "competitors")
    aeo = _load(stack, "aeo")

    kws = "\n".join(f"- {k['kw']} ({k.get('intent','?')}, score {k.get('score',0)})"
                    for k in (kw.get("top") or [])[:25])
    sigs = "\n".join(f"- [{s['platform']}] {_clip(s['title'] + ' — ' + s['snippet'], 160)}"
                     for s in (sig.get("signals") or [])[:15])
    comps = "\n".join(f"- {c['domain']} ({c.get('mentions',0)} mentions, prix: {', '.join(c.get('prices_spotted', [])[:3]) or '—'})"
                      for c in (comp.get("competitors") or [])[:8])
    aeo_s = f"{aeo.get('score','?')}/{aeo.get('max_score','?')} — manques: " + \
        ", ".join(c["id"] for c in aeo.get("checks", []) if not c["ok"])

    return f"""Tu es un stratège GTM senior. À partir UNIQUEMENT des données ci-dessous (recherche réelle), produis une synthèse stratégique. Français. Aucune invention : si une donnée manque, écris "donnée insuffisante".

## PRODUIT
Marque: {ctx.get('brand', {}).get('guess', stack)}
Promesses: {_clip(' | '.join(ctx.get('product', {}).get('taglines_h1', [])), 300)}
Arguments: {_clip(' | '.join(ctx.get('product', {}).get('value_props_h2', []), ), 400)}
Prix détectés: {', '.join(ctx.get('product', {}).get('prices', [])) or 'non détecté'}
Site: {ctx.get('site_url', '—')}

## MOTS-CLÉS (top)
{kws or '- aucun'}

## SIGNAUX MARCHÉ (verbatims)
{sigs or '- aucun'}

## CONCURRENTS
{comps or '- aucun'}

## AUDIT AEO/GEO
{aeo_s}

Réponds STRICTEMENT en JSON valide (sans markdown), structure:
{{
 "resume_executif": "5 phrases max",
 "personas": [{{"id":"P1","nom":"...","hypothese":"...","peurs":["..."],"questions":["..."],"angle":"...","canaux":"...","confiance":0.6}}],
 "angles_positionnement": [{{"nom":"...","promesse":"...","preuve":"..."}}],
 "quick_wins": ["5 actions classées par ROI/effort"],
 "risques": ["3 risques concrets"]
}}"""


def _extract_json(text: str) -> dict:
    text = re.sub(r"```(?:json)?|```", "", text).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("pas de JSON dans la réponse")
    return json.loads(text[start:end + 1])


def _try_ollama(model: str) -> tuple[dict, str] | None:
    url = os.environ.get("QEYNOX_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/") + "/api/chat"
    body = json.dumps({"model": model, "stream": False,
                       "messages": [{"role": "user", "content": PROMPT[0]}],
                       "options": {"temperature": 0.4}}).encode()
    try:
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.loads(r.read().decode())
        content = data.get("message", {}).get("content", "")
        return _extract_json(content), f"ollama/{model}"
    except Exception:
        return None


def _try_openai(model: str) -> tuple[dict, str] | None:
    base = os.environ.get("QEYNOX_LLM_BASEURL", "https://api.openai.com/v1").rstrip("/")
    key = os.environ.get("QEYNOX_LLM_API_KEY", "")
    if not key:
        return None
    body = json.dumps({"model": model, "temperature": 0.4,
                       "messages": [{"role": "user", "content": PROMPT[0]}],
                       "response_format": {"type": "json_object"}}).encode()
    try:
        req = urllib.request.Request(base + "/chat/completions", data=body,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read().decode())
        content = data["choices"][0]["message"]["content"]
        return _extract_json(content), f"openai-compat/{model}"
    except Exception:
        return None


PROMPT = [""]
MODE = ["none"]


def stage_synthese(stack: str, analysis: dict) -> dict:
    mode = os.environ.get("QEYNOX_LLM", "auto").lower()
    out_dir = os.path.join(STACKS_DIR, stack, "research")
    os.makedirs(out_dir, exist_ok=True)

    def save(status: str, note: str, payload: dict | None = None, provider: str = "") -> dict:
        result = {"status": status, "note": note, "provider": provider, "payload": payload or {}}
        with open(os.path.join(out_dir, "synthesis.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        return result

    if mode == "none":
        return save("skipped", "QEYNOX_LLM=none — dossier déterministe (configurez ollama|openai pour activer la synthèse IA)")

    PROMPT[0] = build_prompt(stack)
    chain: list[tuple[str, str]] = []
    if mode in ("auto", "ollama"):
        chain.append(("ollama", os.environ.get("QEYNOX_LLM_MODEL", "mistral")))
    if mode in ("auto", "openai"):
        chain.append(("openai", os.environ.get("QEYNOX_LLM_MODEL", "gpt-4o-mini")))

    for kind, model in chain:
        if kind == "ollama":
            got = _try_ollama(model)
        else:
            got = _try_openai(model)
        if got:
            payload, provider = got
            return save("done", f"synthèse générée via {provider}", payload, provider)

    if mode == "auto":
        return save("skipped", "aucun LLM joignable (Ollama éteint, pas de clé API) — dossier déterministe")
    return save("error", f"fournisseur {mode} injoignable ou réponse invalide")


if __name__ == "__main__":
    import sys
    st = sys.argv[1]
    print(json.dumps(stage_synthese(st, _context(st)), ensure_ascii=False)[:600])
