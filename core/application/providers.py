"""Workflow → Capability → Resolver → Provider.

Le Core choisit par priorité et santé. Il ne branche jamais sur le nom d'un provider.
"""
from __future__ import annotations

from uuid import UUID, uuid4

from core.domain.model import (
    Capability,
    DomainError,
    NotInOrganization,
    Project,
    Provider,
    ProviderBinding,
    capability_for_workflow,
)
from core.ports.repository import CoreRepository

# Offres connues hors du domaine. Un test peut en passer d'autres au resolver.
SEED_OFFERS: dict[str, frozenset[str]] = {
    "searxng": frozenset({"search"}),
    "duckduckgo": frozenset({"search"}),
}


class ProviderResolver:
    def __init__(
        self,
        repository: CoreRepository,
        offers: dict[str, frozenset[str]] | None = None,
    ) -> None:
        self._repository = repository
        self._offers = SEED_OFFERS if offers is None else offers

    def bind(
        self,
        *,
        organization_id: UUID,
        project_id: UUID,
        workflow: str,
        provider: str,
        priority: int,
    ) -> ProviderBinding:
        self._require_project(organization_id, project_id)
        capability = self.capability_for(workflow)
        offered = self._offers.get(provider, frozenset())
        if capability.key not in offered:
            raise DomainError("provider hors capability")
        binding = ProviderBinding(
            id=uuid4(),
            organization_id=organization_id,
            project_id=project_id,
            capability=capability.key,
            provider=provider,
            priority=priority,
            health="up",
        )
        self._repository.add_provider_binding(binding)
        return binding

    def replace_provider(
        self,
        *,
        organization_id: UUID,
        project_id: UUID,
        binding_id: UUID,
        provider: str,
    ) -> ProviderBinding:
        current = self._require_binding(organization_id, project_id, binding_id)
        updated = current.with_provider(provider)
        self._repository.save_provider_binding(updated)
        return updated

    def set_health(
        self,
        *,
        organization_id: UUID,
        project_id: UUID,
        binding_id: UUID,
        health: str,
    ) -> ProviderBinding:
        current = self._require_binding(organization_id, project_id, binding_id)
        updated = current.with_health(health)
        self._repository.save_provider_binding(updated)
        return updated

    def capability_for(self, workflow: str) -> Capability:
        return Capability(key=capability_for_workflow(workflow))

    def resolve(self, *, organization_id: UUID, project_id: UUID, workflow: str) -> Provider:
        self._require_project(organization_id, project_id)
        capability = self.capability_for(workflow)
        bindings = self._repository.list_provider_bindings(organization_id, project_id, capability.key)
        ranked = sorted(bindings, key=lambda item: (-item.priority, item.provider))
        chosen = next((item for item in ranked if item.health == "up"), None)
        if chosen is None:
            raise DomainError("provider indisponible")
        return Provider(key=chosen.provider)

    def _require_project(self, organization_id: UUID, project_id: UUID) -> Project:
        project = self._repository.get_project(organization_id, project_id)
        if project is None or project.organization_id != organization_id:
            raise NotInOrganization("project")
        return project

    def _require_binding(self, organization_id: UUID, project_id: UUID, binding_id: UUID) -> ProviderBinding:
        found = self._repository.get_provider_binding(organization_id, project_id, binding_id)
        if found is None or found.organization_id != organization_id or found.project_id != project_id:
            raise NotInOrganization("provider_binding")
        return found
