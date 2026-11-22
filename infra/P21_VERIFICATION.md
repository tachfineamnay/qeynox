# P21 — execution authority and revocation boundaries

Date: 2026-11-22. Base: `32d298f63ada4bb3e31830127788fd035e49c996`.
Branch: `arena/ea9c3f46-qeynox`.

## Preserved, not replaced

`PgToolAuthorization` retains its existing PostgreSQL membership/operation/attempt/revision,
capability/profile allowlist, reviewed-provider resolution, exact WRITE approval and active-consent
checks. ToolBroker still authorizes after rate-limit and durable ledger waits, immediately before
connector entry. Existing PostgreSQL beta admission/reservation locks, finite budgets, tool intent /
idempotency ledger, Worker PENDING claim, Hatchet ownership, runtime/native-tool isolation and
configuration immutability remain. No new execution platform, provider, WRITE adapter or scheduler.
Stripe's frozen commerce state and BETA_FREE / INVITE_ONLY are unchanged.

## Confirmed missing guarantees and source changes

| Gap | Completion |
| --- | --- |
| Membership checked at executor entry, not every inference turn | New short canonical admission before **each** engine dispatch; membership/user, mission, revision, attempt, capability and profile are re-read after budget waits. |
| Beta revoked between reservation and tool/inference invocation | Final admission checks the latest mission grant plus the reservation's SPEND_RESERVED event on that same grant. A RESERVED row alone is not permission. Existing budget locks still own quota/spend ceilings. |
| Long inference retains consented document excerpts | Prepared documents bind original consent IDs/versions, document/chunk IDs and content hashes. Each inference/tool boundary checks consent, attachment, retention, availability, attaching member and profile context permission. Revocation/regrant cannot silently revive old bindings. |
| Prior step output can contain document-derived text | Bindings are carried in document grounding and combined with dependency output bindings. Legacy document-grounded outputs with no authority binding fail closed; they require newly authorized execution, not guessed consent. |
| Same attempt ID can become RUNNING again after retry | Existing StepAttempt.version is the epoch. Worker claim compares the observed PENDING version; engine/tool admissions require the claimed version; completion and failure handling cannot overwrite a resumed epoch. |
| Inference budget idempotency returns an existing reservation, permitting duplicate dispatch | Existing PostgreSQL command-id uniqueness supplies a durable inference admission per reservation. A second worker cannot use the same reservation to send another inference. No expiring lock permits replay after a crash. |
| Tool failure records UNKNOWN for WRITE but propagates an ordinary error | Broker now propagates UNKNOWN_OUTCOME after connector entry, including failure to record its ledger acknowledgement. Worker records an UNKNOWN attempt, not a clean FAILED attempt. |
| A new retry/revision can encounter an unresolved earlier WRITE | Mission admissions refuse other STARTED/UNKNOWN WRITE ledger entries, across revisions; only the current intent is excluded from its own check. Reconciliation is required; no automatic clearing/replay. |
| Denied/duplicate tool brokerage can settle another worker's reservation | Broker distinguishes NOT_STARTED failures. The executor does not settle a competing/denied pre-dispatch reservation. Existing holds remain conservative; no financial history is erased. |
| Advisory calls and retrieval can outlive the HTTP membership/profile snapshot | Soul context reads, direct document search, Soul converse and production Soul/Pilot advisory wiring recheck active membership. New advisory inference also checks its active versioned profile and original stored-fact consent bindings. |

### 1. New mission inference

Worker claims a PENDING attempt once, using its observed version as a compare-and-set condition.
Before private context preparation and before each engine call, `PgExecutionAuthority` requires:

* active owner workspace membership and a non-disabled identity;
* RUNNING operation, matching current revision, RUNNING attempt at the claimed epoch, actual step /
  capability relation, ACTIVE versioned capability and selected active business profile;
* current required consent scopes and any original prepared-context bindings;
* active, unrevoked, unexpired mission beta admission;
* no unresolved earlier WRITE;
* ACTIVE required tool configurations (if this capability requires providers);
* a scoped, still-RESERVED engine reservation and its matching beta reservation event.

The durable `inference:<reservationId>` command marker is **ADMITTED**, not proof of provider entry or
success. A crash between admission and send cannot be distinguished from a sent request without
provider evidence. The marker cannot be reused; the reservation stays held until a separately
reviewed reconciliation. No timeout or lease expiry authorizes automatic replay.

### 2. Context retrieval and reuse

Mission passages require current membership and `context:read` inside the vault, not merely a caller's
run-start boolean. Retrieval rechecks original consent versions and attachment eligibility after
optional embedding waits. The Worker supplies its mission authority gate before optional query
embedding dispatch. No DB lock is held during embedding. Missing consent continues to withhold
passages rather than fabricate context. New inference receives only still-authorized bound excerpts.

