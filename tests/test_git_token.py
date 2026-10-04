"""Le PAT GitHub ne sort jamais de l'environnement du processus git."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine.git_auth import _HEADER_KEY
from engine.runner import run_tool
from engine.safety import validate_git_url

TOKEN = "github_pat_SUPERSECRETVALUE99"
GITHUB = "https://github.com/tachfineamnay/SocioPulseV1.git"


def _files(root: Path) -> str:
    parts = []
    if not root.exists():
        return ""
    for path in root.rglob("*"):
        if path.is_file():
            parts.append(path.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(parts)


def _fake_git(captured: dict, stderr: str):
    def fake_run(argv, **kwargs):
        captured["argv"] = list(argv)
        captured["env"] = dict(kwargs.get("env") or {})
        out = f"stdout mentions {TOKEN}"
        err = stderr

        class Proc:
            returncode = 128

        Proc.stdout = out
        Proc.stderr = err
        return Proc()

    return fake_run


def test_github_https_header_is_env_only(monkeypatch, tmp_path):
    monkeypatch.setenv("QEYNOX_GIT_TOKEN", TOKEN)
    monkeypatch.setenv("QEYNOX_LOGS_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "user.email")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "dev@example.com")
    captured: dict = {}
    monkeypatch.setattr(
        "engine.runner.subprocess.run",
        _fake_git(captured, f"fatal: authentication failed for {TOKEN}"),
    )

    result = run_tool("git_clone", {"url": GITHUB, "dest": str(tmp_path / "repo")}, cwd=str(tmp_path))

    assert captured["argv"] == ["git", "clone", "--depth", "1", "--", GITHUB, str(tmp_path / "repo")]
    assert TOKEN not in " ".join(captured["argv"])
    assert "QEYNOX_GIT_TOKEN" not in captured["env"]
    assert captured["env"]["GIT_CONFIG_COUNT"] == "2"
    assert captured["env"]["GIT_CONFIG_KEY_0"] == "user.email"
    assert captured["env"]["GIT_CONFIG_KEY_1"] == _HEADER_KEY
    assert captured["env"]["GIT_CONFIG_VALUE_1"] == f"Authorization: Bearer {TOKEN}"
    assert TOKEN not in result.stdout
    assert TOKEN not in result.stderr
    assert "***" in result.stderr
    journal = (tmp_path / "logs" / "tool-runs.jsonl").read_text(encoding="utf-8")
    assert TOKEN not in journal
    assert GITHUB in journal
    assert TOKEN not in _files(tmp_path)


def test_token_is_not_sent_to_other_hosts(monkeypatch, tmp_path):
    monkeypatch.setenv("QEYNOX_GIT_TOKEN", TOKEN)
    monkeypatch.setenv("QEYNOX_LOGS_DIR", str(tmp_path / "logs"))
    monkeypatch.delenv("GIT_CONFIG_COUNT", raising=False)
    for url in (
        "https://gitlab.com/org/repo.git",
        "http://github.com/org/repo.git",
        "git@github.com:org/repo.git",
    ):
        captured: dict = {}
        monkeypatch.setattr("engine.runner.subprocess.run", _fake_git(captured, "fatal: no"))
        run_tool("git_clone", {"url": url, "dest": str(tmp_path / "repo")})
        env = captured["env"]
        assert "QEYNOX_GIT_TOKEN" not in env
        assert not any(str(key).startswith("GIT_CONFIG_KEY_") and env.get(key) == _HEADER_KEY for key in env)
        assert TOKEN not in " ".join(captured["argv"])
    assert TOKEN not in _files(tmp_path)


def test_without_token_clone_argv_is_unchanged(monkeypatch, tmp_path):
    monkeypatch.delenv("QEYNOX_GIT_TOKEN", raising=False)
    monkeypatch.delenv("GIT_CONFIG_COUNT", raising=False)
    monkeypatch.setenv("QEYNOX_LOGS_DIR", str(tmp_path / "logs"))
    captured: dict = {}
    monkeypatch.setattr("engine.runner.subprocess.run", _fake_git(captured, "fatal: public"))
    run_tool("git_clone", {"url": GITHUB, "dest": str(tmp_path / "repo")})
    assert "GIT_CONFIG_COUNT" not in captured["env"]
    assert captured["argv"][4] == "--"


def test_credential_in_url_is_refused_before_it_is_stored(tmp_path, monkeypatch):
    secret = "github_pat_EMBEDDEDSECRET99"
    monkeypatch.setenv("QEYNOX_STACKS_DIR", str(tmp_path / "stacks"))
    url = f"https://x-access-token:{secret}@github.com/tachfineamnay/LumiraV2.git"
    with pytest.raises(ValueError):
        validate_git_url(url)
    from engine import pipeline as pl
    with pytest.raises(ValueError):
        pl.create_stack("Lumira", url)
    assert secret not in _files(tmp_path)


def test_pipeline_error_files_do_not_contain_the_token(tmp_path, monkeypatch):
    monkeypatch.setenv("QEYNOX_GIT_TOKEN", TOKEN)
    monkeypatch.setenv("QEYNOX_STACKS_DIR", str(tmp_path / "stacks"))
    monkeypatch.setenv("QEYNOX_LOGS_DIR", str(tmp_path / "logs"))
    monkeypatch.setattr("engine.repo_scan.shutil.which", lambda _name: "/usr/bin/git")
    monkeypatch.setattr(
        "engine.runner.subprocess.run",
        _fake_git({}, f"fatal: could not read Password for {TOKEN}"),
    )
    from engine import pipeline as pl

    created = pl.create_stack("Socio", GITHUB)
    pl.init_pipeline(created["slug"])
    pl.run_pipeline(created["slug"], {"source": GITHUB, "name": "Socio"})
    pipe = pl.read_pipeline(created["slug"])
    assert pipe["status"] == "error"
    assert pipe["stages"][0]["status"] == "error"
    blob = _files(tmp_path)
    assert TOKEN not in blob
    assert "***" in json.dumps(pipe)
