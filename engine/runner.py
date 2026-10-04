"""Point d'entrée unique des outils et sous-processus V1.

Les appelants nomment un outil et passent des paramètres. Ce module construit
l'argv, impose un timeout, journalise l'appel et renvoie un résultat normalisé.
C'est le seam du futur routeur de providers (ADR-001 / ADR-004) : pas de
FastAPI, pas de registry externe.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import asdict, dataclass

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(ENGINE_DIR, ".."))
TOOLS_DIR = os.path.join(ROOT, "tools")
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from engine.paths import logs_dir  # noqa: E402
from engine.safety import safe_cli_value, safe_geo  # noqa: E402

TIMEOUTS = {
    "keyword_research": 420,
    "social_pulse": 180,
    "competitor_watch": 300,
    "serp_rank": 420,
    "trends_check": 120,
    "git_clone": 300,
    "git_rev_parse": 10,
}

MISSION_TOOLS = {
    "keywords": "keyword_research",
    "social": "social_pulse",
    "competitors": "competitor_watch",
    "serp": "serp_rank",
    "trends": "trends_check",
}


@dataclass
class ToolResult:
    name: str
    ok: bool
    returncode: int | None
    stdout: str
    stderr: str
    timed_out: bool
    duration_s: float
    log_path: str | None = None
    pid: int | None = None


def _bounded_int(value, default: int, lo: int, hi: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = default
    return max(lo, min(hi, n))


def _cli_list(values, field: str, limit: int) -> list[str]:
    out = []
    for raw in (values or [])[:limit]:
        if isinstance(raw, str) and raw.strip():
            out.append(safe_cli_value(raw, field=field))
    return out


def normalize_mission(mtype: str, params: dict | None) -> tuple[str, dict]:
    """Valide une mission UI et retourne (outil, paramètres du runner)."""
    params = params or {}
    name = MISSION_TOOLS.get(mtype)
    if not name:
        raise ValueError(mtype)
    if name == "keyword_research":
        return name, {
            "seeds": _cli_list(params.get("seeds", []), "graine", 10),
            "rounds": _bounded_int(params.get("rounds", 1), 1, 1, 4),
            "breadth": _bounded_int(params.get("breadth", 6), 6, 1, 12),
        }
    if name == "social_pulse":
        return name, {"queries": _cli_list(params.get("queries", []), "requête", 8)}
    if name == "competitor_watch":
        return name, {"scan": True}
    if name == "serp_rank":
        return name, {
            "from_store": True,
            "limit": _bounded_int(params.get("limit", 20), 20, 1, 100),
        }
    return name, {
        "kws": _cli_list(params.get("kws", []), "mot-clé", 5),
        "geo": safe_geo(str(params.get("geo") or "FR")),
    }


def _script(filename: str) -> str:
    return os.path.join(TOOLS_DIR, filename)


def _argv(name: str, params: dict) -> list[str]:
    if name == "keyword_research":
        args: list[str] = []
        for seed in params.get("seeds") or []:
            args += ["--seed", str(seed)]
        if params.get("rounds") is not None:
            args += ["--rounds", str(params["rounds"])]
        if params.get("breadth") is not None:
            args += ["--breadth", str(params["breadth"])]
        if params.get("min_score") is not None:
            args += ["--min-score", str(params["min_score"])]
        if params.get("out"):
            args += ["--out", str(params["out"])]
        return [sys.executable, _script("keyword_research.py"), *args]
    if name == "social_pulse":
        args = []
        for query in params.get("queries") or []:
            args += ["--q", str(query)]
        return [sys.executable, _script("social_pulse.py"), *args]
    if name == "competitor_watch":
        return [sys.executable, _script("competitor_watch.py"), "--scan"]
    if name == "serp_rank":
        args = [sys.executable, _script("serp_rank.py")]
        if params.get("from_store"):
            args += ["--from-store", "--limit", str(int(params.get("limit", 20)))]
        else:
            for kw in params.get("kws") or []:
                args += ["--kw", str(kw)]
        if params.get("domain"):
            args += ["--domain", str(params["domain"])]
        return args
    if name == "trends_check":
        args = [sys.executable, _script("trends_check.py")]
        for kw in params.get("kws") or []:
            args += ["--kw", str(kw)]
        geo = params.get("geo")
        if geo:
            args += ["--geo", str(geo)]
        return args
    if name == "git_clone":
        return ["git", "clone", "--depth", "1", "--", str(params["url"]), str(params["dest"])]
    if name == "git_rev_parse":
        return ["git", "-C", str(params["repo"]), "rev-parse", "HEAD"]
    raise ValueError(f"outil inconnu: {name}")


def _logs_dir() -> str:
    return logs_dir()


def _journal(result: ToolResult, argv: list[str], cwd: str | None) -> None:
    try:
        folder = _logs_dir()
        os.makedirs(folder, exist_ok=True)
        line = {
            "name": result.name,
            "ok": result.ok,
            "returncode": result.returncode,
            "timed_out": result.timed_out,
            "duration_s": result.duration_s,
            "pid": result.pid,
            "cwd": cwd,
            "argv": argv,
        }
        with open(os.path.join(folder, "tool-runs.jsonl"), "a", encoding="utf-8") as handle:
            handle.write(json.dumps(line, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _decode(data) -> str:
    if data is None:
        return ""
    if isinstance(data, bytes):
        return data.decode("utf-8", "replace")
    return str(data)


def run_tool(
    name: str,
    params: dict | None = None,
    *,
    cwd: str | None = None,
    env: dict | None = None,
    timeout: float | None = None,
    background: bool = False,
    log_path: str | None = None,
    on_start=None,
) -> ToolResult:
    """Exécute un outil. `background=True` ne attend pas la fin (MCP)."""
    params = dict(params or {})
    argv = _argv(name, params)
    limit = TIMEOUTS.get(name, 300) if timeout is None else timeout
    run_env = dict(os.environ if env is None else env)
    if name == "git_clone":
        run_env.setdefault("GIT_TERMINAL_PROMPT", "0")
    started = time.monotonic()
    log_handle = None
    try:
        if log_path:
            folder = os.path.dirname(os.path.abspath(log_path))
            if folder:
                os.makedirs(folder, exist_ok=True)
            log_handle = open(log_path, "w", encoding="utf-8")
        if not background and log_handle is None:
            try:
                proc = subprocess.run(
                    argv, cwd=cwd, env=run_env, capture_output=True, text=True, timeout=limit,
                )
                result = ToolResult(
                    name=name, ok=proc.returncode == 0, returncode=proc.returncode,
                    stdout=proc.stdout or "", stderr=proc.stderr or "", timed_out=False,
                    duration_s=round(time.monotonic() - started, 3), log_path=None,
                )
            except subprocess.TimeoutExpired as exc:
                result = ToolResult(
                    name=name, ok=False, returncode=None,
                    stdout=_decode(exc.stdout), stderr=_decode(exc.stderr), timed_out=True,
                    duration_s=round(time.monotonic() - started, 3), log_path=None,
                )
            _journal(result, argv, cwd)
            return result
        if background:
            proc = subprocess.Popen(
                argv, cwd=cwd, env=run_env,
                stdout=log_handle or subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
            )
            if log_handle:
                log_handle.close()
                log_handle = None
            result = ToolResult(
                name=name, ok=True, returncode=None, stdout="", stderr="",
                timed_out=False, duration_s=round(time.monotonic() - started, 3),
                log_path=log_path, pid=proc.pid,
            )
            _journal(result, argv, cwd)
            return result

        stdout_target = log_handle if log_handle else subprocess.PIPE
        stderr_target = subprocess.STDOUT if log_handle else subprocess.PIPE
        proc = subprocess.Popen(
            argv, cwd=cwd, env=run_env,
            stdout=stdout_target, stderr=stderr_target, text=True,
        )
        if on_start:
            on_start(proc.pid)
        try:
            out, err = proc.communicate(timeout=limit)
            result = ToolResult(
                name=name, ok=proc.returncode == 0, returncode=proc.returncode,
                stdout=_decode(out), stderr=_decode(err), timed_out=False,
                duration_s=round(time.monotonic() - started, 3),
                log_path=log_path, pid=proc.pid,
            )
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate()
            result = ToolResult(
                name=name, ok=False, returncode=None,
                stdout=_decode(out), stderr=_decode(err), timed_out=True,
                duration_s=round(time.monotonic() - started, 3),
                log_path=log_path, pid=proc.pid,
            )
    except Exception as exc:
        result = ToolResult(
            name=name, ok=False, returncode=None, stdout="", stderr=str(exc),
            timed_out=False, duration_s=round(time.monotonic() - started, 3),
            log_path=log_path,
        )
    finally:
        if log_handle:
            log_handle.close()
    _journal(result, argv, cwd)
    return result


def result_dict(result: ToolResult) -> dict:
    return asdict(result)
