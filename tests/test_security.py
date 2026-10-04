"""Contrôles de sécurité V1 : bind, jeton, chemins, git, zip, SSRF."""
from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer

import pytest

from engine import repo_scan
from engine import safety


@pytest.fixture
def token(monkeypatch):
    monkeypatch.setenv("QEYNOX_API_TOKEN", "test-token-secret")
    monkeypatch.delenv("GTM_HOOK_TOKEN", raising=False)
    return "test-token-secret"


@pytest.fixture
def http_server(token):
    from web.app import Handler

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        thread.join(timeout=3)


def _request(port: int, method: str, path: str, token: str | None = None, body: dict | None = None, header: str | None = None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if header:
        name, value = header.split(":", 1)
        headers[name] = value.strip()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            raw = response.read()
            ctype = response.headers.get("Content-Type", "")
            if "json" in ctype:
                return response.status, json.loads(raw.decode())
            return response.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return exc.code, payload


def test_bind_defaults_to_loopback(monkeypatch):
    monkeypatch.delenv("QEYNOX_BIND", raising=False)
    assert safety.bind_host() == "127.0.0.1"


def test_refuses_public_bind_without_token(monkeypatch):
    monkeypatch.delenv("QEYNOX_API_TOKEN", raising=False)
    monkeypatch.delenv("GTM_HOOK_TOKEN", raising=False)
    with pytest.raises(SystemExit):
        safety.assert_bind_allowed("0.0.0.0")


def test_allows_public_bind_with_token(token):
    safety.assert_bind_allowed("0.0.0.0")


def test_health_is_open_and_api_requires_token(http_server, token):
    code, payload = _request(http_server, "GET", "/api/health")
    assert code == 200
    assert payload["ok"] is True
    assert "searxng" in payload

    code, payload = _request(http_server, "GET", "/api/stacks")
    assert code == 401

    code, payload = _request(http_server, "POST", "/api/missions", body={"type": "keywords", "params": {}})
    assert code == 401

    code, payload = _request(http_server, "POST", "/api/hooks/agent", body={"title": "x", "body_md": "y"})
    assert code == 401

    code, payload = _request(http_server, "GET", "/api/stacks", token=token)
    assert code == 200
    assert "rows" in payload

    code, payload = _request(http_server, "GET", "/api/stacks", header="X-Qeynox-Token: test-token-secret")
    assert code == 200

    code, payload = _request(http_server, "POST", "/api/stacks", token=token, body={})
    assert code == 400

    code, payload = _request(http_server, "GET", "/api/stacks?access_token=test-token-secret")
    assert code == 401


def test_open_on_loopback_when_no_token(monkeypatch):
    monkeypatch.delenv("QEYNOX_API_TOKEN", raising=False)
    monkeypatch.delenv("GTM_HOOK_TOKEN", raising=False)
    from web.app import Handler

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]
    try:
        code, payload = _request(port, "GET", "/api/stacks")
        assert code == 200
        assert "rows" in payload
    finally:
        httpd.shutdown()
        thread.join(timeout=3)


def test_static_and_report_reject_traversal(http_server, token):
    code, _ = _request(http_server, "GET", "/static/../app.py", token=token)
    assert code == 404
    code, _ = _request(http_server, "GET", "/static/%2e%2e/%2e%2e/qeynox.py", token=token)
    assert code == 404
    code, raw = _request(http_server, "GET", "/static/favicon.svg", token=token)
    assert code == 200
    assert raw.startswith(b"<svg") or b"svg" in raw[:200]
    code, payload = _request(http_server, "GET", "/api/report?path=../../README.md", token=token)
    assert code == 404
    code, payload = _request(http_server, "GET", "/api/keywords?stack=../../etc", token=token)
    assert code == 400


