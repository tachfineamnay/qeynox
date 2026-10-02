#!/usr/bin/env python3
"""Catalogue de bras QeyNox — outils OSS/payants branchables.

Trois fichiers, fusionnés à la lecture (dernier gagne sur les champs d'override) :
  catalog/arms.json            seed versionné (ne pas y coller d'endpoints locaux)
  catalog/custom.json          outils ajoutés (qeynox arms add)
  catalog/overrides.json       enabled / endpoint / priorité par instance

    python3 -m engine.arms list
    python3 -m engine.arms get searxng
    python3 -m engine.arms add --file extra.json
    python3 -m engine.arms enable searxng --endpoint http://127.0.0.1:8888
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(ENGINE_DIR)
CATALOG_DIR = os.path.join(ROOT, "catalog")
SEED_PATH = os.path.join(CATALOG_DIR, "arms.json")
CUSTOM_PATH = os.path.join(CATALOG_DIR, "custom.json")
OVERRIDES_PATH = os.path.join(CATALOG_DIR, "overrides.json")

REQUIRED = ("id", "name", "categories", "summary", "capabilities")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")

# Types de jobs QeyNox → capacités catalogue
JOB_CAPABILITIES = {
    "discover.keywords": ("keywords",),
    "discover.serp": ("serp", "search"),
    "discover.signals": ("search",),
    "crawl.site": ("crawl", "site_audit"),
    "audit.technical": ("site_audit", "crawl"),
    "audit.aeo": ("aeo", "ai_visibility"),
    "geo.visibility": ("geo", "ai_visibility", "aeo"),
    "rank.track": ("rank_tracking",),
    "competitors.watch": ("competitors", "crawl"),
    "analytics.traffic": ("analytics", "gsc"),
    "search.web": ("search", "serp"),
    "llm.local": ("llm_local",),
    "llm.observe": ("llm_observability",),
    "rag.embed": ("vector", "rag"),
    "perf.lighthouse": ("cwv", "perf"),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_json(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _write_json(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:63]
    return s or "arm"


def validate_arm(arm: dict, *, partial: bool = False) -> list[str]:
    errors: list[str] = []
    if not partial:
        for k in REQUIRED:
            if k not in arm:
                errors.append(f"champ manquant: {k}")
    if "id" in arm and not ID_RE.match(str(arm["id"])):
        errors.append(f"id invalide: {arm.get('id')!r} (attendu kebab-case a-z0-9-)")
    if "categories" in arm and not isinstance(arm["categories"], list):
        errors.append("categories doit être une liste")
    if "capabilities" in arm and not isinstance(arm["capabilities"], list):
        errors.append("capabilities doit être une liste")
    if "rating" in arm:
        try:
            r = int(arm["rating"])
            if r < 1 or r > 5:
                errors.append("rating doit être 1..5")
        except (TypeError, ValueError):
            errors.append("rating doit être un entier")
    return errors


def _index(rows: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for row in rows:
        aid = row.get("id")
        if isinstance(aid, str):
            out[aid] = row
    return out


def load_seed() -> dict:
    data = _read_json(SEED_PATH, None)
    if not isinstance(data, dict) or "arms" not in data:
        return {"schema_version": 1, "arms": []}
    return data


def load_custom() -> list[dict]:
    data = _read_json(CUSTOM_PATH, {"arms": []})
    if isinstance(data, list):
        return data
    return data.get("arms") or []


def load_overrides() -> dict[str, dict]:
    data = _read_json(OVERRIDES_PATH, {})
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if not str(k).startswith("_") and isinstance(v, dict)}


def merge_arm(base: dict, *layers: dict) -> dict:
    merged = dict(base)
    for layer in layers:
        for k, v in layer.items():
            if k.startswith("_"):
                continue
            if k == "qeynox" and isinstance(v, dict) and isinstance(merged.get("qeynox"), dict):
                q = dict(merged["qeynox"])
                q.update(v)
                merged["qeynox"] = q
            else:
                merged[k] = v
    return merged


def load_arms() -> list[dict]:
    seed = _index(load_seed().get("arms") or [])
    custom = _index(load_custom())
    ids = list(dict.fromkeys([*seed, *custom]))
    overrides = load_overrides()
    out: list[dict] = []
    for aid in ids:
        layers = []
        if aid in seed:
            layers.append(seed[aid])
        if aid in custom:
            layers.append(custom[aid])
        arm = merge_arm(*layers) if layers else {"id": aid}
        ov = overrides.get(aid, {})
        q_ov = {k: ov[k] for k in ("enabled", "endpoint", "priority", "notes") if k in ov}
        extra = {k: v for k, v in ov.items() if k not in q_ov}
        q = dict(arm.get("qeynox") or {})
        q.update(q_ov)
        arm = merge_arm(arm, extra)
        arm["qeynox"] = q
        arm.setdefault("qeynox", {})
        arm["qeynox"].setdefault("enabled", False)
        out.append(arm)
    return out


def get_arm(arm_id: str) -> dict | None:
    for a in load_arms():
        if a.get("id") == arm_id:
            return a
    return None


def filter_arms(
    rows: list[dict] | None = None,
    *,
    category: str | None = None,
    capability: str | None = None,
    mcp: bool | None = None,
    enabled: bool | None = None,
    job: str | None = None,
) -> list[dict]:
    rows = rows if rows is not None else load_arms()
    want_caps = JOB_CAPABILITIES.get(job, ()) if job else ()
    out = []
    for a in rows:
        cats = [c.lower() for c in a.get("categories") or []]
        caps = [c.lower() for c in a.get("capabilities") or []]
        if category and category.lower() not in cats:
            continue
        if capability and capability.lower() not in caps:
            continue
        if mcp is True and not ((a.get("mcp") or {}).get("native")):
            continue
        if mcp is False and (a.get("mcp") or {}).get("native"):
            continue
        if enabled is True and not (a.get("qeynox") or {}).get("enabled"):
            continue
        if enabled is False and (a.get("qeynox") or {}).get("enabled"):
            continue
        if want_caps and not any(c in caps for c in want_caps):
            continue
        out.append(a)
    out.sort(key=lambda x: (-int(x.get("rating") or 0), x.get("name") or x.get("id") or ""))
    return out


def add_arm(arm: dict, *, replace: bool = False) -> dict:
    errs = validate_arm(arm)
    if errs:
        raise ValueError("; ".join(errs))
    arm = dict(arm)
    arm.setdefault("source", "custom")
    arm.setdefault("added_at", now_iso())
    custom = load_custom()
    idx = next((i for i, r in enumerate(custom) if r.get("id") == arm["id"]), None)
    seed_ids = {r["id"] for r in load_seed().get("arms") or []}
    if idx is None and arm["id"] in seed_ids and not replace:
        raise ValueError(f"{arm['id']} existe déjà dans le seed — passez --replace pour surcharger via custom.json")
    if idx is not None and not replace:
        raise ValueError(f"{arm['id']} existe déjà dans custom.json — passez --replace")
    if idx is None:
        custom.append(arm)
    else:
        custom[idx] = merge_arm(custom[idx], arm)
    _write_json(CUSTOM_PATH, {"schema_version": 1, "updated": now_iso(), "arms": custom})
    return get_arm(arm["id"]) or arm


def set_override(arm_id: str, **fields: Any) -> dict:
    if not get_arm(arm_id):
        raise ValueError(f"outil inconnu: {arm_id}")
    data = _read_json(OVERRIDES_PATH, {})
    if not isinstance(data, dict):
        data = {}
    row = dict(data.get(arm_id) or {})
    for k, v in fields.items():
        if v is None:
            row.pop(k, None)
        else:
            row[k] = v
    data[arm_id] = row
    _write_json(OVERRIDES_PATH, data)
    return get_arm(arm_id) or {}


def _fmt_row(a: dict) -> str:
    stars = "*" * int(a.get("rating") or 0)
    mcp = "MCP" if (a.get("mcp") or {}).get("native") else "-"
    on = "on" if (a.get("qeynox") or {}).get("enabled") else "off"
    deploy = (a.get("deploy") or {}).get("mode") or "?"
    cats = ",".join(a.get("categories") or [])
    return f"{a['id']:<22} {on:<3} {mcp:<3} {deploy:<10} {stars:<5} {cats:<20} {a.get('name')}"


def cmd_list(args: argparse.Namespace) -> int:
    mcp = True if args.mcp else (False if args.no_mcp else None)
    enabled = True if args.enabled else (False if args.disabled else None)
    rows = filter_arms(
        category=args.category,
        capability=args.capability,
        mcp=mcp,
        enabled=enabled,
        job=args.job,
    )
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    print(f"{'id':<22} {'en':<3} {'mcp':<3} {'deploy':<10} {'rate':<5} {'cats':<20} name")
    for a in rows:
        print(_fmt_row(a))
    print(f"\n{len(rows)} outil(s)")
    return 0


def cmd_get(args: argparse.Namespace) -> int:
    arm = get_arm(args.id)
    if not arm:
        print(f"inconnu: {args.id}", file=sys.stderr)
        return 1
    print(json.dumps(arm, ensure_ascii=False, indent=2))
    return 0


def cmd_add(args: argparse.Namespace) -> int:
    if args.file:
        payload = _read_json(args.file, None)
        if payload is None:
            print(f"fichier introuvable: {args.file}", file=sys.stderr)
            return 1
        arms = payload.get("arms") if isinstance(payload, dict) and "arms" in payload else None
        if arms is None:
            arms = [payload] if isinstance(payload, dict) else payload
    elif args.json:
        payload = json.loads(args.json)
        arms = payload.get("arms") if isinstance(payload, dict) and "arms" in payload else [payload]
    else:
        print("passez --file ou --json", file=sys.stderr)
        return 2
    n = 0
    for arm in arms:
        saved = add_arm(arm, replace=args.replace)
        print(f"+ {saved['id']}")
        n += 1
    print(f"{n} outil(s) dans catalog/custom.json")
    return 0


def cmd_enable(args: argparse.Namespace) -> int:
    fields: dict[str, Any] = {"enabled": True}
    if args.endpoint:
        fields["endpoint"] = args.endpoint
    try:
        arm = set_override(args.id, **fields)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"enabled {arm['id']}" + (f" @ {args.endpoint}" if args.endpoint else ""))
    return 0


def cmd_disable(args: argparse.Namespace) -> int:
    try:
        set_override(args.id, enabled=False)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"disabled {args.id}")
    return 0


def build_parser(sub: argparse._SubParsersAction | None = None) -> argparse.ArgumentParser:
    if sub:
        p = sub.add_parser("arms", help="catalogue d'outils (bras) alimentable")
        nest = p.add_subparsers(dest="arms_cmd", required=True)
    else:
        p = argparse.ArgumentParser("qeynox arms")
        nest = p.add_subparsers(dest="arms_cmd", required=True)

    ls = nest.add_parser("list", help="lister le catalogue")
    ls.add_argument("--category")
    ls.add_argument("--capability")
    ls.add_argument("--job", help="filtrer par type de job QeyNox (ex. discover.keywords)")
    ls.add_argument("--mcp", action="store_true")
    ls.add_argument("--no-mcp", action="store_true")
    ls.add_argument("--enabled", action="store_true")
    ls.add_argument("--disabled", action="store_true")
    ls.add_argument("--json", action="store_true")
    ls.set_defaults(_arms_handler=cmd_list)

    g = nest.add_parser("get", help="détail d'un outil")
    g.add_argument("id")
    g.set_defaults(_arms_handler=cmd_get)

    ad = nest.add_parser("add", help="ajouter un outil dans custom.json")
    ad.add_argument("--file", help="JSON d'un outil ou {arms:[...]}")
    ad.add_argument("--json", help="objet JSON inline")
    ad.add_argument("--replace", action="store_true")
    ad.set_defaults(_arms_handler=cmd_add)

    en = nest.add_parser("enable", help="activer un bras (overrides.json)")
    en.add_argument("id")
    en.add_argument("--endpoint", help="URL locale (MCP, API, UI)")
    en.set_defaults(_arms_handler=cmd_enable)

    dis = nest.add_parser("disable", help="désactiver un bras")
    dis.add_argument("id")
    dis.set_defaults(_arms_handler=cmd_disable)
    return p


def dispatch(args: argparse.Namespace) -> int:
    handler = getattr(args, "_arms_handler", None)
    if not handler:
        return 2
    return int(handler(args) or 0)


def main(argv: list[str] | None = None) -> int:
    p = build_parser()
    args = p.parse_args(argv)
    return dispatch(args)


if __name__ == "__main__":
    raise SystemExit(main())
