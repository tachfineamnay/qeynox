"""Les données runtime suivent les variables d'environnement, pas des constantes d'import."""
from __future__ import annotations

import os
import sys

from engine.paths import halt_file, logs_dir, missions_file, qeynox_root, registry_path, stacks_dir


def test_defaults_stay_inside_the_repo(monkeypatch):
    monkeypatch.delenv("QEYNOX_STACKS_DIR", raising=False)
    monkeypatch.delenv("QEYNOX_LOGS_DIR", raising=False)
    monkeypatch.delenv("QEYNOX_MISSIONS_FILE", raising=False)
    monkeypatch.delenv("QEYNOX_ROOT", raising=False)
    root = qeynox_root()
    assert stacks_dir() == os.path.join(root, "stacks")
    assert logs_dir() == os.path.join(root, "logs")
    assert missions_file() == os.path.join(root, "web", "missions.json")
    assert registry_path() == os.path.join(root, "stacks", "registry.json")
    assert halt_file() == os.path.join(root, "stacks", ".halt")


def test_env_overrides_are_read_at_call_time(monkeypatch, tmp_path):
    stacks = tmp_path / "stacks"
    logs = tmp_path / "logs"
    missions = tmp_path / "state" / "missions.json"
    monkeypatch.setenv("QEYNOX_STACKS_DIR", str(stacks))
    monkeypatch.setenv("QEYNOX_LOGS_DIR", str(logs))
    monkeypatch.setenv("QEYNOX_MISSIONS_FILE", str(missions))
    assert stacks_dir() == os.path.abspath(stacks)
    assert logs_dir() == os.path.abspath(logs)
    assert missions_file() == os.path.abspath(missions)
    assert registry_path() == os.path.join(os.path.abspath(stacks), "registry.json")
    assert halt_file() == os.path.join(os.path.abspath(stacks), ".halt")


def test_pipeline_and_halt_follow_the_volume(monkeypatch, tmp_path):
    stacks = tmp_path / "vol" / "stacks"
    monkeypatch.setenv("QEYNOX_STACKS_DIR", str(stacks))
    from engine import pipeline as pl
    from engine.loops import main

    created = pl.create_stack("Northstar", "/tmp/mini-repo", "https://example.com", ["suivi"])
    assert (stacks / "registry.json").is_file()
    assert (stacks / created["slug"]).is_dir()

    monkeypatch.setattr(sys, "argv", ["loops.py", "--halt"])
    main()
    assert (stacks / ".halt").is_file()
