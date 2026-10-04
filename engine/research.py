#!/usr/bin/env python3
"""QeyNox — Deep research marché à partir du contexte extrait du dépôt.

Stages :
  - keywords    : expansion autocomplete (Google/DDG/YouTube) sur les graines dérivées du contexte
  - signals     : verbatims & besoins (SearXNG si dispo, sinon fallback DuckDuckGo HTML)
  - competitors : découverte + snapshot des concurrents
  - aeo         : audit AEO/GEO du site (schema, entités, FAQ, llms.txt, sitemap…)

Chaque stage écrit stacks/<slug>/research/<stage>.json — tolérant aux pannes réseau.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from urllib.parse import parse_qs, unquote, urlparse

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
QEYNOX_ROOT = os.path.dirname(ENGINE_DIR)
TOOLS_DIR = os.path.join(QEYNOX_ROOT, "tools")
if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)

from engine.paths import stacks_dir  # noqa: E402

from gtm_common import UA, domain_of, fetch_text, safe_get, searx_search, searxng_url  # noqa: E402
import requests  # noqa: E402

RESEARCH_DIR = lambda stack: os.path.join(stacks_dir(), stack, "research")  # noqa: E731
STACK_DB = lambda stack: os.path.join(stacks_dir(), stack, "data", "gtm.db")  # noqa: E731


def _save(stack: str, name: str, data: dict) -> None:
    os.makedirs(RESEARCH_DIR(stack), exist_ok=True)
    with open(os.path.join(RESEARCH_DIR(stack), f"{name}.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def _load(stack: str, name: str) -> dict | None:
    p = os.path.join(RESEARCH_DIR(stack), f"{name}.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return None


def searxng_available() -> bool:
    try:
        r = requests.get(f"{searxng_url()}/search", params={"q": "test", "format": "json"},
                         headers={"User-Agent": UA}, timeout=4)
        return r.status_code == 200
    except Exception:
        return False


def ddg_search(query: str, limit: int = 10) -> list[dict]:
    """Fallback sans SearXNG : résultats HTML DuckDuckGo (title, url, snippet)."""
    out = []
    try:
        r = requests.get("https://html.duckduckgo.com/html/", params={"q": query},
                         headers={"User-Agent": UA}, timeout=18)
        anchors = re.findall(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', r.text)
        snippets = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', r.text, re.S)
        for i, (href, title) in enumerate(anchors[:limit]):
            if "uddg=" in href:
                href = unquote(parse_qs(urlparse(href).query).get("uddg", [href])[0])
            snip = re.sub(r"<[^>]+>", "", snippets[i]) if i < len(snippets) else ""
            out.append({"title": re.sub(r"<[^>]+>", "", title), "url": href, "snippet": snip.strip()[:280]})
    except Exception:
        pass
    return out


def _decode_bing_url(href: str) -> str:
    """Décode les redirections bing.com/ck/a?…&u=a1<base64url> vers l'URL réelle."""
    if "bing.com/ck/" not in href:
        return href
    href = href.replace("&amp;", "&")
    m = re.search(r"[?&]u=a1([\w-]+)", href)
    if not m:
        return href
    b64 = m.group(1)
    try:
        import base64
        pad = "=" * (-len(b64) % 4)
        return base64.urlsafe_b64decode(b64 + pad).decode("utf-8", "replace")
    except Exception:
        return href


def _q(noun: str) -> str:
    """Quote le terme s'il contient plusieurs mots (recherche exacte)."""
    return f'"{noun}"' if " " in noun else noun


def bing_search(query: str, limit: int = 10) -> list[dict]:
    """Fallback sans SearXNG : résultats HTML Bing (b_algo)."""
    out = []
    try:
        r = requests.get("https://www.bing.com/search",
                         params={"q": query, "setlang": "fr", "count": str(limit + 5)},
                         headers={"User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.7"},
                         timeout=18)
        blocks = re.split(r'<li class="b_algo', r.text)[1:]
        for b in blocks[:limit]:
            m = re.search(r'<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', b, re.S)
            if not m:
                continue
            href = _decode_bing_url(m.group(1))
            title = re.sub(r"<[^>]+>", "", m.group(2))
            ms = re.search(r'<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>(.*?)</p>', b, re.S) \
                or re.search(r'<div class="b_caption[^"]*"[^>]*>.*?<p[^>]*>(.*?)</p>', b, re.S)
            snip = re.sub(r"<[^>]+>", "", ms.group(1)).strip() if ms else ""
            out.append({"title": title.strip(), "url": href, "snippet": snip[:280]})
    except Exception:
        pass
    return out


