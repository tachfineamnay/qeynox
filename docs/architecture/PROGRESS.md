# QeyNox 2027 — Backend source wave 10–20

## 2026-11-21 — MISSION P13: notification event loss fixed (PR, branch `arena/1a108289-qeynox`, off `e48ab02`)

**Defect.** `materialize()` re-scanned only the newest 25 events with no progress record, so bursts and
worker outages lost older events.

**Fix.**
- **Migration `0031` (additive):**
  - `notification_event_receipts`: one row per processed event (MATERIALIZED or SKIPPED, with a reason
    and counts);
  - `notification_checkpoints`: a scan watermark;
  - a partial scan index on `operation_events`.
- **Processing.** Events without a receipt are processed oldest first, in up to 4 batches per drain;
  the remainder continues on the next drain. Each event is one transaction: the receipt is claimed
  first, so concurrent workers serialize, then the inbox rows and PENDING email jobs are written.
  Failure rolls the whole event back for a retry and does not block the others.
- **Watermark.** It never passes an unprocessed event and stays at least 24 h behind now, so
  late-committing events are still found. Receipts carry correctness.
- **Unchanged.** Deduplication keys (`evt:<event>:<user>`) and preferences behave as before.
- **Isolation.** An event is skipped when its workspace does not own the operation. The creator is
  notified only while an ACTIVE member of that workspace.
- **Email age.** Events older than 7 days on first materialization (the post-deploy backfill) get inbox
  rows only, no email.

**Verified.**
- `pnpm typecheck` passes (4/4).
- The existing `qa:notifications` suite passes 98/98 on a disposable local PostgreSQL.
- A throwaway check (not committed) covered:
  - a 130-event burst under concurrent drains, with no duplicates and no losses;
  - resume after downtime;
  - a forged cross-workspace event being skipped;
  - stale events getting inbox rows only;
  - the watermark lag;
  - a late-committed event being processed.

**Not verified.** Production: migration 0031 is not applied there.

## 2026-11-21 — MISSION P12: safe document deletion (PR, branch `arena/c199d114-qeynox`, off `3d6732f`)

**Defect.** `DocumentVaultService.delete` and `purgeExpired` swallowed S3 `deleteObject` errors and
deleted the PostgreSQL row anyway. A failed or ambiguous storage delete left an orphaned private object
with no record of it.

**Fix (same mechanism for user deletion and retention expiry).**
- **Migration `0030_document_storage_deletions.sql` (additive).** A durable intent with no foreign keys,
  so it outlives the document row and the workspace. It stores the storage key, SHA-256, size, content
  type, the document state at deletion, the reason (`USER_DELETE` / `RETENTION_EXPIRED`), the requester,
  the state (`PENDING` / `DELETED` / `FAILED`), attempts, a classified last error, the backoff
  (`not_before`) and a lease. The document name and content are not retained.
- **Immediate revocation.** One transaction locks the live document in the caller's workspace, inserts
  the intent and deletes the row. FK cascades remove chunks, mission attachments and ingest jobs, so the
  document can no longer be listed, searched, downloaded, attached or retrieved into an agent context
  (P10 queries live rows only). An in-flight P11 ingestion aborts at finalize.
- **Storage deletion.** `deleteObject` followed by `head`. DELETED is recorded only when `head` reports the
  object absent. Otherwise the intent stays PENDING with a code:
  - `DELETE_FAILED:<SdkErrorName>`;
  - `VERIFY_FAILED:<name>`, which is ambiguous and never assumed deleted;
  - `STILL_PRESENT`.
- **Retries.** `drainStorageDeletions` runs in the worker loop next to `purgeExpired`.
  - Claims use SKIP LOCKED with a fencing lease token (2 min).
  - Backoff is exponential, from 1 minute up to 6 hours.
  - After 12 attempts the intent is FAILED, which needs operator attention; the worker logs it.
  - PENDING_UPLOAD documents wait 11 minutes, until any presigned PUT has expired.
- **Truthful outcomes.** `delete` returns `{ storage: 'DELETED' | 'PENDING' }`. `DELETE /v1/documents/:id`
  keeps `{ ok: true }` and adds `storage`. Audit events: `DELETE` / `EXPIRED_PURGE` "access_revoked", then
  `STORAGE_DELETE` SUCCESS "verified_absent" or FAILED "will_retry:…" / "attempts_exhausted:…". The
  tenant-scoped `storageDeletionStatus()` reads the intent.
- **Retention.** `purgeExpired` now covers expired documents in any state, not only AVAILABLE, using the
  same revoke-and-queue path.
- **Behaviour change.** Deleting no longer requires object storage to be configured: access is revoked
  and the intent waits as PENDING.

**Verified.**
- `pnpm typecheck` passes (4/4).
- The existing `qa:documents` suite passes 77/77 on a disposable local PostgreSQL 14.
- A throwaway check (not committed) covered:
  - tenant isolation;
  - a verified happy path;
  - access revoked despite storage failure;
  - no agent passages after deletion;
  - backoff;
  - an ambiguous verify not counted as deleted;
  - a retry succeeding;
  - an object still present not counted as success;
  - FAILED after exhausted attempts;
  - retention going through the same path;
  - the presigned-upload grace period;
  - no name, content or error message retained.

**Not verified / limits.**
- Real S3 behaviour is not verified.
- Migration 0030 is not applied in production.
- No full QA or browser run (deferred by the mission).
- Download URLs already issued (180 s) remain usable until the object is actually deleted.
- The web UI does not yet display `storage`.

## 2026-11-21 — MISSION P11: stuck document ingest jobs fixed (PR, branch `arena/236acc84-qeynox`, off `3b18d58`)

**Defect.** A `document_ingest_jobs` row claimed as PROCESSING stayed there forever if the worker
crashed before completion, leaving the document PROCESSING. Chunks were also written row by row
before the document flipped to AVAILABLE, outside any transaction.

**Fix (existing lifecycle, no new engine).**
- **Migration `0029_document_ingest_leases.sql` (additive):** `lease_owner`, `lease_token` and
  `lease_expires_at`, plus a partial index on PROCESSING leases.
- **Claim.** One `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` takes PENDING jobs and
  abandoned ones. A job is abandoned when its PROCESSING lease has expired, or when a legacy lease-less
  row is older than one lease. Each claim sets a fresh fencing token and counts as an attempt.
- **Single owner.** Lease renewal, finalize and failure writes are all conditioned on
  `state = PROCESSING AND lease_token = <claim token>`. A worker that lost its lease writes nothing.
- **Lease expiry.** `QEYNOX_DOCUMENT_INGEST_LEASE_MS` (default 5 min, clamped 30 s – 30 min). The lease is
  renewed after the read, after extraction and after each embeddings batch.
- **Bounded retries.** A failure with attempts left returns the job to PENDING. The 3rd failed attempt
  is terminal: job FAILED and document FAILED, with leftover chunks removed. An abandoned job with
  attempts exhausted becomes FAILED `LEASE_EXPIRED` instead of being re-claimed forever. A vanished or
  non-PROCESSING document is terminal at once. A legacy job whose document already reached AVAILABLE is
  closed as DONE.
- **Atomic, idempotent finalize.** Chunks, and any embeddings, are computed in memory. Then one
  transaction re-verifies the lease, locks the PROCESSING document, deletes existing chunks, inserts the
  new ones, sets AVAILABLE with `chunkCount`, and sets the job DONE with the lease cleared. A partially
  processed document can no longer become AVAILABLE.
- **Re-enqueue.** `completeUpload` re-enqueueing clears any lease, which fences a stale holder.
- **Unchanged.** Storage, extraction, chunking and the optional embeddings are kept as they were.

**Verified.**
- `pnpm typecheck` passes (4/4).
- The existing `qa:documents` suite passes 77/77 on a disposable local PostgreSQL 14.
- A throwaway crash-recovery check (not committed) passed. It covered:
  - the happy path;
  - a legacy stuck job with partial chunks being recovered, with the chunks replaced;
  - a live lease being respected and an expired lease being re-claimed;
  - an exhausted abandoned job ending FAILED `LEASE_EXPIRED`;
  - a lease lost mid-run writing nothing and leaving no chunks;
  - concurrent drains taking exactly one attempt per job;
  - bounded retries ending FAILED, which is never re-claimed.

**Not verified.** Production: migration 0029 is not applied, and a real worker crash under load has not
been tested. No new QA suite was added, by mission scope.

## 2026-11-21 — MISSION P10: A17 document knowledge in the agent context (PR, branch `arena/187ac026-qeynox`, off `4b07928`)

**The gap.** A17 provided upload, ingestion, PostgreSQL FTS (optional embedding rerank) and mission
attachments, but the worker never handed attached documents to Hermes.

**What changed.** No new retrieval platform: `DocumentVaultService` gained two methods and a thin glue
module (`packages/application/src/mission-documents.ts`) wires them into `apps/worker/src/runtime.ts`.
- **Retrieval (`DocumentVaultService.missionPassages`).**
  - Only documents attached to *this* operation in *this* workspace. The mission must belong to the
    workspace, and attachments, documents and chunks are all filtered by workspace and operation.
  - Eligible = AVAILABLE, not deleted, not expired, recorded upload purpose (the A17 consent act),
    mission owner and attaching member both still ACTIVE in the workspace.
  - Everything else is reported in `withheld` with a reason: `NOT_AVAILABLE`, `EXPIRED`,
    `NO_CONSENT_RECORD`, `ACCESS_REVOKED`, `CONSENT_MISSING`, `PROFILE_NOT_PERMITTED`.
  - Ranking reuses the existing FTS (`websearch_to_tsquery('simple')` over an operator-free OR query of
    the mission and step text) and the existing optional 65/35 embedding rerank. Embedding failure falls
    back to FTS. If nothing matches, the opening passages are used and labelled `LEADING`.
  - Every retrieval writes `AGENT_RETRIEVAL` rows to `document_audit_events` (SUCCESS or DENIED + reason).
- **Authorization at the worker.**
  - The mission owner needs an unrevoked, unexpired consent with scope `context:read` (the scope the
    mission opt-in already grants). Revoking it withholds every document.
  - The reviewed agent profile must permit the `documents:excerpts` context key. Hermes forwards only
    permitted keys, and without it no chunk text is read.
  - The vault is built **without an object store**: this path cannot fetch, sign or list storage
    objects. Hermes gets excerpts plus name/page/chunk metadata only, with no storage keys or URLs.
- **Bounds.** At most 6 passages, 1,500 characters each, 8,000 in total (about 2k tokens; the estimate is
  reported). Hard clamps inside the vault: 12 passages, 4,000 characters each, 48,000 in total.
- **Grounding.**
  - The agent is told to cite excerpts as `[D1]`, `[D2]`…
  - After an **accepted** output (a rejected P09 deliverable records nothing), only markers that match
    an excerpt handed out *and* whose document is still citable become citations. "Still citable" is
    re-checked after the run, so deletion, detachment, expiry or revocation during the run is honoured.
  - Each citation is an UNVERIFIED evidence row with document id, chunk id, page, ordinal, document
    SHA-256 and excerpt SHA-256, but **no excerpt text**: deleting a document leaves no copy in evidence.
  - The step output stores `documentGrounding`: provided, cited, uncitable and unknown markers,
    withheld, and the character/token estimate. It holds provenance only.
- **Result.** `ResultAssembler` adds `documentSources`: cited documents still AVAILABLE with the same
  SHA-256. They are customer-provided material, never finding citations, and never count toward
  `unresolved`, document state or the delivery gate (which still requires http(s) SUPPORTED citations).
- **Unchanged.** Missions with no attached document get no extra context. ToolBroker, budgets, the P09
  pack validation, human review and the A21.07 runtime gates are untouched.

**Verified.**
- `pnpm typecheck` passes (4/4).
- Existing suites on a disposable local PostgreSQL 14: `qa:documents` 77/77, `qa:mission-lifecycle`
  88/88 and `qa:agent-runtime` 65/65 pass.
- A throwaway local smoke check (not committed) passed. It covered:
  - the consent and profile gates;
  - AVAILABLE-only passages, with NOT_AVAILABLE/EXPIRED withheld;
  - no storage keys or cross-mission text in the context;
  - the LEADING fallback, the bounds, and operation and workspace isolation;
  - citation recording with unknown markers;
  - post-run revocation refusing citations, and deletion;
  - audit rows.
- `qa:business-packs` fails identically on the unmodified base `4b07928`
  ("Business pack deliverable is unavailable for this revision"), so it is pre-existing and not caused
  by P10.

**Not verified / deferred.**
- Committed integration tests and screenshots (deferred by the mission).
- A live Hermes run with documents.
- Live embeddings.
- Production (migration 0022 still unapplied there).
- Atlas/API display of `documentSources`: the results controller projects fields explicitly, so they
  are not yet exposed, including via shared links.
- Agent output text may paraphrase excerpts and flows to later steps as prior output; deleting a
  document does not rewrite text the agent already produced.

## 2026-11-21 — MISSION P09: A16 business outputs wired into the worker (PR, branch `arena/1004e438-qeynox`, off `779577d`)

**The gap.** The eight A16 packs, their `<pack>@1` deliverable schemas, `validatePackDeliverable()` and
`projectDeliverableToResultSummary()` existed. The worker still stored every step as one generic
`AGENT_FINDING` built from the raw answer text, so no pack mission ever produced its structured
deliverable.

**What changed.** All glue lives in `packages/application/src/business-pack-execution.ts`; it adds no
new business rules.
- **Request recovery.** `BusinessPackService.createPlan` records the validated, normalized request on
  the goal (`serviceRequest`: contract, pack, capability, fingerprint, canonical JSON). Before any engine
  selection or budget use, the worker recovers it and proves it: the recorded JSON must hash to the
  approved fingerprint, and pack and contract must match the operation constraints. Otherwise it fails
  closed with `INVALID_STATE`, and the mission is never run as a generic one.
- **Pack instructions.**
  - Every step must belong to the pack capability, which selects its slot profile.
  - That profile must permit `step:input`.
  - Supporting steps get the request and prior outputs.
  - The plan's single terminal step, which must depend on every other step, gets the `<pack>@1`
    output contract and the exact URIs ToolBroker captured in the revision.
- **Acceptance.** The actual Hermes output goes through the existing
  `extractStructuredDeliverableFromJson` / `validatePackDeliverable`. The validation context is rebuilt
  from the recovered request: captured URIs, competitors, channels and budget, and the deterministic
  diagnostics and sensitivity. Rejected output fails the step with the new code `INVALID_AGENT_OUTPUT`;
  no evidence, claim, output or document is written for it.
