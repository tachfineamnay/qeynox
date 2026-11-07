"""Adaptateur Hatchet. Seul paquet autorisé à importer hatchet_sdk."""
from __future__ import annotations

import base64
import json
import sys
import threading
import time
import uuid
from datetime import timedelta
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from core.application.service import CoreService
from core.ports.orchestration import LaunchRequest, RuntimeState
from core.postgres.repository import PostgresCoreRepository

try:
    from hatchet_sdk import Hatchet
    from hatchet_sdk.config import ClientConfig, EmbeddedHatchetConfig
    from hatchet_sdk.exceptions import NonRetryableException
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("hatchet-sdk est requis pour l'adaptateur d'orchestration") from exc


class JobRunTaskInput(BaseModel):
    organization_id: str
    project_id: str
    job_run_id: str
    body: dict
    sources: list[dict]
    confidence: str
    timeout_seconds: float = 30
    delay_seconds: float = 0
    transient_failures: int = 0


class HatchetAdapter:
    def __init__(
        self,
        dsn: str,
        *,
        data_dir: str,
        grpc_port: int,
        api_port: int,
        execution_timeout_seconds: float = 30,
        retries: int = 2,
    ) -> None:
        self._dsn = dsn
        self._retries = retries
        self._stop = threading.Event()
        self._embedded = sys.platform != "win32"
        if self._embedded:
            self._hatchet = Hatchet.from_embedded(
                ClientConfig(
                    embedded=EmbeddedHatchetConfig(
                        postgres_data_dir=data_dir,
                        grpc_port=grpc_port,
                        api_port=api_port,
                        ready_timeout_seconds=180,
                    )
                )
            )
        else:
            # Le binaire embarqué Hatchet n'existe pas sous Windows.
            # Le client SDK reste réel ; le worker exécute la tâche via mock_run.
            self._hatchet = Hatchet(config=ClientConfig(token=_offline_token()))
        self._workflow = self._hatchet.workflow(name="qeynox-job-run")

        def execute(task_input: JobRunTaskInput, ctx) -> dict:
            return self._execute(task_input, ctx)

        def on_failure(task_input: JobRunTaskInput, ctx) -> dict:
            return self._on_failure(task_input, ctx)

        self._task = self._workflow.task(
            name="execute",
            retries=retries,
            execution_timeout=timedelta(seconds=execution_timeout_seconds),
            backoff_factor=1.0,
            backoff_max_seconds=1,
        )(execute)
        self._workflow.on_failure_task(name="on-failure", retries=0)(on_failure)
        self._worker = None
        self._thread: threading.Thread | None = None

    def launch(self, request: LaunchRequest) -> RuntimeState:
        task_input = self._task_input(request)
        if self._embedded:
            ref = self._task.run(task_input, wait_for_result=False)
            engine_run_id = str(ref.workflow_run_id)
        else:
            engine_run_id = str(uuid.uuid4())
        self._insert_queued(request, engine_run_id, task_input)
        state = self.runtime(request.organization_id, request.project_id, request.job_run_id)
        if state is None:
            raise RuntimeError("état runtime absent après le déclenchement")
        return state

    def runtime(self, organization_id: UUID, project_id: UUID, job_run_id: UUID) -> RuntimeState | None:
        with psycopg.connect(self._dsn, row_factory=dict_row) as conn:
            row = conn.execute(
                """
                SELECT job_run_id, engine, engine_run_id, status, attempt, error
                FROM job_run_runtime
                WHERE organization_id = %s AND project_id = %s AND job_run_id = %s
                """,
                (organization_id, project_id, job_run_id),
            ).fetchone()
        if row is None:
            return None
        return RuntimeState(
            job_run_id=row["job_run_id"],
            engine=row["engine"],
            engine_run_id=row["engine_run_id"],
            status=row["status"],
            attempt=row["attempt"],
            error=row["error"],
        )

    def start_worker(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop = threading.Event()
        if self._embedded:
            self._worker = self._hatchet.worker("qeynox-job-run", workflows=[self._workflow])
            self._thread = threading.Thread(target=self._worker.start, name="qeynox-hatchet-worker", daemon=True)
        else:
            self._recover_interrupted()
            self._thread = threading.Thread(target=self._local_loop, name="qeynox-hatchet-worker", daemon=True)
        self._thread.start()

    def stop_worker(self) -> None:
        worker = self._worker
        thread = self._thread
        self._stop.set()
        self._worker = None
        self._thread = None
        if worker is not None:
            worker.exit_gracefully()
        if thread is not None:
            thread.join(timeout=15)

    def close(self) -> None:
        self.stop_worker()
        if self._embedded:
            self._hatchet.stop_embedded()

    def _execute(self, task_input: JobRunTaskInput, ctx) -> dict:
        attempt = int(ctx.retry_count) + 1
        engine_run_id = str(ctx.workflow_run_id)
        self._upsert(task_input, engine_run_id, "running", attempt, None)
        with self._service() as (conn, service):
            service.mark_job_run(
                organization_id=UUID(task_input.organization_id),
                project_id=UUID(task_input.project_id),
                job_run_id=UUID(task_input.job_run_id),
                status="running",
            )
            conn.commit()
        if int(ctx.retry_count) < task_input.transient_failures:
            raise RuntimeError("échec transitoire")
        deadline = time.monotonic() + task_input.timeout_seconds
        remaining = task_input.delay_seconds
        while remaining > 0:
            if time.monotonic() >= deadline:
                self._fail(task_input, engine_run_id, attempt, "timeout", timed_out=True)
                raise NonRetryableException("timeout")
            step = min(0.05, remaining)
            time.sleep(step)
            remaining -= step
        with self._service() as (conn, service):
            version = service.complete_job_run(
                organization_id=UUID(task_input.organization_id),
                project_id=UUID(task_input.project_id),
                job_run_id=UUID(task_input.job_run_id),
                body=task_input.body,
                sources=[(item["url"], item["note"]) for item in task_input.sources],
                confidence=task_input.confidence,
            )
            conn.commit()
            version_id = str(version.id)
        self._upsert(task_input, engine_run_id, "ok", attempt, None)
        return {"artifact_version_id": version_id}

    def _on_failure(self, task_input: JobRunTaskInput, ctx) -> dict:
        message = ""
        try:
            message = str(ctx.get_task_run_error() or "")
        except Exception:
            message = ""
        timed_out = "timeout" in message.lower()
        self._fail(
            task_input,
            str(ctx.workflow_run_id),
            int(ctx.retry_count) + 1,
            "timeout" if timed_out else (message or "failed"),
            timed_out=timed_out,
        )
        return {"status": "timed_out" if timed_out else "failed"}

    def _fail(self, task_input: JobRunTaskInput, engine_run_id: str, attempt: int, error: str, *, timed_out: bool) -> None:
        with self._service() as (conn, service):
            service.mark_job_run(
                organization_id=UUID(task_input.organization_id),
                project_id=UUID(task_input.project_id),
                job_run_id=UUID(task_input.job_run_id),
                status="failed",
                error=error,
            )
            conn.commit()
        status = "timed_out" if timed_out else "failed"
        self._upsert(task_input, engine_run_id, status, attempt, error)

    def _service(self):
        conn = psycopg.connect(self._dsn, row_factory=dict_row)
        return _Service(conn, CoreService(PostgresCoreRepository(conn)))

    def _insert_queued(self, request: LaunchRequest, engine_run_id: str, task_input: JobRunTaskInput) -> None:
        with psycopg.connect(self._dsn) as conn:
            conn.execute(
                """
                INSERT INTO job_run_runtime (
                    job_run_id, organization_id, project_id, engine, engine_run_id,
                    status, attempt, error, payload, updated_at
                ) VALUES (%s, %s, %s, 'hatchet', %s, 'queued', 0, NULL, %s, now())
                ON CONFLICT (job_run_id) DO NOTHING
                """,
                (
                    request.job_run_id,
                    request.organization_id,
                    request.project_id,
                    engine_run_id,
                    Jsonb(task_input.model_dump()),
                ),
            )
            conn.commit()

    def _task_input(self, request: LaunchRequest) -> JobRunTaskInput:
        return JobRunTaskInput(
            organization_id=str(request.organization_id),
            project_id=str(request.project_id),
            job_run_id=str(request.job_run_id),
            body=request.body,
            sources=[{"url": url, "note": note} for url, note in request.sources],
            confidence=request.confidence,
            timeout_seconds=request.timeout_seconds,
            delay_seconds=request.delay_seconds,
            transient_failures=request.transient_failures,
        )

    def _recover_interrupted(self) -> None:
        with psycopg.connect(self._dsn) as conn:
            conn.execute(
                """
                UPDATE job_run_runtime AS runtime
                SET status = 'queued', updated_at = now()
                WHERE runtime.status = 'running'
                  AND NOT EXISTS (
                    SELECT 1 FROM artifact_versions AS version
                    WHERE version.job_run_id = runtime.job_run_id
                  )
                """
            )
            conn.commit()

    def _local_loop(self) -> None:
        while not self._stop.is_set():
            try:
                row = self._claim()
            except Exception:
                self._stop.wait(0.05)
                continue
            if row is None:
                self._stop.wait(0.05)
                continue
            self._drive(row)

    def _claim(self):
        with psycopg.connect(self._dsn, row_factory=dict_row) as conn:
            row = conn.execute(
                """
                UPDATE job_run_runtime
                SET status = 'running', updated_at = now()
                WHERE job_run_id = (
                    SELECT job_run_id FROM job_run_runtime
                    WHERE status = 'queued'
                    ORDER BY updated_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING job_run_id, engine_run_id, payload
                """
            ).fetchone()
            conn.commit()
            return row

    def _drive(self, row) -> None:
        payload = row["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        task_input = JobRunTaskInput.model_validate(payload)
        attempt = 0
        while not self._stop.is_set():
            try:
                self._task.mock_run(task_input, retry_count=attempt)
                return
            except NonRetryableException:
                return
            except Exception:
                attempt += 1
                if attempt > self._retries:
                    self._fail(task_input, str(row["engine_run_id"]), attempt, "failed", timed_out=False)
                    return
                self._stop.wait(0.2)

    def _upsert(self, task_input: JobRunTaskInput, engine_run_id: str, status: str, attempt: int, error: str | None) -> None:
        with psycopg.connect(self._dsn) as conn:
            conn.execute(
                """
                INSERT INTO job_run_runtime (
                    job_run_id, organization_id, project_id, engine, engine_run_id,
                    status, attempt, error, payload, updated_at
                ) VALUES (%s, %s, %s, 'hatchet', %s, %s, %s, %s, %s, now())
                ON CONFLICT (job_run_id) DO UPDATE SET
                    engine_run_id = EXCLUDED.engine_run_id,
                    status = EXCLUDED.status,
                    attempt = EXCLUDED.attempt,
                    error = EXCLUDED.error,
                    updated_at = now()
                WHERE job_run_runtime.status <> 'ok'
                  AND NOT (job_run_runtime.status = 'timed_out' AND EXCLUDED.status = 'failed')
                """,
                (
                    task_input.job_run_id,
                    task_input.organization_id,
                    task_input.project_id,
                    engine_run_id,
                    status,
                    attempt,
                    error,
                    Jsonb(task_input.model_dump()),
                ),
            )
            conn.commit()


class _Service:
    def __init__(self, connection, service: CoreService) -> None:
        self.connection = connection
        self.service = service

    def __enter__(self):
        return self.connection, self.service

    def __exit__(self, exc_type, exc, tb) -> None:
        self.connection.close()


def _offline_token() -> str:
    def part(value: dict) -> str:
        raw = base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=")
        return raw.decode()

    header = part({"alg": "HS256", "typ": "JWT"})
    claims = part(
        {
            "sub": "qeynox",
            "server_url": "http://127.0.0.1:8888",
            "grpc_broadcast_address": "127.0.0.1:7077",
        }
    )
    return f"{header}.{claims}.local"

