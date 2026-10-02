#!/usr/bin/env python3
"""Recherche web/news/images via SearXNG auto-hébergé — le moteur du swarm.

Exemples:
  python searx_search.py "avis produit" --limit 15
  python searx_search.py "catégorie marché" --categories news
  python searx_search.py "mot-clé" --engines google,bing --pages 2 --out out.json --fmt json
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gtm_common import searx_search  # noqa: E402
from gtm_store import log_run  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="Recherche SearXNG (JSON)")
    ap.add_argument("query")
    ap.add_argument("--categories", default="general",
                    help="general | news | images | videos | science (défaut: general)")
    ap.add_argument("--engines", default=None, help="ex: google,bing,duckduckgo")
    ap.add_argument("--lang", default="fr")
    ap.add_argument("--pages", type=int, default=1)
    ap.add_argument("--limit", type=int, default=15)
    ap.add_argument("--out", default=None, help="fichier de sortie")
    ap.add_argument("--fmt", default="md", choices=["md", "csv", "json"])
    args = ap.parse_args()

    results = searx_search(args.query, categories=args.categories,
                           engines=args.engines, lang=args.lang, pages=args.pages)
    rows = results[: args.limit]
    if not rows:
        print("Aucun résultat (ou SearXNG injoignable).")
        log_run("searx_search", args.query, "empty")
        return

    for i, r in enumerate(rows, 1):
        print(f"{i:>2}. {r['title']}\n    {r['url']}\n    {r['snippet'][:160]}\n")

    if args.out:
        from gtm_store import export_rows
        path = export_rows(rows, ["title", "url", "snippet", "engine", "category", "published"],
                           args.out, args.fmt)
        print(f"→ {len(rows)} résultats exportés: {path}")
    log_run("searx_search", args.query)


if __name__ == "__main__":
    main()
