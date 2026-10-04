"""Régressions des trois bugs de stabilité V1."""
from __future__ import annotations

import json
import os

from engine import repository as repo
from engine import repo_scan
from engine.loops import program_call


def test_trends_loop_reads_kw_not_a_missing_column(tmp_path, monkeypatch):
    monkeypatch.setenv("QEYNOX_STACKS_DIR", str(tmp_path))
    slug = "demo"
    db = tmp_path / slug / "data" / "gtm.db"
    con = repo.connect(str(db))
    try:
        repo.upsert_keywords(con, [{
            "kw": "suivi gtm",
            "score": 9,
            "source": "test",
            "intent": "commercial",
        }])
    finally:
        con.close()
    ctx = tmp_path / slug / "context"
    ctx.mkdir(parents=True)
    (ctx / "repo-analysis.json").write_text(
        json.dumps({"brand": {"guess": "MarqueFallback"}}),
        encoding="utf-8",
    )

    name, params = program_call({"type": "trends", "params": {}}, slug)
    assert name == "trends_check"
    assert params["kws"][0] == "suivi gtm"


def test_failed_clone_marks_stage_error_and_targets_stack_repo(tmp_path, monkeypatch):
    stacks = tmp_path / "stacks"
    monkeypatch.setenv("QEYNOX_STACKS_DIR", str(stacks))
    monkeypatch.setattr(repo_scan.shutil, "which", lambda _name: "/usr/bin/git")
    dests = []

    def fake_run(argv, **kwargs):
        dests.append(argv[-1])

        class Proc:
            returncode = 128
            stdout = ""
            stderr = "fatal: boom"

        return Proc()

    monkeypatch.setattr("engine.runner.subprocess.run", fake_run)
    from engine import pipeline as pl

    created = pl.create_stack("Demo", "https://github.com/example/demo.git")
    slug = created["slug"]
    pl.init_pipeline(slug)
    pl.run_pipeline(slug, {"source": "https://github.com/example/demo.git", "name": "Demo"})

    expected = os.path.join(str(stacks), slug, "repo")
    assert dests == [expected]
    assert not expected.endswith(os.path.join("repo", "repo"))

    pipe = pl.read_pipeline(slug)
    statuses = {stage["id"]: stage["status"] for stage in pipe["stages"]}
    assert statuses["clone"] == "error"
    assert pipe["status"] == "error"
    assert "boom" in pipe["error"]
    clone = next(stage for stage in pipe["stages"] if stage["id"] == "clone")
    assert "boom" in clone["log"]
