#!/usr/bin/env python3
"""QeyNox — Consolidation : personas, besoins, dossier GTM complet prêt pour validation admin.

Entrées : context/repo-analysis.json + research/*.json
Sorties : dossier/gtm-dossier-<date>.md (+ dossier/data.json pour l'UI)
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
STACKS_DIR = os.path.join(ENGINE_DIR, "..", "stacks")


def _load(stack: str, name: str):
    p = os.path.join(STACKS_DIR, stack, "research", f"{name}.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return None


def _load_ctx(stack: str) -> dict:
    with open(os.path.join(STACKS_DIR, stack, "context", "repo-analysis.json"), encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- personas
def build_personas(stack: str, ctx: dict, signals: dict | None, kws: dict | None) -> list[dict]:
    """Personas heuristiques ancrés dans les données réelles (verbatims + questions).
    Hypothèses à valider par l'admin — jamais présentées comme des faits."""
    # le « marché » = 1re graine de recherche réelle si dispo, sinon mots du contexte
    kws_seeds = (kws or {}).get("seeds") or []
    noun = kws_seeds[0] if kws_seeds else (" ".join(ctx["product"]["category_words"][:2]) or ctx["brand"]["guess"])
    questions = [k["kw"] for k in (kws or {}).get("top", []) if any(
        q in k["kw"] for q in ("comment", "pourquoi", "quel", "que ", "est-ce"))][:8]
    verbatims = [(s["title"], s["snippet"], s["url"]) for s in (signals or {}).get("signals", [])][:20]
    joined = " ".join(t + " " + sn for t, sn, _u in verbatims).lower()

    def has(*words: str) -> bool:
        return any(w in joined for w in words)

    def verbatims_with(*words: str, limit: int = 3) -> list[tuple[str, str, str]]:
        out = [(t, sn, u) for t, sn, u in verbatims if any(w in (t + " " + sn).lower() for w in words)]
        return out[:limit]

    personas = []
    # P1 — le pragmatique méfiant (présence de signaux de confiance)
    p1_quotes = verbatims_with("avis", "arnaque", "fiable", "scam", "légitime", "sérieux")
    personas.append({
        "id": "P1", "nom": "Le Pragmatique méfiant",
        "hypothese": f"Cherche {noun} mais redoute les arnaques et le attrape-touristes ; compare avant d'acheter.",
        "signaux": {
            "peurs": [w for w in ("arnaque", "fiable", "scam", "rembours", "légitime") if w in joined] or ["qualité/incertitude non documentée dans les signaux"],
            "questions": questions[:4],
        },
        "verbatims": p1_quotes,
        "angle_marketing": "Transparence radicale : preuve, process, garanties, avis vérifiables.",
        "canaux": "Recherche Google (« avis », « fiable »), comparatifs, Trustpilot, Reddit.",
    })
    # P2 — l'optimiste curieux (prix/gratuit/découverte)
    p2_quotes = verbatims_with("gratuit", "prix", "pas cher", "offre", "essai", "promo")
    personas.append({
        "id": "P2", "nom": "Le Curieux sensible au prix",
        "hypothese": f"Découvre {noun} par curiosité ; sensible à une offre d'entrée basse friction.",
        "signaux": {
            "peurs": [w for w in ("gratuit", "prix", "essai", "abonnement") if w in joined] or ["prix non documentés dans les signaux"],
            "questions": questions[4:8],
        },
        "verbatims": p2_quotes,
        "angle_marketing": "Offre d'essai/entrée à prix doux + valeur immédiate démontrée.",
        "canaux": "TikTok/Reels, Pinterest, requêtes « gratuit », contenus de découverte.",
    })
    # P3 — l'engagé en quête de sens (émotion/besoin profond)
    p3_quotes = verbatims_with("besoin", "recommande", "j'adore", "incroyable", "aide", "conseil", "meilleur")
    personas.append({
        "id": "P3", "nom": "L'Engagé en quête de sens",
        "hypothese": f"Recherche le meilleur {noun} pour un besoin réel ; prêt à s'engager si la promesse est profonde et humaine.",
        "signaux": {
            "peurs": [w for w in ("déçu", "problème", "besoin", "conseil") if w in joined] or ["attente de profondeur non mesurable dans les signaux"],
            "questions": questions[:3] + questions[4:6],
        },
        "verbatims": p3_quotes,
        "angle_marketing": "Narration + communauté + preuve d'expertise humaine derrière le produit.",
        "canaux": "Newsletter, communauté, YouTube long, SEO de fond.",
    })
    return personas


