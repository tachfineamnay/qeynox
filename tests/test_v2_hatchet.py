"""Orchestration Hatchet : lancement, worker, retry, timeout, reprise."""
from __future__ import annotations

import ast
import socket
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from core.application.orchestration import JobOrchestrator
from core.application.service import CoreService
from core.domain.model import DomainError, JobRun
from core.hatchet.adapter import HatchetAdapter
from core.postgres.migrate import apply as migrate
from core.postgres.repository import PostgresCoreRepository
from tests.test_v2_postgres import _database_url

ROOT = Path(__file__).resolve().parents[1]
WHEN = datetime(2026, 10, 3, 21, 0, tzinfo=timezone.utc)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class TransitionTests(unittest.TestCase):
    def test_status_follows_the_run_and_rejects_a_regression(self) -> None:
        run = JobRun(
            id=uuid4(),
            organization_id=uuid4(),
            project_id=uuid4(),
            job_spec_id=uuid4(),
            type="discover.keywords",
            status="queued",
            model="auto",
            error=None,
            created_at=WHEN,
        )
        running = run.with_status("running")
        done = running.with_status("ok")
        self.assertEqual(done.status, "ok")
        self.assertIsNone(done.error)
        with self.assertRaises(DomainError):
            done.with_status("running")
        failed = running.with_status("failed", "timeout")
        self.assertEqual(failed.error, "timeout")

    def test_hatchet_sdk_stays_outside_the_domain_core(self) -> None:
        for relative in ("core/domain", "core/application", "core/ports"):
            for path in (ROOT / relative).glob("*.py"):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                modules = [node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
                modules += [
                    alias.name
                    for node in ast.walk(tree)
                    if isinstance(node, ast.Import)
                    for alias in node.names
                ]
                for name in modules:
                    self.assertFalse(name == "hatchet_sdk" or name.startswith("hatchet_sdk."))


class HatchetRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.url, cls._server = _database_url()
        cls._data = tempfile.mkdtemp(prefix="qeynox-hatchet-")
        cls.adapter = HatchetAdapter(
            cls.url,
            data_dir=cls._data,
            grpc_port=_free_port(),
            api_port=_free_port(),
            execution_timeout_seconds=20,
            retries=2,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.adapter.close()

    def setUp(self) -> None:
        self.conn = psycopg.connect(self.url, row_factory=dict_row)
        migrate(self.conn)
        self.conn.commit()
        self.conn.execute(
            "TRUNCATE job_runs, job_specs, business_contexts, projects, organizations CASCADE"
        )
        self.conn.commit()
        self.service = CoreService(PostgresCoreRepository(self.conn))
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
            gate=False,
            done_when="plan livré",
        )
        self.conn.commit()
        self.adapter.start_worker()
        self.orchestrator = JobOrchestrator(self.service, self.adapter, self.conn.commit)

    def tearDown(self) -> None:
        self.conn.close()

    def _wait_version(self, job_run_id: UUID):
        repo = PostgresCoreRepository(self.conn)
        for _ in range(80):
            self.conn.commit()
            found = repo.get_version_for_run(self.org.id, self.project.id, job_run_id)
            if found is not None:
                return found
            time.sleep(0.25)
        self.fail("ArtifactVersion absente")

    def _wait_runtime(self, job_run_id: UUID, statuses: set[str]):
        for _ in range(80):
            state = self.adapter.runtime(self.org.id, self.project.id, job_run_id)
            if state is not None and state.status in statuses:
                return state
            time.sleep(0.25)
        self.fail(f"état runtime absent parmi {statuses}")

    def test_worker_persists_a_version_and_restart_keeps_it(self) -> None:
        run, state = self.orchestrator.launch(
            organization_id=self.org.id,
            project_id=self.project.id,
            job_spec_id=self.spec.id,
            body={"rows": ["alpha"]},
            sources=[("https://exemple.com/a", "serp")],
            confidence="ok",
            created_at=WHEN,
        )
        self.assertEqual(run.status, "queued")
        self.assertEqual(state.engine, "hatchet")
        self.assertTrue(state.engine_run_id)
        version = self._wait_version(run.id)
        self.conn.commit()
        finished = PostgresCoreRepository(self.conn).get_job_run(self.org.id, self.project.id, run.id)
        self.assertEqual(finished.status, "ok")
        self.assertEqual(version.body, {"rows": ["alpha"]})
        self.assertEqual(version.job_run_id, run.id)
        self.assertEqual(version.version_number, 1)
        self.adapter.stop_worker()
        self.adapter.start_worker()
        with psycopg.connect(self.url, row_factory=dict_row) as other:
            reloaded = CoreService(PostgresCoreRepository(other)).complete_job_run(
                organization_id=self.org.id,
                project_id=self.project.id,
                job_run_id=run.id,
                body={"rows": ["perdu"]},
                sources=[],
                confidence="low",
            )
            count = other.execute(
                "SELECT count(*) AS n FROM artifact_versions WHERE job_run_id = %s",
                (run.id,),
            ).fetchone()
        self.assertEqual(reloaded.id, version.id)
        self.assertEqual(reloaded.body, {"rows": ["alpha"]})
        self.assertEqual(count["n"], 1)
        runtime = self.adapter.runtime(self.org.id, self.project.id, run.id)
        self.assertEqual(runtime.status, "ok")
        self.assertEqual(runtime.engine, "hatchet")

    def test_transient_failure_retries_once_and_writes_a_single_version(self) -> None:
        run, _state = self.orchestrator.launch(
            organization_id=self.org.id,
            project_id=self.project.id,
            job_spec_id=self.spec.id,
            body={"rows": ["beta"]},
            sources=[("https://exemple.com/b", "serp")],
            confidence="ok",
            created_at=WHEN,
            transient_failures=1,
        )
        version = self._wait_version(run.id)
        state = self._wait_runtime(run.id, {"ok"})
        self.assertGreaterEqual(state.attempt, 2)
        self.assertEqual(version.version_number, 1)
        self.assertEqual(version.body, {"rows": ["beta"]})

    def test_timeout_fails_the_run_without_a_version(self) -> None:
        run, _state = self.orchestrator.launch(
            organization_id=self.org.id,
            project_id=self.project.id,
            job_spec_id=self.spec.id,
            body={"rows": ["trop tard"]},
            sources=[],
            confidence="low",
            created_at=WHEN,
            timeout_seconds=1,
            delay_seconds=3,
        )
        state = self._wait_runtime(run.id, {"timed_out"})
        self.conn.commit()
        stored = PostgresCoreRepository(self.conn).get_job_run(self.org.id, self.project.id, run.id)
        version = PostgresCoreRepository(self.conn).get_version_for_run(self.org.id, self.project.id, run.id)
        self.assertEqual(stored.status, "failed")
        self.assertEqual(stored.error, "timeout")
        self.assertIsNone(version)
        self.assertEqual(state.status, "timed_out")
        self.assertEqual(state.job_run_id, run.id)
