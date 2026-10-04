#!/usr/bin/env python3
"""Recherche de mots-clés par expansion d'autocomplete (sans clé API, sans scraper).

Méthode "keyword shrimp":
  1. Chaque seed est passé aux autocompletes Google, DuckDuckGo et YouTube (langue/pays au choix)
  2. Les meilleures suggestions deviennent de nouvelles graines (BFS, N tours)
  3. Modificateurs commerciaux FR ajoutés (avis, prix, gratuit, meilleur, en ligne…)
  4. Score heuristique = fréquence d'apparition multi-sources + bonus intention
  5. Tout est stocké dans data/gtm.db et exporté en CSV

⚠️ Le score est un signal de DEMANDE relative (présence dans l'autocomplete),
pas un volume Google exact. Complétez avec trends_check.py et serp_rank.py.

Exemples:
  python keyword_research.py --seed "votre marché" --seed "votre offre"
  python keyword_research.py --seed "mot-clé" --rounds 3 --breadth 8 --min-word-len 2
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gtm_common import DEFAULT_GL, DEFAULT_LANG, autocomplete  # noqa: E402
from gtm_store import export_rows, log_run, connect, upsert_keywords  # noqa: E402

SOURCES = ["google", "ddg", "youtube"]
SRC_WEIGHT = {"google": 3.0, "ddg": 2.0, "youtube": 2.0}

COMMERCIAL = ["avis", "prix", "gratuit", "meilleur", "comparatif", "en ligne",
              "fiable", "test", "abonnement", "pas cher"]
QUESTION = ["comment", "pourquoi", "quel", "quelle", "quels", "quelles", "est-ce",
            "quand", "ou ", "qui ", "que signifie"]
MODIFIERS = ["", "avis", "gratuit", "en ligne", "fiable", "meilleur"]


def brand_aliases() -> list[str]:
    raw = os.environ.get("GTM_BRAND_ALIASES") or os.environ.get("GTM_BRAND") or ""
    return [a.strip().lower() for a in raw.split(",") if a.strip()]


def intent_of(kw: str) -> str:
    k = " " + kw.lower() + " "
    if any(re.search(r"\b" + re.escape(m.strip()) + r"", k) for m in COMMERCIAL):
        return "commercial"
    if any(q.strip() and q in k for q in QUESTION):
        return "info"
    aliases = brand_aliases()
    if aliases and any(re.search(r"\b" + re.escape(a) + r"\b", k) for a in aliases):
        return "brand"
    return "?"


def expand(seed: str, lang: str, gl: str, rounds: int, breadth: int, delay: float) -> dict[str, dict]:
    """BFS d'autocomplete. Retourne {kw: {hits: Counter, parents: set}}"""
    if os.environ.get("QEYNOX_OFFLINE_SEARCH"):
        delay = 0.0
    hits: dict[str, Counter] = {}
    parents: dict[str, set] = {}
    frontier = [seed.lower().strip()]
    seen_seeds = set(frontier)

    for round_no in range(1, rounds + 1):
        next_frontier: list[str] = []
        for base in frontier:
            queries = [base] + [f"{base} {m}" for m in MODIFIERS[1:]]
            for q in queries:
                for src in SOURCES:
                    for s in autocomplete(src, q, lang, gl):
                        s = s.lower().strip()
                        if len(s) < 3 or s == q:
                            continue
                        hits.setdefault(s, Counter())[src] += 1
                        parents.setdefault(s, set()).add(base)
                        if s not in seen_seeds and len(next_frontier) < breadth * 2:
                            next_frontier.append(s)
                            seen_seeds.add(s)
                    time.sleep(delay)
            print(f"[tour {round_no}] {base!r} → {len(hits)} mots-clés uniques cumulés")
        # priorité aux mots-clés multi-sources (signal de demande plus fort)
        next_frontier.sort(key=lambda k: sum(hits[k].values()), reverse=True)
        frontier = [k for k in next_frontier[:breadth] if " " in k or len(k) > 4]
        if not frontier:
            break
    return {k: {"hits": v, "parents": parents.get(k, set())} for k, v in hits.items()}


def main() -> None:
    ap = argparse.ArgumentParser(description="Expansion de mots-clés (autocomplete Google/DDG/YouTube)")
    ap.add_argument("--seed", action="append", required=True, help="graine (répétable)")
    ap.add_argument("--lang", default=DEFAULT_LANG)
    ap.add_argument("--gl", default=DEFAULT_GL)
    ap.add_argument("--rounds", type=int, default=2, help="profondeur BFS (défaut 2)")
    ap.add_argument("--breadth", type=int, default=6, help="meilleurs kws relancés par tour")
    ap.add_argument("--delay", type=float, default=0.6, help="pause entre requêtes (s)")
    ap.add_argument("--min-score", type=float, default=3.0)
    ap.add_argument("--out", default="output/keywords.csv")
    ap.add_argument("--limit", type=int, default=200)
    args = ap.parse_args()

    data = {}
    for seed in args.seed:
        data.update(expand(seed, args.lang, args.gl, args.rounds, args.breadth, args.delay))

    rows = []
    for kw, info in data.items():
        h = info["hits"]
        score = sum(SRC_WEIGHT[s] * c for s, c in h.items())
        if score < args.min_score:
            continue
        rows.append({
            "kw": kw,
            "source": "+".join(sorted(h)),
            "intent": intent_of(kw),
            "score": round(score, 1),
            "parent": "; ".join(sorted(info["parents"])[:3]),
            "trend": None,
        })
    rows.sort(key=lambda r: -r["score"])

    con = connect()
    upsert_keywords(con, rows)
    out_path = export_rows(rows[: args.limit],
                           ["kw", "intent", "score", "source", "parent", "trend"],
                           args.out, "csv")
    print(f"\n✅ {len(rows)} mots-clés (score ≥ {args.min_score}) → {out_path}")
    print("   Base SQLite mise à jour: top 10 —")
    for r in rows[:10]:
        print(f"   {r['score']:>5}  [{r['intent']:<12}] {r['kw']}")
    log_run("keyword_research", " ".join(args.seed))


if __name__ == "__main__":
    main()
