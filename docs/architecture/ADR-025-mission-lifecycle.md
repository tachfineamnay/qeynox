# ADR-025 — Mission lifecycle: interruption, retry and honest progress

- **Status:** Accepted
- **Date:** 2026-11-19
- **Mission:** A06
- **Extends:** ADR-002/005 (Hatchet as the single durable executor), ADR-010 (plan execution),
  ADR-013 (claims), ADR-014 (results). Introduces no second workflow engine, no second scheduler and
  no new table.

## Context

The lifecycle `GOAL → PLAN → APPROVAL → EXECUTION → TOOL EVIDENCE → HUMAN REVIEW → RESULT` was
implemented but not closed. Four defects meant a customer mission could not be trusted end to end:

1. **`INTERRUPT_REQUESTED` was a terminal trap.** `OperationControlService.interrupt` moved an
   operation into it and *nothing anywhere moved it out*. No code path, no worker, no API. A customer
   who pressed stop saw "Stop requested" forever, and because the read model mapped that status to
   attention `NONE`, the operation also vanished from the attention list. The only escape was a manual
   `abandon` on a recovery incident, which does not exist for a clean stop.
2. **`FAILED` and `INTERRUPTED` were dead ends.** There was no retry path at all. `requestRedo` exists
   but goes through a different command and is not a retry of a failed attempt.
3. **Worker failures lost their cause.** The catch block in `apps/worker/src/runtime.ts` collapsed
   every non-`DomainError` into `ENGINE_OR_TOOL_ERROR`, so an unknown external write, a JSON parse bug
   and a provider timeout all recorded the same code. `UNKNOWN_OUTCOME` — the one code that must never
   be confused with a clean failure — was not distinguished at all.
4. **Progress could disagree with the business record.** `attention` and status labels were derived
   ad hoc inside the read model, and the web filtered the decision list on a hardcoded subset of
   attention values. Nothing tied the customer's screen to a single derivation from persisted state.

## Decision 1 — a stop is a request; confirmation needs proof

New `InterruptionService` (`packages/application/src/interruption.ts`).

`interrupt` still only records intent (`INTERRUPT_REQUESTED`). A separate `reconcile` decides whether
the stop can be *confirmed*, and it confirms only when persisted state proves nothing can still run:

| Blocker found | Reason reported |
|---|---|
| A `PENDING`/`RUNNING` step attempt | `ATTEMPT_IN_FLIGHT` |
| An outbox intent `PENDING` | `DISPATCH_PENDING` |
| An outbox intent `DISPATCHING` | `DISPATCH_IN_FLIGHT` |
| An outbox intent `UNKNOWN` | `DISPATCH_UNCONFIRMED` |
| A tool ledger row with outcome `UNKNOWN` | `TOOL_OUTCOME_UNKNOWN` |
| Cancellation not acknowledged by the executor | `CANCELLATION_UNCONFIRMED` |

If any blocker exists the operation **stays `INTERRUPT_REQUESTED`** and an `INTERRUPTION_UNRESOLVED`
event records why. Only when the list is empty does it transition to `INTERRUPTED`, and any attempt
left `RUNNING` by a lost worker is failed explicitly with `errorCode: 'INTERRUPTED'` — we know it did
not finish, so it is not left ambiguous.

Reconciliation runs inside one transaction with `SELECT … FOR UPDATE` on the operation and a status
guard in the `WHERE`, so two operators reconciling concurrently cannot both transition it.

## Decision 2 — retry reuses the attempt identity and refuses uncertainty

`InterruptionService.retry` accepts only `FAILED` or `INTERRUPTED`, and refuses when any of these hold:

- an outbox intent for the operation is `UNKNOWN` → `UNKNOWN_OUTCOME`;
- a tool ledger row has outcome `UNKNOWN` → `UNKNOWN_OUTCOME` (a remote write may already have landed).

This is the "recovery never duplicates uncertain side effects" requirement, enforced at the entry
point rather than hoped for downstream. The retry **reuses the existing failed attempt row** (flipping
it back to `PENDING`) instead of creating a new one, so evidence and claim attribution keep pointing at
the attempt that actually produced them, and a retried delivery cannot produce two attempts for the
same step.

It also exposed a real defect: the first implementation transitioned `FAILED → RUNNING` directly.
The lifecycle only allows `FAILED/INTERRUPTED → READY → RUNNING`, so retry now walks both edges. The
QA caught this as `Illegal operation transition`, not a code review.

## Decision 3 — real error propagation, and budget exhaustion is not a failure

`apps/worker/src/runtime.ts` now records the actual propagated code. Unknown external outcomes produce
a `STEP_OUTCOME_UNKNOWN` event rather than `STEP_FAILED`, and `DomainErrorCode` gained
`UNEXPECTED_EXECUTION_ERROR` so the generic bucket is a *stated* code that means "we did not expect
this", never a silent substitute for a known one.

`BUDGET_EXHAUSTED` is a policy stop. It is recorded as terminal with its own code, and the customer
sees it as requiring a decision. An earlier attempt to map it to `INTERRUPTED` was rejected by the
lifecycle (`RUNNING → INTERRUPTED` is not an edge) — the correct move was to stop inventing a status
and record the cause accurately on `FAILED`.

## Decision 4 — one derivation for customer-visible progress

New `lifecycle-view.ts`: `lifecycleView(status, pendingApprovals)` is a pure total function returning
`{ status, attention, milestones, currentMilestone, provisional }`.

- `milestones` are the seven contract milestones, and a milestone is `complete` only when the persisted
  status *proves* it. `WAITING_APPROVAL` proves evidence exists and the document is assembled; only
  `COMPLETED` proves a delivered result.
- `provisional` is true for `RUNNING` (in flight, unobserved) and for `INTERRUPT_REQUESTED` (a stop we
  have not confirmed). The UI is told not to present these as settled.
- `OperationReadModels` and the MyDash decision list both consume this, so the screen cannot drift
  from the database. Milestone and provisionality are *derived on read* rather than stored as columns,
  because a stored projection can drift and a pure function cannot.
- `INTERRUPTED` maps to attention `STALLED` and `INTERRUPT_REQUESTED` to `INTERRUPTION`, both of which
  are now included in the customer's decision list; previously they mapped to `NONE`.

The operator check in `reconcile` runs **before** any status read. Returning `NOOP` first would have
let a non-operator probe whether an operation was awaiting a stop.

## Consequences

- A mission can now be stopped, confirmed stopped, retried, failed, and retried again, with every step
  recorded.
- Two operator actions race safely: reconcile is transactional, approval decisions are
  single-winner, and concurrent retries produce one dispatch intent.
- Future work must not add a status without extending `COMPLETED_THROUGH` and `ATTENTION_BY_STATUS`;
  the compiler enforces the first (exhaustive `Record<OperationStatus, …>`) but not the semantics.

## Not verified — and not claimed

**No Hatchet server ran.** This environment has no container runtime and cannot reach `ghcr.io`, so
`hatchet-lite` cannot be started. Dispatch was exercised through a recording `OrchestratorPort` double,
which proves the *dispatch decision logic* — leasing, one intent per step, `SENT`/`UNKNOWN`
recording, refusal to replay — and proves nothing about live Hatchet scheduling, its retry semantics,
gRPC cancellation or `runs.getDetails` observation. **Live dispatch remains NOT VERIFIED.** Hermes was a
deterministic local HTTP fixture, not a model: no business result is claimed anywhere.

The store authorises on workspace, not membership; membership is established by the HTTP auth guard.
The QA states this boundary explicitly rather than asserting a guarantee the store does not make.
