"""Régressions des bugs P0 legacy prouvés sur main, sans réseau externe."""
from __future__ import annotations

import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
import zipfile
from contextlib import redirect_stdout

import engine.loops as loops
import engine.pipeline as pipeline
import engine.repo_scan as repo_scan
import engine.research as research
import engine.synthesize as synthesize
import mcp_server
import tools.gtm_store as gtm_store
import web.app as app


GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "lot0",
    "GIT_AUTHOR_EMAIL": "lot0@example.com",
    "GIT_COMMITTER_NAME": "lot0",
    "GIT_COMMITTER_EMAIL": "lot0@example.com",
}


def git(*args: str, cwd: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, env=GIT_ENV, check=True, capture_output=True, text=True)


class Lot0Tests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved: list[tuple[object, str, object]] = []
        self._env: list[tuple[str, str | None]] = []

    def tearDown(self) -> None:
        for obj, name, value in reversed(self._saved):
            setattr(obj, name, value)
        for key, value in reversed(self._env):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def patch(self, obj: object, name: str, value: object) -> None:
        self._saved.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def _restore_module(self, name: str, previous: object) -> None:
        if previous is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = previous

    def setenv(self, key: str, value: str | None) -> None:
        self._env.append((key, os.environ.get(key)))
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value

    def test_top_kws_reads_kw_column(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        self.patch(loops, "STACKS", tmp)
        os.makedirs(os.path.join(tmp, "demo", "data"))
        con = sqlite3.connect(os.path.join(tmp, "demo", "data", "gtm.db"))
        con.execute("CREATE TABLE keywords (kw TEXT PRIMARY KEY, score REAL)")
        con.execute("INSERT INTO keywords (kw, score) VALUES ('seo local', 9)")
        con.commit()
        con.close()
        rows = loops._top_kws("demo", 5)
        self.assertEqual([r[0] for r in rows], ["seo local"])

    def test_upsert_fills_metadata_without_wiping_blanks(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        con = sqlite3.connect(os.path.join(tmp, "gtm.db"))
        con.row_factory = sqlite3.Row
        con.executescript(gtm_store.SCHEMA)
        gtm_store.upsert_keywords(con, [{"kw": "Alpha", "source": "seed", "score": 2}])
        gtm_store.upsert_keywords(con, [{
            "kw": "alpha", "source": "google", "intent": "commercial", "parent": "seed", "score": 1,
        }])
        row = con.execute("SELECT intent, source, parent, score FROM keywords").fetchone()
        self.assertEqual(row["intent"], "commercial")
        self.assertEqual(row["source"], "google")
        self.assertEqual(row["parent"], "seed")
        self.assertEqual(row["score"], 2)
        gtm_store.upsert_keywords(con, [{"kw": "alpha", "intent": "", "source": None, "score": 4}])
        row = con.execute("SELECT intent, source, parent, score FROM keywords").fetchone()
        self.assertEqual(row["intent"], "commercial")
        self.assertEqual(row["source"], "google")
        self.assertEqual(row["parent"], "seed")
        self.assertEqual(row["score"], 4)
        con.close()

    def test_rescan_next_run_survives_cycle_save(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        slug = "demo"
        stack = os.path.join(tmp, slug)
        os.makedirs(stack)
        progs = [
            {"id": "rescan-event", "type": "rescan", "every_h": 24, "enabled": True, "params": {}},
            {"id": "keywords-enrich", "type": "keywords", "every_h": 0, "enabled": True, "params": {}},
            {"id": "competitors-watch", "type": "competitors", "every_h": 72, "enabled": True, "params": {}},
        ]
        with open(os.path.join(stack, "programs.json"), "w", encoding="utf-8") as f:
            json.dump(progs, f)
        with open(os.path.join(stack, "loop_state.json"), "w", encoding="utf-8") as f:
            json.dump({"source_fingerprint": "old"}, f)
        self.patch(loops, "STACKS", tmp)
        self.patch(loops, "source_fingerprint", lambda _slug: "new")
        loaded, _fresh = loops.load_programs(slug)
        rescan = next(p for p in loaded if p["type"] == "rescan")
        loops.run_program(slug, rescan, loaded)
        loops.save_programs(slug, loaded)
        saved = json.load(open(os.path.join(stack, "programs.json"), encoding="utf-8"))
        by_type = {p["type"]: p for p in saved}
        self.assertTrue(by_type["keywords"].get("next_run"))
        self.assertTrue(by_type["competitors"].get("next_run"))

    def test_fingerprint_follows_nested_clone_remote(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        bare = os.path.join(tmp, "bare.git")
        work = os.path.join(tmp, "work")
        os.makedirs(bare)
        os.makedirs(work)
        git("init", "--bare", cwd=bare)
        git("init", cwd=work)
        with open(os.path.join(work, "readme.txt"), "w", encoding="utf-8") as f:
            f.write("v1\n")
        git("add", "readme.txt", cwd=work)
        git("commit", "-m", "v1", cwd=work)
        git("branch", "-M", "main", cwd=work)
        git("remote", "add", "origin", bare, cwd=work)
        git("push", "-u", "origin", "main", cwd=work)
        git("symbolic-ref", "HEAD", "refs/heads/main", cwd=bare)
        slug = "demo"
        clone = os.path.join(tmp, "stacks", slug, "repo", "repo")
        os.makedirs(os.path.dirname(clone))
        remote = "file:///" + bare.replace("\\", "/").lstrip("/")
        subprocess.run(
            ["git", "clone", "--depth", "1", "--branch", "main", remote, clone],
            check=True, capture_output=True, text=True, env=GIT_ENV,
        )
        first = subprocess.run(
            ["git", "-C", clone, "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        self.patch(loops, "STACKS", os.path.join(tmp, "stacks"))
        self.assertEqual(loops.source_fingerprint(slug), first)
        with open(os.path.join(work, "readme.txt"), "w", encoding="utf-8") as f:
            f.write("v2\n")
        git("add", "readme.txt", cwd=work)
        git("commit", "-m", "v2", cwd=work)
        git("push", "origin", "main", cwd=work)
        second = subprocess.run(
            ["git", "-C", work, "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        self.assertNotEqual(first, second)
        self.assertEqual(loops.source_fingerprint(slug), second)

    def test_fingerprint_local_source_not_inside_stack(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        src = os.path.join(tmp, "outside")
        os.makedirs(src)
        with open(os.path.join(src, "a.txt"), "w", encoding="utf-8") as f:
            f.write("one")
        slug = "demo"
        ctx = os.path.join(tmp, "stacks", slug, "context")
        os.makedirs(ctx)
        with open(os.path.join(ctx, "repo-analysis.json"), "w", encoding="utf-8") as f:
            json.dump({"source": src, "source_mode": "local"}, f)
        self.patch(loops, "STACKS", os.path.join(tmp, "stacks"))
        before = loops.source_fingerprint(slug)
        with open(os.path.join(src, "a.txt"), "w", encoding="utf-8") as f:
            f.write("two")
        os.utime(os.path.join(src, "a.txt"), (1_700_000_000, 1_800_000_000))
        after = loops.source_fingerprint(slug)
        self.assertNotEqual(before, after)
        self.assertTrue(after)

    def test_create_stack_stores_redacted_git_url(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        self.patch(pipeline, "STACKS_DIR", tmp)
        self.patch(pipeline, "REGISTRY", os.path.join(tmp, "registry.json"))
        raw = "https://user:sekret@github.com/acme/private.git"
        pipeline.create_stack("Demo", raw, "https://example.com")
        blob = open(pipeline.REGISTRY, encoding="utf-8").read()
        self.assertNotIn("sekret", blob)
        self.assertNotIn("user:sekret", blob)
        self.assertIn("github.com/acme/private.git", blob)

    def test_scan_and_pipeline_do_not_persist_git_credentials(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        raw = "https://user:sekret@github.com/acme/private.git"
        seen: dict[str, str] = {}

        def fake_prepare(source: str, workdir: str):
            seen["clone_source"] = source
            os.makedirs(workdir, exist_ok=True)
            return workdir, "git"

        def fake_scan(_repo: str) -> dict:
            return {
                "brand": {"guess": "Demo", "html_title": "", "meta_description": ""},
                "product": {
                    "category_words": ["outil"], "prices": [], "emails": [],
                    "socials": {}, "ctas": [], "taglines_h1": [], "value_props_h2": [],
                },
                "readme": {"excerpt": ""},
                "languages": {},
                "n_files": 0,
                "manifests": {"frameworks": []},
                "site_url": "",
            }

        self.patch(repo_scan, "prepare_repo", fake_prepare)
        self.patch(repo_scan, "scan_repo", fake_scan)
        repo_scan.run(raw, os.path.join(tmp, "scan"))
        scanned = open(os.path.join(tmp, "scan", "context", "repo-analysis.json"), encoding="utf-8").read()
        self.assertNotIn("sekret", scanned)
        self.assertIn("sekret", seen["clone_source"])

        self.patch(pipeline, "STACKS_DIR", tmp)
        self.patch(pipeline, "REGISTRY", os.path.join(tmp, "registry.json"))
        os.makedirs(os.path.join(tmp, "demo"), exist_ok=True)
        pipeline.save_registry([{
            "slug": "demo", "name": "Demo", "source": "redacted-already",
            "site_url": "", "status": "queued",
        }])
        self.patch(research, "stage_keywords", lambda *a, **k: {"top": [], "seeds": []})
        self.patch(research, "stage_signals", lambda *a, **k: {"signals": [], "engine": "test"})
        self.patch(research, "stage_competitors", lambda *a, **k: {"competitors": []})
        self.patch(research, "stage_aeo", lambda *a, **k: {"reachable": False, "score": 0, "max_score": 1, "checks": []})
        self.patch(synthesize, "stage_synthese", lambda *a, **k: {"status": "skipped", "note": "test"})
        fake_dossier = types.ModuleType("engine.dossier")
        fake_dossier.build_dossier = lambda *a, **k: {
            "path": "dossier.md",
            "data": {"aeo_score": None, "n_keywords": 0, "n_signals": 0, "n_competitors": 0, "brand": "Demo", "site": ""},
        }
        previous_dossier = sys.modules.get("engine.dossier")
        sys.modules["engine.dossier"] = fake_dossier
        self.addCleanup(self._restore_module, "engine.dossier", previous_dossier)
        pipeline.run_pipeline("demo", {"source": raw, "name": "Demo", "site_url": "", "seeds": []})
        analysis = open(os.path.join(tmp, "demo", "context", "repo-analysis.json"), encoding="utf-8").read()
        pipe = open(os.path.join(tmp, "demo", "pipeline.json"), encoding="utf-8").read()
        registry = open(pipeline.REGISTRY, encoding="utf-8").read()
        self.assertNotIn("sekret", analysis)
        self.assertNotIn("sekret", pipe)
        self.assertNotIn("sekret", registry)
        self.assertIn("sekret", seen["clone_source"])

    def test_clone_error_scrubs_credentials(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        raw = "https://user:sekret@github.com/acme/private.git"

        class Proc:
            returncode = 1
            stdout = ""
            stderr = f"fatal: Authentication failed for '{raw}'"

        self.patch(repo_scan.subprocess, "run", lambda *a, **k: Proc())
        with self.assertRaises(RuntimeError) as caught:
            repo_scan.prepare_repo(raw, tmp)
        self.assertNotIn("sekret", str(caught.exception))

    def test_zip_slip_is_rejected(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        zpath = os.path.join(tmp, "evil.zip")
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr("../../outside.txt", "pwned")
        work = os.path.join(tmp, "nested", "work")
        os.makedirs(work)
        outside = os.path.join(tmp, "outside.txt")
        with self.assertRaises(RuntimeError):
            repo_scan.prepare_repo(zpath, work)
        self.assertFalse(os.path.exists(outside))
        ok_zip = os.path.join(tmp, "ok.zip")
        with zipfile.ZipFile(ok_zip, "w") as zf:
            zf.writestr("readme.md", "hello")
        ok_work = os.path.join(tmp, "okwork")
        os.makedirs(ok_work)
        extracted, mode = repo_scan.prepare_repo(ok_zip, ok_work)
        self.assertEqual(mode, "zip")
        self.assertTrue(os.path.isfile(os.path.join(extracted, "readme.md")))

    def test_report_and_static_stay_inside_root(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        root = os.path.join(tmp, "output")
        os.makedirs(root)
        inside = os.path.join(root, "note.md")
        with open(inside, "w", encoding="utf-8") as f:
            f.write("ok")
        secret = os.path.join(tmp, "secret.txt")
        with open(secret, "w", encoding="utf-8") as f:
            f.write("no")
        self.assertEqual(app.resolve_under(root, "note.md"), os.path.normpath(inside))
        self.assertIsNone(app.resolve_under(root, "../secret.txt"))
        self.assertIsNone(app.resolve_under(root, "..\\secret.txt"))
        self.assertFalse(app.contained(root, secret))

    def test_invalid_stack_slug_is_rejected(self) -> None:
        self.assertIsNone(app.normalize_slug("../demo"))
        self.assertIsNone(app.normalize_slug("demo/../x"))
        self.assertEqual(app.normalize_slug(""), "")
        self.assertEqual(app.normalize_slug("demo-1"), "demo-1")
        resp = mcp_server.handle({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "get_keywords", "arguments": {"slug": "../x"}},
        })
        text = resp["result"]["content"][0]["text"]
        self.assertTrue(resp["result"]["isError"])
        self.assertIn("invalide", text)

    def test_web_mission_cwd_is_the_stack(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        slug = "demo"
        stack = os.path.join(tmp, slug)
        os.makedirs(os.path.join(stack, "context"))
        with open(os.path.join(stack, "context", "repo-analysis.json"), "w", encoding="utf-8") as f:
            json.dump({"brand": {"guess": "DemoBrand"}}, f)
        self.patch(app, "STACKS_DIR", tmp)
        self.patch(app.pl, "STACKS_DIR", tmp)
        self.patch(app.pl, "REGISTRY", os.path.join(tmp, "registry.json"))
        app.pl.save_registry([{
            "slug": slug, "name": "Demo", "site_url": "https://www.example.com",
            "source": "local", "status": "active",
        }])
        captured: dict = {}

        class Proc:
            def __init__(self, cmd, cwd=None, env=None, stdout=None, stderr=None):
                captured["cwd"] = cwd
                captured["env"] = env
                self.pid = 7

            def wait(self):
                return 0

        self.patch(app.subprocess, "Popen", Proc)
        app._missions.clear()
        app._missions[1] = {
            "id": 1, "type": "keywords", "stack": slug,
            "params": {"seeds": ["graine"]}, "status": "running",
        }
        app.run_mission(1)
        self.assertEqual(os.path.normcase(captured["cwd"]), os.path.normcase(stack))
        self.assertTrue(captured["env"]["GTM_DB"].endswith(os.path.join(slug, "data", "gtm.db")))
        self.assertEqual(captured["env"]["GTM_BRAND"], "DemoBrand")
        self.assertEqual(captured["env"]["GTM_DOMAIN"], "example.com")

    def test_web_mission_rejects_escaping_slug(self) -> None:
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        self.patch(app, "STACKS_DIR", tmp)
        called = {"n": 0}

        class Proc:
            def __init__(self, *a, **k):
                called["n"] += 1
                self.pid = 1

            def wait(self):
                return 0

        self.patch(app.subprocess, "Popen", Proc)
        app._missions.clear()
        app._missions[2] = {
            "id": 2, "type": "keywords", "stack": "..",
            "params": {"seeds": ["x"]}, "status": "running",
        }
        app.run_mission(2)
        self.assertEqual(called["n"], 0)
        self.assertEqual(app._missions[2]["status"], "error")

    def test_server_defaults_to_loopback(self) -> None:
        captured: dict = {}

        class Srv:
            def __init__(self, addr, handler):
                captured["addr"] = addr

            def serve_forever(self):
                return None

        self.patch(app, "ThreadingHTTPServer", Srv)
        self.setenv("GTM_WEB_HOST", None)
        with redirect_stdout(io.StringIO()):
            app.main()
        self.assertEqual(captured["addr"][0], "127.0.0.1")
        self.setenv("GTM_WEB_HOST", "0.0.0.0")
        with redirect_stdout(io.StringIO()):
            app.main()
        self.assertEqual(captured["addr"][0], "0.0.0.0")


if __name__ == "__main__":
    unittest.main()
