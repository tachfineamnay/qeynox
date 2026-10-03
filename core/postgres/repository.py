"""Adaptateur PostgreSQL du port CoreRepository."""
from __future__ import annotations

from uuid import UUID

from psycopg.errors import ForeignKeyViolation, UniqueViolation
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from core.domain.model import (
    BusinessContext,
    Conflict,
    JobRun,
    JobSpec,
    NotInOrganization,
    Organization,
    Project,
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

    def _write(self, sql: str, params: tuple, kind: str) -> None:
        try:
            self._connection.execute(sql, params)
        except UniqueViolation as exc:
            raise Conflict(kind) from exc
        except ForeignKeyViolation as exc:
            raise NotInOrganization(kind) from exc
