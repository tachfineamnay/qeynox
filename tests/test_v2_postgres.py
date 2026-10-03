"""Repository PostgreSQL : persistance, clés étrangères, isolation."""
from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timezone
from uuid import uuid4

import psycopg
from psycopg.errors import ForeignKeyViolation
from psycopg.rows import dict_row

from core.application.service import CoreService
from core.domain.model import Conflict, NotInOrganization
from core.postgres.migrate import apply as migrate
from core.postgres.repository import PostgresCoreRepository

WHEN = datetime(2026, 10, 3, 18, 0, tzinfo=timezone.utc)


def _database_url() -> tuple[str, object | None]:
    url = os.environ.get("QEYNOX_TEST_DATABASE_URL")
    if url:
        return url, None
    import pgserver

    directory = tempfile.mkdtemp(prefix="qeynox-pg-")
    server = pgserver.get_server(directory, cleanup_mode="delete")
    return server.get_uri(), server


class PostgresCoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.url, cls._server = _database_url()

    def setUp(self) -> None:
        self.conn = psycopg.connect(self.url, row_factory=dict_row)
        migrate(self.conn)
        self.conn.commit()
        self.conn.execute(
            "TRUNCATE job_runs, job_specs, business_contexts, projects, organizations CASCADE"
        )
        self.conn.commit()
        self.service = CoreService(PostgresCoreRepository(self.conn))

    def tearDown(self) -> None:
        self.conn.close()

    def _persist_chain(self):
        org = self.service.open_organization(name="Acme", slug="acme")
        project = self.service.open_project(organization_id=org.id, name="Mon Produit", slug="mon-produit")
        context = self.service.set_business_context(
            organization_id=org.id,
            project_id=project.id,
            language="fr",
            geo="FR",
            site_url="https://exemple.com",
            brand_aliases=["Acme", "Acme GTM"],
            offer="Offre sourcée",
        )
        spec = self.service.define_job_spec(
            organization_id=org.id,
            project_id=project.id,
            type="discover.keywords",
            role="research",
            title="Enrichir les graines",
            inputs={"seeds": ["alpha"]},
            arms=["searxng"],
            model="auto",
            gate=False,
            done_when="n_keywords >= 30",
        )
        run = self.service.record_job_run(
            organization_id=org.id,
            project_id=project.id,
            job_spec_id=spec.id,
            created_at=WHEN,
        )
        self.conn.commit()
        return org, project, context, spec, run

    def test_golden_chain_is_read_from_a_new_connection(self) -> None:
        org, project, context, spec, run = self._persist_chain()
        with psycopg.connect(self.url, row_factory=dict_row) as other:
            loaded = CoreService(PostgresCoreRepository(other)).read_chain(
                organization_id=org.id,
                project_id=project.id,
                job_run_id=run.id,
            )
        self.assertEqual(loaded.organization, org)
        self.assertEqual(loaded.project, project)
        self.assertEqual(loaded.context, context)
        self.assertEqual(loaded.spec, spec)
        self.assertEqual(loaded.run, run)

    def test_same_slug_is_allowed_in_another_organization_only(self) -> None:
        org, project, _, _, _ = self._persist_chain()
        other = self.service.open_organization(name="Autre", slug="autre")
        twin = self.service.open_project(organization_id=other.id, name="Mon Produit", slug="mon-produit")
        self.conn.commit()
        self.assertNotEqual(twin.id, project.id)
        with self.assertRaises(Conflict):
            self.service.open_project(organization_id=org.id, name="Doublon", slug="mon-produit")

    def test_repository_hides_other_tenants(self) -> None:
        org, project, _, spec, run = self._persist_chain()
        other = self.service.open_organization(name="Autre", slug="autre")
        self.conn.commit()
        repo = PostgresCoreRepository(self.conn)
        self.assertIsNone(repo.get_project(other.id, project.id))
        self.assertIsNone(repo.get_job_spec(other.id, project.id, spec.id))
        self.assertIsNone(repo.get_job_run(other.id, project.id, run.id))
        self.assertIsNone(repo.get_business_context(other.id, project.id))
        with self.assertRaises(NotInOrganization):
            self.service.read_chain(organization_id=other.id, project_id=project.id, job_run_id=run.id)
        self.assertEqual(
            repo.get_project(org.id, project.id).slug,
            "mon-produit",
        )

    def test_foreign_keys_reject_cross_tenant_and_orphan_rows(self) -> None:
        org, project, _, spec, _ = self._persist_chain()
        other = self.service.open_organization(name="Autre", slug="autre")
        bare = self.service.open_project(organization_id=org.id, name="Sans contexte", slug="sans-contexte")
        self.conn.commit()
        with self.assertRaises(ForeignKeyViolation):
            self.conn.execute(
                """
                INSERT INTO projects (id, organization_id, name, slug)
                VALUES (%s, %s, %s, %s)
                """,
                (uuid4(), uuid4(), "Orphelin", "orphelin"),
            )
        self.conn.rollback()
        with self.assertRaises(ForeignKeyViolation):
            self.conn.execute(
                """
                INSERT INTO business_contexts (
                    id, organization_id, project_id, language, geo, site_url, brand_aliases, offer
                ) VALUES (%s, %s, %s, 'fr', 'FR', 'https://exemple.com', '{}', 'offre')
                """,
                (uuid4(), other.id, bare.id),
            )
        self.conn.rollback()
        with self.assertRaises(ForeignKeyViolation):
            self.conn.execute(
                """
                INSERT INTO job_runs (
                    id, organization_id, project_id, job_spec_id, type, status, model, error, created_at
                ) VALUES (%s, %s, %s, %s, 'discover.keywords', 'queued', 'auto', NULL, %s)
                """,
                (uuid4(), other.id, project.id, spec.id, WHEN),
            )
        self.conn.rollback()
        with self.assertRaises(ForeignKeyViolation):
            self.conn.execute(
                """
                INSERT INTO job_runs (
                    id, organization_id, project_id, job_spec_id, type, status, model, error, created_at
                ) VALUES (%s, %s, %s, %s, 'search.web', 'queued', 'fast', NULL, %s)
                """,
                (uuid4(), org.id, project.id, spec.id, WHEN),
            )
        self.conn.rollback()
        with self.assertRaises(ForeignKeyViolation):
            self.conn.execute("DELETE FROM organizations WHERE id = %s", (org.id,))
        self.conn.rollback()

    def test_database_rejects_unknown_job_type_and_status(self) -> None:
        org, project, _, _, _ = self._persist_chain()
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.conn.execute(
                """
                INSERT INTO job_specs (
                    id, organization_id, project_id, type, role, title, inputs, arms, model, gate, done_when
                ) VALUES (%s, %s, %s, 'custom.whatever', 'research', 'Titre', '{}', '{}', 'auto', false, 'fait')
                """,
                (uuid4(), org.id, project.id),
            )
        self.conn.rollback()
        spec_id = uuid4()
        self.conn.execute(
            """
            INSERT INTO job_specs (
                id, organization_id, project_id, type, role, title, inputs, arms, model, gate, done_when
            ) VALUES (%s, %s, %s, 'discover.keywords', 'research', 'Titre', '{}', '{}', 'auto', false, 'fait')
            """,
            (spec_id, org.id, project.id),
        )
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.conn.execute(
                """
                INSERT INTO job_runs (
                    id, organization_id, project_id, job_spec_id, type, status, model, error, created_at
                ) VALUES (%s, %s, %s, %s, 'discover.keywords', 'approved', 'auto', NULL, %s)
                """,
                (uuid4(), org.id, project.id, spec_id, WHEN),
            )

    def test_migrate_is_idempotent(self) -> None:
        migrate(self.conn)
        self.conn.commit()
        row = self.conn.execute("SELECT count(*) AS n FROM schema_migrations").fetchone()
        self.assertEqual(row["n"], 2)
