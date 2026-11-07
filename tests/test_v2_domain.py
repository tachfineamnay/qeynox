"""Règles du Domain Core V2, sans base et sans SDK d'infrastructure."""
from __future__ import annotations

import ast
import inspect
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from core.domain.model import (
    JOB_STATUSES,
    JOB_TYPES,
    MODEL_SELECTORS,
    BusinessContext,
    DomainError,
    JobRun,
    JobSpec,
    Organization,
    Project,
)

ROOT = Path(__file__).resolve().parents[1]


def _ids():
    return uuid4(), uuid4()


class DomainTests(unittest.TestCase):
    def test_organization_project_context_spec_and_run_are_valid(self) -> None:
        org_id, project_id = _ids()
        spec_id, run_id = uuid4(), uuid4()
        org = Organization(id=org_id, name="  Acme  ", slug="acme")
        project = Project(id=project_id, organization_id=org_id, name="Mon Produit", slug="mon-produit")
        context = BusinessContext(
            id=uuid4(),
            organization_id=org_id,
            project_id=project_id,
            language="fr",
            geo="FR",
            site_url="https://exemple.com",
            brand_aliases=["Acme"],
            offer="Une offre sourcée",
        )
        spec = JobSpec(
            id=spec_id,
            organization_id=org_id,
            project_id=project_id,
            type="discover.keywords",
            role="research",
            title="Enrichir les graines",
            inputs={"seeds": ["alpha"]},
            arms=["searxng"],
            model="auto",
            gate=False,
            done_when="n_keywords >= 30",
        )
        run = JobRun(
            id=run_id,
            organization_id=org_id,
            project_id=project_id,
            job_spec_id=spec_id,
            type=spec.type,
            status="queued",
            model=spec.model,
            error=None,
            created_at=datetime(2026, 10, 3, tzinfo=timezone.utc),
        )
        self.assertEqual(org.name, "Acme")
        self.assertEqual(context.brand_aliases, ("Acme",))
        self.assertEqual(spec.inputs["seeds"], ["alpha"])
        self.assertEqual(run.status, "queued")
        self.assertIn("discover.keywords", JOB_TYPES)
        self.assertEqual(JOB_STATUSES, frozenset({"queued", "running", "ok", "failed", "needs_approval"}))
        self.assertEqual(MODEL_SELECTORS, frozenset({"auto", "fast", "strong", "local", "custom"}))

    def test_rejects_invalid_slug_blank_name_and_bad_url(self) -> None:
        org_id = uuid4()
        with self.assertRaises(DomainError):
            Organization(id=org_id, name="   ", slug="acme")
        with self.assertRaises(DomainError):
            Organization(id=org_id, name="Acme", slug="Acme")
        with self.assertRaises(DomainError):
            Organization(id=org_id, name="Acme", slug="../x")
        with self.assertRaises(DomainError):
            BusinessContext(
                id=uuid4(),
                organization_id=org_id,
                project_id=uuid4(),
                language="fr",
                geo="FR",
                site_url="ftp://exemple.com",
                brand_aliases=[],
                offer="offre",
            )

    def test_job_spec_and_run_stay_inside_the_closed_contract(self) -> None:
        org_id, project_id, spec_id = uuid4(), uuid4(), uuid4()
        with self.assertRaises(DomainError):
            JobSpec(
                id=spec_id,
                organization_id=org_id,
                project_id=project_id,
                type="custom.whatever",
                role="research",
                title="Titre",
                inputs={},
                arms=[],
                model="auto",
                gate=False,
                done_when="fait",
            )
        with self.assertRaises(DomainError):
            JobSpec(
                id=spec_id,
                organization_id=org_id,
                project_id=project_id,
                type="discover.keywords",
                role="research",
                title="Titre",
                inputs=["pas", "un", "objet"],
                arms=[],
                model="auto",
                gate=False,
                done_when="fait",
            )
        with self.assertRaises(DomainError):
            JobRun(
                id=uuid4(),
                organization_id=org_id,
                project_id=project_id,
                job_spec_id=spec_id,
                type="discover.keywords",
                status="approved",
                model="auto",
                error=None,
                created_at=datetime(2026, 10, 3, tzinfo=timezone.utc),
            )
        with self.assertRaises(DomainError):
            JobRun(
                id=uuid4(),
                organization_id=org_id,
                project_id=project_id,
                job_spec_id=spec_id,
                type="discover.keywords",
                status="queued",
                model="auto",
                error=None,
                created_at=datetime(2026, 10, 3),
            )

    def test_inputs_are_copied(self) -> None:
        payload = {"seeds": ["alpha"]}
        spec = JobSpec(
            id=uuid4(),
            organization_id=uuid4(),
            project_id=uuid4(),
            type="search.web",
            role="research",
            title="Chercher",
            inputs=payload,
            arms=["web"],
            model="fast",
            gate=True,
            done_when="sources",
        )
        payload["seeds"].append("beta")
        self.assertEqual(spec.inputs["seeds"], ["alpha"])

    def test_domain_and_application_do_not_import_infrastructure(self) -> None:
        banned = ("psycopg", "sqlalchemy", "asyncpg", "hatchet", "fastapi", "boto3", "langfuse")
        for relative in ("core/domain", "core/application", "core/ports"):
            for path in (ROOT / relative).glob("*.py"):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                modules = [node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
                modules += [alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names]
                for name in modules:
                    for token in banned:
                        self.assertNotIn(token, name)
        self.assertNotIn("psycopg", inspect.getsource(__import__("core.domain.model", fromlist=["model"])))
