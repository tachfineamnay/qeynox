"""Chemins runtime, lus à chaque appel.

Les données tenant (stacks, SQLite, logs, missions) restent hors de l'image.
Un volume Coolify pointe ces variables vers /data sans changer le code.

  QEYNOX_ROOT            racine du code (défaut : parent de engine/)
  QEYNOX_STACKS_DIR      stacks/<slug>/… (défaut : <root>/stacks)
  QEYNOX_LOGS_DIR        journaux (défaut : <root>/logs)
  QEYNOX_MISSIONS_FILE   file des missions UI (défaut : <root>/web/missions.json)
"""
from __future__ import annotations

import os


def qeynox_root() -> str:
    raw = (os.environ.get("QEYNOX_ROOT") or "").strip()
    if raw:
        return os.path.abspath(raw)
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def stacks_dir() -> str:
    raw = (os.environ.get("QEYNOX_STACKS_DIR") or "").strip()
    if raw:
        return os.path.abspath(raw)
    return os.path.join(qeynox_root(), "stacks")


def logs_dir() -> str:
    raw = (os.environ.get("QEYNOX_LOGS_DIR") or "").strip()
    if raw:
        return os.path.abspath(raw)
    return os.path.join(qeynox_root(), "logs")


def missions_file() -> str:
    raw = (os.environ.get("QEYNOX_MISSIONS_FILE") or "").strip()
    if raw:
        return os.path.abspath(raw)
    return os.path.join(qeynox_root(), "web", "missions.json")


def registry_path() -> str:
    return os.path.join(stacks_dir(), "registry.json")


def halt_file() -> str:
    return os.path.join(stacks_dir(), ".halt")
