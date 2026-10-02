#!/usr/bin/env python3
"""QeyNox — CLI plateforme.

    python3 qeynox.py onboard --name "Mon Produit" --repo /chemin/ou/url.git [--site https://...] [--seed "kw1"]
    python3 qeynox.py status [slug]
    python3 qeynox.py validate <slug>
    python3 qeynox.py serve [--port 8765]
    python3 qeynox.py arms list
"""
from __future__ import annotations

import argparse
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from engine import pipeline as pl      # noqa: E402
from engine import launch as launch_mod  # noqa: E402
from engine import arms as arms_mod      # noqa: E402


def cmd_onboard(args) -> None:
    created = pl.create_stack(args.name, args.repo, args.site or "", args.seed or [])
    slug = created["slug"]
    print(f"⬡ Stack créé : {slug}")
    pl.init_pipeline(slug)
    pl.run_pipeline(slug, {"source": args.repo, "name": args.name, "site_url": args.site or "", "seeds": args.seed or []})
    pipe = pl.read_pipeline(slug)
    print(f"\nPipeline terminé — statut : {pipe['status']}")
    for st in pipe["stages"]:
        print(f"  {st['status']:<8} {st['label']}" + (f" — {st['log'][:90]}" if st["log"] else ""))
    if pipe["status"] == "review":
        print(f"\n📦 Dossier prêt : stacks/{slug}/dossier/")
        print(f"   → Consultez-le puis : python3 qeynox.py validate {slug}")


def cmd_status(args) -> None:
    if args.slug:
        rows = [pl.get_stack(args.slug)]
    else:
        rows = pl.load_registry()
    if not rows:
        print("Aucun stack. Créez-en un : python3 qeynox.py onboard ...")
        return
    for s in rows:
        if not s:
            continue
        pipe = pl.read_pipeline(s["slug"]) or {}
        stages = {st["id"]: st["status"] for st in pipe.get("stages", [])}
        print(f"\n⬡ {s['name']} ({s['slug']}) — {s['status']}")
        print(f"   source: {s.get('source','?')}")
        if stages:
            print("   pipeline: " + " · ".join(f"{k}={v}" for k, v in stages.items()))


def cmd_validate(args) -> None:
    result = launch_mod.validate_stack(args.slug)
    if result.get("ok"):
        print(f"✅ Swarm lancé pour {args.slug}")
        for f in result["files"]:
            print(f"   - {result['swarm_dir']}/{f}")
    else:
        print(f"⚠️ {result.get('error')}")


def cmd_serve(args) -> None:
    os.environ.setdefault("GTM_WEB_PORT", str(args.port))
    from web.app import main
    main()


def main() -> None:
    ap = argparse.ArgumentParser("qeynox")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ob = sub.add_parser("onboard")
    ob.add_argument("--name", required=True)
    ob.add_argument("--repo", required=True, help="chemin local, URL git ou .zip")
    ob.add_argument("--site", help="URL du site produit (pour l'audit AEO)")
    ob.add_argument("--seed", action="append", help="graine de mots-clés (répétable)")
    st = sub.add_parser("status")
    st.add_argument("slug", nargs="?", default="")
    va = sub.add_parser("validate")
    va.add_argument("slug")
    se = sub.add_parser("serve")
    se.add_argument("--port", type=int, default=8765)
    arms_mod.build_parser(sub)
    args = ap.parse_args()
    if args.cmd == "arms":
        raise SystemExit(arms_mod.dispatch(args))
    {"onboard": cmd_onboard, "status": cmd_status, "validate": cmd_validate, "serve": cmd_serve}[args.cmd](args)


if __name__ == "__main__":
    main()
