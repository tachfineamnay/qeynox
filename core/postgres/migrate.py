"""Applique les fichiers SQL de core/migrations dans l'ordre des noms."""
from __future__ import annotations

import re
from pathlib import Path

_MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


def apply(connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    for path in sorted(_MIGRATIONS.glob("*.sql")):
        existing = connection.execute(
            "SELECT 1 FROM schema_migrations WHERE version = %s",
            (path.name,),
        ).fetchone()
        if existing:
            continue
        for statement in _statements(path.read_text(encoding="utf-8")):
            connection.execute(statement)
        connection.execute(
            "INSERT INTO schema_migrations (version) VALUES (%s)",
            (path.name,),
        )


def _statements(sql: str) -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    index = 0
    dollar: str | None = None
    while index < len(sql):
        if dollar is not None:
            if sql.startswith(dollar, index):
                buf.append(dollar)
                index += len(dollar)
                dollar = None
            else:
                buf.append(sql[index])
                index += 1
            continue
        marker = re.match(r"\$[A-Za-z0-9_]*\$", sql[index:])
        if marker:
            dollar = marker.group(0)
            buf.append(dollar)
            index += len(dollar)
            continue
        if sql[index] == ";":
            statement = "".join(buf).strip()
            if statement:
                parts.append(statement)
            buf = []
            index += 1
            continue
        buf.append(sql[index])
        index += 1
    tail = "".join(buf).strip()
    if tail:
        parts.append(tail)
    return parts
