"""Entités du Domain Core. Aucune dépendance d'infrastructure."""
from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_LANGUAGE = re.compile(r"^[a-z]{2}$")
_URL = re.compile(r"^https?://\S+$")

JOB_TYPES = frozenset({
    "discover.keywords",
    "discover.serp",
    "discover.signals",
    "crawl.site",
    "audit.technical",
    "audit.aeo",
    "geo.visibility",
    "rank.track",
    "competitors.watch",
    "analytics.traffic",
    "search.web",
    "content.outline",
    "content.hooks",
    "strategy.critique",
    "perf.lighthouse",
    "llm.observe",
    "rag.embed",
})

JOB_STATUSES = frozenset({"queued", "running", "ok", "failed", "needs_approval"})
MODEL_SELECTORS = frozenset({"auto", "fast", "strong", "local", "custom"})


class DomainError(Exception):
    """Règle métier refusée."""


class NotFound(DomainError):
    """Agrégat introuvable dans l'organisation demandée."""


class NotInOrganization(DomainError):
    """L'identifiant n'appartient pas à cette organisation."""


class Conflict(DomainError):
    """Unicité déjà prise (slug, ou contexte déjà posé)."""


def _name(value: str) -> str:
    text = str(value).strip()
    if not text:
        raise DomainError("nom vide")
    return text


def _slug(value: str) -> str:
    if not isinstance(value, str) or _SLUG.fullmatch(value) is None:
        raise DomainError("slug invalide")
    return value


def _text(value: str, label: str) -> str:
    text = str(value).strip()
    if not text:
        raise DomainError(f"{label} vide")
    return text


def _aliases(value: object) -> tuple[str, ...]:
    if isinstance(value, str) or not isinstance(value, (tuple, list)):
        raise DomainError("alias invalides")
    aliases = tuple(_text(item, "alias") for item in value)
    if len(set(aliases)) != len(aliases):
        raise DomainError("alias en double")
    return aliases


def _json_value(value: object) -> object:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise DomainError("clé d'inputs non texte")
        return {key: _json_value(item) for key, item in value.items()}
    raise DomainError("inputs non sérialisables")


@dataclass(frozen=True)
class Organization:
    id: UUID
    name: str
    slug: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", _name(self.name))
        object.__setattr__(self, "slug", _slug(self.slug))


@dataclass(frozen=True)
class Project:
    id: UUID
    organization_id: UUID
    name: str
    slug: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", _name(self.name))
        object.__setattr__(self, "slug", _slug(self.slug))


@dataclass(frozen=True)
class BusinessContext:
    id: UUID
    organization_id: UUID
    project_id: UUID
    language: str
    geo: str
    site_url: str
    brand_aliases: tuple[str, ...]
    offer: str

    def __post_init__(self) -> None:
        if not isinstance(self.language, str) or _LANGUAGE.fullmatch(self.language) is None:
            raise DomainError("langue invalide")
        object.__setattr__(self, "geo", _text(self.geo, "geo"))
        if not isinstance(self.site_url, str) or _URL.fullmatch(self.site_url) is None:
            raise DomainError("site_url invalide")
        object.__setattr__(self, "brand_aliases", _aliases(self.brand_aliases))
        object.__setattr__(self, "offer", _text(self.offer, "offre"))


@dataclass(frozen=True)
class JobSpec:
    id: UUID
    organization_id: UUID
    project_id: UUID
    type: str
    role: str
    title: str
    inputs: dict
    arms: tuple[str, ...]
    model: str
    gate: bool
    done_when: str

    def __post_init__(self) -> None:
        if self.type not in JOB_TYPES:
            raise DomainError("type de job inconnu")
        if self.model not in MODEL_SELECTORS:
            raise DomainError("modèle inconnu")
        if not isinstance(self.gate, bool):
            raise DomainError("gate invalide")
        if not isinstance(self.inputs, dict):
            raise DomainError("inputs doit être un objet")
        object.__setattr__(self, "role", _text(self.role, "rôle"))
        object.__setattr__(self, "title", _text(self.title, "titre"))
        object.__setattr__(self, "done_when", _text(self.done_when, "done_when"))
        object.__setattr__(self, "arms", _arms(self.arms))
        object.__setattr__(self, "inputs", _json_value(copy.deepcopy(self.inputs)))


def _arms(value: object) -> tuple[str, ...]:
    if isinstance(value, str) or not isinstance(value, (tuple, list)):
        raise DomainError("arms invalides")
    arms = tuple(_text(item, "arm") for item in value)
    if len(set(arms)) != len(arms):
        raise DomainError("arm en double")
    return arms


@dataclass(frozen=True)
class JobRun:
    id: UUID
    organization_id: UUID
    project_id: UUID
    job_spec_id: UUID
    type: str
    status: str
    model: str
    error: str | None
    created_at: datetime

    def __post_init__(self) -> None:
        if self.type not in JOB_TYPES:
            raise DomainError("type de job inconnu")
        if self.status not in JOB_STATUSES:
            raise DomainError("statut inconnu")
        if self.model not in MODEL_SELECTORS:
            raise DomainError("modèle inconnu")
        if self.error is not None:
            object.__setattr__(self, "error", _text(self.error, "erreur"))
        if self.created_at.tzinfo is None or self.created_at.utcoffset() is None:
            raise DomainError("created_at sans fuseau")
