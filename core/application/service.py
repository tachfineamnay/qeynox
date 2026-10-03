"""Cas d'usage du Domain Core : créer et relire. Pas d'exécution."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID, uuid4

from core.domain.model import (
    BusinessContext,
    Conflict,
    JobRun,
    JobSpec,
    NotFound,
    NotInOrganization,
    Organization,
    Project,
)
from core.ports.repository import CoreRepository


@dataclass(frozen=True)
class Chain:
    organization: Organization
    project: Project
    context: BusinessContext
    spec: JobSpec
    run: JobRun


class CoreService:
    def __init__(self, repository: CoreRepository) -> None:
        self._repository = repository

    def open_organization(self, *, name: str, slug: str) -> Organization:
        organization = Organization(id=uuid4(), name=name, slug=slug)
        self._repository.add_organization(organization)
        return organization

    def open_project(self, *, organization_id: UUID, name: str, slug: str) -> Project:
        if self._repository.get_organization(organization_id) is None:
            raise NotFound("organization")
        project = Project(id=uuid4(), organization_id=organization_id, name=name, slug=slug)
        self._repository.add_project(project)
        return project

    def set_business_context(
        self,
        *,
        organization_id: UUID,
        project_id: UUID,
        language: str,
        geo: str,
        site_url: str,
        brand_aliases: list[str] | tuple[str, ...],
        offer: str,
    ) -> BusinessContext:
        self._require_project(organization_id, project_id)
        if self._repository.get_business_context(organization_id, project_id) is not None:
            raise Conflict("business_context")
        context = BusinessContext(
            id=uuid4(),
            organization_id=organization_id,
            project_id=project_id,
            language=language,
            geo=geo,
            site_url=site_url,
            brand_aliases=brand_aliases,
            offer=offer,
        )
        self._repository.add_business_context(context)
        return context

    def define_job_spec(
        self,
        *,
        organization_id: UUID,
        project_id: UUID,
        type: str,
        role: str,
        title: str,
        inputs: dict,
        arms: list[str] | tuple[str, ...],
        model: str,
        gate: bool,
        done_when: str,
    ) -> JobSpec:
        self._require_project(organization_id, project_id)
        spec = JobSpec(
            id=uuid4(),
            organization_id=organization_id,
            project_id=project_id,
            type=type,
            role=role,
            title=title,
            inputs=inputs,
            arms=arms,
            model=model,
            gate=gate,
            done_when=done_when,
        )
        self._repository.add_job_spec(spec)
        return spec

    def record_job_run(
        self,
        *,
        organization_id: UUID,
        project_id: UUID,
        job_spec_id: UUID,
        created_at: datetime | None = None,
    ) -> JobRun:
        spec = self._repository.get_job_spec(organization_id, project_id, job_spec_id)
        if spec is None or spec.organization_id != organization_id or spec.project_id != project_id:
            raise NotInOrganization("job_spec")
        moment = created_at if created_at is not None else datetime.now(timezone.utc)
        run = JobRun(
            id=uuid4(),
            organization_id=organization_id,
            project_id=project_id,
            job_spec_id=spec.id,
            type=spec.type,
            status="queued",
            model=spec.model,
            error=None,
            created_at=moment,
        )
        self._repository.add_job_run(run)
        return run

    def read_chain(self, *, organization_id: UUID, project_id: UUID, job_run_id: UUID) -> Chain:
        organization = self._repository.get_organization(organization_id)
        if organization is None:
            raise NotFound("organization")
        project = self._require_project(organization_id, project_id)
        context = self._repository.get_business_context(organization_id, project_id)
        if context is None:
            raise NotFound("business_context")
        run = self._repository.get_job_run(organization_id, project_id, job_run_id)
        if run is None:
            raise NotInOrganization("job_run")
        spec = self._repository.get_job_spec(organization_id, project_id, run.job_spec_id)
        if spec is None:
            raise NotInOrganization("job_spec")
        return Chain(organization=organization, project=project, context=context, spec=spec, run=run)

    def _require_project(self, organization_id: UUID, project_id: UUID) -> Project:
        project = self._repository.get_project(organization_id, project_id)
        if project is None or project.organization_id != organization_id:
            raise NotInOrganization("project")
        return project
