"""Filet de sécurité : pipeline d'onboarding complet, sans réseau.

Le statut terminal d'un pipeline réussi est `review` (dossier prêt pour la
validation humaine). L'étape dossier elle-même est `done`.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine import dossier as dossier_mod
from engine import pipeline as pl
from engine import research
from engine import synthesize

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "mini-repo"


def _use_tmp_stacks(monkeypatch, tmp_path: Path) -> Path:
    stacks = tmp_path / "stacks"
    stacks.mkdir()
    monkeypatch.setattr(pl, "STACKS_DIR", str(stacks))
    monkeypatch.setattr(pl, "REGISTRY", str(stacks / "registry.json"))
    for module in (research, dossier_mod, synthesize):
        monkeypatch.setattr(module, "STACKS_DIR", str(stacks))
    return stacks


def _fake_search(query: str, limit: int = 10) -> list[dict]:
    return [
        {
            "title": f"{query} — avis fiable",
            "url": "https://example.com/northstar-avis",
            "snippet": "avis fiable, pas une arnaque, prix d'essai et besoin de recommandation",
        },
        {
            "title": "Meilleur suivi gtm",
            "url": "https://competitor.example/gtm",
            "snippet": "alternative suivi gtm comparatif prix 29 EUR",
        },
    ][:limit]


def _fake_fetch(url: str, timeout: int = 15) -> tuple[str, str]:
    return "Competitor GTM", "Offre a 29 EUR. Suivi gtm pour equipes produit, avis fiable."


class _Resp:
    def __init__(self, text: str, status_code: int = 200) -> None:
        self.text = text
        self.status_code = status_code


def _fake_safe_get(url: str, timeout: int = 20, headers=None):
    if url.rstrip("/").endswith(("/robots.txt", "/sitemap.xml", "/llms.txt")):
        return _Resp("User-agent: *\nAllow: /\n" + ("x" * 30))
    page = """<!doctype html><html><head>
<title>Northstar Desk suivi gtm pour equipes produit</title>
<meta name="description" content="Une meta description suffisamment longue pour depasser cinquante caracteres utiles.">
<link rel="canonical" href="https://example.com/">
<meta property="og:title" content="Northstar Desk">
<script type="application/ld+json">{"@type":"Organization"}</script>
</head><body>
<h1>Cockpit GTM</h1>
<h2>Comment suivre son go to market ?</h2>
</body></html>"""
    return _Resp(page)


@pytest.fixture
def offline(monkeypatch, tmp_path):
    monkeypatch.setenv("QEYNOX_OFFLINE_SEARCH", "1")
    monkeypatch.setenv("QEYNOX_LLM", "none")
    monkeypatch.setattr(research, "searxng_available", lambda: False)
    monkeypatch.setattr(research, "_search", _fake_search)
    monkeypatch.setattr(research, "fetch_text", _fake_fetch)
    monkeypatch.setattr(research, "safe_get", _fake_safe_get)
    monkeypatch.setattr(research.time, "sleep", lambda *_a, **_k: None)
    return _use_tmp_stacks(monkeypatch, tmp_path)


def test_onboarding_pipeline_produces_dossier(offline):
    stacks = offline
    source = str(FIXTURE)
    created = pl.create_stack("Northstar Desk", source, "https://example.com", ["suivi gtm"])
    slug = created["slug"]
    pl.init_pipeline(slug)
    pl.run_pipeline(slug, {
        "source": source,
        "name": "Northstar Desk",
        "site_url": "https://example.com",
        "seeds": ["suivi gtm"],
    })

    pipe = pl.read_pipeline(slug)
    assert pipe is not None
    statuses = {stage["id"]: stage["status"] for stage in pipe["stages"]}
    assert statuses == {
        "clone": "done",
        "scan": "done",
        "keywords": "done",
        "signals": "done",
        "competitors": "done",
        "aeo": "done",
        "synthese": "skipped",
        "dossier": "done",
    }
    # Succès terminal : le dossier attend la validation humaine.
    assert pipe["status"] == "review"

    stack = stacks / slug
    keywords = json.loads((stack / "research" / "keywords.json").read_text(encoding="utf-8"))
    assert keywords["top"], keywords.get("log_tail")
    signals = json.loads((stack / "research" / "signals.json").read_text(encoding="utf-8"))
    assert signals["signals"]
    dossier_dir = stack / "dossier"
    markdowns = sorted(dossier_dir.glob("*.md"))
    assert markdowns, "aucun dossier markdown"
    text = markdowns[-1].read_text(encoding="utf-8")
    assert "Dossier GTM" in text
    assert (dossier_dir / "data.json").is_file()
    pointer = json.loads((dossier_dir / "latest.json").read_text(encoding="utf-8"))
    assert pointer["version"] >= 1
    assert (dossier_dir / pointer["markdown"]).is_file()
