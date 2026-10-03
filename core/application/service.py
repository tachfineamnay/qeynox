"""Cas d'usage du Domain Core : créer et relire. Pas d'exécution."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID, uuid4

from core.domain.model import (
    Approval,
    Artifact,
    ArtifactVersion,
    BusinessContext,
    Conflict,
    ContextSnapshot,
    Feedback,
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


@dataclass(frozen=True)
class Publication:
    snapshot: ContextSnapshot
    run: JobRun
    artifact: Artifact
    version: ArtifactVersion


@dataclass(frozen=True)
class ApprovalState:
    head: ArtifactVersion
    approval: Approval | None
    stale: bool


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

    def publish_artifact(
        self,
        *,
        organization_id: UUID,
        project_id: UUID,
        job_spec_id: UUID,
        body: dict,
        sources: list | tuple,
        confidence: str,
        created_at: datetime | None = None,
    ) -> Publication:
        spec = self._require_spec(organization_id, project_id, job_spec_id)
        context = self._require_context(organization_id, project_id)
        if self._repository.get_artifact_for_spec(organization_id, project_id, spec.id) is not None:
            raise Conflict("artifact")
        moment = created_at if created_at is not None else datetime.now(timezone.utc)
        return self._append_version(
            spec=spec,
            context=context,
            artifact=Artifact(
                id=uuid4(),
                organization_id=organization_id,
                project_id=project_id,
                job_spec_id=spec.id,
                created_at=moment,
            ),
            version_number=1,
            parent_version_id=None,
            body=body,
            sources=sources,
            confidence=confidence,
            created_at=moment,
            create_artifact=True,
        )

    def regenerate_artifact(
        self,
        *,
        organization_id: UUID,
        project_id: UUID,
        artifact_id: UUID,
        body: dict,
        sources: list | tuple,
        confidence: str,
        created_at: datetime | None = None,
    ) -> Publication:
        artifact = self._repository.get_artifact(organization_id, project_id, artifact_id)
        if artifact is None or artifact.organization_id != organization_id:
            raise NotInOrganization("artifact")
        spec = self._require_spec(organization_id, project_id, artifact.job_spec_id)
        context = self._require_context(organization_id, project_id)
        versions = self._repository.list_artifact_versions(organization_id, project_id, artifact.id)
        if not versions:
            raise NotFound("artifact_version")
        head = versions[-1]
        moment = created_at if created_at is not None else datetime.now(timezone.utc)
        return self._append_version(
            spec=spec,
            context=context,
            artifact=artifact,
            version_number=head.version_number + 1,
            parent_version_id=head.id,
            body=body,
            sources=sources,
            confidence=confidence,
            created_at=moment,
            create_artifact=False,
        )

    def list_versions(self, *, organization_id: UUID, project_id: UUID, artifact_id: UUID) -> list[ArtifactVersion]:
        if self._repository.get_artifact(organization_id, project_id, artifact_id) is None:
            raise NotInOrganization("artifact")
        return self._repository.list_artifact_versions(organization_id, project_id, artifact_id)

    def record_feedback(
        self,
        *,
        organization_id: UUID,
        project_id: UUID,
        artifact_version_id: UUID,
        note: str,
        created_at: datetime | None = None,
    ) -> Feedback:
        version = self._require_version(organization_id, project_id, artifact_version_id)
        moment = created_at if created_at is not None else datetime.now(timezone.utc)
        feedback = Feedback(
            id=uuid4(),
            organization_id=organization_id,
            project_id=project_id,
            artifact_version_id=version.id,
            note=note,
            created_at=moment,
        )
        self._repository.add_feedback(feedback)
        return feedback

    def list_feedback(
        self, *, organization_id: UUID, project_id: UUID, artifact_version_id: UUID
    ) -> list[Feedback]:
        self._require_version(organization_id, project_id, artifact_version_id)
        return self._repository.list_feedback(organization_id, project_id, artifact_version_id)

    def approve(
        self,
        *,
        organization_id: UUID,
        project_id: UUID,
        artifact_version_id: UUID,
        decision: str,
        decided_at: datetime | None = None,
    ) -> Approval:
        version = self._require_version(organization_id, project_id, artifact_version_id)
        moment = decided_at if decided_at is not None else datetime.now(timezone.utc)
        approval = Approval(
            id=uuid4(),
            organization_id=organization_id,
            project_id=project_id,
            artifact_version_id=version.id,
            decision=decision,
            decided_at=moment,
        )
        self._repository.add_approval(approval)
        return approval

    def approval_state(self, *, organization_id: UUID, project_id: UUID, artifact_id: UUID) -> ApprovalState:
        versions = self.list_versions(
            organization_id=organization_id, project_id=project_id, artifact_id=artifact_id
        )
        if not versions:
            raise NotFound("artifact_version")
        head = versions[-1]
        head_approval = self._repository.get_approval_for_version(organization_id, project_id, head.id)
        if head_approval is not None:
            return ApprovalState(head=head, approval=head_approval, stale=False)
        earlier = None
        for version in versions:
            found = self._repository.get_approval_for_version(organization_id, project_id, version.id)
            if found is not None:
                earlier = found
        return ApprovalState(head=head, approval=earlier, stale=earlier is not None)

    def _append_version(
        self,
        *,
        spec: JobSpec,
        context: BusinessContext,
        artifact: Artifact,
        version_number: int,
        parent_version_id: UUID | None,
        body: dict,
        sources: list | tuple,
        confidence: str,
        created_at: datetime,
        create_artifact: bool,
    ) -> Publication:
        snapshot = ContextSnapshot(
            id=uuid4(),
            organization_id=context.organization_id,
            project_id=context.project_id,
            business_context_id=context.id,
            language=context.language,
            geo=context.geo,
            site_url=context.site_url,
            brand_aliases=context.brand_aliases,
            offer=context.offer,
            captured_at=created_at,
        )
        run = JobRun(
            id=uuid4(),
            organization_id=spec.organization_id,
            project_id=spec.project_id,
            job_spec_id=spec.id,
            type=spec.type,
            status="ok",
            model=spec.model,
            error=None,
            created_at=created_at,
        )
        version = ArtifactVersion(
            id=uuid4(),
            organization_id=artifact.organization_id,
            project_id=artifact.project_id,
            artifact_id=artifact.id,
            version_number=version_number,
            parent_version_id=parent_version_id,
            job_run_id=run.id,
            context_snapshot_id=snapshot.id,
            body=body,
            sources=sources,
            confidence=confidence,
            created_at=created_at,
        )
        self._repository.add_context_snapshot(snapshot)
        self._repository.add_job_run(run)
        if create_artifact:
            self._repository.add_artifact(artifact)
        self._repository.add_artifact_version(version)
        return Publication(snapshot=snapshot, run=run, artifact=artifact, version=version)

    def _require_context(self, organization_id: UUID, project_id: UUID) -> BusinessContext:
        context = self._repository.get_business_context(organization_id, project_id)
        if context is None:
            raise NotFound("business_context")
        return context

    def _require_spec(self, organization_id: UUID, project_id: UUID, job_spec_id: UUID) -> JobSpec:
        spec = self._repository.get_job_spec(organization_id, project_id, job_spec_id)
        if spec is None or spec.organization_id != organization_id or spec.project_id != project_id:
            raise NotInOrganization("job_spec")
        return spec

    def _require_version(self, organization_id: UUID, project_id: UUID, artifact_version_id: UUID) -> ArtifactVersion:
        version = self._repository.get_artifact_version(organization_id, project_id, artifact_version_id)
        if version is None or version.organization_id != organization_id:
            raise NotInOrganization("artifact_version")
        return version

    def _require_project(self, organization_id: UUID, project_id: UUID) -> Project:
        project = self._repository.get_project(organization_id, project_id)
        if project is None or project.organization_id != organization_id:
            raise NotInOrganization("project")
        return project