# ---------------------------------------------------------------- dossier
def _kw_table(kws: dict | None, limit: int = 30) -> str:
    if not kws or not kws.get("top"):
        return "_Pas encore de mots-clés — relancer la recherche._"
    rows = kws["top"][:limit]
    lines = ["| Mot-clé | Intention | Score | Sources |", "|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['kw']} | {r.get('intent','?')} | {r.get('score',0)} | {r.get('source','')} |")
    return "\n".join(lines)


def _competitor_table(comp: dict | None) -> str:
    if not comp or not comp.get("competitors"):
        return "_Pas de concurrents détectés — vérifier la catégorie._"
    lines = ["| Concurrent | Prix repérés | Signal |", "|---|---|---|"]
    for c in comp["competitors"][:8]:
        prices = ", ".join(c.get("prices_spotted", [])) or "—"
        lines.append(f"| [{c['domain']}]({c['url']}) | {prices} | {c['snippet'][:120]} |")
    return "\n".join(lines)


def _aeo_table(aeo: dict | None) -> str:
    if not aeo or not aeo.get("checks"):
        return "_Audit AEO indisponible (pas d'URL de site)._"
    lines = [f"**Score AEO/GEO : {aeo['score']}/{aeo['max_score']}**", "", "| Vérification | Points | Statut |", "|---|---|---|"]
    for c in aeo["checks"]:
        lines.append(f"| {c['label']} | {c['points']} | {'✅' if c['ok'] else '❌'} |")
    return "\n".join(lines)