def _search(query: str, limit: int = 10) -> list[dict]:
    """Recherche web : SearXNG si dispo, sinon Bing, sinon DDG."""
    if searxng_available():
        return [{"title": r["title"], "url": r["url"], "snippet": r["snippet"]}
                for r in searx_search(query, lang="fr")[:limit]]
    for fallback in (bing_search, ddg_search):
        results = fallback(query, limit)
        if results:
            return results
    return []


# ----------------------------------------------------------------- stages
def stage_keywords(stack: str, analysis: dict, extra_seeds: list[str] | None = None) -> dict:
    brand = analysis["brand"]["guess"]
    words = analysis["product"]["category_words"]
    seeds = list(extra_seeds or [])
    if not seeds and words:  # graines déduites seulement si l'admin n'en fournit pas
        seeds += [" ".join(words[:2]), words[0] + " en ligne"]
    seeds += [f"{brand} avis"]
    # dédoublonnage, nettoyage, max 6
    seeds = [s.strip().lower() for s in seeds if s and len(s.strip()) > 2]
    seeds = list(dict.fromkeys(seeds))[:6]

    env = {**os.environ, "GTM_DB": STACK_DB(stack), "GTM_LANG": "fr", "GTM_GL": "FR", "PYTHONUNBUFFERED": "1"}
    from engine.runner import run_tool
    ran = run_tool(
        "keyword_research",
        {
            "seeds": seeds,
            "rounds": 1,
            "breadth": 5,
            "min_score": 3,
            "out": os.path.join("research", "keywords.csv"),
        },
        cwd=stack_dir_of(stack),
        env=env,
        timeout=420,
    )
    log = (ran.stdout or "") + (ran.stderr or "")
    if ran.timed_out:
        log = "timeout: keyword_research exceeded 420s"
    elif not ran.ok:
        log += f"\n[exit {ran.returncode}]"
    # lecture du top depuis la base du stack
    top = []
    try:
        from engine.repository import top_scored_keywords
        top = top_scored_keywords(STACK_DB(stack), limit=40)
    except Exception:
        pass
    result = {"seeds": seeds, "top": top, "log_tail": log[-1500:]}
    _save(stack, "keywords", result)
    return result


def stack_dir_of(stack: str) -> str:
    return os.path.join(stacks_dir(), stack)


def _market_noun(analysis: dict, seeds: list[str] | None = None) -> str:
    """Le « marché » du stack : 1re graine admin si fournie, sinon mots de catégorie."""
    if seeds:
        return seeds[0].lower()
    return " ".join(analysis["product"].get("category_words", [])[:2]) or analysis["brand"]["guess"]


def stage_signals(stack: str, analysis: dict, seeds: list[str] | None = None) -> dict:
    brand = analysis["brand"]["guess"]
    noun = _market_noun(analysis, seeds)
    qn = _q(noun)
    queries = [
        f"{qn} avis",
        f"{brand} avis",
        f"{qn} arnaque ou fiable",
        f"site:reddit.com {qn}",
        f"besoin {qn} recommandation",
    ]
    rows = []
    for q in queries:
        for r in _search(q, limit=8):
            dom = domain_of(r["url"]) or "web"
            text = (r["title"] + " " + r["snippet"]).lower()
            score = sum(2.5 for k in ("avis", "arnaque", "fiable", "gratuit", "prix", "déçu",
                                      "recommande", "j'adore", "incroyable", "problème", "besoin") if k in text)
            rows.append({"platform": dom, "title": r["title"], "url": r["url"],
                         "snippet": r["snippet"], "score": round(score, 1)})
        time.sleep(0.8)
    rows.sort(key=lambda r: -r["score"])
    result = {"queries": queries, "signals": rows[:60],
              "engine": "searxng" if searxng_available() else "web-fallback (Bing/DDG)"}
    noun_words = set(re.findall(r"[a-zà-ÿ]{4,}", noun.lower()))
    scored = sum(1 for s in result["signals"] if s["score"] > 0 or
                 noun_words & set(re.findall(r"[a-zà-ÿ]{4,}", (s["title"] + " " + s["snippet"]).lower())))
    result["confidence"] = "ok" if not result["signals"] or scored >= len(result["signals"]) * 0.3 else "low"
    _save(stack, "signals", result)
    return result


