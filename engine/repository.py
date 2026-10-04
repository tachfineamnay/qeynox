"""Accès SQLite unique de QeyNox V1.

Tous les `sqlite3.connect` du projet passent par `connect`. Les requêtes
connues des surfaces web, MCP, research et loops sont des fonctions de
repository : une migration PostgreSQL ultérieure ne touche que ce module.
Le schéma est inchangé.
"""
from __future__ import annotations

import hashlib
import os
import sqlite3
from datetime import datetime, timezone

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


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connect(path: str, *, init: bool = True) -> sqlite3.Connection:
    """Ouvre la base. `init=True` crée le dossier parent et applique le schéma."""
    if init:
        folder = os.path.dirname(os.path.abspath(path))
        if folder:
            os.makedirs(folder, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    if init:
        con.executescript(SCHEMA)
    return con


def _read(path: str, sql: str, params: tuple = ()) -> list[dict]:
    if not path or not os.path.exists(path):
        return []
    con = connect(path, init=False)
    try:
        return [dict(row) for row in con.execute(sql, params).fetchall()]
    finally:
        con.close()


def _scalar(path: str, sql: str, params: tuple = ()) -> int:
    if not path or not os.path.exists(path):
        return 0
    con = connect(path, init=False)
    try:
        return int(con.execute(sql, params).fetchone()[0])
    except Exception:
        return 0
    finally:
        con.close()


# ---------------------------------------------------------------- écritures
def upsert_keywords(con: sqlite3.Connection, rows: list[dict]) -> int:
    """rows: [{kw, source, intent?, score?, parent?, trend?}]"""
    n = 0
    for row in rows:
        kw = (row.get("kw") or "").strip().lower()
        if not kw:
            continue
        con.execute(
            """INSERT INTO keywords (kw, source, intent, score, trend, parent, first_seen, last_seen)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(kw) DO UPDATE SET
                 score = MAX(COALESCE(keywords.score,0), COALESCE(excluded.score,0)),
                 trend = COALESCE(excluded.trend, keywords.trend),
                 last_seen = excluded.last_seen""",
            (
                kw, row.get("source"), row.get("intent"), row.get("score", 0),
                row.get("trend"), row.get("parent"), now(), now(),
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
    os.makedirs(outdir, exist_ok=True)
    prev = con.execute(
        "SELECT sha, text_path FROM snapshots WHERE name = ? ORDER BY id DESC LIMIT 1", (name,)
    ).fetchone()
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    path = os.path.join(outdir, f"{name}-{sha}.txt")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    con.execute(
        "INSERT INTO snapshots (name, url, sha, text_path, fetched_at) VALUES (?,?,?,?,?)",
        (name, url, sha, path, now()),
    )
    con.commit()
    return sha, (prev["text_path"] if prev and prev["sha"] != sha else None)


def add_signals(con: sqlite3.Connection, rows: list[dict]) -> int:
    seen = {
        row["url"] for row in con.execute(
            "SELECT url FROM signals WHERE seen_at > datetime('now','-7 days')"
        ).fetchall()
    }
    n = 0
    for row in rows:
        if not row.get("url") or row["url"] in seen:
            continue
        con.execute(
            "INSERT INTO signals (platform, title, url, snippet, score, seen_at) VALUES (?,?,?,?,?,?)",
            (row.get("platform"), row.get("title"), row["url"], row.get("snippet", ""), row.get("score", 0), now()),
        )
        n += 1
    con.commit()
    return n


def log_run(path: str, tool: str, args: str, status: str = "ok") -> None:
    try:
        con = connect(path)
        try:
            con.execute(
                "INSERT INTO runs (tool, args, started_at, finished_at, status) VALUES (?,?,?,?,?)",
                (tool, args, now(), now(), status),
            )
            con.commit()
        finally:
            con.close()
    except Exception:
        pass


# ---------------------------------------------------------------- lectures
def recent_runs(path: str, limit: int = 10) -> list[dict]:
    return _read(
        path,
        "SELECT tool, args, started_at, status FROM runs ORDER BY id DESC LIMIT ?",
        (limit,),
    )


def count_keywords(path: str) -> int:
    return _scalar(path, "SELECT COUNT(*) FROM keywords")


def count_keywords_intent(path: str, intent: str = "commercial") -> int:
    return _scalar(path, "SELECT COUNT(*) FROM keywords WHERE intent = ?", (intent,))


def count_signals(path: str) -> int:
    return _scalar(path, "SELECT COUNT(*) FROM signals")


def count_serp_runs(path: str) -> int:
    return _scalar(path, "SELECT COUNT(*) FROM serp_runs")


def stack_counts(path: str) -> dict[str, int]:
    """Compteurs loops : keywords, signals, competitors (table snapshots)."""
    counts = {"keywords": 0, "signals": 0, "competitors": 0}
    if not path or not os.path.exists(path):
        return counts
    tables = {"keywords": "keywords", "signals": "signals", "competitors": "snapshots"}
    con = connect(path, init=False)
    try:
        for key, table in tables.items():
            try:
                counts[key] = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            except sqlite3.OperationalError:
                pass
    except Exception:
        return {"keywords": 0, "signals": 0, "competitors": 0}
    finally:
        con.close()
    return counts


def keywords_for_ui(path: str, limit: int = 1000) -> list[dict]:
    return _read(
        path,
        "SELECT kw, intent, score, source, parent, trend, last_seen FROM keywords ORDER BY score DESC LIMIT ?",
        (limit,),
    )


def keywords_for_export(path: str) -> list[dict]:
    return _read(path, "SELECT kw, intent, score, source, parent, trend FROM keywords ORDER BY score DESC")


def keywords_for_agent(path: str, intent: str | None = None, limit: int = 20) -> list[dict]:
    sql = "SELECT kw, intent, score, source FROM keywords"
    params: list = []
    if intent:
        sql += " WHERE intent = ?"
        params.append(intent)
    sql += " ORDER BY score DESC LIMIT ?"
    params.append(int(limit))
    return _read(path, sql, tuple(params))


def top_scored_keywords(path: str, limit: int = 40) -> list[dict]:
    return _read(
        path,
        "SELECT kw, intent, score, source FROM keywords ORDER BY score DESC LIMIT ?",
        (limit,),
    )


def top_keyword_rows(path: str, limit: int) -> list[tuple]:
    """Top mots-clés `(kw,)` pour la boucle trends. La colonne du schéma est `kw`."""
    if not path or not os.path.exists(path):
        return []
    con = connect(path, init=False)
    try:
        rows = con.execute(
            "SELECT kw FROM keywords ORDER BY score DESC LIMIT ?", (limit,)
        ).fetchall()
        return [tuple(row) for row in rows]
    finally:
        con.close()


def signals_for_ui(path: str, limit: int = 200) -> list[dict]:
    return _read(
        path,
        "SELECT platform, title, url, snippet, score, seen_at FROM signals ORDER BY score DESC, id DESC LIMIT ?",
        (limit,),
    )


def signals_for_agent(path: str, limit: int = 10) -> list[dict]:
    return _read(
        path,
        "SELECT platform, title, url, snippet, score FROM signals ORDER BY score DESC, id DESC LIMIT ?",
        (int(limit),),
    )


def latest_serp(path: str) -> list[dict]:
    return _read(
        path,
        """SELECT kw, position, url, checked_at FROM serp_runs s
           WHERE id IN (SELECT MAX(id) FROM serp_runs GROUP BY kw)""",
    )


def competitor_snapshots(path: str) -> list[dict]:
    return _read(
        path,
        """SELECT name, url, MAX(fetched_at) AS last_at, COUNT(*) AS versions
           FROM snapshots GROUP BY name ORDER BY name""",
    )