- **Persistence.**
  - Observed statements from `projectDeliverableToResultSummary` become
    `business-pack:<pack>:observation` claims. Each is linked to every capture of the URI it cites
    (exact digest) and assessed against the active policy.
  - The validated deliverable is stored on the step output.
  - `ResultAssembler` re-validates it on every (re)assembly and derives the title, scope, limitations,
    next actions, `interpretations` and `businessPack` identity from it, using only that attempt's
    claims.
  - Supporting pack steps no longer register generic claims.
  - Generic missions are unchanged.
- **Atlas.** Contracts, library and shared views, the web reader (EN/FR), the HTML/PDF exports and the
  review view carry `interpretations`, labelled AI interpretation and never a finding.
- **Unchanged.** ToolBroker, budgets, the result-review approval and the delivery gate, which still
  requires every finding to be SUPPORTED with a verifiable citation.

**Verified.**
- `pnpm typecheck` and `pnpm build` pass (4/4).
- A throwaway local check (not committed) over all eight packs passed 82/82. It covered request recovery
  through a JSON round trip, refusal of a tampered or missing request, deliverable-step selection,
  instructions, acceptance of the A16 fixture deliverables under the rebuilt context, and rejection of
  prose, incomplete JSON and uncaptured citations.

**Not verified.**
- No QA suite was run against PostgreSQL.
- No live Hermes run.
- No browser screenshot.

**Known limits.**
- Pack operations created before this change have no recorded request and fail closed at execution;
  they must be re-requested.
- Operations whose deliverable has no observed statement (for example operations without benchmark
  URIs) assemble as DRAFT and are not deliverable under the existing rules.

Not deployed.

## 2026-11-21 — MISSION P08: QA runtime bypass restricted to isolated QA runs (PR, branch `arena/6c9e84ad-qeynox`, off `45b9241`)

**The gap.** `QEYNOX_QA_ALLOW_UNVERIFIED=true` skipped the A21.07 runtime gate whenever `NODE_ENV` was
not `production`. A staging or preproduction worker, or one with no `NODE_ENV`, could therefore execute
on an unverified runtime.

**Fix.** `evaluateQaRuntimeBypass` (`apps/worker/src/qa-runtime-bypass.ts`) now requires all of the
following:
- the explicit marker `QEYNOX_QA_ENVIRONMENT=isolated`;
- a non-deployed environment;
- a loopback `qeynox_qa_*` disposable database, judged on the URL the worker actually connected with;
- a loopback QA admin URL;
- a loopback Hermes double, if Hermes is configured;
- no Hatchet token.

Otherwise the bypass is refused and the gate applies. The three fixture suites set the marker.

**Verified:** typecheck passes; `qa:agent-runtime` 65 and `qa:mission-lifecycle` 88 are unchanged.
`qa:connectors` is still blocked by World Bank TLS in the sandbox, as before. No new suite was added.
Not deployed.

## 2026-11-21 — MISSION A21.07: truthful runtime readiness; bounded live probes per component (draft PR, branch `arena/6b29158c-qeynox`, off `72521d7`)

**The defect.** "Verified" runtime meant `QEYNOX_RUNTIME_VERIFIED_LIVE=true` plus a free evidence string,
and the worker defaulted that string to `"live-probe"`. One flag covered Hermes and Hatchet together.
Nothing probed either runtime, nothing expired, and the API admitted launches without checking the runtime.

