# ADR-005: Pinned Hatchet TypeScript SDK

Selected SDK: @hatchet-dev/typescript-sdk 1.46.1 (November 2026). Target Node.js 22+.

Confirmed documented primitives: HatchetClient.init(), client.task(), task.runNoWait(), client.worker(), worker.start(), ctx.workflowRunId(). The run-reference ID shape, cancellation and deployment infrastructure are not asserted without an SDK runtime/typing verification. The adapter fails closed if a run identity is not exposed.

Our worker executes a bounded business step. The outbox stores committed work intent and claims events for dispatch; an ambiguous network failure leaves UNKNOWN, not an automatic duplicate trigger. Hatchet is the durable scheduler: no QeyNox-defined second workflow engine.

This version is SOURCE ONLY. No worker or engine was started. API/SDK integration remains UNTESTED.
