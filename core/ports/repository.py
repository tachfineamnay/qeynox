"""Port de persistance. Méthodes explicites, pas de dépôt générique."""
from __future__ import annotations

from typing import Protocol
from uuid import UUID

from core.domain.model import (
    Approval,
    Artifact,
    ArtifactVersion,
    BusinessContext,
    ContextSnapshot,
    Feedback,
    JobRun,
    JobSpec,
    Organization,
    Project,
)


class CoreRepository(Protocol):
    def add_organization(self, organization: Organization) -> None: ...

    def get_organization(self, organization_id: UUID) -> Organization | None: ...

    def add_project(self, project: Project) -> None: ...

    def get_project(self, organization_id: UUID, project_id: UUID) -> Project | None: ...

    def add_business_context(self, context: BusinessContext) -> None: ...

    def get_business_context(self, organization_id: UUID, project_id: UUID) -> BusinessContext | None: ...

    def add_job_spec(self, spec: JobSpec) -> None: ...

    def get_job_spec(self, organization_id: UUID, project_id: UUID, job_spec_id: UUID) -> JobSpec | None: ...

    def add_job_run(self, run: JobRun) -> None: ...

    def get_job_run(self, organization_id: UUID, project_id: UUID, job_run_id: UUID) -> JobRun | None: ...

    def save_job_run(self, run: JobRun) -> None: ...

    def get_version_for_run(
        self, organization_id: UUID, project_id: UUID, job_run_id: UUID
    ) -> ArtifactVersion | None: ...

    def add_context_snapshot(self, snapshot: ContextSnapshot) -> None: ...

    def add_artifact(self, artifact: Artifact) -> None: ...

    def get_artifact(self, organization_id: UUID, project_id: UUID, artifact_id: UUID) -> Artifact | None: ...

    def get_artifact_for_spec(
        self, organization_id: UUID, project_id: UUID, job_spec_id: UUID
    ) -> Artifact | None: ...

    def add_artifact_version(self, version: ArtifactVersion) -> None: ...

    def get_artifact_version(
        self, organization_id: UUID, project_id: UUID, artifact_version_id: UUID
    ) -> ArtifactVersion | None: ...

    def list_artifact_versions(
        self, organization_id: UUID, project_id: UUID, artifact_id: UUID
    ) -> list[ArtifactVersion]: ...

    def add_feedback(self, feedback: Feedback) -> None: ...

    def list_feedback(
        self, organization_id: UUID, project_id: UUID, artifact_version_id: UUID
    ) -> list[Feedback]: ...

    def add_approval(self, approval: Approval) -> None: ...

    def get_approval_for_version(
        self, organization_id: UUID, project_id: UUID, artifact_version_id: UUID
    ) -> Approval | None: ...