def stage_competitors(stack: str, analysis: dict, seeds: list[str] | None = None) -> dict:
    brand = analysis["brand"]["guess"]
    noun = _market_noun(analysis, seeds)
    own_domains = set()
    if analysis.get("site_url"):
        own_domains.add(domain_of(analysis["site_url"]))
    for e in analysis["product"]["emails"]:
        own_domains.add(e.split("@")[1])
    candidates: list[dict] = []
    qn = _q(noun)
    # mots de marque significatifs → exclure les domaines homonymes (marque "Acme Cloud" ≠ acme.com)
    brand_words = {w for w in re.findall(r"[a-zà-ÿ]{3,}", brand.lower())}
    SOCIAL_BLOCKS = ("reddit", "youtube", "wikipedia", "medium", "linkedin", "facebook",
                     "twitter", "x.com", "pinterest", "trustpilot", "g2.com", "capterra", "quora")
    PAGE_JUNK = re.compile(r"(sign-?in|log-?in|login|account|profile|docs?/|support/|/help|register|signup)", re.I)
    TITLE_JUNK = re.compile(r"(sign in|log in|se connecter|connexion|créer un compte)", re.I)

    def registrable(dom: str) -> str:
        parts = dom.split(".")
        return ".".join(parts[-2:]) if len(parts) >= 2 else dom

    for q in (f"{qn} alternative", f"meilleur {qn}", f"{brand} vs", f"{qn} comparatif"):
        for r in _search(q, limit=8):
            dom = domain_of(r["url"])
            if not dom or dom in own_domains or registrable(dom) in own_domains \
               or any(s in dom for s in SOCIAL_BLOCKS) or PAGE_JUNK.search(r["url"]) \
               or TITLE_JUNK.search(r["title"]):
                continue
            reg = registrable(dom)
            if any(reg.split(".")[0] == w for w in brand_words):
                continue  # domaine homonyme de la marque (premier token = registrable)
            if not any(c["domain"] == reg for c in candidates):
                candidates.append({"domain": reg, "url": r["url"], "title": r["title"],
                                   "snippet": r["snippet"], "mentions": 1, "queries": [q]})
            else:
                for c in candidates:
                    if c["domain"] == reg:
                        c["mentions"] += 1
                        if q not in c["queries"]:
                            c["queries"].append(q)
        time.sleep(0.8)
    candidates.sort(key=lambda c: -c["mentions"])
    # snapshot des 5 premiers (page d'accueil)
    for c in candidates[:5]:
        try:
            title, text = fetch_text(c["url"], timeout=15)
            c["page_title"] = title[:200]
            c["excerpt"] = re.sub(r"\s+", " ", text)[:1200]
            prices = [f"{m.group(1)} {m.group(2)}" for m in
                      re.finditer(r"(\d{1,4}(?:[.,]\d{1,2})?)\s?(€|\$|EUR|USD)\b", text, re.I)]
            c["prices_spotted"] = prices[:5]
        except Exception as exc:
            c["excerpt"] = f"(fetch impossible: {exc})"
        time.sleep(0.6)
    result = {"category_query": noun, "competitors": candidates[:10]}
    # garde-fou : les résultats partagent-ils un mot avec le marché ? (moteur dégradé = bruit)
    noun_words = set(re.findall(r"[a-zà-ÿ]{4,}", noun.lower())) | set(analysis["product"].get("category_words", [])[:5])
    rel = sum(1 for c in result["competitors"]
              if noun_words & set(re.findall(r"[a-zà-ÿ]{4,}", (c["title"] + " " + c["snippet"]).lower())))
    result["confidence"] = "ok" if not result["competitors"] or rel >= len(result["competitors"]) * 0.4 else "low"
    _save(stack, "competitors", result)
    return result


