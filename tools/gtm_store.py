"""Mémoire persistante du swarm GTM — façade des scripts tools/.

Toute ouverture SQLite vit dans engine.repository. Ce module garde l'API
historique (`connect()` lit GTM_DB) et l'export CSV/markdown/JSON.
"""
from __future__ import annotations

import csv
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from engine.repository import (  # noqa: E402
    SCHEMA,
    add_signals,
    connect as connect_path,
    log_run as log_run_path,
    record_serp,
    save_snapshot,
    top_keywords,
    upsert_keywords,
)
from gtm_common import db_path, ensure_dirs  # noqa: E402

__all__ = [
    "SCHEMA",
    "add_signals",
    "connect",
    "export_rows",
    "log_run",
    "record_serp",
    "save_snapshot",
    "top_keywords",
    "upsert_keywords",
]


def connect():
    return connect_path(db_path())


def log_run(tool: str, args: str, status: str = "ok") -> None:
    log_run_path(db_path(), tool, args, status)


def export_rows(rows, columns: list[str], out: str | None, fmt: str = "csv") -> str:
    """Écrit en CSV/markdown/JSON et retourne le chemin (ou imprime stdout si out=None)."""
    if fmt == "json":
        payload = [dict(r) for r in rows]
        text = __import__("json").dumps(payload, ensure_ascii=False, indent=2)
    elif fmt == "md":
        lines = ["| " + " | ".join(columns) + " |", "|" + "---|" * len(columns)]
        lines += ["| " + " | ".join(str(r[c] if c in r.keys() else "") for c in columns) + " |" for r in rows]
        text = "\n".join(lines)
    else:
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: r[c] if c in r.keys() else "" for c in columns})
        text = buf.getvalue()
    if out:
        ensure_dirs(os.path.dirname(out) or ".")
        with open(out, "w", encoding="utf-8") as handle:
            handle.write(text)
        return out
    print(text)
    return "-"
