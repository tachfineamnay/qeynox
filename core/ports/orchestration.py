"""Port d'orchestration. Aucun SDK de runtime."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID


@dataclass(frozen=True)
class LaunchRequest:
    organization_id: UUID
    project_id: UUID
    job_run_id: UUID
    body: dict
    sources: tuple
    confidence: str
    timeout_seconds: float = 30
    delay_seconds: float = 0
    transient_failures: int = 0


@dataclass(frozen=True)
class RuntimeState:
    job_run_id: UUID
    engine: str
    engine_run_id: str
    status: str
    attempt: int
    error: str | None


class OrchestrationPort(Protocol):
    def launch(self, request: LaunchRequest) -> RuntimeState: ...

    def runtime(self, organization_id: UUID, project_id: UUID, job_run_id: UUID) -> RuntimeState | None: ...

    def start_worker(self) -> None: ...

    def stop_worker(self) -> None: ...
