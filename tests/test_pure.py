"""Fonctions pures les plus risquées : slugs, intention, URLs Bing, personas."""
from __future__ import annotations

import base64

from engine import research
from engine.dossier import build_personas
from engine.pipeline import slugify
from tools.keyword_research import intent_of


def test_slugify_strips_and_falls_back():
    assert slugify("Mon Produit!") == "mon-produit"
    assert slugify("***") == "stack"
    assert len(slugify("a" * 80)) <= 40


def test_intent_of_commercial_and_question():
    assert intent_of("northstar avis") == "commercial"
    assert intent_of("comment choisir") == "info"


def test_decode_bing_redirect():
    assert research._decode_bing_url("https://example.com/plain") == "https://example.com/plain"
    target = "https://example.com/avis"
    token = base64.urlsafe_b64encode(target.encode()).decode().rstrip("=")
    href = f"https://www.bing.com/ck/a?u=a1{token}&ntb=1"
    assert research._decode_bing_url(href) == target


def test_build_personas_anchors_on_signals():
    ctx = {"brand": {"guess": "Northstar"}, "product": {"category_words": ["suivi", "gtm"]}}
    keywords = {"seeds": ["suivi gtm"], "top": [{"kw": "comment choisir un suivi gtm"}]}
    signals = {"signals": [{
        "title": "avis fiable",
        "snippet": "pas une arnaque",
        "url": "https://example.com/a",
    }]}
    personas = build_personas("northstar", ctx, signals, keywords)
    assert [p["id"] for p in personas] == ["P1", "P2", "P3"]
    assert personas[0]["verbatims"]
    assert "suivi gtm" in personas[0]["hypothese"]
