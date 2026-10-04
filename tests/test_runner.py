"""Runner unique et dossiers versionnés."""
from __future__ import annotations

import json

from engine import dossier
from engine.runner import normalize_mission, run_tool


def test_run_tool_builds_keyword_argv(monkeypatch):
    captured = {}

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        captured["timeout"] = kwargs.get("timeout")

        class Proc:
            returncode = 0
            stdout = "ok"
            stderr = ""

        return Proc()

    monkeypatch.setattr("engine.runner.subprocess.run", fake_run)
    result = run_tool(
        "keyword_research",
        {"seeds": ["suivi gtm"], "rounds": 1, "breadth": 5, "min_score": 3, "out": "research/keywords.csv"},
        cwd="/tmp",
        timeout=420,
    )
    assert result.ok
    assert result.timed_out is False
    argv = captured["argv"]
    assert argv[1].endswith("keyword_research.py")
    assert argv[argv.index("--seed") + 1] == "suivi gtm"
    assert argv[argv.index("--rounds") + 1] == "1"
    assert argv[argv.index("--min-score") + 1] == "3"
    assert captured["timeout"] == 420


def test_normalize_mission_rejects_flag_injection():
    try:
        normalize_mission("keywords", {"seeds": ["--help"]})
        raised = False
    except ValueError:
        raised = True
    assert raised


def test_dossier_versions_are_immutable(tmp_path, monkeypatch):
    monkeypatch.setattr(dossier, "STACKS_DIR", str(tmp_path))
    slug = "demo"
    ctx_dir = tmp_path / slug / "context"
    ctx_dir.mkdir(parents=True)
    ctx = {
        "brand": {"guess": "Demo", "html_title": "", "meta_description": ""},
        "product": {
            "prices": [], "emails": [], "socials": {},
            "taglines_h1": [], "value_props_h2": [], "ctas": [],
            "category_words": ["suivi"],
        },
        "readme": {"excerpt": "extrait"},
        "languages": {},
        "manifests": {"frameworks": []},
        "source": "fixture",
        "site_url": "",
    }
    (ctx_dir / "repo-analysis.json").write_text(json.dumps(ctx), encoding="utf-8")
    first = dossier.build_dossier(slug, "Demo")
    original = open(first["path"], encoding="utf-8").read()
    second = dossier.build_dossier(slug, "Demo")
    assert first["version"] == 1
    assert second["version"] == 2
    assert open(first["path"], encoding="utf-8").read() == original
    assert "v0002" in second["path"]
    pointer = json.loads((tmp_path / slug / "dossier" / "latest.json").read_text(encoding="utf-8"))
    assert pointer["version"] == 2
    name, content = dossier.read_dossier_markdown(slug)
    assert name == "gtm-dossier-v0002.md"
    assert "Dossier GTM" in content
