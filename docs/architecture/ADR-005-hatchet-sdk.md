# ADR-005: Pinned Hatchet TypeScript SDK

Selected SDK: @hatchet-dev/typescript-sdk 1.46.1 (November 2026). Target Node.js 22+.

Installed-package contract verified from its TypeScript declarations: `HatchetClient.init()`, `client.task()`, `task.runNoWait()` returning a `WorkflowRunRef`, `WorkflowRunRef.getWorkflowRunId(): Promise<string>`, `WorkflowRunRef.cancel()`, `client.runs.cancel({ids})`, `client.runs.getDetails(runId)`, `client.worker()` and `worker.start()`. The adapter uses `getWorkflowRunId()` and fails closed (UNSUPPORTED) if a run identity is not exposed; cancellation is reported only as a REQUEST, never as confirmed cancellation. Run observation maps recorded statuses only. A live Hatchet server was never launched in this environment, so dispatch, run-ID receipt, cancellation and observation remain NOT VERIFIED at runtime.

Our worker executes a bounded business step. The outbox stores committed work intent and claims events for dispatch; an ambiguous network failure leaves UNKNOWN, not an automatic duplicate trigger. Hatchet is the durable scheduler: no QeyNox-defined second workflow engine.

Contract-level verification was performed in isolated QA against the installed SDK; no production dispatch is enabled and no engine was deployed.
