#!/usr/bin/env python3
"""Google Trends via pytrends — intérêt dans le temps + requêtes associées.

⚠️ Google limite parfois (HTTP 429). Attendez quelques minutes ou réduisez
la fréquence. Les données Trends sont relatives (0-100), pas des volumes.

Exemples:
  python trends_check.py --kw "votre marché" --kw "votre offre" --geo FR
  python trends_check.py --kw "catégorie" --related --out output/trends
"""
from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gtm_store import export_rows, log_run, connect, upsert_keywords  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="Google Trends (pytrends)")
    ap.add_argument("--kw", action="append", required=True, help="mot-clé (max 5 par passe)")
    ap.add_argument("--geo", default="FR")
    ap.add_argument("--timeframe", default="today 12-m")
    ap.add_argument("--related", action="store_true", help="récupérer aussi les requêtes associées")
    ap.add_argument("--out", default="output/trends.csv")
    args = ap.parse_args()

    try:
        from pytrends.request import TrendReq
    except ImportError:
        print("pytrends manquant: pip install pytrends")
        sys.exit(1)

    kw_groups = [args.kw[i:i + 5] for i in range(0, len(args.kw), 5)]
    all_rows, related_rows = [], []
    for group in kw_groups:
        try:
            pt = TrendReq(hl="fr-FR", tz=0)
            pt.build_payload(group, timeframe=args.timeframe, geo=args.geo)
        except Exception as exc:
            print(f"⚠️ Trends a refusé la passe {group}: {exc}\n   (rate limit fréquent — réessayez plus tard)")
            continue

        df = pt.interest_over_time()
        if df is not None and not df.empty:
            if "isPartial" in df.columns:
                df = df.drop(columns=["isPartial"])
            avg = df.mean().round(1).to_dict()
            for kw, v in avg.items():
                all_rows.append({"kw": kw.lower(), "trend": v, "source": "trends",
                                 "intent": "?", "score": float(v) / 2.0})
            last_q = df.tail(12).mean().round(1).to_dict()  # trimestre récent vs année
            for kw, v in last_q.items():
                base = avg.get(kw) or 1
                momentum = round((v - base) / max(base, 1) * 100, 1)
                for r in all_rows:
                    if r["kw"] == kw.lower():
                        r["momentum_pct"] = momentum
                        break

        if args.related:
            for kw in group:
                try:
                    rq = pt.related_queries(kw)
                except Exception:
                    continue
                for kind in ("top", "rising"):
                    dfq = (rq or {}).get(kind)
                    if dfq is None or dfq.empty:
                        continue
                    for _, row in dfq.head(12).iterrows():
                        related_rows.append({
                            "kw": str(row["query"]).lower(),
                            "source": f"trends-{kind}",
                            "intent": "commercial" if kind == "rising" else "?",
                            "score": float(row.get("value", 0) or 0),
                            "parent": kw.lower(),
                        })
                time.sleep(2)

    if not all_rows and not related_rows:
        print("Aucune donnée Trends récupérée.")
        log_run("trends_check", ",".join(args.kw), "empty")
        return

    con = connect()
    upsert_keywords(con, all_rows + related_rows)
    path = export_rows(all_rows, ["kw", "trend", "momentum_pct", "score", "source"], args.out, "csv")
    print(f"\n✅ Intérêt moyen 12 mois → {path}")
    for r in sorted(all_rows, key=lambda x: -(x.get("trend") or 0)):
        mom = r.get("momentum_pct")
        mom_s = f"  momentum: {mom:+.0f}%" if mom is not None else ""
        print(f"   {r['trend']:>5}/100  {r['kw']}{mom_s}")
    if related_rows:
        rel_path = args.out.replace(".csv", "-related.csv")
        export_rows(related_rows, ["kw", "score", "source", "parent"], rel_path, "csv")
        print(f"✅ {len(related_rows)} requêtes associées → {rel_path}")
    log_run("trends_check", ",".join(args.kw))


if __name__ == "__main__":
    main()
