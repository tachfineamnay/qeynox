#!/usr/bin/env python3
"""Suivi de positions SERP d'un domaine via SearXNG (engine google + bing).

Exemples:
  python serp_rank.py --domain exemple.com --kw "votre marché" --kw "votre offre"
  python serp_rank.py --domain exemple.com --from-store --limit 30
"""
from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gtm_common import domain_of, searx_search  # noqa: E402
from gtm_store import export_rows, log_run, connect, record_serp, top_keywords  # noqa: E402


def rank_for_kw(kw: str, domain: str, lang: str) -> dict:
    results = searx_search(kw, categories="general", engines="google,bing", lang=lang, pages=1)
    for pos, r in enumerate(results, 1):
        if domain in domain_of(r["url"]):
            return {"kw": kw, "position": pos, "url": r["url"], "results": len(results)}
    return {"kw": kw, "position": None, "url": "", "results": len(results)}


def main() -> None:
    ap = argparse.ArgumentParser(description="Positions SERP d'un domaine (via SearXNG)")
    ap.add_argument("--domain", default=os.environ.get("GTM_DOMAIN", ""),
                    help="domaine à suivre (sinon env GTM_DOMAIN)")
    ap.add_argument("--kw", action="append", default=[], help="mot-clé à tester (répétable)")
    ap.add_argument("--from-store", action="store_true",
                    help="reprendre les meilleurs mots-clés de la base (keyword_research)")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--min-score", type=float, default=5)
    ap.add_argument("--lang", default="fr")
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--out", default="output/serp.csv")
    args = ap.parse_args()
    domain = (args.domain or "").strip().lower().removeprefix("www.")
    if not domain:
        print("Domaine manquant: --domain exemple.com ou env GTM_DOMAIN.", file=sys.stderr)
        sys.exit(1)
    args.domain = domain

    kws = list(args.kw)
    if args.from_store:
        con = connect()
        kws += [r["kw"] for r in top_keywords(con, limit=args.limit, min_score=args.min_score)]
    if not kws:
        print("Aucun mot-clé: utilisez --kw ou --from-store (après keyword_research.py).")
        sys.exit(1)

    con = connect()
    rows = []
    for kw in kws:
        r = rank_for_kw(kw, args.domain, args.lang)
        if r["results"] == 0:
            print(f"   (échec recherche — mot-clé ignoré)   {kw}")
            continue
        rows.append(r)
        record_serp(con, kw, args.domain, r["position"], r["url"])
        pos = r["position"] if r["position"] else "absent"
        print(f"   {pos:>7}   {kw}")
        time.sleep(args.delay)

    ranked = [r for r in rows if r["position"]]
    path = export_rows(rows, ["kw", "position", "url"], args.out, "csv")
    print(f"\n✅ {len(ranked)}/{len(rows)} mots-clés positionnés → {path}")
    if ranked:
        best = sorted(ranked, key=lambda r: r["position"])[:5]
        print("   Top positions: " + ", ".join(f"{r['kw']} (#{r['position']})" for r in best))
    log_run("serp_rank", args.domain)


if __name__ == "__main__":
    main()
