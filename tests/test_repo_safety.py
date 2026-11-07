"""Le git du cœur ne suit pas le runtime, les secrets, ni les artefacts générés."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import engine.pipeline as pipeline
import scripts.secret_guard as secret_guard

ROOT = Path(__file__).resolve().parents[1]

IGNORED = [
    "stacks/registry.json",
    "stacks/demo/data/gtm.db",
    "stacks/demo/repo/repo/.git/config",
    "stacks/demo/output/pulse.md",
    "web/missions.json",
    "logs/mission-0001.log",
    "output/keywords.csv",
    "tools/data/gtm.db",
    ".env",
    "catalog/overrides.json",
    "catalog/custom.json",
    "graphify-out/graph.json",
    "graphify-out/2026-10-03/graph.json",
    "id_rsa",
]

TRACKED_TEMPLATES = [
    "catalog/arms.json",
    "catalog/overrides.example.json",
    "tools/config.example.env",
    "README.md",
    "engine/loops.py",
    "qeynox.py",
]


def _ignored(rel: str) -> bool:
    proc = subprocess.run(
        ["git", "check-ignore", "-q", "--no-index", rel],
        cwd=ROOT,
        capture_output=True,
    )
    return proc.returncode == 0


class RepoSafetyTests(unittest.TestCase):
    def test_runtime_paths_match_gitignore(self) -> None:
        for rel in IGNORED:
            self.assertTrue(_ignored(rel), rel)

    def test_bootstrap_templates_stay_visible(self) -> None:
        for rel in TRACKED_TEMPLATES:
            self.assertTrue((ROOT / rel).is_file(), rel)
            self.assertFalse(_ignored(rel), rel)

    def test_missing_registry_is_an_empty_list(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        old_dir, old_reg = pipeline.STACKS_DIR, pipeline.REGISTRY
        pipeline.STACKS_DIR = tmp
        pipeline.REGISTRY = os.path.join(tmp, "registry.json")
        try:
            self.assertEqual(pipeline.load_registry(), [])
        finally:
            pipeline.STACKS_DIR, pipeline.REGISTRY = old_dir, old_reg

    def test_secret_guard_flags_tokens_and_clears_the_repo(self) -> None:
        self.assertTrue(secret_guard.scan_text("aws AKIA" + "IOSFODNN7EXAMPLE"))
        self.assertTrue(secret_guard.scan_text("https://user:" + "Sup3rSecret@github.com/a/b.git"))
        self.assertFalse(secret_guard.scan_text("HERMES_API_KEY=\n"))
        self.assertFalse(secret_guard.scan_text("https://user:sekret@github.com/acme/private.git"))
        self.assertEqual(secret_guard.scan_repo(ROOT), [])


if __name__ == "__main__":
    unittest.main()
