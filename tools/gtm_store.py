"""Mémoire persistante du swarm GTM (SQLite).

Tables: keywords, serp_runs, snapshots, signals, runs.
Tous les agents partagent cette base → le swarm accumule la connaissance.
"""
from __future__ import annotations

import csv
import hashlib
import io
import os
import sqlite3
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gtm_common import db_path, ensure_dirs  # noqa: E402

SCHEMA = """
CREATE TABLE IF NOT EXISTS keywords (
  kw TEXT PRIMARY KEY,
  source TEXT,              -- seed|google|ddg|youtube|trends|manual
  intent TEXT,              -- info|commercial|transactional|brand|?
  score REAL DEFAULT 0,
  trend REAL,               -- intérêt Google Trends moyen 0-100 (si connu)
  parent TEXT,
  first_seen TEXT,
  last_seen TEXT
);
CREATE TABLE IF NOT EXISTS serp_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kw TEXT, domain TEXT, position INTEGER, url TEXT, checked_at TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, url TEXT, sha TEXT, text_path TEXT,
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT, title TEXT, url TEXT, snippet TEXT,
  score REAL DEFAULT 0, seen_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT, args TEXT, started_at TEXT, finished_at TEXT, status TEXT
);
"""


def connect() -> sqlite3.Connection:
    path = db_path()
    ensure_dirs(os.path.dirname(path) or ".")
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def upsert_keywords(con: sqlite3.Connection, rows: list[dict]) -> int:
    """rows: [{kw, source, intent?, score?, parent?, trend?}]"""
    n = 0
    for r in rows:
        kw = (r.get("kw") or "").strip().lower()
        if not kw:
            continue
        con.execute(
            """INSERT INTO keywords (kw, source, intent, score, trend, parent, first_seen, last_seen)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(kw) DO UPDATE SET
                 source = COALESCE(excluded.source, keywords.source),
                 intent = CASE
                   WHEN excluded.intent IS NOT NULL AND excluded.intent NOT IN ('', '?')
                   THEN excluded.intent ELSE keywords.intent END,
                 score = MAX(COALESCE(keywords.score,0), COALESCE(excluded.score,0)),
                 trend = COALESCE(excluded.trend, keywords.trend),
                 parent = COALESCE(excluded.parent, keywords.parent),
                 last_seen = excluded.last_seen""",
            (
                kw, r.get("source"), r.get("intent"), r.get("score", 0),
                r.get("trend"), r.get("parent"), now(), now(),
            ),
        )
        n += 1
    con.commit()
    return n


def top_keywords(con: sqlite3.Connection, limit: int = 50, min_score: float = 0) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT * FROM keywords WHERE score >= ? ORDER BY score DESC, trend DESC LIMIT ?",
        (min_score, limit),
    ).fetchall()


def record_serp(con: sqlite3.Connection, kw: str, domain: str, position: int | None, url: str) -> None:
    con.execute(
        "INSERT INTO serp_runs (kw, domain, position, url, checked_at) VALUES (?,?,?,?,?)",
        (kw, domain, position, url, now()),
    )
    con.commit()


def save_snapshot(con: sqlite3.Connection, name: str, url: str, text: str, outdir: str = "data/snapshots") -> tuple[str, str | None]:
    """Sauvegarde un snapshot. Retourne (sha, chemin du snapshot précédent ou None)."""
    ensure_dirs(outdir)
    prev = con.execute(
        "SELECT sha, text_path FROM snapshots WHERE name = ? ORDER BY id DESC LIMIT 1", (name,)
    ).fetchone()
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    path = os.path.join(outdir, f"{name}-{sha}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    con.execute(
        "INSERT INTO snapshots (name, url, sha, text_path, fetched_at) VALUES (?,?,?,?,?)",
        (name, url, sha, path, now()),
    )
    con.commit()
    return sha, (prev["text_path"] if prev and prev["sha"] != sha else None)


def add_signals(con: sqlite3.Connection, rows: list[dict]) -> int:
    seen = {
        s["url"] for s in con.execute(
            "SELECT url FROM signals WHERE seen_at > datetime('now','-7 days')"
        ).fetchall()
    }
    n = 0
    for r in rows:
        if not r.get("url") or r["url"] in seen:
            continue
        con.execute(
            "INSERT INTO signals (platform, title, url, snippet, score, seen_at) VALUES (?,?,?,?,?,?)",
            (r.get("platform"), r.get("title"), r["url"], r.get("snippet", ""), r.get("score", 0), now()),
        )
        n += 1
    con.commit()
    return n


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
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        return out
    print(text)
    return "-"


def log_run(tool: str, args: str, status: str = "ok") -> None:
    try:
        con = connect()
        con.execute(
            "INSERT INTO runs (tool, args, started_at, finished_at, status) VALUES (?,?,?,?,?)",
            (tool, args, now(), now(), status),
        )
        con.commit()
    except Exception:
        pass