**Fix.**
- **Probes.** Each process (API, worker) runs its own `RuntimeProbeMonitor`, with separate bounded probes
  for Hermes (`/health` identity, key accepted, no enabled toolset, model advertised) and Hatchet (API
  ready, version, the token's own tenant, gRPC reachable).
- **Evidence.** Each component gets its own in-memory evidence record: reference, verified identity,
  timestamps, expiry, failure class. No credential is stored.
- **Invalidation.** Evidence expires (freshness limit), is invalidated by an endpoint or credential change
  (`TARGET_CHANGED`), and does not survive a restart (`NOT_PROBED`).
- **Old flags.** The env flags are no longer read.
- **Launch gate.** `OperationExecutionService` requires the runtime source and refuses `start` before
  anything is consumed: 503 when unproven, 502 when a probe failed. The worker re-checks with
  `freshReadiness()`.
- **Surfaces.** Readiness, the beta journey, the web (EN/FR) and the control show per-component
  verification.
- **QA opt-out.** `QEYNOX_QA_ALLOW_UNVERIFIED` is ignored when `NODE_ENV=production`.

**Verified:**
- `qa:runtime-verification` (new): 146 assertions. Real sockets against local Hermes/Hatchet fixtures,
  disposable PostgreSQL, real HTTP.
- `qa:runtime-readiness`: 70 + 27 (was 38 + 19).
- Beta suites now obtain a verified runtime through real probes of the fixtures:
  - beta-journey 130 (was 128);
  - beta-access 126;
  - beta-execution 440.
- Unchanged suites:
  - identity 57;
  - registration 149;
  - verification-resend 68;
  - payment-freeze 369;
  - backend 28;
  - agent-runtime 65;
  - mission-lifecycle 88;
  - stripe-payments 108;
  - business-packs 370.
- Smoke 449 (436 at baseline) and flow2 37 (35 at baseline).
- typecheck and build pass.
- Screenshots in EN/FR at 390/1440 px, with no horizontal overflow.

**Pre-existing, unchanged:**
- `qa:task02` parity failure.
- `qa:connectors`, `qa:raas` and `qa:a03-service` part 2 are blocked by World Bank TLS in this sandbox.

**Not verified:**
- Any real Hermes or Hatchet deployment.
- A worker step run against the new gate.
- Control page screenshots.

Not deployed.

Design: `docs/design/A21_RUNTIME_READINESS.md`; ADR-020 "A21.07 amendment".

## 2026-11-21 — MISSION A21.06: e-mail verification resend fixed; authenticated resend route (draft PR, branch `arena/31248bfb-qeynox`, off `291ed00`)

**The bug.** The account page's resend button posted an empty body to the public
`POST /v1/identity/verification/request`, which requires an e-mail. Every resend failed with 400, and the
form labelled every success as "delivery not configured".

**Fix.** A new session-only `POST /v1/identity/verification/resend` takes no body and derives the recipient
from the authenticated user, so a client-supplied e-mail is never trusted. It reuses the existing
single-use hashed tokens, the ledger and the Resend transport. It reports `ACCEPTED` / `NOT_CONFIGURED`
(no token issued) / `DELIVERY_FAILED` / `ALREADY_VERIFIED`, or 429 when throttled (dedicated per-user
budget of 5 per 15 min). The public route and its anti-enumeration answers are unchanged. The web maps
each outcome to its own EN/FR state; malformed responses show an error, never success.

**Verified:**
- `qa:verification-resend` (new): 68 assertions, real HTTP and the real Resend adapter against a local
  e-mail fixture, disposable PostgreSQL.
- Smoke: 436 (386 at baseline). Flow2: 35.
- Identity, registration, backend, agent-runtime, payment-freeze and beta suites are green.
- `qa:task02` keeps its pre-existing parity failure.
- typecheck and build pass.
- Browser screenshots in EN and FR, with no mobile overflow.

**Not verified:** real Resend delivery. Not deployed.

Design: `docs/design/A21_VERIFICATION_RESEND.md`.

## 2026-11-21 — MISSION A21.05: registration configuration mismatch fixed; invite-only beta registration (draft PR, branch `arena/6d6d13aa-qeynox`, off `c2d2f62`)

**The bug.** The two layers read different switches with opposite defaults:
- The web register page read `QEYNOX_REGISTRATION_ENABLED`, which defaulted the form to ON.
- The API read `QEYNOX_ALLOW_REGISTRATION`, which defaulted to OFF.

So the default deployment offered a form that the API always refused with 503.

**One authoritative server-side policy now decides.** `QEYNOX_REGISTRATION_MODE` is resolved by `resolveRegistrationPolicy` (`packages/application/src/registration.ts`):
- `CLOSED` is the default.
- `INVITE_ONLY` requires a registration invitation.
- `OPEN` allows public signup.
- Any other value fails closed to `CLOSED`.
- `QEYNOX_ALLOW_REGISTRATION=true` is kept as a deprecated alias for `OPEN`, honoured only when the mode is unset.

**How the API and the web share it:**
- The API enforces the policy on `POST /v1/auth/register` and publishes it on the public `GET /v1/auth/registration-policy`.
- The policy is resolved on every call, never cached.
- The web register page renders only what that endpoint reports: OPEN or INVITE_ONLY forms, or CLOSED / unavailable / not-configured states with no form.
- `QEYNOX_REGISTRATION_ENABLED` is no longer read anywhere.

**Invite-only beta registration.** Additive migration **0028** adds `registration_invitations`:
- operator-issued, single-use, bound to an e-mail address, stored as a SHA-256 digest only, valid 7 days;
- it carries the beta terms.

Platform routes are at `/v1/platform/registration-invitations`:
- issue: ADMINISTRATION, with a justification; no self-invitation; no invitation for an e-mail that already has an account; one pending invitation per e-mail; audited;
- list: ADMINISTRATION or SUPPORT;
- revoke: ADMINISTRATION.

Redemption happens inside the one signup transaction in `RegistrationStore.register`. It writes, atomically:
- the account, workspace and ACTIVE OWNER membership;
- an **ACTIVE beta grant** with the invited terms;
- ledger events `INVITED` and `ACTIVATED`;
- the invitation marked `REDEEMED`.

**Refusals and preserved behaviour:**
- Every invitation problem returns the same 403 `INVITATION_INVALID`: missing, malformed, unknown, used, revoked, expired or for another e-mail.
- A duplicate e-mail stays the generic 409 and never consumes the invitation.
- Concurrent redemptions yield exactly one account.
- An uninvited OPEN signup stays `NOT_ENROLLED` and cannot launch beta missions. Public signup never bypasses beta enrollment.
- Password 12–256, workspace creation and the 24-hour session are unchanged.

Verified on a disposable **real PostgreSQL 14.1** (applied nowhere else):
- **New `qa:registration`: 9 groups / 149 assertions PASS** over the real HTTP API. It covers:
  - policy resolution;
  - a web/API agreement matrix over 9 configurations, with `QEYNOX_REGISTRATION_ENABLED=true` set throughout;
  - disabled and enabled registration;
  - operator issuance;
  - every invalid-invitation case;
  - valid invitation, including the grant and journey checks;
  - duplicate e-mail in OPEN and INVITE_ONLY;
  - three-way concurrent redemption.
- Schema parity of `registration_invitations` (columns, 3 indexes, 11 checks, 5 FKs) was checked against the migrated database with the same `getTableConfig` comparison that qa:task02 uses.
- Web `test:smoke`: **386 PASS** (was 329). It covers the register page in OPEN, OPEN with an invitation link, INVITE_ONLY, CLOSED, malformed policy and failing policy, in EN and FR. The retired web switch is set to `true` and is ignored. The policy is read on every render. `test:flow2` 35 PASS.
- Headless-Chromium screenshots (24) at 390×844 and 1440×900, EN and FR, are in `docs/design/screenshots/a21-05/`. No horizontal overflow and no unlabeled inputs (`report.json`).
- Regressions, identical to the A21.04 baseline:

  | Suite | Assertions |
  |---|---|
  | `qa:backend` | 28 |
  | `qa:identity` | 57 |
  | `qa:beta-access` | 126 |
  | `qa:beta-execution` | 440 |
  | `qa:beta-journey` | 128 |
  | `qa:payment-freeze` | 369 |
  | `qa:workspace-management` | 82 |
  | `qa:platform-organizations` | 87 |
  | `qa:agent-runtime` | 65 |

  `pnpm typecheck` and `pnpm build` 4/4.

Pre-existing failures (unchanged, not caused here): `qa:task02` still stops at its first known parity failure, the missing `email_deliveries_dedup_unique` index. World Bank TLS still blocks `qa:connectors` and `qa:raas` in this sandbox.

NOT verified:
- no production or deployed check;
- no real e-mail delivery of invitations (reported `BLOCKED / MANUAL_DELIVERY_REQUIRED`);
- no operator console screen for invitations (API only).

Design: `docs/design/A21_REGISTRATION_POLICY.md`. ADR-023 consequences updated.

No production change. One draft PR; not merged.

## 2026-11-21 — MISSION A21.04: free beta customer UX, EN/FR (draft PR, branch `arena/846bce88-qeynox`, off `6676229`)

The customer now sees the free beta truthfully on every commercial surface. A new read-only endpoint, `GET /v1/workspaces/current/beta-access/journey` (`BetaJourneyService`), composes server-side:
- the A21.01 commerce mode;
- the A21.02 workspace grant;
- live runtime readiness.

It returns one state: NOT_CONFIGURED, NOT_ENROLLED, INVITATION_PENDING, EXPIRED, REVOKED, QUOTA_EXHAUSTED (missions or provider budget), CONCURRENT_LIMIT_REACHED, RUNTIME_UNAVAILABLE or ACTIVE. It also returns the allowance, the expiry and constant pricing facts: no card, payments unavailable, 0 due today, a 100% waiver only in `BETA_FREE`.

The web parses this with literal guards and renders a shared EN/FR beta offer summary on:
- the catalogue;
- service detail;
- mission creation;
- MyDash (with invitation activation for OWNER/ADMIN);
- quote acceptance;
- launch.

The summary shows "Free beta — no card required", the list price (crossed out only when the waiver applies), "Beta waiver (100%)", "Amount due today €0.00", remaining missions, expiry and account status. In beta flows the payment panel, the payment-required prompt and every checkout path are replaced by the summary.

Verified on a disposable **real PostgreSQL 14.1** (applied nowhere else):
- New `qa:beta-journey`: **7 groups / 128 assertions PASS** over the real HTTP API. It covers every state from real grants, admissions, reservations, revocation and expiry; session and tenant isolation; that the read is side-effect free; and NOT_CONFIGURED via a second boot in `PAYMENTS_DISABLED`.
- Web `test:smoke`: **329 PASS** (was 218), covering all states in EN and FR across MyDash, catalogue, detail, quote, launch and payment replacement; an unreadable journey; and a journey that asks for a card, which is rejected. `test:flow2` 35 PASS.
- Headless-Chromium screenshots (73) at 390×844, 1024×768 and 1440×900, EN and FR, in `docs/design/screenshots/a21-04/`. No horizontal overflow (`report.json`).
- Regressions:
  - `qa:beta-access` 126, `qa:beta-execution` 440, `qa:payment-freeze` 369;
  - `qa:backend` 28, `qa:agent-runtime` 65, `qa:stripe-payments` 108, `qa:business-packs` 370 and 22 other suites PASS.
  - `pnpm typecheck` and `pnpm build` 4/4.

Pre-existing or environmental failures, not caused by this mission:
- `qa:task02` parity (no schema change here).
- `qa:platform-authorization` and `qa:platform-users`: they fail identically on the untouched base `6676229`.
- `qa:connectors`, `qa:raas`, `qa:egress` and `qa:a03-service` part 2: World Bank TLS BLOCKED.

NOT verified:
- Screens against a real API with real data (screenshots use the labelled smoke fixtures).
- Assistive-technology runs.
- Screenshot reference comparison: **BLOCKED**, because the reference PNG is absent.

No production change. One draft PR; not merged. Full record: [A21_BETA_CUSTOMER_UX.md](../design/A21_BETA_CUSTOMER_UX.md).

## 2026-11-21 — MISSION A21.03: free beta execution authorization (draft PR, branch `arena/45f55f1b-qeynox`, off `74f25d5`)

Eligible beta testers can now execute all eight A16 business packs without paying. They get a **distinct, non-financial beta authorization** (new table `raas_beta_authorizations`, additive migration `0027_beta_execution_authorization.sql`), never a fake payment:
- **Accept:** in `BETA_FREE` mode, a priced quote accepted by a workspace with an ACTIVE, unexpired A21.02 grant creates an order in the explicit state `BETA_AUTHORIZED`. The order keeps the published price, quote, offer version, scope hash, terms acceptance and revision. The authorization row is bound to all of them and to the grant. It records the list price unchanged and pins the amount due now to 0 with a DB CHECK.
- **Nothing financial:** no payment, invoice, checkout session or refund is created. A beta order is never `AUTHORIZED`, `DELIVERED`, `PAID` or `CAPTURED`. The payment view never payment-authorizes it, and the webhook can never change its state.
- **Free offers** stay `AUTHORIZED` as before. Without a grant, or under the default `PAYMENTS_DISABLED`, priced orders stay `PAYMENT_REQUIRED` (A21.01 unchanged).
- **Re-checked at every use:** start, retry, redo and result delivery each re-check the mode, the grant's status and expiry, the current revision and every binding. Revocation, expiry, a plan change, tampering or a switch back to `PAYMENTS_DISABLED` fail closed with `403 BETA_ACCESS_REQUIRED` (`BETA_AUTHORIZATION_<denial>`).
- **Delivery** needs no Stripe. The order becomes `BETA_DELIVERED`, and `RESULT_DELIVERED` names the `FREE_BETA` basis.
- **Conversion:** `POST /v1/operations/:id/commercial/beta-authorization` converts a `PAYMENT_REQUIRED` order accepted before the grant, only if it has no payment history.
- **Other controls unchanged:** consent, budgets, the A21.02 quota, concurrency and spend gates, ToolBroker permissions, runtime readiness and the human `RESULT_REVIEW` all still apply.
- **Visible state:** commercial, readiness and web views show the list price, "due now 0" and why an authorization no longer applies.

Verified on a disposable **real PostgreSQL 14.1** (applied nowhere else):
- New `qa:beta-execution`: **13 groups / 440 assertions PASS** over the real `AppModule` HTTP API and in-process services. It covers:
  - all 8 packs accepted at published prices and executed through the real ToolBroker/PgToolLedger, human review and delivery (one over HTTP), with zero payment, payment-event or refund rows;
  - concurrent acceptance (replays, racing keys, competing quotes);
  - revoked and expired grants (start, retry, delivery);
  - changed plans and tampered bindings;
  - cross-tenant attempts;
  - explicit conversion;
  - fail-closed mode switch;
  - mandatory controls;
  - the DB CHECK on amount due.
  
  Mutation checks: bypassing validation at delivery, removing the retry re-check, or ignoring the grant status each make the suite fail.
- Regressions:
  - `qa:payment-freeze` PASS; `qa:beta-access` 126 PASS; `qa:business-packs` 370 PASS (pack fixtures moved to `qa-pack-fixtures.ts`, unchanged);
  - `qa:stripe-payments` 108; `qa:backend` 28; `qa:agent-runtime` 65; `qa:mission-lifecycle` 88; `qa:atlas-library` 105; `qa:atlas-results` 150; `qa:notifications` 98;
  - 19 other `qa:*` suites PASS.
- `qa:task02` past the pre-existing parity failures: 4637 assertions PASS (only those mismatches relaxed in a throwaway copy). The new table has full Drizzle↔SQL parity.
- `pnpm typecheck` PASS; `pnpm build` 4/4; web `test:smoke` 218 PASS; `test:flow2` 35 PASS.

Pre-existing or environmental failures, not caused by this mission:
- `qa:task02` parity (`email_deliveries_dedup_unique`, `notifications_dedup_unique`, their unique columns, and `result_share_links_access_count_check`).
- `qa:platform-authorization` and `qa:platform-users` part B: `pilot.module.ts` queries the database at boot.
- `qa:connectors`, `qa:raas`, `qa:egress` and `qa:a03-service` part 2: BLOCKED because the live World Bank provider is unreachable over TLS from the sandbox.

NOT verified: browser rendering of the free-beta block and conversion button; a real worker, Hermes or provider run on a beta order (providers were local fakes behind the real ToolBroker); a delivered Stripe webhook against a beta order (payments stay frozen). No production change. One draft PR; not merged. Full record: [A21_BETA_EXECUTION.md](../design/A21_BETA_EXECUTION.md).

## 2026-11-21 — MISSION A21.02: invite-only beta access (draft PR, branch `arena/3e51529e-qeynox`, off `1177489`)

Durable, workspace-scoped beta grants on the existing PostgreSQL identity and workspace model (no second authentication system). A PLATFORM_ADMIN creates a grant for one `identity_workspaces` row, with an expiry, a mission quota, a concurrent-mission limit and a provider-spend cap. The grant starts INVITED with a single-use 43-character token, stored only as a SHA-256 digest. An OWNER or ADMIN of that same workspace activates it. States are ACTIVE, EXPIRED (evaluated from the clock on every read and gate) and REVOKED. A **mandatory** server-side gate runs inside the launch transaction of start, retry and redo, and inside every provider-spend reservation. It locks the grant row: no grant, an INVITED, expired or revoked grant, or an unadmitted mission → 403 `BETA_ACCESS_REQUIRED`. Quota, concurrency or spend cap reached → 429 `BETA_LIMIT_REACHED`. Readiness names the blocker. Operators cannot grant a workspace they created or hold any membership in, and the issuer cannot activate their own grant. Every operator action (success or denial) lands in `platform_admin_audit`. Lifecycle, admissions, denials and spend go to the new `beta_grant_events` ledger. The new Control `/beta` pages list, grant, inspect and revoke. Additive migration `0026_beta_access.sql`.

Verified on a disposable **real PostgreSQL 14.1** (applied nowhere else):
- New `qa:beta-access`: **11 groups / 126 assertions PASS**, in-process and over the real `AppModule` HTTP API. It covers:
  - unauthorized callers denied and audited;
  - activation rules and single-use token;
  - exact limits under parallel launches (2 of 6 within concurrency; quota 3) and parallel reservations (2 of 6 under the cap);
  - DB CHECK backstops;
  - revocation blocking start, racing launches, retry, redo and new spend at once;
  - expired grants and invitations failing closed;
  - A21.01 freeze precedence;
  - audit and ledger completeness.
  
  Mutation check: removing the START gate makes the suite fail.
- Suites that launch missions now seed an explicit ACTIVE grant via `apps/api/scripts/qa-beta-fixture.ts`; nothing was weakened. Results: `qa:payment-freeze` 369 PASS; `qa:backend` 28 PASS; `qa:agent-runtime` 65 PASS; `qa:mission-lifecycle` 88 PASS; `qa:business-packs` 370 PASS; `qa:stripe-payments` 108 PASS.
- `qa:task02`: everything past the pre-existing parity failures passes (4310 assertions, run with only those pre-existing mismatches relaxed in a throwaway copy). The new beta tables have full Drizzle↔SQL parity.
- `pnpm typecheck` 4/4; `pnpm build` 4/4; web `test:smoke` 199 PASS; `test:flow2` 35 PASS.
- 20 other `qa:*` suites run and PASS.

Pre-existing or environmental failures, not caused by this mission:
- `qa:task02` parity: `email_deliveries_dedup_unique`, `notifications_dedup_unique` and their unique columns (0024), and `result_share_links_access_count_check` (0025).
- `qa:platform-authorization` and `qa:platform-users` part B: `pilot.module.ts` queries the database at boot against the suite's unreachable URL. They fail identically on the untouched base.
- `qa:connectors`, `qa:raas`, `qa:egress` and `qa:a03-service` part 2: BLOCKED because the live World Bank provider is unreachable. `qa:a03-service` reaches the provider call past the beta gate.
- `qa:atlas-library` failed once on the reconcile assertion. It passed on two re-runs and on the base; it does not touch launches.

NOT verified: browser rendering of the Control `/beta` pages and web blocker copy; real worker, Hermes or provider spend (exercised through `BudgetService.reserve/settle`); invitation e-mail (none is sent; delivery is manual). No production change. Once deployed, **no workspace can launch until it holds an ACTIVE grant**. One draft PR; not merged. Full record: [A21_BETA_ACCESS.md](../design/A21_BETA_ACCESS.md).

## 2026-11-21 — MISSION A21.01: hard payment freeze (draft PR, branch `arena/21a16ce5-qeynox`, off `d872738`)

Server-authoritative `QEYNOX_COMMERCE_MODE` replaces Stripe key presence as the commercial switch. Supported values are `PAYMENTS_DISABLED` (the default when unset) and `BETA_FREE`. **Both freeze payments.** Any other value, including any paid mode, refuses API boot. The API now composes `FrozenPaymentGateway` and never constructs `StripePaymentProvider`. Configured Stripe test keys are not read and cannot lift the freeze. Checkout, capture, refund, reconcile and the Stripe webhook return `503 PAYMENTS_FROZEN` before any body, signature, database row or provider is touched. Webhooks are refused without verification or ledger write, so redelivered and new events can't authorize an order or record a fake success. Reads stay truthful: history is shown as stored, stale checkout links are withheld, the new `commerce` availability block and `GET /v1/commerce/availability` state the mode, and the readiness blocker is `PAYMENTS_FROZEN`. The web payment panel renders a frozen, read-only state with no checkout action. `BETA_FREE` grants no new entitlement: priced orders stay `PAYMENT_REQUIRED`. The Stripe adapter, the A08 `PaymentService`, prices, orders, payments, refunds, the webhook ledger and every DB contract are preserved. There is no migration.

Verified on a disposable PGlite (real PostgreSQL 18.7 wire protocol; applied nowhere else):
- New `qa:payment-freeze`: **21 groups / 369 assertions PASS**. It covers {PAYMENTS_DISABLED, BETA_FREE} × {Stripe test keys present, absent}, in-process and over the real `AppModule` HTTP API. It confirms zero non-loopback network attempts, with a positive control proving that the interceptor catches a real Stripe SDK call. All seven commerce tables are deep-equal to the pre-freeze baseline after every combination.
- `qa:stripe-payments` 108 PASS (dormant engine unchanged); `qa:business-packs` 370 PASS; `qa:backend` 28 PASS; `qa:agent-runtime` 65 PASS; `qa:mission-lifecycle` 88 PASS.
- Web `test:smoke` 199 PASS (payment fixtures moved to the frozen contract, with frozen EN/FR states and legacy-shape rejection); `test:flow2` 35 PASS.
- `pnpm typecheck` 4/4; `pnpm build` 4/4.

Pre-existing or environmental failures, not caused by this mission:
- `qa:task02` fails on `email_deliveries_dedup_unique`. It fails identically on the untouched base.
- `qa:connectors`, `qa:raas` and `qa:a03-service` part 2 are BLOCKED: the live World Bank provider is unreachable from the sandbox.

NOT verified: browser rendering of the frozen panel; any production env or deployment; disabling the Stripe dashboard webhook endpoint (an operator action). One draft PR; not merged. Full record: [A21_PAYMENT_FREEZE.md](../design/A21_PAYMENT_FREEZE.md).

## 2026-11-20 — MISSION A19: real e-mail delivery and notifications (draft PR, branch `arena/28bda8cd-qeynox`, off `ae18a2b`)

The not-configured-only e-mail stub is replaced by a real provider path: `ResendEmailTransport` (2xx-with-id ⇒ receipt; 429/network ⇒ retryable; other 4xx ⇒ permanent) behind the existing `EmailTransport` port — receipt-returning, provider-labelled — selected by env (`QEYNOX_EMAIL_PROVIDER=resend` + `QEYNOX_RESEND_API_KEY` + `QEYNOX_EMAIL_FROM`), fail-closed otherwise; **credentials are deployment secrets only**. EN/FR/ES/DE reviewed templates (6 templates, HTML-escaped); self-service verification/recovery/invitation sends inline post-commit; customer + platform invitation paths now deliver for real when configured. Notifications: `NotificationService` materializes `STEPS_COMPLETED_REVIEW_REQUIRED`/`STEP_FAILED`/`STEP_OUTCOME_UNKNOWN`/`RESULT_DELIVERED` into in-app inbox rows (always) and e-mail deliveries (per-user opt-out, default on, transactional never opt-out-able); delivery ledger (`email_deliveries`) records every attempt truthfully — SENT only on provider acceptance — with backoff 60/300/900 s, maxAttempts 3, idempotent per `(event, recipient)`; worker drains every 5 s; API `/v1/notifications*` (list/read/read-all/preferences); Web inbox `/{lang}/notifications` (EN/FR). Operator-triggered lifecycle sends remain blocked by design (`ACCOUNT_LIFECYCLE_FLOW_NOT_IMPLEMENTED`, audited). Verified: migration `0024` applies cleanly (24/24) on a disposable PGlite (real PostgreSQL 18.7 wire protocol; applied nowhere else); `qa:notifications` **98 assertions PASS** (incl. delivered-result flow end-to-end through the real assembler → approve → `deliver()`); `qa:identity` 57 assertions PASS; forced typecheck 4/4. NOT verified: any live provider call (no Resend key on this deployment); delivery to a real mailbox; production secrets/migration (never applied by the agent); worker failure path end-to-end (code-reviewed only). `qa:backend` remains pre-existing-failing and untouched. One draft PR; not merged. Full record: [A19_NOTIFICATIONS.md](../design/A19_NOTIFICATIONS.md).

## 2026-11-19 — MISSION A17: documents, files and tenant-safe knowledge (draft PR, branch `arena/ea3cf859-qeynox`, off `99169ae`)

Customer document vault: secure upload (declare → direct-to-storage PUT → complete with size + SHA-256 re-verification), server-side extraction (PDF/DOCX/txt/markdown/csv — never fabricated), tenant-scoped full-text retrieval with citations tied to the document SHA-256, optional operator-configured embeddings (JSONB vectors; HYBRID degrades to FTS; FTS is the guaranteed path), mission attachment, consent/revocation/retention controls and a complete EN/FR customer UI (`/[lang]/documents` + mission attach card) in Professional Blue. API under `v1/documents` (+ `v1/operations/:id/attach|detach|vault-documents` — deliberately not reusing the result-documents path). Verified: `qa:documents` 77 assertions; `qa:task02` 3847 assertions (parity checker extended for server-GENERATED tsvector, not weakened); `qa:agent-runtime` 65 assertions; typecheck 4/4; build 4/4. NOT verified: any real-S3 leg (in-memory fake only — no MinIO/docker), live embeddings (none configured), pgvector (not used), production (migration 0022 never applied; production untouched), a browser pass (no Chromium). `qa:connectors`/`qa:raas` still blocked on sandbox TLS (pre-existing). `qa:backend` remains pre-existing-failing and untouched. One draft PR; not merged. Full record: [A17_DOCUMENTS.md](../design/A17_DOCUMENTS.md).

## 2026-11-20 — MISSION A15 (increment 1): licensed web search adapter — Brave (draft PR, branch `arena/5c2dfdf2-qeynox`, off `d2c8d2b`)

First, highest-priority provider family of MISSION A15. A REAL, reviewed, read-only adapter (`packages/tools/src/providers/brave-search.ts`, tool `web@1`) for the documented Brave Search API (`GET https://api.search.brave.com/res/v1/web/search`, `X-Subscription-Token` header): zod-typed input/output contracts, HTTPS through the pinned `secureProviderRequest` egress (no redirects, byte/time caps, host allowlist, attested attestation), a mapped failure taxonomy (401/403 → NOT_CONFIGURED, 429 → BUDGET_EXHAUSTED, 5xx → UNAVAILABLE, malformed/wrong-shape → INVALID_STATE), consent scope `web:search`, pagination capped at the provider's documented deep-offset limit (count ≤ 20, offset ≤ 9). Triple-gated activation: ACTIVE operator TOOL configuration + `QEYNOX_BRAVE_SEARCH_ENABLED=true` + `QEYNOX_BRAVE_SEARCH_API_KEY` (token never logged, never in the URL) + attested egress allowlisting `api.search.brave.com`. Operator bundle (`infra/operator/a15-web-research.json`) creates an INTERNAL "Licensed web research" capability + agent profile + verification policy only — deliberately NO RAAS_OFFER and NO `unitMaxMinor` budget mapping (spend requires explicit operator approval; executor path fails closed until then). `infra/connectors.registry.json` records the adapter as INACTIVE with the real remaining blockers. Verified: `qa:brave-search` **57 assertions PASS** (PART 1 contracts 23 + PART 2 registry-fail-closed/broker-path against a disposable PostgreSQL and an in-process loopback fake — the only double; no live provider call was made, no Brave subscription token exists on this deployment). `pnpm typecheck` 4/4 clean; `qa:connector-hub` 79 assertions PASS. NOT executed: any live Brave Search call (token never provisioned; sandbox TLS BLOCKED — recorded as a deployment gate, not claimed), the full executor path (no offer/budget by design), and the remaining A15 families. `qa:backend` remains pre-existing-failing and untouched. One draft PR; not merged. Full record: [A15_BRAVE_SEARCH.md](../design/A15_BRAVE_SEARCH.md).

## 2026-11-19 — MISSION A14: connector hub and account connections (draft PR, branch `arena/bcb91636-qeynox`)

Workspace-scoped external account connections: OAuth authorization/callback/refresh/revocation lifecycle with PKCE S256 and single-use hashed state; server-side AES-256-GCM credential vault (opaque workspace-scoped refs, no plaintext column, no key ⇒ everything fails closed); scope-derived capability discovery and a scope-subset credential resolver for reviewed adapters (ToolBroker remains mandatory; no adapter ships); workspace audit trail; connect/disconnect/reconnect/error-recovery UI (EN/FR). One reviewed provider profile ships (`google-workspace`, scopes `openid email profile` only); every real provider stays BLOCKED in `infra/connectors.registry.json` until an operator provisions OAuth client credentials. **No live OAuth provider call has been made.** Verified: `qa:connector-hub` **79 assertions PASS** against a disposable socket-only PostgreSQL with an in-process loopback fake OAuth server (the only OAuth authority in QA); typecheck 4/4; api build clean; web build clean; live smoke (API + Web on the disposable DB) renders the honest NOT_CONFIGURED page EN/FR. NOT executed: live provider verification (blocked — no OAuth client on this deployment), a real browser pass (no installable Chromium), any ToolBroker-integrated adapter consuming the resolver. `qa:backend` remains pre-existing-failing and untouched. Not merged; one draft PR. Full record: [A14_CONNECTOR_HUB.md](../design/A14_CONNECTOR_HUB.md).

## 2026-11-19 — MISSION A13: service catalogue and customer ordering (draft PR, branch `arena/d3e6a7b3-qeynox`)

Customer-facing service catalogue: ACTIVE operator-published RaaS offers joined with real capability availability; detail pages with typed request forms; World Bank research (A03) connected to its actual API contract and plan creation; reusable typed request contracts for future capabilities; request → plan → quote → acceptance unchanged; clear statuses for unavailable providers/missing configuration; an operator publishing workflow through Control (offers table + read-only validate-service). Nothing is fake-available, no price is invented, and a zero price without explicit free authorization renders as invalid. Verified: `qa:service-catalogue` 63 assertions PASS against a disposable PostgreSQL (created/dropped by the harness, local socket, never production); typecheck 4/4; web/control builds clean; `qa:a03-service` PART 1 49/49 and BLOCKED at the live provider leg (TLS unreachable — honest BLOCK, no fixture substituted). NOT executed: browser pass over the services pages (no installable Chromium); no live provider claim; launch stays readiness-gated. `qa:backend` remains pre-existing-failing and untouched. Not merged; one draft PR. Full record: [A13_SERVICE_CATALOGUE.md](../design/A13_SERVICE_CATALOGUE.md).

## 2026-11-19 — A10: reliable Chatwoot support (source reconciliation, NOT live-verified)

The existing support surfaces (customer Web tab, operator Control inbox, `/v1/support/*`, `/v1/platform/support/*`) now run on the documented Chatwoot contract with a durable reconciliation strategy instead of the old unverified gate: per-request deterministic `source_id`, a `support_intents` state machine (migration `0020_support_intents.sql`), contact-scoped adoption (never cross-tenant), tenant-scoped idempotency `(workspace_id, user_id, intent_ref)`, 404→orphan marking, duplicate-mapping fail-closed on every surface with a `DUPLICATE_LINK_DETECTED` audit row, audited operator actions (`REPLY_SUPPORT_CONVERSATION`, `UPDATE_SUPPORT_STATUS`, justification required, schema-rejected input audited) and explicit `CHATWOOT_LIVE_VERIFICATION_REQUIRED` until an operator completes the live-verification procedure in [CHATWOOT_SUPPORT.md](CHATWOOT_SUPPORT.md). Chatwoot remains the only support engine: no second inbox, no message mirrored into PostgreSQL. QA (all fixtures/disposable PostgreSQL, never a live Chatwoot): `qa:chatwoot` 42 assertions, `qa:support-concurrency` 11, `qa:support-isolation`, `qa:support-private`, `qa:support-reconciliation` 33 against migrated disposable PostgreSQL; `qa:task02` 3783 assertions. **No live Chatwoot integration is claimed and the capability ships fail-closed.** Not deployed; draft PR only. Pre-existing `qa:backend` esbuild/decorators failure also reproduces on the base commit and was not chased.

## 2026-11-17 — Flow 2.0 Web release preparation

On the Flow branch based on `9dac541`, Web typecheck/build, all three Flow fixture variants and the updated Web HTTP smoke passed. A real browser observed one 220 ms signal for a new QA event, no signal for initial/repeated/paginated history, and none with reduced motion. A local Web image built with QA files excluded and served `/en` in a network-isolated container; it was built before the final documentation update, not from a deployed SHA. Full scope, screenshots, proposed Web-only delivery and remaining gates: [FLOW2_STATUS.md](../flow/FLOW2_STATUS.md). No real runtime, customer journey, merge, push, deployment or independent production certification was performed.

## 2026-11-16 — FAST LIVE 2.0 adoption and preproduction delivery (main 21ec11d)

FAST LIVE 2.0 is now the permanent delivery method for this repository: the canonical method
file sits at the root and FAST_LIVE_QEYNOX.yaml records only values read from the live Coolify
instance (project/environment/resource UUIDs, Dockerfiles, ports, health paths, shared stacks,
databases) plus the real deploy trigger. Every historical deployment is is_mcp=true and
is_webhook=false, and the commit 5bb66db reached main without any deployment: pushing to main
does not deploy, so one MCP deployment is used per impacted resource.

The DevOps lots A/B repair branch (PR #12) was integrated as f9e220f after one defect was proven
and corrected: its worker Dockerfile assumed a Hatchet worker healthcheck server that
@hatchet-dev/typescript-sdk 1.46.1 does not ship (no WORKER_HEALTHCHECK, livez or readyz in the
pinned dist), so the added probe would have reported a healthy worker as unhealthy; the proven
liveness probe was restored in 93b76a9. The retained changes are: dispatch-lease expiry becomes
UNKNOWN with a durable recovery incident instead of a silent replay, a crash after claiming is
never auto-replayed, a post-step failure can no longer turn a COMPLETED attempt into FAILED or
overwrite an operation awaiting review, and the worker reloads the operator provider configuration
per attempt instead of using its startup snapshot.

Targeted QA in a disposable PostgreSQL only (never production): typecheck PASS over the 12
workspace packages, agent-runtime PASS with 65 assertions, connectors PASS with 49 assertions.
One earlier connector run failed with an aborted provider request while two live-network suites
ran concurrently; origin/main passed at 48 assertions and the serial rerun of the branch passed
at 49, so the failure was parallelism, not the change.

Delivery: single MCP trigger, preproduction only, api + worker built at
21ec11d26ad59ffe5e3493b464b47a01b5417aa4 (web and control unchanged since 9906819). Verified
live: /v1/operator/operations/:id/runs/:runId is mapped by the running api, the worker reports
"listening for actions" and established its Hatchet listener with LISTEN_STRATEGY_V2, and
https://qeynox.io, /en, /fr/mydash and /admin answer 200 with the MyDash workbench rendered.

BLOCKED, not verified: qeynox-hermes reports restarting:unknown and Coolify exposes no logs for
a non-running container, so live mission execution through Hermes is NOT_RUN; no authenticated
session is available in this environment for the customer journey either. No Hermes, ToolBroker,
authentication or budget protection was disabled.


## 2026-11-15 — Mission 10 targeted repair

Structural source linkage alone previously allowed an `AGENT_FINDING` to become SUPPORTED when a policy did not require human review. Agent findings now require an authorized human decision even under such a policy; this does not establish semantic support automatically. Disposable local PostgreSQL QA: frozen install, typecheck, build, task02 (3297 assertions), backend (28), and agent-runtime (62, fixtures) PASS. The added task02 checks exercise the agent finding and authorized review with a deterministic QA-only source. Live World Bank, real Hermes and mission delivery were not exercised in this pass. Coolify reported Hermes restarting/unhealthy; Hatchet was healthy, but no new real dispatch was tested. Mission 10 end-to-end, capability 1 configuration and the existing source-to-claim semantic attribution remain unverified. No push, deployment, preproduction database change or production certification.

One commit per prompt was requested and created on feat/qeynox-2027-foundations. Main remains outside the execution scope. Rows 10–20 record the original source wave; later TASK and consolidation entries record the isolated-QA evidence now available and supersede their runtime-status wording where verified.

| Prompt | Source result | Runtime status |
|---|---|---|
| 10 | Sessions, workspace memberships, authentication guard | UNTESTED |
| 11 | Plan seals, step handoffs and next-step dispatch | UNTESTED |
| 12 | Hermes tool proposals mediated through ToolBroker | NATIVE TOOL ISOLATION BLOCKED |
| 13 | Connector manifests, World Bank indicator source adapter | NO LIVE PROVIDERS |
| 14 | Claim verification and source attribution | UNTESTED |
| 15 | ResultDocument versions, S3 artifact port, JSON/HTML | STORAGE NOT CONFIGURED |
| 16 | Versioned RaaS offers, quotes and free/paid gating | PAYMENTS UNCONFIGURED |
| 17 | Budget reservations, cost ledger, loop controls | RATES UNCONFIGURED |
| 18 | Business read models and authenticated polling API | UNTESTED |
| 19 | Incident records, operator actions, approval expiration | RUN OBSERVATION UNSUPPORTED |
| 20 | Source-level integration and immutable runtime selection | UNTESTED |
| TASK 02 | Migration runner, schema parity fixes, operator configuration services, isolated-QA verification | QA-VERIFIED IN DISPOSABLE DB |
| TASK 01 | Dependency install/lockfile, NestJS DI repairs, production build, isolated-QA backend HTTP certification | QA-VERIFIED (28 ASSERTIONS) |
| TASK 03 | Hatchet SDK contracts, dispatch/run-ID/cancellation/observation adapters, Hermes isolation gate + native-tool rejection, multi-step worker workflow, Soul/Pilot API wiring | QA-VERIFIED WITH LOCAL FIXTURES (62 ASSERTIONS); EXTERNAL HATCHET/HERMES RUNTIMES NOT VERIFIED |
| TASK 04 | Configured-provider ToolRegistry, egress/SSRF policy, provider rate limits, source snapshots, MCP/HTTP boundaries, World Bank real read-only activation | QA-VERIFIED (48 ASSERTIONS) WITH LIVE WORLD BANK READ; NO SECOND PROVIDER ADDED |
| TASK 05 | Evidence-backed claim verification, cited result assembly, human review, immutable delivery version, JSON/HTML exports | QA-VERIFIED (47 ASSERTIONS): REAL WORLD BANK READ → TRACEABLE DELIVERABLE WITH CITATIONS |
| CONSOLIDATION | Frozen install/typecheck/build + all five isolated-QA suites re-run; docs aligned; proven dead duplicate modules and dead DI wiring removed; historical commits and ADRs preserved | PASS: 3059 ASSERTIONS, NO RUNTIME/EXTERNAL CERTIFICATION CLAIMED |
| TASK 08A | Real isolated-MinIO artifact storage, private signed expiry, tenant isolation, safe PENDING_UPLOAD reconciliation, canonical JSON exports, pinned-DNS/private-address/redirect-hardened provider egress | QA-VERIFIED: 26 STORAGE + 47 EGRESS ASSERTIONS (REAL MINIO + LIVE PINNED WORLD BANK); PRODUCTION STORAGE/FIREWALL NOT VERIFIED |

NEXT SESSION HANDOFF: Do NOT add more product features before the requested separate verification phase. Dependencies are installed with a frozen lockfile, typecheck/build pass, and migrations, operator configuration, backend HTTP/DI, agent-runtime contracts, a controlled multi-step worker workflow, the reviewed World Bank connector, one evidence-backed RaaS deliverable and real MinIO artifact storage/downloads/reconciliation were verified only in disposable QA resources (the World Bank checks were real read-only public API calls through pinned egress; the Hermes endpoint was a local deterministic fixture). Still required: review auth/service wiring for pre-production, apply migrations to a controlled pre-production database, launch and certify real Hatchet dispatch/run observation and Hermes network/tool isolation, configure and certify production object storage, review provider licensing/freshness terms, then execute real sourced end-to-end RaaS work with customer-auditable policy. No customer data or production activity until these gates are passed.

GLOBAL: ISOLATED QA VERIFIED (MIGRATIONS + CONFIGURATION + BACKEND HTTP/DI + AGENT-RUNTIME CONTRACTS + WORLD BANK CONNECTOR + EVIDENCE-BACKED DELIVERABLE + REAL MINIO STORAGE/RECONCILIATION + PINNED EGRESS; CONSOLIDATION AUDIT PASS) / EXTERNAL HATCHET + HERMES RUNTIMES AND PRODUCTION STORAGE NOT VERIFIED / NOT DEPLOYED / NOT PRODUCTION-READY.

## Frontend foundation — 2026-11-13

### Subsequent mission workspace increment — 2026-11-13

Extended the existing mission page with operation/summary state, recorded step counts, paginated activity, full timeline (kind/date only; raw event payloads are not exposed), independent section errors, visible-page read-only refresh and Pilot next-action/overview. Added one nested result-document reader for findings, evidence status, citations, unresolved claims and limitations, plus existing JSON/HTML exports and expiring grant renewal. Soul displays consent-filtered context and offers explicit purpose-scoped grants, real-ID text fact save, confirmed local delete/revoke. Stop requests re-read the current operation version and never claim runtime cancellation. No backend source/endpoints, dependencies, Graphify rebuild or global audit.

Verification: frontend `typecheck` and production `build` PASS; expanded HTTP suite PASS with 50 assertions (test-first baseline failed on missing mission progress). Browser QA with an isolated fixture confirmed login, mission/result navigation and JSON/HTML export grant controls; screenshots at 1440×900, 1024×768 and 390×844 are in ignored `.tmp/mission-evidence/`. Mobile result and French mission/tablet views had no measured horizontal overflow. These are QA fixture images, never customer proof. A test run collided with the interactive preview port; the preview was stopped and automated smoke runs now select an ephemeral port.

Actual local integration at that time: BLOCKED — no configured QEYNOX_API_URL, QEYNOX_QA_DATABASE_URL or apps/web/.env.local, and no listener on loopback port 4000. No real backend mutation, external runtime or production data was exercised. Soul and stop mutations were contract-wired/typechecked only. No production certification, push or deployment performed. Approved screenshot comparison remains BLOCKED (reference PNG absent); no formal contrast/screen-reader certification claimed. **Superseded by the live integration verification recorded below.**

Remaining API gaps: customer goal/plan/attempt/approval detail and commercial readiness reads, consent metadata listing (returned consent IDs are used explicitly), artifact inventory, and document reassembly after evidence reassessment. No approval/delivery/start/redo controls are inferred from counts or raw events. Pre-execution Soul/Pilot conversations remain unavailable without real scope/attempt IDs. Export errors may require operator reconciliation after unknown outcomes; no blind retry is automated. Existing deployment gates remain unchanged.

Reused the locally committed Graphify/UX mapping in `07236ac`; Graphify was not rerun. Confirmed no pre-existing `apps/web`, then added one Next.js 16.4.6 / React 19.3.1 / TypeScript application within the existing pnpm/Turbo workspace. Canonical Professional Blue tokens, responsive shell, EN/FR copy, outcome-first home, MyDash, recent missions, mission detail, session login/logout and contract-validated draft creation are implemented. Browser tokens are not exposed: the web server uses an HTTP-only SameSite cookie and the existing bearer/workspace API contract. No backend source changed.

Verification: `pnpm install --frozen-lockfile`, `pnpm --filter @qeynox/web typecheck`, `pnpm --filter @qeynox/web build` and `pnpm --filter @qeynox/web test:smoke` PASS (26 HTTP assertions). The smoke suite exercises built EN/FR pages, anonymous/session boundaries, genuine empty/loaded/denied/malformed API responses and absence of bearer tokens in HTML, using an isolated test-only HTTP fixture. No unrelated backend QA suite, production database, external runtime, push or deployment was run.

Limits: no browser/keyboard/contrast screenshot certification; approved-reference comparison BLOCKED because `docs/design/reference/concept-02-professional-blue.png` is absent. Login/logout/draft mutations against a real backend were unverified at that point (superseded by the live integration verification below). Capability catalogue availability is unknown, not assumed configured. Planning, quotes, execution, full Library discovery and artifact delivery UI remain outside this foundation; their API gaps remain in the UX plan. All existing runtime, public-identity and production certification gates remain unchanged.

### Live frontend↔backend integration verification — 2026-11-13 (codex/mission-workspace, bd71b80 + fixes)

Verified the existing `apps/web` customer UI end-to-end against the existing NestJS API in a disposable local QA environment only: Docker `postgres:16.6` database `qeynox_web_qa`, real isolated MinIO artifact store, the real API (`apps/api`) on loopback and the production Next.js build (`apps/web`). No production or customer data, no external Hatchet/Hermes runtime, no paid service, no deployment.

Real workflows passing: real login and logout revocation; mission draft creation from the UI form; mission detail with live summary, full timeline, cursor-paginated activity (including a 56-event pagination fixture), Pilot next-action/overview; Soul consent grant → text fact save → read → confirmed delete → revoke; result-document reader for a real World Bank-sourced DELIVERABLE document (1 supported finding, real citation URI, limitation/unresolved states) with JSON/HTML exports and signed MinIO downloads; the RUNNING stop-request control (recorded `INTERRUPT_REQUESTED`, no claimed cancellation); EN and FR routes; desktop 1440×900, tablet 1024×768 and mobile 390×844 layouts with no horizontal overflow; zero browser console exceptions; no bearer token in page HTML or browser storage.

Evidence: 73/75 live API assertions PASS (the 2 failures are the same non-UI-blocking backend input-hygiene defect listed below); 44/44 live response-shape probes and 19/19 rendered-page probes validated against the exact frontend Zod schemas; 41 real-browser screenshots from Chrome via CDP. The seeded deliverable used one real read-only World Bank call mediated by ToolBroker plus real application services; it is disposable QA test infrastructure, never customer evidence or a product fallback.

Reproducible integration defects fixed (frontend only; no screen redesign, Professional Blue tokens/components unchanged): activity "next page" is only offered when a full page is returned (no dead link to an empty page); document and finding status badges are localized in EN/FR (no raw `DELIVERABLE`/`SUPPORTED` enum labels); explicit "none recorded" empty states for limitations/unresolved/next actions; the one known English Pilot recorded-state reason is translated in FR and unknown API text is shown verbatim. Focused checks after the fix: `pnpm --filter @qeynox/web typecheck`, production `build`, smoke suite (54 HTTP assertions, now also asserting localized document labels in EN/FR) and post-fix real-browser verification PASS.

Remaining non-blocking findings (reported, not fixed because they are outside this frontend integration-defect scope): a server-revoked but locally unexpired session renders the 403 `DENIED` page state without an in-page re-authentication action (Account sign-out/sign-in is required; documented 403 ambiguity); direct API calls with a malformed path id or non-numeric `after` cursor return 500 `INTERNAL_ERROR` instead of 400 `INVALID_INPUT` (unreachable from the UI, backend input hygiene); mutation response-shape failures would be reported as `INVALID_INPUT` rather than an unknown outcome (latent; all live contracts currently validate); non-JSON upstream bodies collapse to `UNAVAILABLE` (live repro blocked by the isolated environment). Contract gaps unchanged: customer capability catalogue, consent metadata listing, plan/attempt/approval detail and commercial readiness reads, artifact inventory, document reassembly after evidence reassessment, and no WAITING_APPROVAL UI fixture. Approved reference screenshot comparison remains BLOCKED because the reference PNG is absent. No push, merge, deployment or production certification.



## 2026-11-13 — Independent Coolify preproduction preparation

Operator explicitly authorized creation, code corrections, compatible main push and preproduction-only deploys. Nine distinct resources created in project gm3bynlnlsrkikanyzvxfew7 / preproduction girv53ul8pmfikflpxf9j2re; production remains empty. Full UUID inventory, capacity evidence, configuration and blockers: infra/PREPRODUCTION.md.

Source corrections: 2cb31f4 Docker context exclusions and outbound network split reused selectively; explicit server-only private-origin authorization for Web/API and Hermes; three root-context non-root production Dockerfiles; atomic shared Redis provider quotas with unavailable-store failure; guarded initial-only preproduction migration CLI; disabled versioned integration declarations. No connector activation or Hermes isolation attestation.

Fresh local disposable verification: frozen install, typecheck, build; QA task02 2874, backend 28, runtime 62, connectors 48, RaaS 47; real MinIO storage 26 and pinned egress 47 assertions. Private-origin and shared Redis checks passed; Redis AOF survived independent restart. Empty-target migration applied 11 migrations with production runtime, then rejected a nonempty target. External Hatchet/Hermes customer execution, VPS DNS/connectivity, production storage SSE, domains/TLS and public identity remain unverified. Do not infer VPS success from local QA.

Phase-2 runtime evidence: SSH unlocked by operator; VPS CPU/RAM/disk measured directly. Core, Redis, Hatchet DB, S3 and Hatchet Lite healthy; 11 canonical-LF business migrations applied atomically only to verified-empty preproduction. Redis authenticated and AOF persisted through restart. Private S3 bucket AES256 SSE-S3 enabled with separate preproduction KMS secret and bucket-scoped app user. Three final Docker builds and local API/Web startup, Docker-DNS HTTP call, non-root execution, offline pnpm and API restart checks passed. Application deployment/live connections are still pending at this code commit; Hermes customer execution remains blocked. See infra/PREPRODUCTION.md.

Phase-2 compatibility finding: the initial API deployment at 2782736 was rejected by Coolify's generated curl/wget healthcheck despite successful Nest startup. Added curl to API/Web images, preserving platform health validation. Optional AnythingLLM resource now exists but is stopped. Actual Hatchet diagnostic task completed (21744469-4441-45af-a9f7-13e37d6b0d87); VPS ToolBroker/World Bank QA passed 48 assertions in a separate disposable database with a dedicated non-superuser QA role. This does not enable client Hermes execution. Full application deployment retest follows.

## Final phase-2 result — authoritative status
See docs/architecture/PREPRODUCTION_VERIFICATION.md. All ten requested resources exist individually: eight running healthy, Hermes and optional AnythingLLM deliberately stopped. API/Web/worker actual deployed image tags all match 541a60d0a9e1fffe9b3756b5918f225f3666d75f. Native persistent aliases fixed application UUID DNS assumptions. Authenticated MyDash returned 200 and displayed the real DRAFT mission after restarts. API and worker PostgreSQL/Redis/S3/Hatchet connections were tested on VPS; real Hatchet infrastructure task and isolated World Bank QA passed. Private encrypted technical mission exports signed 200 / anonymous 403; no fake business result. Independent API restart preserved the mission. Production stayed empty. Public DNS/TLS, real Hermes provider+confinement and production certification remain blocked.

## 2026-11-13 — qeynox.io and public signed HTTPS exports

Public verification is recorded in PUBLIC_ACCESS_VERIFICATION.md and supersedes the earlier missing-domain/public-download blockers. VPS eth0 and four DNS resolver/authoritative checks agree on 31.97.158.141. Native Coolify domain https://qeynox.io applied only to Web; valid Let's Encrypt/TLS1.3 certificate observed. Real rendered login form POST returned 303 to /fr/mydash; authenticated MyDash and the existing mission returned 200. Existing DRAFT mission persisted.

Only Web, storage, API and worker were restarted, without application rebuild. Bucket-only Traefik routing on the same host preserves SigV4 Host/path; API/worker now load QEYNOX_ARTIFACT_ENDPOINT=https://qeynox.io. Actual encrypted HTTPS uploads/HEAD/downloads passed from both processes. Existing JSON/HTML exports signed 200 and correct hashes; anonymous and expired signatures 403. Download attachment, sandbox/no-store/nosniff/no-referrer protections are present. S3 console/admin and internal API were not published. DB/Redis host port bindings remain empty. Hermes/AnythingLLM still exited, production still empty, other projects untouched. Application images remain 541a60d. This is not independent production/public-identity certification.

## 2026-11-13 — Global platform administration foundation (Mission 01)

Added a strictly separated internal administration layer over the existing identity core: migration
0012 (platform assignments, sessions, audit; 0001–0011 untouched), platform role/permission model,
separate session namespace, fail-closed global guard with mandatory per-route access policy, explicit
CLI bootstrap, audited assignment/revocation API, last-administrator protection and read-only
support/operations diagnostics. Design and permission matrix: docs/architecture/PLATFORM_ADMINISTRATION.md.

Reuse: AuthService.verifyCredentials (same scrypt/lockout path) and identity credentials; no
credential or session code duplicated, and the platform port never reads workspace memberships.

Verification: API typecheck and production tsc build PASS; qa:platform-authorization PASS
(107 assertions — real service/guard against in-memory ports plus real NestJS HTTP wiring with an
unreachable database). Hardened after adversarial review: assignment/revocation commit atomically with
session revocation and audit, last-admin revocation locks and re-counts inside the transaction,
append-only audit trigger, fail-closed guard for declared policies without the platform marker, and
best-effort denial auditing. qa:platform-admin (isolated PostgreSQL HTTP e2e) is BLOCKED in this
environment: no QEYNOX_QA_DATABASE_URL and no reachable Docker daemon. It reports BLOCKED and is not
claimed as passing. No push, merge, deployment or production change was performed.

## 2026-11-14 — Platform user administration (Mission 02)

Added the platform user-administration API over the existing identity tables (no second
authentication system, no credential writes, no deletion): paginated directory with e-mail search and
status filter, user detail (registration date, workspaces/roles, status, session summary, activity),
session metadata, merged activity timeline, reversible suspend/reactivate with mandatory
justification and atomic audit, scoped session revocation, and any-of route policies
(ADMINISTRATION/SUPPORT/…/CONSULTATION) extending the Mission 01 guard. Migration 0013 adds four
additive indexes only; 0001–0012 are untouched. Invitations, e-mail verification and account recovery
are explicitly blocked (503 NOT_CONFIGURED) behind a not-configured EmailTransport port: no message is
sent and no account state changes.

Verification: API typecheck and tsc build PASS; qa:platform-users PASS (107 assertions — parts A/B real
service/guard/controller metadata and HTTP wiring; part C isolated-PostgreSQL e2e BLOCKED without
QEYNOX_QA_DATABASE_URL); qa:platform-authorization regression PASS (107 assertions). Hardened after
adversarial review: suspension and revocation share one enabled-administrator rule under a PostgreSQL
advisory transaction lock (no lockout path), both session namespaces are revoked atomically on
suspension/session revocation, platform sessions and roles are disclosed only to ADMINISTRATION, the
account timeline is restricted to lifecycle actions, and workspace counts only ACTIVE memberships. No push, merge or
deployment; no production data touched.

## 2026-11-14 — Workspaces & organisations (Mission 03)

Extended the existing identity_workspaces/identity_memberships into a full organisation API: paginated
organisation/member consultation with roles and lifecycle dates, invitation of existing identity
accounts without any fake e-mail delivery (single-use hashed acceptance token, delivery explicitly
BLOCKED), role changes, access revocation, explicit multi-workspace switching with session rotation,
last-enabled-owner protection (including refusal to suspend the last enabled workspace owner), and
session revocation when a member loses their last active membership. Migrations 0014 (lifecycle
columns/indexes) and 0015 (invitation tokens) are additive; 0001–0013 untouched. No second
organisation entity, no deletion.

Verification on a disposable PostgreSQL 16.6 instance: qa:platform-organizations PASS (87 assertions:
two organisations, cross-tenant refusal, invitations/decline/reissue/token acceptance, last-owner
guards, workspace switching and invalidated sessions, audit, preserved rows). Regressions re-run on the
same isolated database: qa:platform-admin PASS (70), qa:platform-users PASS (165). Sandbox note: the
harness cannot complete DROP DATABASE (checkpoint signal denied), so teardown logged a warning and the
disposable server was stopped and deleted manually; assertions ran against the real database.
No push, merge or deployment.

## 2026-11-14 — Soul onboarding (Mission 05, code-only)

Added the pre-mission Soul onboarding flow required before any mission exists. It lives in the existing
`apps/api/src/soul` module, `packages/roles/src/soul.ts`, the existing consents/user_contexts tables and
`apps/web`: no second onboarding and no MyDash rework. Migration 0016 adds one progress table per
user/workspace (status, step, locale, consent reference, dates; no answer content). The existing
`/v1/soul/converse` contract (operationId + attemptId) is untouched and never called pre-mission;
onboarding has its own operation-free routes under `/v1/soul/onboarding` (view, start, answer, skip,
consent, pause, resume, dismiss, complete) plus `GET /v1/soul/consents` and `DELETE /v1/soul/context` for
context consultation, edition, deletion and consent revocation. Answers are only written as
user_context facts after the explicit consent step; a refused/revoked consent blocks memorisation.
Guidance is deterministic and explicitly labelled (`deterministic: true`, `aiAvailable: false`,
reason PRE_MISSION_CONTRACT): no fake LLM conversation is produced.
> **Superseded on 2026-11-19 by Mission A05.** Those literals were unconditional and could not report a
> configured engine. The view now reports real readiness (`aiAvailable`/`aiReason`/`guidanceAvailable`),
> and an optional bounded guide layer exists. See the 2026-11-19 block and ADR-024. The claim below
> that guidance is always deterministic no longer holds; the claim that no fake LLM conversation is
> produced still does.
The web route `/[lang]/soul`
offers one useful question at a time (activity, objectives, language, needs, preferences), skip/pause/
resume/dismiss, direct MyDash access and the consented-context panel; first login redirects there
while onboarding is NOT_STARTED/IN_PROGRESS/PAUSED. The first objective is completed through the
existing mission creation contract (`POST /v1/operations`) and redirects to the existing mission page.
Platform administration now receives per-workspace onboarding status/step/dates only (no private
content), displayed in QeyNox Control user detail.

NOT VERIFIED (per Mission 04–09 FAST MODE: code only): no typecheck, build, migration run, QA suite,
screenshot or certification was executed for this lot. No push, merge or deployment.

## 2026-11-14 — Customer support via Chatwoot (Mission 06, code-only)

Chatwoot is integrated as the external support engine; no CRM, no second messaging system and no
message duplication in PostgreSQL. Migration 0017 adds only the account ↔ Chatwoot contact/
conversation mapping (`support_chatwoot_links`); conversations, messages, status, priority and
history are read live from the Chatwoot REST API by a server-only adapter
(`apps/api/src/support/chatwoot.client.ts`). Missing `QEYNOX_CHATWOOT_*` server variables leave the
integration NOT_CONFIGURED: API status endpoints return the explicit reason (variable names only,
never values), customer pages show a blocked state instead of a form, and no request can pretend a
message was delivered. The Chatwoot API token never reaches a browser. Customer routes
(`/v1/support/*`, workspace session) are scoped by the authenticated user + active workspace through
the mapping; a user cannot read or reply to another user's conversation. `/[lang]/support` and the
MyDash "Contact support" entry reuse the existing web shell; reply/history/status/priority are shown
live. The platform Support inbox lives in QeyNox Control (`/admin/{lang}/support`, nav visible only
with the existing SUPPORT permission); replies and status changes are audited. Chatwoot webhooks are
not required by this design (no message is persisted or state-synced); any future webhook must verify
a shared secret before writing. No Coolify resource was created or started.

NOT VERIFIED (FAST MODE): no typecheck, build, migration run, Chatwoot provisioning or certification
was executed. No push, merge or deployment.

## 2026-11-14 — Operations desk (Mission 07, code-only)

Added a read-only operations centre in QeyNox Control, gated by the existing OPERATIONS permission:
missions by status with cross-workspace read-model counts and attention, incidents and recovery
history (existing recovery_incidents/recovery_actions, read only), operation detail with summary,
runtime dispatch/executions/attempts and event history, runtime health facts (PostgreSQL SELECT 1
latency, schema_migrations facts, API uptime), deployed version/commit/date when the operator exposes
them, and platform anomalies from the existing platform audit (24 h, DENIED/ERROR). New read-only
endpoints live under `/v1/platform/operations/*` and reuse the existing operation summary/runtime
readers and operation_views/event_envelopes read models. No mutation route exists: no cancel, retry,
replay, redeploy or Docker command. A Coolify inventory adapter is included only as an optional
read-only GET adapter (servers/applications/services); without QEYNOX_COOLIFY_BASE_URL and
QEYNOX_COOLIFY_API_TOKEN it reports NOT_CONFIGURED; upstream failure reports UNAVAILABLE and never
fabricates metrics. Missing values are rendered UNAVAILABLE. No new monitoring engine, no automatic
redelivery, and no Coolify resource created or started.

NOT VERIFIED (FAST MODE): no typecheck, build, migration run, Coolify provisioning or certification
was executed. No push, merge or deployment.

## 2026-11-14 — Public website & SEO (Mission 08, code-only)

The public Home in apps/web was rebuilt as a Professional Blue showcase and complemented by
bilingual public pages: home, how-it-works, manifesto (from docs/product/MANIFESTO.md), contact,
legal notice, privacy, terms and cookies. Public pages use a new server-only PublicShell (no client
JavaScript; native details/mobile menu), semantic HTML and real product/limits content: no prices,
testimonials, invented legal identity or unverified promises. Legal identity, hosting, jurisdiction,
retention, DPO and public contact fields are visibly flagged as to be completed before publication
(docs/product/PUBLIC_LEGAL_CHECKLIST.md). Cookie page documents the actual cookies: public pages set
none, qx-session for the workspace app, qx-control-session for Control; no analytics configured.

SEO: server-rendered content, unique titles/descriptions per page, canonical URLs plus EN/FR/x-default
hreflang, Open Graph and Twitter metadata, data-driven sitemap.xml with language alternates,
robots.txt excluding authenticated/application routes, metadataBase, semantic headings and no raster
images or third-party fonts (system stack/inline SVG mark). MyDash behaviour and the existing
qeynox.io routing (next.config redirects) were not changed.

NOT VERIFIED (FAST MODE): no build, crawl, Lighthouse audit, typecheck or visual certification was
executed. No push, merge or deployment.

## 2026-11-14 — Release preparation: Control Docker, /admin routing, migrations (Mission 09)

Prepared the 01–08 candidate for integration without deploying. Inspected the real qeynox-web Coolify
resource read-only (project Qeynox, environment preproduction, branch main/commit 541a60d, Dockerfile
/infra/Dockerfile.web, port 3000, https://qeynox.io, health /en) and prepared a declarative
qeynox-control application payload (same GitHub repository, /infra/Dockerfile.control, port 3001,
domain https://qeynox.io/admin, health /admin/en, instant_deploy false, env keys only) plus manual
build/deploy/rollback documentation. QeyNox Control now uses Next.js basePath "/admin" with its route
tree at /[lang] so pages, server actions and /_next assets all live under /admin; the reverse proxy
only needs Host(qeynox.io) && PathPrefix(/admin) -> qeynox-control:3001, leaving web, private API and
signed S3 download routes untouched. Added infra/Dockerfile.control with the same pinned Node/pnpm
toolchain and added the apps/control importer to the pnpm lockfile for frozen installs. No PostgreSQL,
Redis, Hatchet, Hermes, storage, API or existing preproduction service is created or modified; no
Coolify resource/deployment, proxy change or migration was executed. Prepared the additive
migration procedure for populated databases (0012–0017 explicitly, backup/ledger/verification/
rollback; empty-database QA migrator prohibited). Static checks over 91 changed/untracked TypeScript
files: syntax OK, relative imports resolve. Candidate commits 01–03 are preserved.

NOT VERIFIED: no Docker build, candidate typecheck/build, migration execution, proxy validation or
deployment. The candidate branch is not pushed; origin lacks apps/control. No push/merge/deployment.

## Independent release audit (2026-11-14)

**NO-GO** for main and deployment. See [FINAL_REPAIR_CERTIFICATION_2026-11-14.md](FINAL_REPAIR_CERTIFICATION_2026-11-14.md) for observed checks, an intermittent backend failure, partial Support/Control repairs and remaining Soul, Coolify, migration and integration blockers. Historical verification entries remain scoped to their stated revision and environment.

## Final closeout continuation (2026-11-14)

MAIN and PREPRODUCTION remain **NO-GO**. The targeted Soul transaction and migration rehearsal passed; Chatwoot remains explicitly disabled, and browser/Control and operator migration-procedure gates remain open. See [FINAL_CLOSEOUT_2026-11-14.md](FINAL_CLOSEOUT_2026-11-14.md) for evidence and exact remaining work.

## 2026-11-19 — Mission A02: Hermes / Vertex inference contract

Read the upstream Hermes Agent source (`NousResearch/hermes-agent`: `agent/vertex_adapter.py`,
`hermes_cli/config_defaults.py`, `hermes_cli/auth.py`, `gateway/platforms/api_server*.py`) instead
of inferring the contract. Two findings changed the implementation:

1. `vertex` (aliases `google-vertex`, `vertex-ai`, `gcp-vertex`, `vertexai`) is a **first-class
   provider** with OAuth2 service-account/ADC auth. The 2026-11-16 note that claimed otherwise is
   corrected in `FAST_LIVE_QEYNOX.yaml` and `ADR-021`. No second inference gateway is built.
2. The wire contract differs from what the adapter assumed: hard failure is HTTP **502**
   `agent_incomplete`, soft partial/failed/cancelled turns are **200** with `finish_reason`
   `length|error|cancelled` plus a `hermes{completed,partial,failed,error,error_code}` object,
   `usage` is all zeros when unobserved, 401 is `gateway_auth_error`, 429 is
   `rate_limit_exceeded` with `Retry-After`, and `X-Hermes-*` headers repeat the same facts.

Implemented in `packages/engine`: `hermes-contract.ts` (pure classification/usage/redaction),
a rewritten `HermesAdapter` (disposition precedence where a failure flag always beats answer text,
timeout distinguished from cancellation, no outcome on any failure path, structured redacted
diagnostics), and `hermes-diagnostics.ts` (`/health`, `/v1/models`, `/v1/toolsets` probing with
isolation reported as *evidenced* only when no toolset is enabled). The API module now forwards
`HERMES_PRIVATE_ORIGIN` (previously worker-only) and an optional `HERMES_PROVIDER` hint.

VERIFIED IN ISOLATION (no model, no network, no database):
- `pnpm qa:hermes-contract` — 57 assertions across every documented response shape, the isolation
  gate, timeout-vs-cancel, native-tool refusal, redaction and classification precedence.
- `pnpm qa:hermes-live-selftest` — 15 assertions proving the live procedure's exit codes
  (BLOCKED 3 / PASS 0), the isolation gap, and that the API key never reaches the output.
- `pnpm typecheck`, `pnpm build`.

BLOCKED — NOT VERIFIED:
- **Real inference through Hermes to Vertex/Gemini has not been executed.** No operator Vertex
  credential and no reachable Hermes deployment exist in this environment. `pnpm qa:hermes-live`
  exits **3 (BLOCKED)**, which is the correct result and never a pass.
- `pnpm qa:agent-runtime`, `qa:connectors`, `qa:raas` require a disposable PostgreSQL that is not
  available here; they were not run in this pass (the adapter changes are not exercised by them
  beyond the local HTTP fixture, which the contract suite supersedes).
- Native-tool isolation and egress containment remain operator attestations requiring deployment
  review; server-side cancellation is not observable on this wire.

Procedure: `docs/architecture/HERMES_VERTEX_LIVE_RUNBOOK.md`. No credential was created, no
attestation set, no public exposure added, no deployment or merge performed.

## MISSION A03 — first operational business service (World Bank economic research)

Delivered: a reusable research service with an explicit request contract, a bounded plan, validated
operator configuration, and a QA gate that separates definition evidence from integration evidence.

Source:
- `packages/application/src/economic-research.ts` — request normalization/validation, deterministic
  plan construction, availability and plan creation.
- `packages/application/src/service-configuration.ts` — read-only validation of the six configuration
  domains with stable finding codes and remedies.
- `infra/operator/a03-economic-research.json` — the applyable configuration (repairs mission-10).
- `infra/operator/SERVICE_TEMPLATE.md` — the reusable service pattern.
- `apps/worker/scripts/qa-a03-service.ts` — the gate (`pnpm qa:a03-service`).

Repaired configuration defects (all present in `mission10-economic-research.json`):
`humanReviewRequired` false→true; `maxAgeDays` 365→180; budget that could not finish a retried
plan (`maxMoneyMinor` 500→4000, `maxAgentCalls` 12→24); offer `regions` `['FR','BE']`→`['GLOBAL']`
(the restriction was commercial, not a provider limit); no reviewed country/indicator allowlist.
`infra/connectors.registry.json` retains `world-bank: INACTIVE` with the reviewed adapter, licence and
activation gates recorded, so the declaration cannot be mistaken for an activated connector.

VERIFIED — configuration and request contract (no database, no network):
- `pnpm qa:a03-service` PART 1 — **49 assertions**: the six domains are internally consistent, every
  malformed or out-of-scope request is refused, the plan is deterministic, bounded and always
  requires approval, and every constraint the caller imposes is disclosed.

VERIFIED — integration against a disposable PostgreSQL 16.2 cluster (`QEYNOX_QA_DATABASE_URL`):
- the template applies and validates with **no blocker**;
- `POLICY_SKIPS_HUMAN_REVIEW`, `POLICY_PROVIDER_MISMATCH`, `POLICY_PROVIDER_DISABLED` and
  `BUDGET_EXHAUSTS_MID_PLAN` are each detected when the configuration is deliberately broken;
- cross-workspace operations are invisible (`NOT_FOUND`, never `DENIED`, so existence does not leak);
- the workspace budget policy materializes onto the operation and engine calls beyond the ceiling
  raise `BUDGET_EXHAUSTED`;
- the broker refuses a provider read for a capability that does not allow the tool (`DENIED`).
- `pnpm qa:agent-runtime` — **65 assertions PASS** (previously BLOCKED: no PostgreSQL).
- `qa:a03-service` total: **82 assertions** before the provider leg.

BLOCKED — NOT VERIFIED:
- **No live World Bank read was performed.** `api.worldbank.org` resolves but the TLS connection is
  refused by this environment's network policy. `pnpm qa:a03-service` therefore exits **3 (BLOCKED)**:
  provider provenance, response digest, human review and the DELIVERABLE were not exercised, and no
  fixture observation was substituted. `qa:connectors` and `qa:raas-deliverable` fail at the same
  layer for the same reason. On a host with provider egress the same command covers the full chain
  with exit 0.
- No Hermes/Vertex inference (A02 state unchanged). `qa:hermes-live` exits 3.

Regression: `pnpm typecheck` 4/4, `pnpm build` 4/4, `qa:runtime-readiness` 38+19,
`qa:hermes-contract` 57, `qa:hermes-live-selftest` 15, `qa:platform-authorization` 107,
`qa-task02` 3297, web smoke 91.

No merge, no deployment, no credential or attestation created.

## MISSION A04 — customer identity completion

Completed the lifecycle ADR-009 listed as follow-up work, without adding a second identity system.

Source:
- `packages/application/src/identity-lifecycle.ts` — token issuance/consumption, durable rate limiter,
  password reset with session revocation in one transaction.
- `packages/persistence/migrations/0018_customer_identity_completion.sql` — `identity_tokens`
  (digest-only, single-use, one live token per user+purpose) and `identity_attempts`.
- `apps/api/src/auth/{identity-lifecycle.service,identity.controller,auth.module}.ts` — six routes under
  `/v1/identity`; `AuthModule.forTest()` exists only for the QA harness.
- `apps/web/src/app/[lang]/account/{register,recover,reset,verify}` + account page states.
- `apps/api/scripts/qa-identity-lifecycle.ts` — the gate (`pnpm qa:identity`).

Design decisions (ADR-023): the transport's state is reported, never assumed; tokens are single-use
digest-only with atomic conditional consumption; anti-enumeration at equal status and body; the rate
limiter is PostgreSQL-backed with an advisory lock because process memory would multiply across
replicas; recovery revokes sessions in the token-consuming transaction; verification is surfaced but
does not gate login.

VERIFIED — configuration and contract behaviour (no database):
- `pnpm typecheck` 4/4, `pnpm build` 4/4.

VERIFIED — integration against a disposable PostgreSQL 16.2 cluster:
- `pnpm qa:identity` — **57 assertions PASS**. Covers: registration creating an unverified account;
  `NOT_CONFIGURED` transport reporting `sent:false` with `EMAIL_PROVIDER_NOT_CONFIGURED` while still
  issuing the token; anti-enumeration parity for unknown addresses; replay refused; **concurrent
  duplicate refused with exactly one winner**; **expired token refused and left unconsumed**; recovery
  rotating the credential and revoking 2 live sessions with the old password then rejected; replay of
  the consumed recovery token refused; cross-purpose token use refused; **suspension blocking the
  existing session, sign-in and recovery issuance**; **cross-tenant isolation** (one account's reset
  never touches another's session row) and workspace/platform separation re-proven after the new flows.
- `pnpm qa:task02` — **3399 assertions PASS** (schema/migration parity; the drift check caught two real
  defects during development: an undeclared CHECK and a redundant unique index).
- `pnpm qa:backend` 28, `qa:platform-users` 165, `qa:platform-admin` 70,
  `qa:platform-organizations` 87, `qa:platform-authorization` 107, `qa:agent-runtime` 65.
- Web smoke **112 assertions** (was 91): new registration, recovery, reset and verification routes in
  EN/FR, and the dead-link state is visible before any action is offered.

BLOCKED — NOT VERIFIED, AND NOT CLAIMED:
- **No e-mail was delivered.** No provider adapter exists. The CONFIGURED run uses an in-process
  recording transport that performs no network I/O; it proves token handling and truthful reporting,
  never delivery. `sent: true` means "a configured transport accepted the message".
- Real e-mail delivery, provider bounce handling, MFA and IP reputation remain operator/deployment
  gates requiring a reviewed adapter.
- Screenshot comparison against `docs/design/reference/concept-02-professional-blue.png` remains
  BLOCKED (reference image not present in the checkout).

No merge, no deployment, no credential, no production e-mail address and no real customer data.

## 2026-11-19 — Guided Soul onboarding (Mission A05)

Evolved pre-mission Soul onboarding from a deterministic questionnaire into an optional, bounded AI
conversation without weakening anything the deterministic flow guaranteed. The state machine
(`WELCOME → LANGUAGE → CONSENT → ACTIVITY → OBJECTIVES → NEEDS → PREFERENCES → FIRST_OBJECTIVE → DONE`)
is untouched and remains the only writer of progress, consent and facts. Full rationale and the
rejected alternatives: [ADR-024-guided-soul-onboarding.md](ADR-024-guided-soul-onboarding.md).

What changed:
- New `packages/roles/src/soul-guidance.ts`: `GuidedOnboardingService` over the existing `EnginePort`,
  plus pure `buildGuidanceMessage`, `fallbackQuestion`, `placeholderIdentity` and `looksLikeRefusal`.
- New route `POST /v1/soul/onboarding/guide` (message, attemptKey, optional history). It refuses on
  non-conversational steps, refuses after completion, returns `stepUnchanged: true`, and cannot write a
  fact or create an operation.
- `EnginePort.isAvailable?()` added; `HermesAdapter` implements it by mirroring `assertOperational()`
  with no network I/O. The onboarding view now reports real `aiAvailable` / `aiReason` /
  `guidanceAvailable` instead of the literal `deterministic: true / aiAvailable: false /
  aiReason: 'PRE_MISSION_CONTRACT'`.
- Web `/[lang]/soul` shows a truthful badge (`AI answer · READY` or `Deterministic guidance · <reason>`),
  a one-shot guidance panel labelled per message, and an optional "ask Soul for help" form only when the
  engine attested readiness. EN/FR copy added; the previous copy claimed "no language model is invoked"
  and was corrected.
- `POST /v1/soul/converse` is unchanged and still requires a real `operationId` + `stepAttemptId`.

Provenance model: every guidance result carries `source` (`AI` | `DETERMINISTIC_FALLBACK`), a reason
(`OK`, `ENGINE_NOT_CONFIGURED`, `ENGINE_UNAVAILABLE`, `ENGINE_TIMEOUT`, `ENGINE_REFUSED`, `ENGINE_EMPTY`,
`TURN_LIMIT`) and `aiGenerated`. Fallback copy is never labelled AI. Bounded: 12 customer turns per
conversation, 8 prior turns per prompt, 2000-character message, 15 s outer timeout, one model call per
attempt key (a retry returns the cached result). The model receives `context: {}` — consented facts are
never forwarded — and sees only answers already given plus the recent turns. Conversation turns are not
persisted: there is no second memory system.

VERIFIED — configuration and contract:
- `pnpm typecheck` 4/4, `pnpm build` 4/4.
- Rendered the three guidance states against a built server to confirm the badge and panel say what the
  backend reported (`AI answer · READY`; `Deterministic guidance · NO_ATTESTATION` with no ask form; a
  fallback reply labelled `Deterministic guidance` with `ENGINE_REFUSED` and its explanation).

VERIFIED — integration against a disposable PostgreSQL 16.2 cluster (rebuilt for this lot):
- `pnpm qa:soul-intelligence` (new) — **22 groups PASS**. Covers: truthful readiness from an
  unconfigured adapter; guidance refused on `LANGUAGE`/`CONSENT` with the step unchanged; guidance after
  declined consent writing no fact; declining the profile degrading to fallback instead of a 503;
  offline engine → `ENGINE_NOT_CONFIGURED` with zero operations; idempotent mission creation plus
  `CONFLICT` on a different objective; guidance closed after completion; AI path labelled AI with
  `context: {}` and namespaced placeholder ids; retry not calling the model twice; refusal →
  `ENGINE_REFUSED`; conservative refusal detection; French fallback from the record locale; hanging
  engine → `ENGINE_TIMEOUT` within the outer bound; empty and failed completions → fallback; turn
  ceiling making **no** model call; missing profile → fallback; prompt bounded to 8 recent turns and
  carrying no facts; attempt key scoped per workspace/user; **consent revocation removing grounding
  while the fact row survives**, with the mission still creatable afterwards; cross-tenant `NOT_STARTED`
  and `NOT_FOUND`.
- Regressions on the same cluster: `qa:task02` **3399**, `qa:identity` **57**, `qa:backend` **28**,
  `qa:agent-runtime` **65**.
- Web smoke **118 assertions** (was 112): the Soul page is now covered, asserting the fallback label,
  the real reason code, and that neither `PRE_MISSION_CONTRACT` nor a false "AI: available" is rendered.
  The fixture's consent row used `scope` where the contract is `scopes`; the page previously crashed on
  it, so the render was also hardened to survive a malformed consent row.

BLOCKED — NOT VERIFIED, AND NOT CLAIMED:
- **No provider call was made and no model output was ever produced in this lot.** Every AI-path
  assertion runs against a scripted in-process engine, so a green run proves the *contract*
  (labelling, bounds, fallback, isolation), never that a provider was reachable or that answer quality
  is acceptable.
- Live Hermes guidance remains an operator gate requiring a configured endpoint, API key and the
  native-tool isolation + egress attestations. Screenshot comparison against a design reference remains
  BLOCKED (no reference image in the checkout).

No merge, no deployment, no credential and no real customer data.

## 2026-11-19 — End-to-end mission execution (Mission A06)

Closed the mission lifecycle `GOAL → PLAN → APPROVAL → EXECUTION → TOOL EVIDENCE → HUMAN REVIEW →
RESULT` using the existing architecture: Hatchet stays the single durable executor, PostgreSQL stays
canonical truth, no second workflow engine and no new table. Rationale and rejected alternatives:
[ADR-025-mission-lifecycle.md](ADR-025-mission-lifecycle.md).

Four real defects were found and fixed (all caught by tests, not by review):

1. **`INTERRUPT_REQUESTED` was a terminal trap.** Nothing ever left it, and the read model mapped it to
   attention `NONE`, so a stopped mission silently vanished from the customer's screen.
2. **`FAILED`/`INTERRUPTED` had no retry path at all.**
3. **The worker collapsed every failure into `ENGINE_OR_TOOL_ERROR`**, so an unknown external write was
   indistinguishable from a clean failure — the exact confusion that duplicates side effects.
4. **Progress was derived ad hoc in several places** and could disagree with the persisted status.

What changed:
- `InterruptionService` (new): `reconcile` confirms a stop only when no attempt, dispatch intent or
  tool write is unresolved, reporting the specific blocker otherwise; `retry` re-dispatches a failed
  attempt reusing its existing identity, and refuses outright when a tool write or dispatch outcome is
  `UNKNOWN`. Both are transactional with row locks and status guards.
- `POST /v1/operations/:id/interrupt/reconcile` and `POST /v1/operations/:id/retry` (operator-gated;
  the role check runs before any status read).
- `lifecycle-view.ts` (new): one pure derivation of attention, milestone and provisionality from
  persisted status, consumed by `OperationReadModels` and the MyDash decision list. Milestones are
  complete only when the status proves them; `RUNNING` and `INTERRUPT_REQUESTED` are flagged
  `provisional`; `INTERRUPTED` is now attention `STALLED` and reaches the customer's decision list.
- Worker: real error codes propagate, unknown outcomes emit `STEP_OUTCOME_UNKNOWN`, and
  `DomainErrorCode` gained `UNEXPECTED_EXECUTION_ERROR` (500) so the generic bucket is explicit.
- `controls.decideApproval` now reports a superseded plan as `STALE_APPROVAL` and records the decision.

VERIFIED — configuration and contract:
- `pnpm typecheck` 4/4, `pnpm build` 4/4.

VERIFIED — integration against a disposable PostgreSQL 16.2 cluster:
- **`pnpm qa:mission-lifecycle` (new) — 14 groups, 88 assertions PASS.** Three-step plan executed in
  strict dependency order with one output and one dispatch intent per step and no duplicate dispatch;
  durable attempt/execution-link tracking; concurrent approval decision with exactly one winner
  (`CONFLICT` for the loser); approval for a superseded revision refused after interrupt → reconcile →
  revise; result document attributed to claims with delivery refused for unverified evidence;
  lifecycle derivation checked against every status (only `COMPLETED` shows all milestones complete);
  stop requested while work is outstanding stays unresolved with a named reason, is refused by the
  worker, then reconciles to `INTERRUPTED` once the attempt is terminal; retry reuses the attempt
  identity, concurrent retries yield one intent, and retry is refused after an unknown tool write or an
  ambiguous dispatch; worker failure propagates its real code as `STEP_FAILED`; budget exhaustion ends
  terminally with the policy cause recorded; timed-out workflow ends in a recoverable state with the
  timeout recorded; tenant isolation of operation, projection and interruption control.
- Regressions on the same cluster: `qa:task02` **3399**, `qa:identity` **57**, `qa:backend` **28**,
  `qa:agent-runtime` **65**.
- Web smoke **121** (was 118): an interrupted mission is asserted to appear in the decision list.

BLOCKED — NOT VERIFIED, AND NOT CLAIMED:
- **No Hatchet server ran.** This environment has no container runtime and cannot reach `ghcr.io`, so
  `hatchet-lite` cannot be started. Dispatch was exercised through a recording `OrchestratorPort`
  double, which proves the dispatch *decision logic* (leasing, single intent per step, `SENT`/`UNKNOWN`
  recording, no blind replay) and proves nothing about live Hatchet scheduling, its own retry
  semantics, gRPC cancellation acknowledgement or `runs.getDetails` observation.
  **Live dispatch, live cancellation and live run observation remain NOT VERIFIED.**
- `qa:connectors` and `qa:raas` fail in this sandbox with a TLS socket disconnect against a live
  provider. The same failure reproduces on the untouched baseline, so it is an environment gap, not a
  regression from this lot; both remain NOT VERIFIED here.
- Hermes was a deterministic local HTTP fixture, not a model. No business result, citation or price is
  claimed anywhere; every fixture answer is labelled QA-only.
- Screenshot comparison remains BLOCKED (no reference image in the checkout).

No merge, no deployment, no credential and no real customer data.

---

## MISSION A07 — Atlas results experience (branch `arena/eb110693-qeynox`)

Scope: make the existing mission result reader a complete, honest results experience, without adding a
second application. The route, the `ResultDocument` contract and the artifact delivery path are
unchanged (see the A07 amendment in `ADR-014-results.md`).

DELIVERED:
- **One classifier** (`packages/application/src/result-classification.ts`) shared by the API view, the
  HTML export, the PDF export and the reader: `VERIFIED` / `AI_INTERPRETATION` / `UNRESOLVED` /
  `AWAITING_ASSESSMENT`. It can only demote — a `SUPPORTED` finding without a verifiable http(s)
  citation becomes `UNRESOLVED` with a stated blocker — and it is total over unknown statuses. An
  unreviewed claim is never rendered as a verified conclusion in any surface.
- **One document verdict** (`documentVerdict()`), stated once per document, so no page or export can
  imply a stronger claim than the persisted state supports.
- **Atlas reader** (`apps/web/src/components/atlas.tsx`) on the existing results route: verdict →
  scope → verified → unresolved → awaiting assessment → AI interpretation → limitations →
  provenance → review/version. Provenance and review always render, even when empty. Class identity is
  carried by headings and text labels, never by colour alone; sections are landmarked with `h2` +
  `aria-labelledby`; jump links; no information depends on hover.
- **PDF export** (`pdf-lib`, deterministic) alongside JSON and HTML, on the existing
  `export/:format` endpoint; `reconcilePending` now re-derives `application/pdf` too.
- **Two defects found by the new QA and fixed**: the generator crashed with `WinAnsi cannot encode`
  on any non-CP1252 character, and lines drawn after the last section could land below the bottom
  margin and be invisible on paper. Non-encodable characters are now substituted with `?`, counted,
  and disclosed on the exported page; the HTML and JSON exports keep the exact original text.
- **One privacy leak found and fixed**: a citation URI carrying `user:password@` was rendered
  verbatim in the reader, HTML and PDF. It is now redacted in every display surface and never made
  clickable; the "not verifiable" marker is preserved so redaction cannot strengthen a weak citation.

VERIFIED IN THIS ENVIRONMENT:
- `qa:atlas-results` — **10 groups, 150 assertions PASS**, against an isolated PostgreSQL database and
  the real generators: classifier totality/conservatism, verdict honesty, JSON byte-stability, HTML
  byte-stability, PDF determinism, PDF structural validity and pagination, HTML escaping and event-
  handler injection, credential redaction, tenant isolation of read/export/reconcile (a real id and a
  fake id are indistinguishable to an outsider), superseded-revision refusal, deterministic PDF
  reconciliation.
- Web smoke — **137 assertions** (was 121), including: the reader exposes each section, an unreviewed
  document is never presented as a reviewed result, the verified section contains only the
  verifiable finding, credentials never reach the page, and all three export formats are offered.
- Regressions on the same cluster: `qa:task02` **3399**, `qa:identity` **57**, `qa:backend` **28**,
  `qa:agent-runtime` **65**, `qa:mission-lifecycle` **88**, `qa:platform-admin` **70**,
  `qa:platform-users` **165**, `qa:platform-organizations` **87**, `qa:platform-authorization` **107**,
  `qa:runtime-readiness` **38**, `qa:hermes-contract` **57**, `qa:soul-intelligence` **22 groups**.
- `pnpm typecheck` 4/4, `pnpm build` 4/4.

BLOCKED — NOT VERIFIED, AND NOT CLAIMED:
- **No browser and no PDF viewer ran.** The PDF assertions prove structure, content, determinism and
  pagination count, not visual layout or print fidelity. PDF visual fidelity remains NOT VERIFIED.
  Responsive behaviour at mobile/tablet/desktop widths is implemented with CSS grid/`clamp` and a
  768px breakpoint but was not visually confirmed.
- `qa:storage` stays BLOCKED (no S3 endpoint): signed-URL expiry, bucket privacy and SSE are unchanged
  and still uncertified here. Artefact upload in `qa:atlas-results` uses an in-memory store double.
- `qa:a03-service` PART 2 BLOCKED and `qa:egress` fails with a TLS socket disconnect against a live
  provider — the same environment gap as previous lots, not a regression.
- No Hatchet server: live dispatch/cancellation remain NOT VERIFIED (unchanged from A06).

No merge, no deployment, no credential and no real customer data.

---

## MISSION A09 — Platform administrator configuration support (branch `arena/e253f733-qeynox`)

The Control console can now read and change the operator-scoped business configuration —
capability slots, agent profiles, tools, verification policies, offers with their **tax
treatment**, and budget policies — reaching the *same* `ConfigurationService` engine used by the
workspace operator path, through an audited platform route. There is no second, divergent engine.

- **Contracts**: additive `platformConfigurationQuerySchema` / `platformConfigurationApplySchema`
  (explicit `workspaceId`, mandatory 10–500 char justification, idempotency key, 1–64 strict
  entries) in `@qeynox/contracts`. No existing schema changed.
- **Engine**: `apply()` accepts an optional same-transaction audit callback (committed with the
  configuration mutation and its idempotency record — an applied bundle can never exist without its
  audit row). `state()` accepts an explicit `bypassOperatorGate` for reads **only**: platform
  `CONSULTATION` + an existing workspace row authorizes reads, so the console can report a
  not-yet-configured deployment; mutations never bypass. The returned offers now surface `taxPolicy`
  and `label`.
- **Platform route** (`/v1/platform/configuration`): `GET` (`CONSULTATION`), `POST preview`
  (dry run, `ADMINISTRATION`), `POST apply` (`ADMINISTRATION`). Both mutating routes still pass the
  unchanged operator gate: `QEYNOX_OPERATOR_USER_IDS` must be set (fail closed `NOT_CONFIGURED`
  otherwise), the acting identity must be allowlisted, and it must hold an ACTIVE
  `OWNER`/`ADMIN`/`OPERATOR` membership in the target workspace — read from `identity_memberships`,
  never fabricated. A platform session is never promoted to a workspace session: no workspace token
  is minted; an in-memory principal is synthesized with the actor's real membership role.
- **Audit**: every success and every denial lands in append-only `platform_admin_audit`
  (`READ/PREVIEW/APPLY_PLATFORM_CONFIGURATION`). Guard denials, engine denials, validation
  rejections and idempotent replays are all recorded; apply audit rows carry `workspaceId`,
  justification, idempotency key, digest, `alreadyApplied` and the per-entry change outcomes.
- **Control**: new `/admin/[lang]/configuration` page — live state (slots, profiles, tools,
  verification policies, offers with tax badges, budget policies) and a preview → explicit
  confirmation → apply flow with a stable idempotency key, all server actions zod-validated.
  Settings page now shows the platform endpoint next to the workspace endpoint; nav entry added
  (EN/FR copy). `PLATFORM_ADMIN` (ADMINISTRATION) manages; AUDITOR reads; SUPPORT/OPERATIONS are
  denied and audited.
- **Tax honesty**: there is no tax-rate store anywhere in the system. Tax is a two-state
  declaration on the offer (`CONFIG_REQUIRED`/`CONFIGURED`), enforced by the engine at activation
  and by the commerce path. A09 surfaces and makes it actionable; it does not invent rates.

VERIFIED IN THIS ENVIRONMENT:
- `qa:platform-configuration` — **70 assertions PASS** against an isolated PostgreSQL database:
  read/mutation permission split, SUPPORT/OPERATIONS/AUDITOR denial, workspace-bearer and
  platform-bearer isolation, unknown/malformed workspace, operator-gate double check (no
  membership, allowlist unset, non-allowlisted actor), dry-run writes nothing, apply digest equals
  preview digest, idempotent replay, conflicting-key refusal, ACTIVE offer refused with
  `CONFIG_REQUIRED` tax, version immutability, budget supersession, state read-back with tax and
  label, same-transaction audit rows, denial audit rows, zero configuration records for refused
  applies.
- `pnpm typecheck` 4/4 and `pnpm build` 4/4 PASS. Web (`qa:stripe-payments` 17 groups/108,
  `qa:soul-intelligence` 22 groups, `qa:mission-lifecycle` 88, `qa:atlas-results` 150,
  `qa:identity` 57, `qa:runtime-readiness` 38, `qa:hermes-contract` 57, `qa:task02` 3695,
  `qa:backend` 28, `qa:agent-runtime` 65, `qa:platform-admin` 70, `qa:platform-users` 165,
  `qa:platform-organizations` 87, `qa:platform-authorization` 107) all PASS.
- Control page rendered against a real API + database: HTTP 200, live tables show an applied tool,
  capability, ACTIVE offer with `CONFIGURED` tax badge and budget policy, and `platform_admin_audit`
  records the reads and applies. No browser was driven; the interactive form is covered by the API
  e2e suite plus typecheck/build, not by a UI automation run (none exists in this repo).
- `qa:raas` remains BLOCKED on the same pre-existing TLS disconnect against the external provider
  (reproduced on unmodified baseline before). Not rerun here.

No merge, no deployment, no credential and no real customer data.

## MISSION A08 — Stripe commercial integration (branch `arena/91ddb82a-qeynox`)

Scope: secure one-time payments for versioned RaaS offers through the existing `PaymentPort`. No
subscriptions. Configuration and operating notes: `docs/architecture/STRIPE_PAYMENTS.md`.

DELIVERED:
- **`StripePaymentProvider`** (`stripe-payments.ts`): test-mode-only adapter, pinned API version, manual
  capture so authorization and capture are separate auditable steps, amount/currency reconciled against
  the quote before any state is recorded, no SDK retries (idempotency keys own retries).
- **`PaymentService`** (`payment-service.ts`): checkout idempotency, single-live-payment enforcement,
  webhook verification and application, ordered/deduplicated event ledger, capture, capped refunds,
  reconciliation, and the customer read model.
- **Webhook route** (`apps/api/src/commerce/payments.controller.ts`): public by signature, raw-body
  verified, `rawBody: true` enabled in `main.ts`.
- **Migration `0019_payments.sql`** + Drizzle schema: `raas_payments`, `raas_refunds`, extended
  `raas_payment_events`, with a partial unique index and CHECK constraints enforcing the money invariants
  in the database.
- **Payment UX** (`payment-panel.tsx`): every state named with a next step, checkout button only when the
  server says checkout is possible, idempotency key stable across retries, `?payment=returned` treated as
  wording only.

DEFECTS FOUND AND FIXED DURING VERIFICATION:
- `assertExecutionAllowed` reported an unpaid order as `PAYMENT_NOT_CONFIGURED` — conflating "you have not
  paid" with "we cannot take money". Now `PAYMENT_REQUIRED`, with `DISPUTED`/`CANCELLED` distinct.
- `confirmReturn` originally called `reconcileOrder`, which writes state — violating its own rule that a
  redirect never changes anything. It now performs a read-only provider lookup and returns what the
  provider says alongside the recorded state.
- The QA provider double reused one payment-intent id per order; the unique index caught it, and the
  double was made accurate (real Stripe mints a new intent per session).

VERIFIED IN THIS ENVIRONMENT:
- `qa:stripe-payments` — **17 groups, 108 assertions PASS** against an isolated PostgreSQL database:
  fail-closed provider, live-key refusal, real HMAC signature accept/reject (forged, tampered, truncated,
  wrong-secret, stale), checkout idempotency and concurrent races, unsigned webhook refusal, duplicate and
  concurrent-duplicate delivery, late/out-of-order events, orphan events, failed/expired/cancelled/disputed
  states, capture idempotency, refund capping/idempotency/failure, expired-quote and mutated-amount
  refusal, redirect-is-not-proof, tenant isolation, ledger integrity.
- `qa:task02` **3695** (was 3399) — the migration/index/constraint declaration guard now covers the A08
  tables.
- Web smoke **146** (was 137): a declined payment is named and recoverable, never shown as paid; an
  unconfigured provider is stated plainly with no checkout button.
- Regressions: `qa:backend` 28, `qa:agent-runtime` 65, `qa:mission-lifecycle` 88, `qa:atlas-results` 150,
  `qa:platform-admin` 70, `qa:platform-users` 165, `qa:platform-organizations` 87,
  `qa:runtime-readiness` 38, `qa:hermes-contract` 57.

BLOCKED — NOT VERIFIED, AND NOT CLAIMED:
- **Stripe was never contacted.** All provider behaviour comes from a deterministic in-process double.
  Live test-mode Stripe, real webhook delivery, dashboard configuration and error semantics are NOT
  VERIFIED. Signatures are real HMAC verified by the Stripe SDK, which is the one part exercised for real.
- **No browser ran.** The redirect to the hosted checkout page and the card UI are NOT VERIFIED.
- `qa:raas` fails with a TLS socket disconnect against the World Bank provider. Confirmed pre-existing by
  reverting the A08 commerce change in place and reproducing the identical failure.

No merge, no deployment, no credential and no real customer data.
