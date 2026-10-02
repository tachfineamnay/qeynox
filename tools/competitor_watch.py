#!/usr/bin/env python3
"""Veille concurrents : snapshot périodique des pages clés + diff automatique.

Les cibles viennent du projet (research/competitors.json), d'un fichier, ou de --name/--url.
Aucun concurrent n'est hardcodé.

Exemples:
  python competitor_watch.py --scan
  python competitor_watch.py --targets-file competitors.txt
  python competitor_watch.py --name "concurrent" --url "https://exemple.com/"
Format competitors.txt: nom<TAB>url  (une ligne par cible)
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gtm_common import fetch_text, slug  # noqa: E402
from gtm_store import log_run, connect, save_snapshot  # noqa: E402


def _from_competitors_json(path: str) -> list[tuple[str, str]]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    rows = data.get("competitors") if isinstance(data, dict) else data
    out: list[tuple[str, str]] = []
    if not isinstance(rows, list):
        return out
    for c in rows:
        if not isinstance(c, dict):
            continue
        url = (c.get("url") or "").strip()
        name = (c.get("name") or c.get("title") or c.get("domain") or "").strip() or url
        if url:
            out.append((name, url))
    return out


def _from_targets_file(path: str) -> list[tuple[str, str]]:
    targets: list[tuple[str, str]] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                name, url = (line.split("\t", 1) + [""])[:2]
                targets.append((name.strip(), url.strip()))
    return targets


def load_targets(args) -> list[tuple[str, str]]:
    targets: list[tuple[str, str]] = []
    json_path = args.from_json or os.path.join("research", "competitors.json")
    if args.targets_file:
        targets = _from_targets_file(args.targets_file)
    elif args.scan or os.path.exists(json_path):
        if os.path.exists(json_path):
            targets = _from_competitors_json(json_path)
    if args.name and args.url:
        targets.append((args.name, args.url))
    return targets


def main() -> None:
    ap = argparse.ArgumentParser(description="Snapshots + diff des pages concurrents")
    ap.add_argument("--name", help="nom d'une cible ponctuelle")
    ap.add_argument("--url", help="URL d'une cible ponctuelle")
    ap.add_argument("--targets-file", help="fichier nom<TAB>url")
    ap.add_argument("--from-json", help="research/competitors.json du projet")
    ap.add_argument("--scan", action="store_true",
                    help="scanner research/competitors.json (cwd = dossier du projet)")
    ap.add_argument("--outdir", default="data/snapshots")
    args = ap.parse_args()

    targets = load_targets(args)
    if not targets:
        print(
            "Aucune cible concurrent. Passez --targets-file, --name/--url, "
            "ou --scan avec research/competitors.json dans le cwd.",
            file=sys.stderr,
        )
        sys.exit(1)
    con = connect()
    changes = 0
    for name, url in targets:
        if not url:
            print(f"⚠️ {name}: URL manquante, ignoré")
            continue
        safe = slug(name)
        try:
            title, text = fetch_text(url)
        except Exception as exc:
            print(f"⚠️ {name} ({url}): {exc}")
            continue
        sha, prev_path = save_snapshot(con, safe, url, text, args.outdir)
        status = "nouveau" if not prev_path else "changé"
        line = f"{name:<16} sha={sha} [{status}]"
        if prev_path:
            changes += 1
            with open(prev_path, encoding="utf-8") as f:
                old = f.readlines()
            new = text.splitlines(keepends=True)
            diff = list(difflib.unified_diff(old, new, lineterm="", n=1))
            diff = [d for d in diff if d.startswith(("+", "-")) and not d.startswith(("+++", "---"))][:30]
            print(f"\n🔄 CHANGEMENT sur {name} ({url}):")
            for d in diff:
                print("   " + d.rstrip()[:160])
        print(line)
    print(f"\n✅ {len(targets)} cibles, {changes} changement(s) détecté(s).")
    log_run("competitor_watch", f"{len(targets)} cibles")


if __name__ == "__main__":
    main()
