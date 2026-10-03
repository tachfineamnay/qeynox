"""Entités du Domain Core. Aucune dépendance d'infrastructure."""
from __future__ import annotations

import copy
import re
from dataclasses import dataclass, replace
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

    def with_status(self, status: str, error: str | None = None) -> JobRun:
        if status not in JOB_STATUSES:
            raise DomainError("statut inconnu")
        if status != self.status:
            allowed = {
                "queued": {"running", "failed"},
                "running": {"ok", "failed"},
                "failed": {"running"},
                "ok": set(),
                "needs_approval": set(),
            }
            if status not in allowed[self.status]:
                raise DomainError("transition interdite")
        if status == "failed":
            next_error: str | None = _text(error or "", "erreur")
        elif status == "ok":
            next_error = None
        else:
            next_error = self.error
        return replace(self, status=status, error=next_error)


CONFIDENCE = frozenset({"ok", "low"})
APPROVAL_DECISIONS = frozenset({"go", "no_go"})


def _moment(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise DomainError("horodatage sans fuseau")
    return value


@dataclass(frozen=True)
class SourceRef:
    url: str
    note: str

    def __post_init__(self) -> None:
        if not isinstance(self.url, str) or _URL.fullmatch(self.url) is None:
            raise DomainError("source url invalide")
        if not isinstance(self.note, str):
            raise DomainError("source note invalide")
        object.__setattr__(self, "note", self.note.strip())


def _sources(value: object) -> tuple[SourceRef, ...]:
    if isinstance(value, str) or not isinstance(value, (tuple, list)):
        raise DomainError("sources invalides")
    refs: list[SourceRef] = []
    for item in value:
        if isinstance(item, SourceRef):
            refs.append(item)
        elif isinstance(item, (tuple, list)) and len(item) == 2:
            refs.append(SourceRef(url=item[0], note=item[1]))
        else:
            raise DomainError("source invalide")
    return tuple(refs)


@dataclass(frozen=True)
class ContextSnapshot:
    id: UUID
    organization_id: UUID
    project_id: UUID
    business_context_id: UUID
    language: str
    geo: str
    site_url: str
    brand_aliases: tuple[str, ...]
    offer: str
    captured_at: datetime

    def __post_init__(self) -> None:
        if not isinstance(self.language, str) or _LANGUAGE.fullmatch(self.language) is None:
            raise DomainError("langue invalide")
        object.__setattr__(self, "geo", _text(self.geo, "geo"))
        if not isinstance(self.site_url, str) or _URL.fullmatch(self.site_url) is None:
            raise DomainError("site_url invalide")
        object.__setattr__(self, "brand_aliases", _aliases(self.brand_aliases))
        object.__setattr__(self, "offer", _text(self.offer, "offre"))
        object.__setattr__(self, "captured_at", _moment(self.captured_at))


@dataclass(frozen=True)
class Artifact:
    id: UUID
    organization_id: UUID
    project_id: UUID
    job_spec_id: UUID
    created_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "created_at", _moment(self.created_at))


@dataclass(frozen=True)
class ArtifactVersion:
    id: UUID
    organization_id: UUID
    project_id: UUID
    artifact_id: UUID
    version_number: int
    parent_version_id: UUID | None
    job_run_id: UUID
    context_snapshot_id: UUID
    body: dict
    sources: tuple[SourceRef, ...]
    confidence: str
    created_at: datetime

    def __post_init__(self) -> None:
        if isinstance(self.version_number, bool) or not isinstance(self.version_number, int) or self.version_number < 1:
            raise DomainError("numéro de version invalide")
        if self.version_number == 1 and self.parent_version_id is not None:
            raise DomainError("v1 sans parent")
        if self.version_number > 1 and self.parent_version_id is None:
            raise DomainError("version sans parent")
        if self.confidence not in CONFIDENCE:
            raise DomainError("confiance inconnue")
        if not isinstance(self.body, dict):
            raise DomainError("body doit être un objet")
        object.__setattr__(self, "body", _json_value(copy.deepcopy(self.body)))
        object.__setattr__(self, "sources", _sources(self.sources))
        object.__setattr__(self, "created_at", _moment(self.created_at))


@dataclass(frozen=True)
class Feedback:
    id: UUID
    organization_id: UUID
    project_id: UUID
    artifact_version_id: UUID
    note: str
    created_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "note", _text(self.note, "note"))
        object.__setattr__(self, "created_at", _moment(self.created_at))


@dataclass(frozen=True)
class Approval:
    id: UUID
    organization_id: UUID
    project_id: UUID
    artifact_version_id: UUID
    decision: str
    decided_at: datetime

    def __post_init__(self) -> None:
        if self.decision not in APPROVAL_DECISIONS:
            raise DomainError("décision inconnue")
        object.__setattr__(self, "decided_at", _moment(self.decided_at))
