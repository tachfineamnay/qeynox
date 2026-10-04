"""Le repository est le seul accès SQLite, sans changement de schéma."""
from __future__ import annotations

from engine import repository as repo


def test_keyword_roundtrip_keeps_schema(tmp_path):
    path = str(tmp_path / "gtm.db")
    con = repo.connect(path)
    try:
        tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"keywords", "serp_runs", "snapshots", "signals", "runs"} <= tables
        assert repo.upsert_keywords(con, [{
            "kw": "Suivi GTM avis",
            "source": "test",
            "intent": "commercial",
            "score": 4,
        }]) == 1
    finally:
        con.close()

    rows = repo.keywords_for_ui(path)
    assert rows[0]["kw"] == "suivi gtm avis"
    assert rows[0]["intent"] == "commercial"
    assert repo.count_keywords(path) == 1
    assert repo.count_keywords_intent(path, "commercial") == 1
    assert repo.top_scored_keywords(path, limit=10)[0]["score"] == 4
    assert repo.keywords_for_agent(path, intent="info") == []
    assert repo.recent_runs(path) == []


def test_missing_database_reads_as_empty(tmp_path):
    path = str(tmp_path / "absent.db")
    assert repo.count_signals(path) == 0
    assert repo.signals_for_ui(path) == []
    assert repo.stack_counts(path) == {"keywords": 0, "signals": 0, "competitors": 0}


def test_sqlite_connect_lives_only_in_repository():
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[1]
    offenders = []
    for path in root.rglob("*.py"):
        if "repository.py" in path.parts or "tests" in path.parts or ".venv" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        if "sqlite3.connect" in text or "import sqlite3" in text:
            offenders.append(str(path.relative_to(root)))
    assert offenders == []
