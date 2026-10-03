"""Résolution Capability → Provider : priorité, santé, repli, isolation."""
from __future__ import annotations

import ast
import unittest
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from core.application.providers import ProviderResolver
from core.application.service import CoreService
from core.domain.model import (
    CAPABILITIES,
    JOB_TYPES,
    PROVIDER_CAPABILITIES,
    PROVIDERS,
    WORKFLOW_CAPABILITY,
    Capability,
    Conflict,
    DomainError,
    NotInOrganization,
    Project,
    Provider,
    ProviderBinding,
    capability_for_workflow,
)
from core.postgres.migrate import apply as migrate
from core.postgres.repository import PostgresCoreRepository
from tests.test_v2_postgres import _database_url

ROOT = Path(__file__).resolve().parents[1]


class MemoryBindings:
    def __init__(self) -> None:
        self.projects: dict[tuple[UUID, UUID], Project] = {}
        self.bindings: dict[UUID, ProviderBinding] = {}

    def get_project(self, organization_id: UUID, project_id: UUID) -> Project | None:
        return self.projects.get((organization_id, project_id))

    def add_provider_binding(self, binding: ProviderBinding) -> None:
        if any(
            item.project_id == binding.project_id
            and item.capability == binding.capability
            and item.provider == binding.provider
            for item in self.bindings.values()
        ):
            raise Conflict("provider_binding")
        self.bindings[binding.id] = binding

    def save_provider_binding(self, binding: ProviderBinding) -> None:
        current = self.bindings.get(binding.id)
        if current is None or current.organization_id != binding.organization_id or current.project_id != binding.project_id:
            raise NotInOrganization("provider_binding")
        clash = any(
            item.id != binding.id
            and item.project_id == binding.project_id
            and item.capability == binding.capability
            and item.provider == binding.provider
            for item in self.bindings.values()
        )
        if clash:
            raise Conflict("provider_binding")
        self.bindings[binding.id] = binding

    def get_provider_binding(
        self, organization_id: UUID, project_id: UUID, binding_id: UUID
    ) -> ProviderBinding | None:
        found = self.bindings.get(binding_id)
        if found is None or found.organization_id != organization_id or found.project_id != project_id:
            return None
        return found

    def list_provider_bindings(
        self, organization_id: UUID, project_id: UUID, capability: str
    ) -> list[ProviderBinding]:
        return [
            item
            for item in self.bindings.values()
            if item.organization_id == organization_id
            and item.project_id == project_id
            and item.capability == capability
        ]


class CatalogTests(unittest.TestCase):
    def test_catalog_is_two_search_providers_and_known_workflows(self) -> None:
        self.assertEqual(PROVIDERS, frozenset({"searxng", "duckduckgo"}))
        self.assertEqual(CAPABILITIES, frozenset({"search"}))
        self.assertEqual(set(PROVIDER_CAPABILITIES), set(PROVIDERS))
        for capability in PROVIDER_CAPABILITIES.values():
            self.assertTrue(capability <= CAPABILITIES)
        for workflow, capability in WORKFLOW_CAPABILITY.items():
            self.assertIn(workflow, JOB_TYPES)
            self.assertIn(capability, CAPABILITIES)
        self.assertEqual(capability_for_workflow("search.web"), "search")
        self.assertEqual(Capability(key="search").key, "search")
        self.assertEqual(Provider(key="searxng").capabilities, frozenset({"search"}))
        with self.assertRaises(DomainError):
            Provider(key="openseo")
        with self.assertRaises(DomainError):
            capability_for_workflow("content.outline")

    def test_core_does_not_branch_on_a_provider_name(self) -> None:
        for relative in ("core/domain", "core/application", "core/ports"):
            for path in (ROOT / relative).glob("*.py"):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                for node in ast.walk(tree):
                    if not isinstance(node, ast.Compare):
                        continue
                    constants = [
                        item.value
                        for item in (node.left, *node.comparators)
                        if isinstance(item, ast.Constant) and isinstance(item.value, str)
                    ]
                    for value in constants:
                        self.assertNotIn(value, PROVIDERS)


class ResolverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = MemoryBindings()
        self.org = uuid4()
        self.project = self._project(self.org, "mon-produit")
        self.other = self._project(self.org, "autre-produit")
        self.resolver = ProviderResolver(self.repo)

    def _project(self, organization_id: UUID, slug: str) -> Project:
        project = Project(id=uuid4(), organization_id=organization_id, name=slug, slug=slug)
        self.repo.projects[(organization_id, project.id)] = project
        return project

    def test_selection_keeps_the_highest_priority(self) -> None:
        self.resolver.bind(
            organization_id=self.org,
            project_id=self.project.id,
            workflow="search.web",
            provider="duckduckgo",
            priority=10,
        )
        self.resolver.bind(
            organization_id=self.org,
            project_id=self.project.id,
            workflow="discover.serp",
            provider="searxng",
            priority=30,
        )
        chosen = self.resolver.resolve(organization_id=self.org, project_id=self.project.id, workflow="discover.signals")
        self.assertEqual(chosen.key, "searxng")
        self.assertEqual(self.resolver.capability_for("discover.signals").key, "search")

    def test_replacement_changes_the_provider_without_changing_the_workflow(self) -> None:
        binding = self.resolver.bind(
            organization_id=self.org,
            project_id=self.project.id,
            workflow="search.web",
            provider="searxng",
            priority=30,
        )
        self.resolver.replace_provider(
            organization_id=self.org,
            project_id=self.project.id,
            binding_id=binding.id,
            provider="duckduckgo",
        )
        chosen = self.resolver.resolve(organization_id=self.org, project_id=self.project.id, workflow="search.web")
        self.assertEqual(chosen.key, "duckduckgo")

    def test_fallback_skips_an_unhealthy_provider(self) -> None:
        primary = self.resolver.bind(
            organization_id=self.org,
            project_id=self.project.id,
            workflow="search.web",
            provider="searxng",
            priority=30,
        )
        self.resolver.bind(
            organization_id=self.org,
            project_id=self.project.id,
            workflow="search.web",
            provider="duckduckgo",
            priority=10,
        )
        self.resolver.set_health(
            organization_id=self.org,
            project_id=self.project.id,
            binding_id=primary.id,
            health="down",
        )
        chosen = self.resolver.resolve(organization_id=self.org, project_id=self.project.id, workflow="search.web")
        self.assertEqual(chosen.key, "duckduckgo")

    def test_unavailable_when_every_binding_is_down(self) -> None:
        primary = self.resolver.bind(
            organization_id=self.org,
            project_id=self.project.id,
            workflow="search.web",
            provider="searxng",
            priority=30,
        )
        secondary = self.resolver.bind(
            organization_id=self.org,
            project_id=self.project.id,
            workflow="search.web",
            provider="duckduckgo",
            priority=10,
        )
        self.resolver.set_health(
            organization_id=self.org, project_id=self.project.id, binding_id=primary.id, health="down"
        )
        self.resolver.set_health(
            organization_id=self.org, project_id=self.project.id, binding_id=secondary.id, health="down"
        )
        with self.assertRaises(DomainError):
            self.resolver.resolve(organization_id=self.org, project_id=self.project.id, workflow="search.web")

    def test_project_isolation(self) -> None:
        self.resolver.bind(
            organization_id=self.org,
            project_id=self.project.id,
            workflow="search.web",
            provider="searxng",
            priority=30,
        )
        self.resolver.bind(
            organization_id=self.org,
            project_id=self.other.id,
            workflow="search.web",
            provider="duckduckgo",
            priority=30,
        )
        own = self.resolver.resolve(organization_id=self.org, project_id=self.project.id, workflow="search.web")
        other = self.resolver.resolve(organization_id=self.org, project_id=self.other.id, workflow="search.web")
        self.assertEqual(own.key, "searxng")
        self.assertEqual(other.key, "duckduckgo")
        stranger = uuid4()
        with self.assertRaises(NotInOrganization):
            self.resolver.resolve(organization_id=stranger, project_id=self.project.id, workflow="search.web")


class ProviderPostgresTests(unittest.TestCase):
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
        self.org = self.service.open_organization(name="Acme", slug="acme")
        self.project = self.service.open_project(organization_id=self.org.id, name="Mon Produit", slug="mon-produit")
        self.other = self.service.open_project(organization_id=self.org.id, name="Autre", slug="autre")
        self.conn.commit()
        self.resolver = ProviderResolver(PostgresCoreRepository(self.conn))

    def tearDown(self) -> None:
        self.conn.close()

    def test_catalog_and_binding_survive_another_connection(self) -> None:
        providers = self.conn.execute("SELECT key FROM providers ORDER BY key").fetchall()
        offers = self.conn.execute(
            "SELECT provider_key, capability_key FROM provider_capabilities ORDER BY provider_key"
        ).fetchall()
        self.assertEqual([row["key"] for row in providers], ["duckduckgo", "searxng"])
        self.assertEqual(
            [(row["provider_key"], row["capability_key"]) for row in offers],
            [("duckduckgo", "search"), ("searxng", "search")],
        )
        binding = self.resolver.bind(
            organization_id=self.org.id,
            project_id=self.project.id,
            workflow="search.web",
            provider="searxng",
            priority=30,
        )
        self.conn.commit()
        with psycopg.connect(self.url, row_factory=dict_row) as other:
            chosen = ProviderResolver(PostgresCoreRepository(other)).resolve(
                organization_id=self.org.id,
                project_id=self.project.id,
                workflow="search.web",
            )
            hidden = PostgresCoreRepository(other).list_provider_bindings(self.org.id, self.other.id, "search")
        self.assertEqual(chosen.key, binding.provider)
        self.assertEqual(hidden, [])
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            self.conn.execute(
                """
                INSERT INTO provider_bindings (
                    id, organization_id, project_id, capability_key, provider_key, priority, health
                ) VALUES (%s, %s, %s, 'search', 'openseo', 1, 'up')
                """,
                (uuid4(), self.org.id, self.project.id),
            )
