#!/usr/bin/env python3
"""QeyNox — Validation admin : transforme un dossier validé en swarm opérationnel.

Crée stacks/<slug>/swarm/ :
  BUSINESS.md          → contexte produit pour les agents (source de vérité)
  personas.md          → personas validés pour les skills contenu/social
  keywords-seeds.json  → graines validées pour les missions mots-clés
  missions-suggested.json → les 5 premières missions à lancer
Et passe le statut du stack à "active".
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
STACKS_DIR = os.path.join(ENGINE_DIR, "..", "stacks")


def _load(stack: str, name: str, folder: str) -> dict:
    p = os.path.join(STACKS_DIR, stack, folder, f"{name}.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return {}


def validate_stack(slug: str) -> dict:
    ctx = _load(slug, "repo-analysis", "context")
    dossier = _load(slug, "data", "dossier")
    kws = _load(slug, "keywords", "research")
    if not ctx and not dossier:
        return {"ok": False, "error": "Aucun dossier à valider — lancez d'abord le pipeline."}
    brand = (dossier or {}).get("brand") or ctx.get("brand", {}).get("guess", slug)
    swarm_dir = os.path.join(STACKS_DIR, slug, "swarm")
    os.makedirs(swarm_dir, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%d/%m/%Y")

    prices = (dossier or {}).get("prices", "—")
    site = (dossier or {}).get("site", "—")
    tech = (dossier or {}).get("stack_tech", "—")
    business_md = f"""# BUSINESS.md — {brand} (généré par QeyNox, validé par l'admin le {today})

> Source de vérité produit pour tous les agents de ce stack. Si une info contredit
> la réalité, signaler l'écart à l'admin — ne jamais improviser.

## Offre
- **Produit/Marque** : {brand}
- **Site** : {site}
- **Prix détectés** : {prices}
- **Stack technique** : {tech}

## Promesses (extraites du dépôt)
{chr(10).join('- ' + h for h in ctx.get('product', {}).get('taglines_h1', [])[:4]) or '- (voir site)'}

## Arguments (H2 du site)
{chr(10).join('- ' + h for h in ctx.get('product', {}).get('value_props_h2', [])[:8]) or '- (voir site)'}

## Contacts & canaux détectés
- Emails : {', '.join(ctx.get('product', {}).get('emails', [])) or '—'}
- Réseaux : {', '.join(sorted(ctx.get('product', {}).get('socials', {}).keys())) or '—'}

## Règles du swarm (rappel)
- Approbation admin obligatoire : publications, emails, dépenses.
- Aucune donnée client réelle dans les contenus.
- Pas de promesse prédictive/médicale/financière.
"""
    personas_md = "# Personas validés\n\n" + "\n\n".join(
        f"## {p['id']} — {p['nom']}\n- **Hypothèse** : {p['hypothese']}\n- **Angle** : {p['angle_marketing']}\n- **Canaux** : {p['canaux']}\n"
        + ("- Verbatims:\n" + "\n".join(f"  > « {(t + ' — ' + sn)[:200]} » ({u})" for t, sn, u in p.get("verbatims", [])) if p.get("verbatims") else "- Verbatims: —")
        for p in (dossier or {}).get("personas", []))

    seeds = [k["kw"] for k in (kws or {}).get("top", []) if k.get("intent") in ("commercial", "transactional")][:8] \
        or [k["kw"] for k in (kws or {}).get("top", [])][:8]
    with open(os.path.join(swarm_dir, "BUSINESS.md"), "w", encoding="utf-8") as f:
        f.write(business_md)
    with open(os.path.join(swarm_dir, "personas.md"), "w", encoding="utf-8") as f:
        f.write(personas_md)
    with open(os.path.join(swarm_dir, "keywords-seeds.json"), "w", encoding="utf-8") as f:
        json.dump({"validated_seeds": seeds}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(swarm_dir, "missions-suggested.json"), "w", encoding="utf-8") as f:
        json.dump([
            {"type": "keywords", "label": "Enrichir l'univers de mots-clés (graines validées)", "params": {"seeds": seeds[:5], "rounds": 1, "breadth": 6}},
            {"type": "social", "label": "Scanner les signaux de la semaine", "params": {"queries": []}},
            {"type": "competitors", "label": "Veille concurrents hebdo", "params": {}},
            {"type": "serp", "label": "Vérifier les positions sur les mots-clés top", "params": {"limit": 20}},
        ], f, ensure_ascii=False, indent=1)

    # registre → active
    from engine.pipeline import load_registry, save_registry
    rows = load_registry()
    for s in rows:
        if s["slug"] == slug:
            s["status"] = "active"
            s["activated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    save_registry(rows)
    return {"ok": True, "files": sorted(os.listdir(swarm_dir)), "swarm_dir": swarm_dir}
