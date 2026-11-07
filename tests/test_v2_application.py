"""Services applicatifs : enregistrement et lecture, sans exécution."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone
from uuid import UUID, uuid4

from core.application.service import CoreService
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


class MemoryCoreRepository:
    def __init__(self) -> None:
        self.organizations: dict[UUID, Organization] = {}
        self.projects: dict[tuple[UUID, UUID], Project] = {}
        self.contexts: dict[tuple[UUID, UUID], BusinessContext] = {}
        self.specs: dict[tuple[UUID, UUID, UUID], JobSpec] = {}
        self.runs: dict[tuple[UUID, UUID, UUID], JobRun] = {}

    def add_organization(self, organization: Organization) -> None:
        if any(item.slug == organization.slug for item in self.organizations.values()):
            raise Conflict("organization")
        self.organizations[organization.id] = organization

    def get_organization(self, organization_id: UUID) -> Organization | None:
        return self.organizations.get(organization_id)

    def add_project(self, project: Project) -> None:
        key = (project.organization_id, project.id)
        if any(item.slug == project.slug and item.organization_id == project.organization_id for item in self.projects.values()):
            raise Conflict("project")
        self.projects[key] = project

    def get_project(self, organization_id: UUID, project_id: UUID) -> Project | None:
        return self.projects.get((organization_id, project_id))

    def add_business_context(self, context: BusinessContext) -> None:
        key = (context.organization_id, context.project_id)
        if key in self.contexts:
            raise Conflict("business_context")
        self.contexts[key] = context

    def get_business_context(self, organization_id: UUID, project_id: UUID) -> BusinessContext | None:
        return self.contexts.get((organization_id, project_id))

    def add_job_spec(self, spec: JobSpec) -> None:
        self.specs[(spec.organization_id, spec.project_id, spec.id)] = spec

    def get_job_spec(self, organization_id: UUID, project_id: UUID, job_spec_id: UUID) -> JobSpec | None:
        return self.specs.get((organization_id, project_id, job_spec_id))

    def add_job_run(self, run: JobRun) -> None:
        self.runs[(run.organization_id, run.project_id, run.id)] = run

    def get_job_run(self, organization_id: UUID, project_id: UUID, job_run_id: UUID) -> JobRun | None:
        return self.runs.get((organization_id, project_id, job_run_id))


class ApplicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = MemoryCoreRepository()
        self.service = CoreService(self.repo)
        self.when = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)

    def _chain(self):
        org = self.service.open_organization(name="Acme", slug="acme")
        project = self.service.open_project(organization_id=org.id, name="Mon Produit", slug="mon-produit")
        context = self.service.set_business_context(
            organization_id=org.id,
            project_id=project.id,
            language="fr",
            geo="FR",
            site_url="https://exemple.com",
            brand_aliases=["Acme"],
            offer="Offre",
        )
        spec = self.service.define_job_spec(
            organization_id=org.id,
            project_id=project.id,
            type="discover.keywords",
            role="research",
            title="Graines",
            inputs={"seeds": []},
            arms=["searxng"],
            model="auto",
            gate=False,
            done_when="n_keywords >= 30",
        )
        run = self.service.record_job_run(
            organization_id=org.id,
            project_id=project.id,
            job_spec_id=spec.id,
            created_at=self.when,
        )
        return org, project, context, spec, run

    def test_records_a_queued_run_copied_from_the_spec(self) -> None:
        org, project, context, spec, run = self._chain()
        loaded = self.service.read_chain(organization_id=org.id, project_id=project.id, job_run_id=run.id)
        self.assertEqual(loaded.organization, org)
        self.assertEqual(loaded.project, project)
        self.assertEqual(loaded.context, context)
        self.assertEqual(loaded.spec, spec)
        self.assertEqual(loaded.run, run)
        self.assertEqual(run.status, "queued")
        self.assertEqual(run.type, spec.type)
        self.assertEqual(run.model, spec.model)
        self.assertIsNone(run.error)

    def test_same_spec_can_be_recorded_twice(self) -> None:
        _, project, _, spec, first = self._chain()
        second = self.service.record_job_run(
            organization_id=project.organization_id,
            project_id=project.id,
            job_spec_id=spec.id,
            created_at=self.when,
        )
        self.assertNotEqual(first.id, second.id)

    def test_foreign_organization_cannot_use_the_project(self) -> None:
        org, project, _, spec, run = self._chain()
        other = self.service.open_organization(name="Autre", slug="autre")
        with self.assertRaises(NotInOrganization):
            self.service.set_business_context(
                organization_id=other.id,
                project_id=project.id,
                language="fr",
                geo="FR",
                site_url="https://exemple.com",
                brand_aliases=[],
                offer="Offre",
            )
        with self.assertRaises(NotInOrganization):
            self.service.record_job_run(
                organization_id=other.id,
                project_id=project.id,
                job_spec_id=spec.id,
                created_at=self.when,
            )
        with self.assertRaises(NotInOrganization):
            self.service.read_chain(organization_id=other.id, project_id=project.id, job_run_id=run.id)
        self.assertIsNone(self.repo.get_project(other.id, project.id))
        self.assertEqual(self.service.read_chain(organization_id=org.id, project_id=project.id, job_run_id=run.id).run, run)

    def test_missing_organization_and_second_context(self) -> None:
        with self.assertRaises(NotFound):
            self.service.open_project(organization_id=uuid4(), name="X", slug="x")
        org, project, _, _, _ = self._chain()
        with self.assertRaises(Conflict):
            self.service.set_business_context(
                organization_id=org.id,
                project_id=project.id,
                language="en",
                geo="US",
                site_url="https://exemple.com",
                brand_aliases=[],
                offer="Autre",
            )
