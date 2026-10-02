#!/usr/bin/env python3
"""Signaux sociaux & demande organique : Reddit, forums, Pinterest, news.

Le swarm scanne ce que les gens disent VRAIMENT (avis, frustrations, vocabulaire
utilisé) pour nourrir le contenu, les hooks sociaux et les angles publicitaires.

Exemples:
  python social_pulse.py --q "avis produit" --q "nom-marque forum"
  python social_pulse.py --platform reddit --limit 10
  GTM_BRAND="Nom Marque" python social_pulse.py
"""
from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gtm_common import domain_of, searx_search  # noqa: E402
from gtm_store import add_signals, log_run, connect  # noqa: E402

def default_queries(brand: str) -> dict[str, list[str]]:
    b = brand.strip()
    if not b:
        return {}
    return {
        "reddit": [f"site:reddit.com {b} avis", f"site:reddit.com {b}"],
        "forums_pinterest": [f"{b} avis", f"{b} forum"],
        "news": [f"{b} marché", b],
    }

KEYWORDS_FR = ["avis", "arnaque", "fiable", "gratuit", "prix", "rembours", "déçu",
               "j'adore", "incroyable", "bluffant", "témoignage", "recommande"]


def score_signal(text: str) -> float:
    t = text.lower()
    return float(sum(2.5 for k in KEYWORDS_FR if k in t) + min(len(t) / 400, 2))


def main() -> None:
    ap = argparse.ArgumentParser(description="Signaux sociaux via SearXNG")
    ap.add_argument("--q", action="append", default=[], help="requête personnalisée (répétable)")
    ap.add_argument("--platform", choices=["all", "reddit", "forums_pinterest", "news"], default="all")
    ap.add_argument("--limit", type=int, default=8, help="résultats max par requête")
    ap.add_argument("--delay", type=float, default=1.0)
    args = ap.parse_args()

    brand = (os.environ.get("GTM_BRAND") or (os.environ.get("GTM_BRAND_ALIASES") or "").split(",")[0]).strip()
    queries = default_queries(brand)
    if args.q:
        queries = {"custom": args.q}
    elif args.platform != "all":
        queries = {args.platform: queries.get(args.platform, [])} if queries else {}
    if not any(queries.values()):
        print("Aucune requete. Passez --q ... ou GTM_BRAND / GTM_BRAND_ALIASES.", file=sys.stderr)
        sys.exit(1)

    con = connect()
    total_new = 0
    for platform, qs in queries.items():
        for q in qs:
            cats = "news" if platform == "news" else "general"
            results = searx_search(q, categories=cats, lang="fr")[: args.limit]
            rows = [{
                "platform": platform,
                "title": r["title"],
                "url": r["url"],
                "snippet": r["snippet"],
                "score": score_signal(r["title"] + " " + r["snippet"]),
            } for r in results]
            new = add_signals(con, rows)
            total_new += new
            print(f"[{platform}] {q} → {len(rows)} résultats, {new} nouveaux signaux")
            time.sleep(args.delay)

    print(f"\n✅ {total_new} nouveaux signaux stockés. Digest des plus pertinents:")
    top = con.execute(
        "SELECT platform, title, url, snippet, score FROM signals ORDER BY score DESC, id DESC LIMIT 12"
    ).fetchall()
    for s in top:
        dom = domain_of(s["url"]) or s["platform"]
        print(f"   ({s['score']:.0f}) [{dom}] {s['title'][:90]}\n        {s['snippet'][:140]}")
    log_run("social_pulse", f"{total_new} nouveaux")


if __name__ == "__main__":
    main()
