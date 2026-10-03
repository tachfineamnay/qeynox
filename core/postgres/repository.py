"""Adaptateur PostgreSQL du port CoreRepository."""
from __future__ import annotations

from uuid import UUID

from psycopg.errors import ForeignKeyViolation, UniqueViolation
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

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
    NotInOrganization,
    Organization,
    Project,
    ProviderBinding,
)


class PostgresCoreRepository:
    def __init__(self, connection) -> None:
        connection.row_factory = dict_row
        self._connection = connection

    def add_organization(self, organization: Organization) -> None:
        self._write(
            """
            INSERT INTO organizations (id, name, slug)
            VALUES (%s, %s, %s)
            """,
            (organization.id, organization.name, organization.slug),
            "organization",
        )

    def get_organization(self, organization_id: UUID) -> Organization | None:
        row = self._connection.execute(
            "SELECT id, name, slug FROM organizations WHERE id = %s",
            (organization_id,),
        ).fetchone()
        if row is None:
            return None
        return Organization(id=row["id"], name=row["name"], slug=row["slug"])

    def add_project(self, project: Project) -> None:
        self._write(
            """
            INSERT INTO projects (id, organization_id, name, slug)
            VALUES (%s, %s, %s, %s)
            """,
            (project.id, project.organization_id, project.name, project.slug),
            "project",
        )

    def get_project(self, organization_id: UUID, project_id: UUID) -> Project | None:
        row = self._connection.execute(
            """
            SELECT id, organization_id, name, slug
            FROM projects
            WHERE organization_id = %s AND id = %s
            """,
            (organization_id, project_id),
        ).fetchone()
        if row is None:
            return None
        return Project(
            id=row["id"],
            organization_id=row["organization_id"],
            name=row["name"],
            slug=row["slug"],
        )

    def add_business_context(self, context: BusinessContext) -> None:
        self._write(
            """
            INSERT INTO business_contexts (
                id, organization_id, project_id, language, geo, site_url, brand_aliases, offer
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                context.id,
                context.organization_id,
                context.project_id,
                context.language,
                context.geo,
                context.site_url,
                list(context.brand_aliases),
                context.offer,
            ),
            "business_context",
        )

    def get_business_context(self, organization_id: UUID, project_id: UUID) -> BusinessContext | None:
        row = self._connection.execute(
            """
            SELECT id, organization_id, project_id, language, geo, site_url, brand_aliases, offer
            FROM business_contexts
            WHERE organization_id = %s AND project_id = %s
            """,
            (organization_id, project_id),
        ).fetchone()
        if row is None:
            return None
        return BusinessContext(
            id=row["id"],
            organization_id=row["organization_id"],
            project_id=row["project_id"],
            language=row["language"],
            geo=row["geo"],
            site_url=row["site_url"],
            brand_aliases=row["brand_aliases"],
            offer=row["offer"],
        )

    def add_job_spec(self, spec: JobSpec) -> None:
        self._write(
            """
            INSERT INTO job_specs (
                id, organization_id, project_id, type, role, title, inputs, arms, model, gate, done_when
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                spec.id,
                spec.organization_id,
                spec.project_id,
                spec.type,
                spec.role,
                spec.title,
                Jsonb(spec.inputs),
                list(spec.arms),
                spec.model,
                spec.gate,
                spec.done_when,
            ),
            "job_spec",
        )

    def get_job_spec(self, organization_id: UUID, project_id: UUID, job_spec_id: UUID) -> JobSpec | None:
        row = self._connection.execute(
            """
            SELECT id, organization_id, project_id, type, role, title, inputs, arms, model, gate, done_when
            FROM job_specs
            WHERE organization_id = %s AND project_id = %s AND id = %s
            """,
            (organization_id, project_id, job_spec_id),
        ).fetchone()
        if row is None:
            return None
        return JobSpec(
            id=row["id"],
            organization_id=row["organization_id"],
            project_id=row["project_id"],
            type=row["type"],
            role=row["role"],
            title=row["title"],
            inputs=row["inputs"],
            arms=row["arms"],
            model=row["model"],
            gate=row["gate"],
            done_when=row["done_when"],
        )

    def add_job_run(self, run: JobRun) -> None:
        self._write(
            """
            INSERT INTO job_runs (
                id, organization_id, project_id, job_spec_id, type, status, model, error, created_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                run.id,
                run.organization_id,
                run.project_id,
                run.job_spec_id,
                run.type,
                run.status,
                run.model,
                run.error,
                run.created_at,
            ),
            "job_run",
        )

    def get_job_run(self, organization_id: UUID, project_id: UUID, job_run_id: UUID) -> JobRun | None:
        row = self._connection.execute(
            """
            SELECT id, organization_id, project_id, job_spec_id, type, status, model, error, created_at
            FROM job_runs
            WHERE organization_id = %s AND project_id = %s AND id = %s
            """,
            (organization_id, project_id, job_run_id),
        ).fetchone()
        if row is None:
            return None
        return JobRun(
            id=row["id"],
            organization_id=row["organization_id"],
            project_id=row["project_id"],
            job_spec_id=row["job_spec_id"],
            type=row["type"],
            status=row["status"],
            model=row["model"],
            error=row["error"],
            created_at=row["created_at"],
        )

    def save_job_run(self, run: JobRun) -> None:
        self._write(
            """
            UPDATE job_runs
            SET status = %s, error = %s
            WHERE organization_id = %s AND project_id = %s AND id = %s
            """,
            (run.status, run.error, run.organization_id, run.project_id, run.id),
            "job_run",
        )

    def get_version_for_run(
        self, organization_id: UUID, project_id: UUID, job_run_id: UUID
    ) -> ArtifactVersion | None:
        row = self._connection.execute(
            """
            SELECT id, organization_id, project_id, artifact_id, version_number, parent_version_id,
                   job_run_id, context_snapshot_id, body, sources, confidence, created_at
            FROM artifact_versions
            WHERE organization_id = %s AND project_id = %s AND job_run_id = %s
            """,
            (organization_id, project_id, job_run_id),
        ).fetchone()
        return None if row is None else self._version(row)

    def add_context_snapshot(self, snapshot: ContextSnapshot) -> None:
        self._write(
            """
            INSERT INTO context_snapshots (
                id, organization_id, project_id, business_context_id,
                language, geo, site_url, brand_aliases, offer, captured_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                snapshot.id,
                snapshot.organization_id,
                snapshot.project_id,
                snapshot.business_context_id,
                snapshot.language,
                snapshot.geo,
                snapshot.site_url,
                list(snapshot.brand_aliases),
                snapshot.offer,
                snapshot.captured_at,
            ),
            "context_snapshot",
        )

    def add_artifact(self, artifact: Artifact) -> None:
        self._write(
            """
            INSERT INTO artifacts (id, organization_id, project_id, job_spec_id, created_at)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (
                artifact.id,
                artifact.organization_id,
                artifact.project_id,
                artifact.job_spec_id,
                artifact.created_at,
            ),
            "artifact",
        )

    def get_artifact(self, organization_id: UUID, project_id: UUID, artifact_id: UUID) -> Artifact | None:
        row = self._connection.execute(
            """
            SELECT id, organization_id, project_id, job_spec_id, created_at
            FROM artifacts
            WHERE organization_id = %s AND project_id = %s AND id = %s
            """,
            (organization_id, project_id, artifact_id),
        ).fetchone()
        return None if row is None else self._artifact(row)

    def get_artifact_for_spec(
        self, organization_id: UUID, project_id: UUID, job_spec_id: UUID
    ) -> Artifact | None:
        row = self._connection.execute(
            """
            SELECT id, organization_id, project_id, job_spec_id, created_at
            FROM artifacts
            WHERE organization_id = %s AND project_id = %s AND job_spec_id = %s
            """,
            (organization_id, project_id, job_spec_id),
        ).fetchone()
        return None if row is None else self._artifact(row)

    def add_artifact_version(self, version: ArtifactVersion) -> None:
        self._write(
            """
            INSERT INTO artifact_versions (
                id, organization_id, project_id, artifact_id, version_number, parent_version_id,
                job_run_id, context_snapshot_id, body, sources, confidence, created_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                version.id,
                version.organization_id,
                version.project_id,
                version.artifact_id,
                version.version_number,
                version.parent_version_id,
                version.job_run_id,
                version.context_snapshot_id,
                Jsonb(version.body),
                Jsonb([{"url": item.url, "note": item.note} for item in version.sources]),
                version.confidence,
                version.created_at,
            ),
            "artifact_version",
        )

    def get_artifact_version(
        self, organization_id: UUID, project_id: UUID, artifact_version_id: UUID
    ) -> ArtifactVersion | None:
        row = self._connection.execute(
            """
            SELECT id, organization_id, project_id, artifact_id, version_number, parent_version_id,
                   job_run_id, context_snapshot_id, body, sources, confidence, created_at
            FROM artifact_versions
            WHERE organization_id = %s AND project_id = %s AND id = %s
            """,
            (organization_id, project_id, artifact_version_id),
        ).fetchone()
        return None if row is None else self._version(row)

    def list_artifact_versions(
        self, organization_id: UUID, project_id: UUID, artifact_id: UUID
    ) -> list[ArtifactVersion]:
        rows = self._connection.execute(
            """
            SELECT id, organization_id, project_id, artifact_id, version_number, parent_version_id,
                   job_run_id, context_snapshot_id, body, sources, confidence, created_at
            FROM artifact_versions
            WHERE organization_id = %s AND project_id = %s AND artifact_id = %s
            ORDER BY version_number
            """,
            (organization_id, project_id, artifact_id),
        ).fetchall()
        return [self._version(row) for row in rows]

    def add_feedback(self, feedback: Feedback) -> None:
        self._write(
            """
            INSERT INTO feedback (
                id, organization_id, project_id, artifact_version_id, note, created_at
            ) VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (
                feedback.id,
                feedback.organization_id,
                feedback.project_id,
                feedback.artifact_version_id,
                feedback.note,
                feedback.created_at,
            ),
            "feedback",
        )

    def list_feedback(
        self, organization_id: UUID, project_id: UUID, artifact_version_id: UUID
    ) -> list[Feedback]:
        rows = self._connection.execute(
            """
            SELECT id, organization_id, project_id, artifact_version_id, note, created_at
            FROM feedback
            WHERE organization_id = %s AND project_id = %s AND artifact_version_id = %s
            ORDER BY created_at, id
            """,
            (organization_id, project_id, artifact_version_id),
        ).fetchall()
        return [
            Feedback(
                id=row["id"],
                organization_id=row["organization_id"],
                project_id=row["project_id"],
                artifact_version_id=row["artifact_version_id"],
                note=row["note"],
                created_at=row["created_at"],
            )
            for row in rows
        ]

    def add_approval(self, approval: Approval) -> None:
        self._write(
            """
            INSERT INTO approvals (
                id, organization_id, project_id, artifact_version_id, decision, decided_at
            ) VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (
                approval.id,
                approval.organization_id,
                approval.project_id,
                approval.artifact_version_id,
                approval.decision,
                approval.decided_at,
            ),
            "approval",
        )

    def get_approval_for_version(
        self, organization_id: UUID, project_id: UUID, artifact_version_id: UUID
    ) -> Approval | None:
        row = self._connection.execute(
            """
            SELECT id, organization_id, project_id, artifact_version_id, decision, decided_at
            FROM approvals
            WHERE organization_id = %s AND project_id = %s AND artifact_version_id = %s
            """,
            (organization_id, project_id, artifact_version_id),
        ).fetchone()
        if row is None:
            return None
        return Approval(
            id=row["id"],
            organization_id=row["organization_id"],
            project_id=row["project_id"],
            artifact_version_id=row["artifact_version_id"],
            decision=row["decision"],
            decided_at=row["decided_at"],
        )

    def _artifact(self, row) -> Artifact:
        return Artifact(
            id=row["id"],
            organization_id=row["organization_id"],
            project_id=row["project_id"],
            job_spec_id=row["job_spec_id"],
            created_at=row["created_at"],
        )

    def _version(self, row) -> ArtifactVersion:
        return ArtifactVersion(
            id=row["id"],
            organization_id=row["organization_id"],
            project_id=row["project_id"],
            artifact_id=row["artifact_id"],
            version_number=row["version_number"],
            parent_version_id=row["parent_version_id"],
            job_run_id=row["job_run_id"],
            context_snapshot_id=row["context_snapshot_id"],
            body=row["body"],
            sources=[(item["url"], item["note"]) for item in row["sources"]],
            confidence=row["confidence"],
            created_at=row["created_at"],
        )

    def add_provider_binding(self, binding: ProviderBinding) -> None:
        self._write(
            """
            INSERT INTO provider_bindings (
                id, organization_id, project_id, capability_key, provider_key, priority, health
            ) VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                binding.id,
                binding.organization_id,
                binding.project_id,
                binding.capability,
                binding.provider,
                binding.priority,
                binding.health,
            ),
            "provider_binding",
        )

    def save_provider_binding(self, binding: ProviderBinding) -> None:
        try:
            cursor = self._connection.execute(
                """
                UPDATE provider_bindings
                SET provider_key = %s, priority = %s, health = %s
                WHERE id = %s AND organization_id = %s AND project_id = %s
                """,
                (
                    binding.provider,
                    binding.priority,
                    binding.health,
                    binding.id,
                    binding.organization_id,
                    binding.project_id,
                ),
            )
        except UniqueViolation as exc:
            raise Conflict("provider_binding") from exc
        except ForeignKeyViolation as exc:
            raise NotInOrganization("provider_binding") from exc
        if cursor.rowcount != 1:
            raise NotInOrganization("provider_binding")

    def get_provider_binding(
        self, organization_id: UUID, project_id: UUID, binding_id: UUID
    ) -> ProviderBinding | None:
        row = self._connection.execute(
            """
            SELECT id, organization_id, project_id, capability_key, provider_key, priority, health
            FROM provider_bindings
            WHERE organization_id = %s AND project_id = %s AND id = %s
            """,
            (organization_id, project_id, binding_id),
        ).fetchone()
        return None if row is None else self._binding(row)

    def list_provider_bindings(
        self, organization_id: UUID, project_id: UUID, capability: str
    ) -> list[ProviderBinding]:
        rows = self._connection.execute(
            """
            SELECT id, organization_id, project_id, capability_key, provider_key, priority, health
            FROM provider_bindings
            WHERE organization_id = %s AND project_id = %s AND capability_key = %s
            """,
            (organization_id, project_id, capability),
        ).fetchall()
        return [self._binding(row) for row in rows]

    def _binding(self, row) -> ProviderBinding:
        return ProviderBinding(
            id=row["id"],
            organization_id=row["organization_id"],
            project_id=row["project_id"],
            capability=row["capability_key"],
            provider=row["provider_key"],
            priority=row["priority"],
            health=row["health"],
        )

    def _write(self, sql: str, params: tuple, kind: str) -> None:
        try:
            self._connection.execute(sql, params)
        except UniqueViolation as exc:
            raise Conflict(kind) from exc
        except ForeignKeyViolation as exc:
            raise NotInOrganization(kind) from exc
