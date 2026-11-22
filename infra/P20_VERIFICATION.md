# P20 — existing Control beta operations

Date: 2026-11-22. Base: `bebd2f09e6cd16d462620877f58b02e5a89e5b84`.
Branch: `arena/d3c425dd-qeynox`.

## Delivered source

This extends QeyNox Control (`/admin/{en,fr}`), its existing platform session/permission/audit model,
and its current users, workspaces, beta grants, missions, health and releases. No second console.
Professional Blue tokens, cards, notices, tables and existing navigation are reused.

| Operator task | Existing/extended location | Authority / truth boundary |
| --- | --- | --- |
| Find testers and their workspaces | Users, Organizations, Beta access; new Beta → Registration invitations | Existing ADMINISTRATION/SUPPORT reads. Redeemed invitations link to user, workspace and grant. |
| Issue/revoke registration invitations | `/beta/invitations` | Existing ADMINISTRATION-only invitation APIs; justification + confirmation. Token/path shown once, manually delivered; no automatic email or stored recoverable token. |
| Quotas and grant spending | Existing `/beta` and `/beta/{id}` | Existing canonical quota, active/reserved usage, expiry, currency and grant events; not a new billing model. |
| Mission state and failure codes | Existing `/operations/{id}` | OPERATIONS; mission/attempt/dispatch machine codes, event metadata, incident history. No raw private event data or arbitrary error text. |
| Pending/failed outbox, ingestion, deletion and email | `/operations/queues` | OPERATIONS; queue/workspace/mission/state filters, 25-row pages (API max 100), offset max 10,000, hasMore. Only IDs, state, attempts, allowlisted error codes, timestamps and uncertainty. |
| Provider spending | `/operations/spending?workspaceId=…` | OPERATIONS; optional mission filter. Ledger groups by provider/currency/accounting origin; RESERVED/UNKNOWN holds separate. Missing costs/tokens remain null, never zero. Maximum 200 groups per section with explicit partial-view warning. |
| Hermes/Hatchet | Existing `/operations/health` | Reads existing API probe monitor snapshot, including evidence timestamps/expiry and missing prerequisites. No extra runtime probe, endpoint, credential, identity or evidence-body disclosure. API observation is not Worker certification. |
| Provider/private storage diagnostics | Existing `/operations/health` | Reuses existing OPERATIONS APIs. Provider status is configuration-only. Existing storage endpoint may make its bounded read/list probe when an operator opens the page; no upload/delete/signing action added. |
| Release and migration compatibility | Existing `/operations/releases` | Existing deployment metadata plus read-only source-file checksum/history comparison: CURRENT/BLOCKED, pending, mismatches, unknown applied and out-of-order. Missing source/DB ledger yields an unavailable notice, not healthy. No migration applied. |

Read APIs are authenticated, no-store; queue/spend/migration SQL uses a read-only repeatable-read
transaction and a 5-second statement timeout. Queue SQL uses a fixed table/projection map and bound
filter parameters. Provider accounting is all-history within the selected workspace/mission, not an
invoice or live balance. Different currencies and provider-reported/estimated/unknown origins are
never combined. Accounting groups are not a certification of provider invoices.

## Restricted recovery

`POST /v1/platform/operations/recovery` is strict-schema, OPERATIONS-only at route **and** service,
requires explicit confirmation and a 10–500-character reason. Successful state change and platform
audit insert share the same DB transaction. Rejections/errors are audited without request payloads;
permission denials use the existing platform denial trail. Lock wait is bounded to 2 seconds.

* `ESCALATE_INCIDENT`: only an OPEN incident in the specified workspace. Reuses extracted existing
  recovery classification logic; row lock, status update, recovery action and platform audit are
  atomic. This does **not** resolve an incident, retry an execution or contact an external runtime.
* `EXPEDITE_OUTBOX`: only a future-scheduled PENDING EXECUTE_STEP job with zero prior attempts,
  matching payload/idempotency/scope and a PENDING attempt on the current RUNNING mission revision.
  Locks the dispatch row and mission, moves only `nextAttemptAt` to now and leaves claiming/execution
  to the canonical dispatcher/Worker. Competing/stale commands fail closed. No new job, attempt,
  idempotency key or reservation is created; no cost/beta/runtime guard is bypassed.

No UNKNOWN/DISPATCHING/FAILED outbox reset, blind replay, lease clearing, terminal ingestion/deletion
reset, email resend, token-email retry, force-success, mission cancel, deploy or shell command exists.
Expired leases and uncertain outcomes remain worker/reconciliation concerns. A failed or uncertain
job being visible is not authorization to retry it. UI mutation network failures remain
UNKNOWN_OUTCOME, explicitly forbid blind resubmission and require inspection of current state/audit.

Operational responses omit email recipients/subjects/templates, lease owner/token, outbox payloads,
storage/object keys, document names/content/chunks/embeddings and raw runtime evidence. Machine error
codes use an explicit allowlist, not a regex that could pass arbitrary secret-looking text. Mission
history only includes an allowlisted errorCode from event data. Free-form incident/action reasons
remain out of the operations projection (platform action justification remains in restricted audit).
SUPPORT alone cannot read operational queues/spending/runtime or execute recovery. Existing customer
workspace membership is not fabricated to grant platform access.

## Minimal verification actually performed

Per requested compilation-only scope (not the broader default AGENTS QA campaign):

* `pnpm install --frozen-lockfile` — **PASS**, lockfile unchanged (pnpm 9.15.9 via Corepack).
* `pnpm typecheck` — **PASS**, six tasks plus release tooling; no suppressed errors or weakened tests.
* `pnpm --filter @qeynox/api build` — **PASS** after final source changes.
* `pnpm --filter @qeynox/control build` — **PASS** after final source changes; production route output
  includes invitations, queues and spending as dynamic server-rendered routes.
* `git diff --check` — **PASS**.

No browser/QA/test campaign, database query/mutation, external probe/provider call, live invitation,
email, S3 object operation, real mission, runtime recovery or migration was executed for verification.
Build/typecheck are **not** proof of SQL/runtime behavior, authorization/concurrency under a real DB,
one-time delivery UX, external recovery safety in deployment or real-user beta acceptance. Those
remain P22/deployment certification gates. In particular, validate SQL projections against a disposable
migrated DB, negative permission cases, audit rollback/competing recovery, no private-payload leakage,
invitation redemption/revocation and external-outcome reconciliation before operational reliance.

No deployment, restart, merge, payments activation, credential/policy edit, DB/S3 modification or
financial-history rewrite. BETA_FREE / INVITE_ONLY and existing private resource boundaries remain.