AEO_CHECKS = [
    ("title_unique", "Balise <title> descriptive", 10),
    ("meta_description", "Meta description présente (150-160 car.)", 10),
    ("h1_unique", "Un seul H1 clair", 10),
    ("jsonld", "Données structurées JSON-LD (schema.org)", 15),
    ("og_tags", "Balises Open Graph (entité partageable)", 8),
    ("canonical", "URL canonique déclarée", 7),
    ("faq_content", "Contenu en questions/réponses (FAQ)", 12),
    ("https", "HTTPS", 5),
    ("robots_txt", "robots.txt accessible", 5),
    ("sitemap", "sitemap.xml accessible", 8),
    ("llms_txt", "llms.txt présent (AEO émergent)", 10),
]


def stage_aeo(stack: str, analysis: dict) -> dict:
    site = (analysis.get("site_url") or "").rstrip("/")
    result: dict = {"site_url": site, "checks": [], "score": 0, "max_score": sum(c[2] for c in AEO_CHECKS),
                    "recommendations": [], "reachable": False}
    if not site:
        result["recommendations"].append("Aucune URL de site détectée — renseignez-la dans la fiche stack pour activer l'audit.")
        _save(stack, "aeo", result)
        return result
    raw_html = ""
    try:
        r = safe_get(site, timeout=18, headers={"User-Agent": UA})
        raw_html = r.text[:500_000]
        result["reachable"] = True
    except Exception as exc:
        result["recommendations"].append(f"Site injoignable ({exc}) — audit partiel.")
    low = raw_html.lower()
    h1s = re.findall(r"<h1[^>]*>(.*?)</h1>", raw_html, re.S | re.I)
    h2s = [re.sub(r"<[^>]+>", "", h).lower() for h in re.findall(r"<h2[^>]*>(.*?)</h2>", raw_html, re.S | re.I)]
    checks: dict[str, bool] = {
        "title_unique": bool(re.search(r"<title>[^<]{10,}</title>", low)),
        "meta_description": bool(re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\'][^"\']{50,}', low)),
        "h1_unique": 1 <= len(h1s) <= 2,
        "jsonld": "application/ld+json" in low,
        "og_tags": 'property="og:' in low or "property='og:" in low,
        "canonical": "rel=\"canonical\"" in low or "rel='canonical'" in low,
        "faq_content": any(("?" in h) or any(q in h for q in ("comment ", "pourquoi ", "qu'est-ce", "est-ce")) for h in h2s),
        "https": site.startswith("https://"),
    }
    for path, key in (("/robots.txt", "robots_txt"), ("/sitemap.xml", "sitemap"), ("/llms.txt", "llms_txt")):
        try:
            rr = safe_get(site + path, headers={"User-Agent": UA}, timeout=10)
            checks[key] = rr.status_code == 200 and len(rr.text) > 10
        except Exception:
            checks[key] = False
    score = 0
    for key, label, pts in AEO_CHECKS:
        ok = checks.get(key, False)
        result["checks"].append({"id": key, "label": label, "points": pts, "ok": ok})
        score += pts if ok else 0
        if not ok:
            result["recommendations"].append(f"{label} — manquant (+{pts} pts)")
    result["score"] = score
    if not checks.get("jsonld"):
        result["recommendations"].append("Ajouter FAQPage + Organization + Product en JSON-LD : c'est ce que les LLM citationnent le plus facilement.")
    if not checks.get("llms_txt"):
        result["recommendations"].append("Publier un /llms.txt décrivant l'offre (format émergent pour les agents IA).")
    _save(stack, "aeo", result)
    return result


STAGES = ["keywords", "signals", "competitors", "aeo"]

if __name__ == "__main__":
    st = sys.argv[1]
    ctx = json.load(open(os.path.join(stacks_dir(), st, "context", "repo-analysis.json"), encoding="utf-8"))
    for s in STAGES:
        fn = globals()[f"stage_{s}"]
        print(f"→ {s}…")
        fn(st, ctx)
        print(f"  ✓ {s}")