Every subsequent inference turn rechecks bindings even when the prompt/history was prepared earlier.
Detached/deleted/expired documents and revoked attaching memberships cannot license another dispatch.
Bindings include hashes, not private excerpt text. Existing still-citable checks and private storage
boundaries remain. This does not claim bytes already sent to an admitted external inference can be
retracted or erased remotely.

User-requested Soul/Pilot **advice** is a distinct boundary, not mission execution. Onboarding can
exist before a mission/beta admission. Advice does not launch an operation, broker tools or bypass
mission spend/beta authority. Its production call sites recheck membership/profile and any bound
stored-fact consent immediately before inference; pure advisory ports retain optional injected gates
for isolated fixtures. This change does not introduce beta mission consumption for pre-mission advice
or claim distributed idempotency certification for advisory caches.

### 3. New external tool calls

All P48/P19 `PgToolAuthorization` decisions remain. A final short snapshot additionally checks the
attempt epoch, capability version, current beta grant/reservation, bound context and ACTIVE provider
configuration. WRITE approval is checked again in that snapshot for exact workspace / mission /
revision / attempt / intent and expiry. Approval cannot authorize a different invocation. Only the
existing reviewed READ adapters are deployable; there is no newly activated WRITE provider.

Existing tool intent/idempotency uniqueness remains the cross-worker duplicate barrier. A duplicate,
refusal, timeout during authorization or stale epoch never enters the connector. No arbitrary
run-start PermissionContext can stand in for canonical authority in the deployed executor.

### 4. External WRITE already admitted / in progress

Admission and remote send cannot be made atomic by a PostgreSQL lock. The authority boundary is the
**fresh PostgreSQL snapshot**, not a promise about remote packet ordering. Revocation committed before
that snapshot refuses a new dispatch. Revocation after it applies to the **next** call; the already
admitted bounded call may still finish, even if the remote server receives it after revocation.

Snapshots are not reusable bearer permissions: admissions exceeding a 2-second freshness bound are
refused, including a slow commit/claim wait. Consent/grant/WRITE approval expiry is checked again at
the end of the admission. The bound limits stale DB work; it is **not** a claim to remotely revoke
an admitted action. Wall-clock/probe/remote ordering and overload behavior need P22 evidence.

A known, successfully recorded provider response remains historical COMPLETED evidence and can still
settle cost after revocation. The executor rechecks authority before another call or using results
for further execution. A failed/timed-out/invalid or unacknowledged WRITE after connector entry is
UNKNOWN_OUTCOME; its ledger is UNKNOWN where persistence succeeds. If persistence is unavailable,
STARTED itself remains a blocker. No clean failure, automatic resend, refund, rollback of the external
side effect, or successful remote cancellation is inferred. Interrupted/stopped missions are not
allowed to start another inference/tool call merely because a previous call was admitted.

## Transactions / epochs

Authorization uses short repeatable-read PostgreSQL transactions, 5-second per-statement timeouts,
a 2-second freshness bound and (for the inference claim) a 2-second lock-wait bound. Transactions end
before engine/connector/embedding network requests. No network callback executes inside them.
Attempt version plus current revision already supply the needed fencing; no new schema migration,
global revocation epoch, long-lived authorization cache or lease-renewal subsystem was added.
Expired admissions fail closed and are never recycled automatically.

## Verification actually performed

Requested basic compilation only:

* `pnpm install --frozen-lockfile` — PASS, lockfile unchanged (Corepack pnpm 9.15.9).
* `pnpm typecheck` — PASS, six tasks plus release tooling.
* `pnpm --filter @qeynox/api build` — PASS.
* `pnpm --filter @qeynox/worker build` — PASS.
* `git diff --check` — PASS.

Added `apps/worker/scripts/qa-execution-authority.ts` as a **not-executed** disposable-PostgreSQL
regression entry point for P22 (membership/consent/beta/revision/status/attempt epoch/config/profile,
expired approval, unresolved WRITE and duplicate inference admission). It uses the existing local-only
isolated database lifecycle and no external provider calls. Existing PostgreSQL authorization script
assertions were not removed or weakened. All fixture callers of canonical PgToolAuthorization now
need real versioned step/capability/profile, beta admission, epoch and spend-reservation inputs; no
production bypass was added to preserve outdated synthetic fixture assumptions.

No database queries/migrations, QA/tests, browser runs, live inference/tool/WRITE calls, revocations,
provider/storage changes, deployment/restart or payment operation were executed. Compilation does
**not** certify SQL behavior, two-worker interleavings, revocation ordering, pool stalls, retries,
crashes, private-context isolation, real provider outcomes or external cancellation. Full concurrency
and end-to-end authority certification remain **P22**, including independently verifying no network
runs under locks, slow-admission refusal, exact financial settlement/holds, legacy fixture provisioning
and stale worker completion/failure races. No production-ready or live concurrency PASS is claimed.
