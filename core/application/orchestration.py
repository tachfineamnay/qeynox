"""Lancement d'un JobRun. Le runtime est derrière OrchestrationPort."""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from uuid import UUID

from core.application.service import CoreService
from core.domain.model import JobRun
from core.ports.orchestration import LaunchRequest, OrchestrationPort, RuntimeState


class JobOrchestrator:
    def __init__(self, service: CoreService, runtime: OrchestrationPort, commit: Callable[[], None]) -> None:
        self._service = service
        self._runtime = runtime
        self._commit = commit

    def launch(
        self,
        *,
        organization_id: UUID,
        project_id: UUID,
        job_spec_id: UUID,
        body: dict,
        sources: list | tuple,
        confidence: str,
        created_at: datetime | None = None,
        timeout_seconds: float = 30,
        delay_seconds: float = 0,
        transient_failures: int = 0,
    ) -> tuple[JobRun, RuntimeState]:
        run = self._service.record_job_run(
            organization_id=organization_id,
            project_id=project_id,
            job_spec_id=job_spec_id,
            created_at=created_at,
        )
        self._commit()
        state = self._runtime.launch(
            LaunchRequest(
                organization_id=organization_id,
                project_id=project_id,
                job_run_id=run.id,
                body=body,
                sources=tuple(sources),
                confidence=confidence,
                timeout_seconds=timeout_seconds,
                delay_seconds=delay_seconds,
                transient_failures=transient_failures,
            )
        )
        return run, state

    def runtime(self, organization_id: UUID, project_id: UUID, job_run_id: UUID) -> RuntimeState | None:
        return self._runtime.runtime(organization_id, project_id, job_run_id)