def build_dossier(stack: str, name: str) -> dict:
    ctx = _load_ctx(stack)
    kws = _load(stack, "keywords")
    sig = _load(stack, "signals")
    comp = _load(stack, "competitors")
    aeo = _load(stack, "aeo")
    synth = _load(stack, "synthesis")
    personas = build_personas(stack, ctx, sig, kws)
    brand = ctx["brand"]["guess"]
    site = ctx.get("site_url") or "—"
    prices = ", ".join(ctx["product"]["prices"]) or "non détecté"
    stack_tech = ", ".join(ctx.get("manifests", {}).get("frameworks", [])) or ", ".join(list(ctx.get("languages", {}).keys())[:5]) or "—"
    today = datetime.now(timezone.utc).strftime("%d/%m/%Y")

    synth_md = ""
    sp = (synth or {}).get("payload") or {}
    if (synth or {}).get("status") == "done" and sp:
        personas_ia = "\n".join(
            f"- **{p.get('id', '?')} — {p.get('nom', '?')}** (confiance {p.get('confiance', '?')}) : {p.get('hypothese', '')} → *{p.get('angle', '')}*"
            for p in sp.get("personas", [])[:4])
        angles_ia = "\n".join(f"- **{a.get('nom', '?')}** : {a.get('promesse', '')} (preuve : {a.get('preuve', '—')})"
                              for a in sp.get("angles_positionnement", [])[:3])
        qw_ia = "\n".join(f"{i}. {w}" for i, w in enumerate(sp.get("quick_wins", [])[:5], 1))
        risques_ia = "\n".join(f"- {r}" for r in sp.get("risques", [])[:3])
        synth_md = (
            f"> 🤖 **Synthèse stratégique générée par LLM** ({synth.get('provider', '?')}) — hypothèses ancrées dans les données ci-dessus, à valider.\n\n"
            f"**Résumé exécutif** : {sp.get('resume_executif', '')}\n\n"
            f"**Personas affinés (cluster IA)** :\n{personas_ia}\n\n"
            f"**Angles de positionnement** :\n{angles_ia}\n\n"
            f"**Quick wins** :\n{qw_ia}\n\n"
            f"**Risques** :\n{risques_ia}\n\n")
    elif (synth or {}).get("status") == "skipped":
        synth_md = (f"> ℹ️ Synthèse IA non générée : {(synth or {}).get('note', 'LLM non configuré')}. "
                    "Activez avec QEYNOX_LLM=ollama (ou openai + clé).\n\n")

    md = f"""# 📦 Dossier GTM — {brand}
> Généré par QeyNox le {today} · Source : `{ctx.get('source','')}` · Admin : à valider avant lancement du swarm.

## 1. Produit & contexte extrait du dépôt
| | |
|---|---|
| **Marque (détectée)** | {brand} |
| **Titre HTML** | {ctx['brand']['html_title'] or '—'} |
| **Meta description** | {ctx['brand']['meta_description'] or '—'} |
| **Site** | {site} |
| **Prix détectés** | {prices} |
| **Emails** | {', '.join(ctx['product']['emails']) or '—'} |
| **Réseaux** | {', '.join(sorted(ctx['product']['socials'].keys())) or '—'} |
| **Stack technique** | {stack_tech} |
| **Langages** | {', '.join(f'{k} ({v})' for k, v in list(ctx.get('languages', {}).items())[:6]) or '—'} |

**Promesses détectées (H1)** : {' · '.join(ctx['product']['taglines_h1'][:4]) or '—'}

**Arguments (H2)** :
{chr(10).join('- ' + h for h in ctx['product']['value_props_h2'][:8]) or '- —'}

**CTA détectés** : {' · '.join(ctx['product']['ctas'][:5]) or '—'}

**Extrait README** :
> {ctx['readme']['excerpt'][:600].replace(chr(10), chr(10) + '> ')}

## 2. Personas & besoins (hypothèses ancrées dans les signaux — à valider)
{chr(10).join(chr(10).join([
f"### {p['id']} — {p['nom']}",
f"**Hypothèse** : {p['hypothese']}",
f"**Peurs/attentes observées** : {', '.join(p['signaux']['peurs'])}",
f"**Questions types** : {' · '.join(p['signaux']['questions']) or '—'}",
f"**Angle marketing** : {p['angle_marketing']}",
f"**Canaux** : {p['canaux']}",
"**Verbatims sourcés** :" if p['verbatims'] else "**Verbatims** : aucun signal fort pour ce profil (à enrichir via missions signaux).",
*[f"> « {(t + ' — ' + sn).strip()[:220]} »  \n> Source : {u}" for t, sn, u in p['verbatims']],
""]) for p in personas)}

## 3. Marché & concurrents
{'' if (comp or {}).get('confidence', 'ok') == 'ok' else '> ⚠️ **Découverte concurrents peu fiable** : le moteur de repli (sans SearXNG) a renvoyé du bruit. Relancer la mission « Veille concurrents » avec SearXNG en marche pour des données exploitables.' + chr(10)}
{chr(10).join('- **' + c['domain'] + '** (' + str(c['mentions']) + ' mentions) — ' + c['snippet'][:110] for c in (comp or {}).get('competitors', [])[:6]) or '- —'}

{_competitor_table(comp)}

## 4. Univers de mots-clés (SEO)
Graines : {', '.join((kws or {}).get('seeds', [])) or '—'}

{_kw_table(kws)}

## 5. Signaux de marché (verbatims réels)
Moteur : {(sig or {}).get('engine', '—')} · {len((sig or {}).get('signals', []))} signaux collectés.
{'' if (sig or {}).get('confidence', 'ok') == 'ok' else chr(10) + '> ⚠️ **Signaux peu pertinents** : moteur de repli dégradé. Relancer avec SearXNG pour des verbatims exploitables.'}

{chr(10).join('- **[' + s['platform'] + ']** ' + (s['title'] + ' — ' + s['snippet'])[:200] for s in (sig or {}).get('signals', [])[:12]) or '- —'}

## 6. Audit AEO / GEO — visibilité dans les IA
{_aeo_table(aeo)}

**Recommandations** :
{chr(10).join('- ' + r for r in (aeo or {}).get('recommendations', [])) or '- —'}

## 7. Recommandations GTM (proposition du swarm)
{synth_md}1. **Positionnement** : articuler la promesse autour des peurs P1 (preuve/process/garanties) et de la profondeur P3 (expertise humaine).
2. **SEO prioritaire** : cibler les {min(10, len((kws or {}).get('top', [])))} mots-clés longue traîne à intention commerciale du tableau §4 (pages FAQ + comparatifs).
3. **AEO/GEO** : appliquer les recommandations §6 (schema FAQPage/Organization/Product, llms.txt) — être la source citée par ChatGPT/Perplexity sur « {brand} avis » et la catégorie.
4. **Contenu social** : transformer chaque verbatim §5 en hook (loop SIGNAL → SCRIBE).
5. **Conversion** : clarifier l'offre autour du prix détecté ({prices}) — page pricing explicite + garanties.

## 8. Plan 90 jours proposé
| Phase | Objectif | Actions |
|---|---|---|
| J0-J15 | Fondations | Corriger l'audit AEO/GEO, pages FAQ/comparatifs sur les mots-clés §4, tracking UTM → conversions |
| J15-J45 | Traction | 3 hooks/sem (verbatims), 1 article SEO/sem, micro-campagnes signaux, veille concurrents en cron |
| J45-J90 | Scale | Arbitrage sur le canal au meilleur CPA, programmatique SEO longue traîne, partenariats créateurs |

## 9. Décisions à valider par l'admin
- [ ] Le positionnement proposé (§7.1) correspond à la vision produit
- [ ] Les personas (§2) sont plausibles → je les valide pour les skills contenu/social
- [ ] Le prix détecté ({prices}) est correct et peut être utilisé en public
- [ ] Je valide l'univers de mots-clés (§4) comme socle SEO
- [ ] Je lance le swarm sur ce dossier

---
*Rapport généré automatiquement par QeyNox à partir de sources publiques + analyse du dépôt. Les personas et recommandations sont des hypothèses à confronter à votre connaissance du terrain.*
"""

    data = {
        "brand": brand, "site": site, "prices": prices, "stack_tech": stack_tech,
        "personas": personas,
        "n_keywords": len((kws or {}).get("top", [])),
        "n_signals": len((sig or {}).get("signals", [])),
        "n_competitors": len((comp or {}).get("competitors", [])),
        "aeo_score": (aeo or {}).get("score"), "aeo_max": (aeo or {}).get("max_score"),
        "synthesis": {"status": (synth or {}).get("status"), "provider": (synth or {}).get("provider")},
        "top_keywords": (kws or {}).get("top", [])[:15],
        "top_signals": (sig or {}).get("signals", [])[:8],
        "competitors": (comp or {}).get("competitors", [])[:8],
        "aeo": aeo or {},
    }
    out_dir = os.path.join(STACKS_DIR, stack, "dossier")
    os.makedirs(out_dir, exist_ok=True)
    version = _next_dossier_version(out_dir)
    name = f"gtm-dossier-v{version:04d}.md"
    ver_dir = os.path.join(out_dir, "versions")
    os.makedirs(ver_dir, exist_ok=True)
    path = os.path.join(ver_dir, name)
    data_name = f"gtm-dossier-v{version:04d}.json"
    with open(path, "w", encoding="utf-8") as f:
        f.write(md)
    with open(os.path.join(ver_dir, data_name), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    top_level = os.path.join(out_dir, name)
    if not os.path.exists(top_level):
        with open(top_level, "w", encoding="utf-8") as f:
            f.write(md)
    pointer = {
        "version": version,
        "markdown": f"versions/{name}",
        "data": f"versions/{data_name}",
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    with open(os.path.join(out_dir, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(pointer, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out_dir, "data.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    return {"path": path, "data": data, "version": version}


_VERSION_RE = re.compile(r"^gtm-dossier-v(\d+)\.md$")


def _next_dossier_version(out_dir: str) -> int:
    best = 0
    for folder in (out_dir, os.path.join(out_dir, "versions")):
        if not os.path.isdir(folder):
            continue
        for fn in os.listdir(folder):
            match = _VERSION_RE.match(fn)
            if match:
                best = max(best, int(match.group(1)))
    return best + 1


def read_dossier_markdown(stack: str, *, max_chars: int | None = None) -> tuple[str, str] | None:
    """Dernière version (latest.json), sinon le markdown le plus récent du dossier."""
    out_dir = os.path.join(STACKS_DIR, stack, "dossier")
    if not os.path.isdir(out_dir):
        return None
    pointer = os.path.join(out_dir, "latest.json")
    target = ""
    if os.path.isfile(pointer):
        try:
            with open(pointer, encoding="utf-8") as handle:
                meta = json.load(handle)
            rel = str(meta.get("markdown") or "")
            from engine.safety import safe_join
            target = safe_join(out_dir, rel) if rel else ""
        except (OSError, ValueError, json.JSONDecodeError):
            target = ""
    if not target or not os.path.isfile(target):
        files = sorted(fn for fn in os.listdir(out_dir) if fn.endswith(".md"))
        if not files:
            return None
        target = os.path.join(out_dir, files[-1])
    with open(target, encoding="utf-8") as handle:
        content = handle.read()
    if max_chars is not None:
        content = content[:max_chars]
    return os.path.basename(target), content
