"""Artefacts immuables : version, régénération, lignée, approval."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone
from uuid import UUID, uuid4

from core.application.service import CoreService
from core.domain.model import (
    Approval,
    ArtifactVersion,
    Conflict,
    DomainError,
    Feedback,
    NotInOrganization,
)
from core.postgres.migrate import _statements

WHEN = datetime(2026, 10, 3, 19, 0, tzinfo=timezone.utc)
LATER = datetime(2026, 10, 3, 20, 0, tzinfo=timezone.utc)


class MemoryCoreRepository:
    def __init__(self) -> None:
        self.organizations: dict[UUID, Organization] = {}
        self.projects: dict[tuple[UUID, UUID], Project] = {}
        self.contexts: dict[tuple[UUID, UUID], BusinessContext] = {}
        self.specs: dict[tuple[UUID, UUID, UUID], JobSpec] = {}
        self.runs: dict[tuple[UUID, UUID, UUID], JobRun] = {}
        self.snapshots: dict[tuple[UUID, UUID, UUID], ContextSnapshot] = {}
        self.artifacts: dict[tuple[UUID, UUID, UUID], object] = {}
        self.by_spec: dict[tuple[UUID, UUID, UUID], object] = {}
        self.versions: dict[tuple[UUID, UUID, UUID], ArtifactVersion] = {}
        self.by_artifact: dict[tuple[UUID, UUID, UUID], list[ArtifactVersion]] = {}
        self.feedback: dict[tuple[UUID, UUID, UUID], list[Feedback]] = {}
        self.approvals: dict[tuple[UUID, UUID, UUID], Approval] = {}

    def add_organization(self, organization: Organization) -> None:
        self.organizations[organization.id] = organization

    def get_organization(self, organization_id: UUID) -> Organization | None:
        return self.organizations.get(organization_id)

    def add_project(self, project: Project) -> None:
        self.projects[(project.organization_id, project.id)] = project

    def get_project(self, organization_id: UUID, project_id: UUID) -> Project | None:
        return self.projects.get((organization_id, project_id))

    def add_business_context(self, context: BusinessContext) -> None:
        self.contexts[(context.organization_id, context.project_id)] = context

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

    def add_context_snapshot(self, snapshot: ContextSnapshot) -> None:
        self.snapshots[(snapshot.organization_id, snapshot.project_id, snapshot.id)] = snapshot

    def add_artifact(self, artifact) -> None:
        key = (artifact.organization_id, artifact.project_id, artifact.job_spec_id)
        if key in self.by_spec:
            raise Conflict("artifact")
        self.artifacts[(artifact.organization_id, artifact.project_id, artifact.id)] = artifact
        self.by_spec[key] = artifact

    def get_artifact(self, organization_id: UUID, project_id: UUID, artifact_id: UUID):
        return self.artifacts.get((organization_id, project_id, artifact_id))

    def get_artifact_for_spec(self, organization_id: UUID, project_id: UUID, job_spec_id: UUID):
        return self.by_spec.get((organization_id, project_id, job_spec_id))

    def add_artifact_version(self, version: ArtifactVersion) -> None:
        bucket = self.by_artifact.setdefault(
            (version.organization_id, version.project_id, version.artifact_id), []
        )
        if any(item.version_number == version.version_number for item in bucket):
            raise Conflict("artifact_version")
        bucket.append(version)
        self.versions[(version.organization_id, version.project_id, version.id)] = version

    def get_artifact_version(self, organization_id: UUID, project_id: UUID, artifact_version_id: UUID):
        return self.versions.get((organization_id, project_id, artifact_version_id))

    def list_artifact_versions(self, organization_id: UUID, project_id: UUID, artifact_id: UUID):
        return list(self.by_artifact.get((organization_id, project_id, artifact_id), []))

    def add_feedback(self, feedback: Feedback) -> None:
        self.feedback.setdefault(
            (feedback.organization_id, feedback.project_id, feedback.artifact_version_id), []
        ).append(feedback)

    def list_feedback(self, organization_id: UUID, project_id: UUID, artifact_version_id: UUID):
        return list(self.feedback.get((organization_id, project_id, artifact_version_id), []))

    def add_approval(self, approval: Approval) -> None:
        key = (approval.organization_id, approval.project_id, approval.artifact_version_id)
        if key in self.approvals:
            raise Conflict("approval")
        self.approvals[key] = approval

    def get_approval_for_version(self, organization_id: UUID, project_id: UUID, artifact_version_id: UUID):
        return self.approvals.get((organization_id, project_id, artifact_version_id))


class ArtifactDomainTests(unittest.TestCase):
    def test_version_requires_lineage_and_copies_body(self) -> None:
        body = {"rows": ["alpha"]}
        version = ArtifactVersion(
            id=uuid4(),
            organization_id=uuid4(),
            project_id=uuid4(),
            artifact_id=uuid4(),
            version_number=1,
            parent_version_id=None,
            job_run_id=uuid4(),
            context_snapshot_id=uuid4(),
            body=body,
            sources=[("https://exemple.com/a", "serp")],
            confidence="ok",
            created_at=WHEN,
        )
        body["rows"].append("beta")
        self.assertEqual(version.body, {"rows": ["alpha"]})
        self.assertEqual(version.sources[0].url, "https://exemple.com/a")
        with self.assertRaises(DomainError):
            ArtifactVersion(
                id=uuid4(),
                organization_id=version.organization_id,
                project_id=version.project_id,
                artifact_id=version.artifact_id,
                version_number=2,
                parent_version_id=None,
                job_run_id=uuid4(),
                context_snapshot_id=uuid4(),
                body={},
                sources=[],
                confidence="ok",
                created_at=WHEN,
            )
        with self.assertRaises(DomainError):
            ArtifactVersion(
                id=uuid4(),
                organization_id=version.organization_id,
                project_id=version.project_id,
                artifact_id=version.artifact_id,
                version_number=1,
                parent_version_id=uuid4(),
                job_run_id=uuid4(),
                context_snapshot_id=uuid4(),
                body={},
                sources=[],
                confidence="high",
                created_at=WHEN,
            )

    def test_approval_and_feedback_name_a_version(self) -> None:
        version_id = uuid4()
        approval = Approval(
            id=uuid4(),
            organization_id=uuid4(),
            project_id=uuid4(),
            artifact_version_id=version_id,
            decision="go",
            decided_at=WHEN,
        )
        self.assertEqual(approval.artifact_version_id, version_id)
        with self.assertRaises(DomainError):
            Approval(
                id=uuid4(),
                organization_id=approval.organization_id,
                project_id=approval.project_id,
                artifact_version_id=version_id,
                decision="maybe",
                decided_at=WHEN,
            )
        with self.assertRaises(DomainError):
            Feedback(
                id=uuid4(),
                organization_id=approval.organization_id,
                project_id=approval.project_id,
                artifact_version_id=version_id,
                note="   ",
                created_at=WHEN,
            )

    def test_sql_splitter_keeps_a_function_body(self) -> None:
        sql = "CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  RAISE EXCEPTION 'immutable';\nEND;\n$$ LANGUAGE plpgsql;"
        self.assertEqual(len(_statements(sql)), 1)
        self.assertIn("RAISE EXCEPTION", _statements(sql)[0])


class ArtifactFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = CoreService(MemoryCoreRepository())
        self.org = self.service.open_organization(name="Acme", slug="acme")
        self.project = self.service.open_project(
            organization_id=self.org.id, name="Mon Produit", slug="mon-produit"
        )
        self.context = self.service.set_business_context(
            organization_id=self.org.id,
            project_id=self.project.id,
            language="fr",
            geo="FR",
            site_url="https://exemple.com",
            brand_aliases=["Acme"],
            offer="Offre",
        )
        self.spec = self.service.define_job_spec(
            organization_id=self.org.id,
            project_id=self.project.id,
            type="discover.keywords",
            role="research",
            title="Graines",
            inputs={"seeds": []},
            arms=["searxng"],
            model="auto",
            gate=True,
            done_when="n_keywords >= 30",
        )

    def _publish(self, body: dict | None = None):
        return self.service.publish_artifact(
            organization_id=self.org.id,
            project_id=self.project.id,
            job_spec_id=self.spec.id,
            body=body or {"rows": ["alpha"]},
            sources=[("https://exemple.com/a", "serp")],
            confidence="ok",
            created_at=WHEN,
        )

    def test_publish_then_regenerate_keeps_v1_and_appends_v2(self) -> None:
        first = self._publish()
        payload = {"rows": ["beta"]}
        second = self.service.regenerate_artifact(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_id=first.artifact.id,
            body=payload,
            sources=[("https://exemple.com/b", "nouveau")],
            confidence="low",
            created_at=LATER,
        )
        payload["rows"].append("gamma")
        versions = self.service.list_versions(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_id=first.artifact.id,
        )
        self.assertEqual(first.version.version_number, 1)
        self.assertIsNone(first.version.parent_version_id)
        self.assertEqual(first.run.job_spec_id, self.spec.id)
        self.assertEqual(first.run.status, "ok")
        self.assertEqual(first.snapshot.offer, self.context.offer)
        self.assertEqual(second.artifact.id, first.artifact.id)
        self.assertEqual(second.version.version_number, 2)
        self.assertEqual(second.version.parent_version_id, first.version.id)
        self.assertNotEqual(second.run.id, first.run.id)
        self.assertEqual(second.run.job_spec_id, self.spec.id)
        self.assertNotEqual(second.snapshot.id, first.snapshot.id)
        self.assertEqual(versions[0].body, {"rows": ["alpha"]})
        self.assertEqual(versions[1].body, {"rows": ["beta"]})
        self.assertEqual(versions[0].id, first.version.id)
        self.assertEqual(versions[1].job_run_id, second.run.id)
        self.assertEqual(versions[1].context_snapshot_id, second.snapshot.id)

    def test_second_publish_is_refused_and_regenerate_is_the_only_next_version(self) -> None:
        first = self._publish()
        with self.assertRaises(Conflict):
            self._publish()
        again = self.service.regenerate_artifact(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_id=first.artifact.id,
            body={"rows": ["beta"]},
            sources=[],
            confidence="ok",
            created_at=LATER,
        )
        third = self.service.regenerate_artifact(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_id=first.artifact.id,
            body={"rows": ["gamma"]},
            sources=[],
            confidence="ok",
            created_at=LATER,
        )
        self.assertEqual(again.version.version_number, 2)
        self.assertEqual(third.version.version_number, 3)
        self.assertEqual(third.version.parent_version_id, again.version.id)

    def test_approval_binds_a_version_and_becomes_stale_when_head_moves(self) -> None:
        first = self._publish()
        approval = self.service.approve(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_version_id=first.version.id,
            decision="go",
            decided_at=WHEN,
        )
        self.service.record_feedback(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_version_id=first.version.id,
            note="ok pour v1",
            created_at=WHEN,
        )
        fresh = self.service.approval_state(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_id=first.artifact.id,
        )
        self.assertFalse(fresh.stale)
        self.assertEqual(fresh.approval.id, approval.id)
        self.assertEqual(fresh.approval.artifact_version_id, first.version.id)
        second = self.service.regenerate_artifact(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_id=first.artifact.id,
            body={"rows": ["beta"]},
            sources=[],
            confidence="low",
            created_at=LATER,
        )
        stale = self.service.approval_state(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_id=first.artifact.id,
        )
        self.assertTrue(stale.stale)
        self.assertEqual(stale.approval.artifact_version_id, first.version.id)
        self.assertEqual(stale.head.id, second.version.id)
        notes = self.service.list_feedback(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_version_id=first.version.id,
        )
        self.assertEqual(notes[0].note, "ok pour v1")
        current = self.service.approve(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_version_id=second.version.id,
            decision="no_go",
            decided_at=LATER,
        )
        aligned = self.service.approval_state(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_id=first.artifact.id,
        )
        self.assertFalse(aligned.stale)
        self.assertEqual(aligned.approval.id, current.id)
        self.assertEqual(
            self.service.list_versions(
                organization_id=self.org.id,
                project_id=self.project.id,
                artifact_id=first.artifact.id,
            )[0].body,
            {"rows": ["alpha"]},
        )
        with self.assertRaises(Conflict):
            self.service.approve(
                organization_id=self.org.id,
                project_id=self.project.id,
                artifact_version_id=first.version.id,
                decision="no_go",
                decided_at=LATER,
            )

    def test_other_organization_cannot_regenerate_or_approve(self) -> None:
        first = self._publish()
        other = self.service.open_organization(name="Autre", slug="autre")
        with self.assertRaises(NotInOrganization):
            self.service.regenerate_artifact(
                organization_id=other.id,
                project_id=self.project.id,
                artifact_id=first.artifact.id,
                body={"rows": ["beta"]},
                sources=[],
                confidence="ok",
                created_at=LATER,
            )
        with self.assertRaises(NotInOrganization):
            self.service.approve(
                organization_id=other.id,
                project_id=self.project.id,
                artifact_version_id=first.version.id,
                decision="go",
                decided_at=WHEN,
            )


class ArtifactPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from tests.test_v2_postgres import _database_url

        cls.url, cls._server = _database_url()

    def setUp(self) -> None:
        import psycopg
        from psycopg.rows import dict_row

        from core.postgres.migrate import apply as migrate
        from core.postgres.repository import PostgresCoreRepository

        self.psycopg = psycopg
        self.conn = psycopg.connect(self.url, row_factory=dict_row)
        migrate(self.conn)
        self.conn.commit()
        self.conn.execute(
            "TRUNCATE job_runs, job_specs, business_contexts, projects, organizations CASCADE"
        )
        self.conn.commit()
        self.repo = PostgresCoreRepository(self.conn)
        self.service = CoreService(self.repo)
        self.org = self.service.open_organization(name="Acme", slug="acme")
        self.project = self.service.open_project(
            organization_id=self.org.id, name="Mon Produit", slug="mon-produit"
        )
        self.service.set_business_context(
            organization_id=self.org.id,
            project_id=self.project.id,
            language="fr",
            geo="FR",
            site_url="https://exemple.com",
            brand_aliases=["Acme"],
            offer="Offre",
        )
        self.spec = self.service.define_job_spec(
            organization_id=self.org.id,
            project_id=self.project.id,
            type="content.outline",
            role="writer",
            title="Plan",
            inputs={},
            arms=[],
            model="strong",
            gate=True,
            done_when="plan livré",
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()

    def test_v1_survives_regenerate_on_a_new_connection(self) -> None:
        from psycopg.types.json import Jsonb

        first = self.service.publish_artifact(
            organization_id=self.org.id,
            project_id=self.project.id,
            job_spec_id=self.spec.id,
            body={"rows": ["alpha"]},
            sources=[("https://exemple.com/a", "serp")],
            confidence="ok",
            created_at=WHEN,
        )
        self.service.approve(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_version_id=first.version.id,
            decision="go",
            decided_at=WHEN,
        )
        second = self.service.regenerate_artifact(
            organization_id=self.org.id,
            project_id=self.project.id,
            artifact_id=first.artifact.id,
            body={"rows": ["beta"]},
            sources=[("https://exemple.com/b", "nouveau")],
            confidence="low",
            created_at=LATER,
        )
        self.conn.commit()
        from core.postgres.repository import PostgresCoreRepository
        from psycopg.rows import dict_row

        with self.psycopg.connect(self.url, row_factory=dict_row) as other:
            service = CoreService(PostgresCoreRepository(other))
            versions = service.list_versions(
                organization_id=self.org.id,
                project_id=self.project.id,
                artifact_id=first.artifact.id,
            )
            state = service.approval_state(
                organization_id=self.org.id,
                project_id=self.project.id,
                artifact_id=first.artifact.id,
            )
        self.assertEqual([item.version_number for item in versions], [1, 2])
        self.assertEqual(versions[0].body, {"rows": ["alpha"]})
        self.assertEqual(versions[0].job_run_id, first.run.id)
        self.assertEqual(versions[1].body, {"rows": ["beta"]})
        self.assertEqual(versions[1].parent_version_id, versions[0].id)
        self.assertEqual(versions[1].job_run_id, second.run.id)
        self.assertNotEqual(versions[0].context_snapshot_id, versions[1].context_snapshot_id)
        self.assertTrue(state.stale)
        self.assertEqual(state.approval.artifact_version_id, versions[0].id)
        with self.assertRaises(self.psycopg.Error):
            self.conn.execute(
                "UPDATE artifact_versions SET body = %s WHERE id = %s",
                (Jsonb({"rows": ["changed"]}), versions[0].id),
            )
        self.conn.rollback()
        with self.assertRaises(self.psycopg.Error):
            self.conn.execute("DELETE FROM artifact_versions WHERE version_number = 1")
        self.conn.rollback()
        kept = self.repo.get_artifact_version(self.org.id, self.project.id, versions[0].id)
        self.assertEqual(kept.body, {"rows": ["alpha"]})