def test_git_url_allowlist():
    assert safety.validate_git_url("https://github.com/tachfineamnay/qeynox.git").startswith("https://")
    assert safety.validate_git_url("git@github.com:tachfineamnay/qeynox.git").startswith("git@")
    for bad in (
        "ext::sh -c id",
        "--upload-pack=touch",
        "file:///etc/passwd",
        "ssh://git@github.com/org/repo.git",
        "https://user:github_pat_embedded@github.com/org/repo.git",
        "https://github.com/org/../../etc/passwd",
        "git@github.com:../../etc/passwd",
        "https://",
    ):
        with pytest.raises(ValueError):
            safety.validate_git_url(bad)


def test_clone_rejects_option_injection_and_uses_end_of_options(monkeypatch, tmp_path):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        os.makedirs(cmd[-1], exist_ok=True)

        class Proc:
            returncode = 0
            stderr = ""
            stdout = ""

        return Proc()

    from engine import runner

    monkeypatch.setattr(repo_scan.shutil, "which", lambda _name: "/usr/bin/git")
    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError):
        repo_scan.prepare_repo("ext::sh -c id", str(tmp_path / "work"))
    assert calls == []

    path, mode = repo_scan.prepare_repo("https://github.com/example/repo.git", str(tmp_path / "ok"))
    assert mode == "git"
    assert calls[0][:5] == ["git", "clone", "--depth", "1", "--"]
    assert calls[0][-1] == path


def test_zip_slip_is_rejected(tmp_path):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../evil.txt", "pwned")
    with pytest.raises(RuntimeError):
        safety.safe_extract_zip(str(archive), str(tmp_path / "out"))
    assert not (tmp_path / "evil.txt").exists()

    good = tmp_path / "good.zip"
    with zipfile.ZipFile(good, "w") as zf:
        zf.writestr("readme.txt", "ok")
    safety.safe_extract_zip(str(good), str(tmp_path / "safe"))
    assert (tmp_path / "safe" / "readme.txt").read_text() == "ok"


def test_public_url_blocks_private_targets(monkeypatch):
    with pytest.raises(ValueError):
        safety.validate_public_http_url("http://127.0.0.1/latest")
    with pytest.raises(ValueError):
        safety.validate_public_http_url("http://169.254.169.254/latest/meta-data")
    with pytest.raises(ValueError):
        safety.validate_public_http_url("file:///etc/passwd")
    with pytest.raises(ValueError):
        safety.validate_public_http_url("http://localhost/admin")

    def fake_dns(*_args, **_kwargs):
        return [(2, 1, 6, "", ("10.1.2.3", 80))]

    monkeypatch.setattr(safety.socket, "getaddrinfo", fake_dns)
    with pytest.raises(ValueError):
        safety.validate_public_http_url("http://internal.example/secret")

    def public_dns(*_args, **_kwargs):
        return [(2, 1, 6, "", ("93.184.216.34", 443))]

    monkeypatch.setattr(safety.socket, "getaddrinfo", public_dns)
    assert safety.validate_public_http_url("https://example.com/page").startswith("https://")


def test_cli_values_reject_flags():
    assert safety.safe_cli_value("gtm factory") == "gtm factory"
    with pytest.raises(ValueError):
        safety.safe_cli_value("--help")
    with pytest.raises(ValueError):
        safety.safe_geo("FRANCE")
    assert safety.safe_geo("fr") == "FR"


def test_mcp_rejects_slug_traversal():
    import mcp_server

    resp = mcp_server.handle({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "get_keywords", "arguments": {"slug": "../etc"}},
    })
    assert resp["result"]["isError"] is True


def test_safe_join_rejects_prefix_sibling(tmp_path):
    root = tmp_path / "stacks"
    root.mkdir()
    sibling = tmp_path / "stacks-secret"
    sibling.mkdir()
    secret = sibling / "note.txt"
    secret.write_text("nope", encoding="utf-8")
    with pytest.raises(ValueError):
        safety.safe_join(str(root), "../stacks-secret/note.txt")
