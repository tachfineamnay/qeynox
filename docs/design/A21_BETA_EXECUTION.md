# MISSION A21.03: Free beta execution authorization

Status: implemented on branch `arena/45f55f1b-qeynox` (off `74f25d5`), verified on disposable real PostgreSQL 14.1. Draft PR, not merged, not deployed.

Builds on A21.01 (hard payment freeze, `QEYNOX_COMMERCE_MODE`) and A21.02 (invite-only beta grants and the mandatory launch and spend gate).

## Decision

During the free beta, eligible testers can run all eight A16 business packs without paying. They do not get a fake payment. Instead they get a **distinct, non-financial beta authorization**:

- **Separate record.** The authorization lives in its own table (`raas_beta_authorizations`), never in `raas_payments`. No payment, invoice, checkout session, refund or provider object is created for it.
- **Its own order states.** The order moves to `BETA_AUTHORIZED` and then `BETA_DELIVERED`. It never becomes `AUTHORIZED`, `DELIVERED`, `PAID` or `CAPTURED`, so a beta order cannot be mistaken for revenue. The payment read model keeps `executionAuthorized=false` for beta orders.
- **Commercial contract unchanged.** The quote, the published price, the offer version, the scope hash, the terms acceptance and the revision binding all stay as they were. The order keeps its published `amount_minor`. The authorization records the same list price and pins `amount_due_now_minor` to `0` with a database CHECK.
- **Exact binding.** Each authorization is bound to one workspace, operation, plan revision, quote, acceptance, order, scope hash, offer and version, terms version, and the beta grant that was ACTIVE when it was created.
- **Re-checked at every use.** The authorization is evaluated again at execution start, retry, redo and result delivery, and on every read model. Each check verifies:
  - the mode is `BETA_FREE`;
  - the linked grant is ACTIVE and not expired;
  - the revision is still current;
  - every binding still matches the quote and acceptance;
  - the result was not already delivered.
  
  Revoking or expiring the grant, changing the plan, or switching the server back to `PAYMENTS_DISABLED` stops further work immediately.
- **Other controls unchanged.** Consent, budgets, the A21.02 quota, concurrency and spend gates, ToolBroker permissions, runtime readiness and the human `RESULT_REVIEW` approval all still apply. The beta authorization only replaces the *payment* precondition.
- **Freeze unchanged.** `BETA_FREE` still freezes all payments (A21.01). Payment mutations and the webhook still return `503 PAYMENTS_FROZEN`. The webhook handler additionally can never change the state of a beta order.

## Data model (migration `0027_beta_execution_authorization.sql`, additive)

The migration adds the `raas_beta_authorizations` table:

- **Identity:** id, `workspace_id` (FK `identity_workspaces`), `operation_id`, `revision_id`.
- **Bindings:**
  - `quote_id` (FK, UNIQUE), `acceptance_id` (FK, UNIQUE), `order_id` (FK, UNIQUE);
  - `beta_grant_id` (FK `beta_grants`);
  - `scope_hash`, `offer_id`, `offer_version`, `terms_version`.
- **Amounts:** `list_amount_minor` (CHECK `> 0`), `currency` (CHECK ISO-4217 shape), `amount_due_now_minor` (DEFAULT 0, **CHECK `= 0`**).
- **Lifecycle:**
  - `status` ∈ {`AUTHORIZED`, `DELIVERED`};
  - `delivered_at` is non-null exactly when the status is DELIVERED (CHECK);
  - `authorized_by` and `authorized_at`.
- **Indexes:** a UNIQUE index on `(operation_id, revision_id)` (one beta authorization per revision), plus grant and workspace indexes.

No existing table, column or constraint changes. `raas_orders.state` has been free text since migration 0006, so the two new states need no DDL. The Drizzle schema is `packages/persistence/src/beta-execution-schema.ts`, and `CommercialState` gains `BETA_AUTHORIZED` and `BETA_DELIVERED`.

## Flow

1. **Accept** (`CommerceService.accept`, unchanged API). There are three outcomes:
   - A priced quote, in `BETA_FREE` mode, with an ACTIVE, unexpired grant for the workspace (read `FOR SHARE` inside the acceptance transaction): the acceptance is recorded as before, the order is created as `BETA_AUTHORIZED` at the published price, the authorization row is inserted, and the `BETA_EXECUTION_AUTHORIZED` event goes to the operation timeline. All of this happens in one transaction.
   - An explicitly free offer: `AUTHORIZED`, exactly as before. No beta row is created, so free offers do not consume or need beta authorizations.
   - Anything else: `PAYMENT_REQUIRED`, exactly as before (the A21.01 freeze).
   
   Concurrency works as follows:
   - The existing UNIQUE constraints (quote, revision order, acceptance) plus the new ones serialize racing acceptances.
   - A unique violation is a replay when it comes from the same actor with the same idempotency key. Otherwise it is a `CONFLICT`.
2. **Explicit conversion** (`CommerceService.authorizeBeta`, `POST /v1/operations/:id/commercial/beta-authorization`):
   - It converts a `PAYMENT_REQUIRED` order on the *current* revision that was accepted before the workspace had a grant.
   - It is refused with `CONFLICT` when any payment row exists for the order, `INVALID_STATE` for other states, and `BETA_ACCESS_REQUIRED` without an active grant or outside `BETA_FREE`.
   - It is idempotent.
3. **Start, retry and redo:**
   - `CommerceService.assertExecutionAllowed` accepts a `BETA_AUTHORIZED` order only when the authorization evaluates as valid.
   - Start checks before the transaction (refusals are recorded in the A21.02 beta ledger as `LAUNCH_DENIED`). It checks again inside the launch transaction, after the A21.02 `admitMission` lock.
   - Retry and redo call `assertBetaContinuation` inside their transactions, after `admitMission`.
4. **Delivery** (`ResultDeliveryService.deliver`):
   - A `BETA_AUTHORIZED` order is delivered only while the authorization is valid. The grant is held `FOR SHARE` until the delivery commits, so a concurrent revocation is ordered either before (delivery refused) or after (delivery completed).
   - On success the order becomes `BETA_DELIVERED`, the authorization becomes `DELIVERED`, and `RESULT_DELIVERED` carries `commercialBasis: 'FREE_BETA'` and the authorization id.
   - Every other delivery precondition is unchanged: WAITING_APPROVAL, a document READY_FOR_REVIEW, an APPROVED `RESULT_REVIEW`, cited findings and SUPPORTED claims. Paid and free orders behave exactly as before.

Denials are raised as `403 BETA_ACCESS_REQUIRED` with `context.reason = 'BETA_AUTHORIZATION_<denial>'`. The possible denials are:
- `BETA_MODE_DISABLED`
- `AUTHORIZATION_MISSING`
- `AUTHORIZATION_MISMATCH`
- `REVISION_CHANGED`
- `SCOPE_CHANGED`
- `ALREADY_DELIVERED`
- `NO_GRANT`
- `GRANT_NOT_ACTIVATED`
- `GRANT_EXPIRED`
- `GRANT_REVOKED`

The core is `packages/application/src/beta-execution.ts` (`BetaExecutionAuthorizer`).

## Read models

- **`GET /v1/operations/:id/commercial`** adds two fields:
  - `betaAuthorization`: basis `FREE_BETA`, status, list price, currency, `amountDueNowMinor: 0`, bindings, `valid`, `denial`;
  - `betaAuthorizationAvailable`.
  
  `executionAuthorized` is true for a beta order only while the authorization is valid.
- **`GET /v1/operations/:id/payment`** is unchanged in shape. For beta orders: `payment: null`, `executionAuthorized: false`, payments still frozen.
- **Readiness** has two new blockers:
  - `BETA_AUTHORIZATION_INVALID` (with the denial);
  - `BETA_AUTHORIZATION_AVAILABLE`, which replaces `PAYMENTS_FROZEN` when an eligible grant could cover the order.
  
  `prerequisites.executionAuthorization.basis` ∈ {`PAID_ORDER`, `FREE_OFFER`, `FREE_BETA`, null}. A new `prerequisites.betaAuthorization` block is added.
- **Web** (mission page):
  - A "Covered by free beta access" block shows the list price and "Due now: 0". It names the invalidity reason when the authorization no longer applies.
  - A "Cover with free beta access" button appears only when the API reports availability.
  - The payment panel is hidden for beta orders.
  - New EN and FR status labels, timeline event copy and blocker copy were added.

## Verification (disposable real PostgreSQL 14.1, nothing else touched)

`pnpm qa:beta-execution` (`apps/api/scripts/qa-beta-execution.ts`): **13 groups / 440 assertions PASS.** It runs on the real `AppModule` HTTP API and in-process services. The groups cover:

| # | Group |
|---|---|
| 0 | Migration 0027 is additive; CHECK constraints, foreign keys and one-per-revision uniqueness hold. |
| 1 | Default `PAYMENTS_DISABLED`: unchanged behaviour even with an active grant; conversion refused. |
| 2 | All 8 packs quoted and accepted over HTTP at their published prices (research 0, strategy 29000, marketing 24000, seo 19000, sales 22000, operations 0, financial 34000, content 18000 EUR). The 6 priced packs become `BETA_AUTHORIZED` with every binding asserted, list price unchanged and 0 due. The 2 free packs stay `AUTHORIZED`. Commercial, payment and readiness views are truthful. Runtime readiness is still mandatory. |
| 3 | All 8 packs executed and delivered without Stripe: start, the real ToolBroker with PgToolLedger, sources and evidence, claims with human SUPPORTED review, StepProgression, ResultAssembler, delivery refused before approval, `RESULT_REVIEW` approval, delivery (one over HTTP). Orders end `BETA_DELIVERED` or `DELIVERED` (free). Redo after a beta delivery is refused. |
| 4 | Concurrency: 6 same-key replays converge; 5 different keys produce 1 winner and 4 `CONFLICT`; competing quotes of one revision produce one order and one authorization. |
| 5 | Revoked grant: start (in-process and HTTP), retry and delivery are refused and ledgered, nothing is released, and the views say `GRANT_REVOKED`. A later grant does not revive the authorization. Without a grant, acceptance stays `PAYMENT_REQUIRED`. |
| 6 | Expired grant (stored ACTIVE, past expiry): start and delivery are refused, views and readiness say `GRANT_EXPIRED`, and new acceptances stay `PAYMENT_REQUIRED`. |
| 7 | Changed plan: the old authorization gets `REVISION_CHANGED` and is preserved untouched; stale quotes get `CONFLICT`; the new revision needs a new acceptance and gets a new authorization. A tampered scope or price is refused. The DB rejects an amount due other than 0. |
| 8 | Cross-tenant: no read, accept, beta-authorize, start, probe or payment read across workspaces. One workspace's grant never covers another. |
| 9 | Explicit conversion: only with a grant; idempotent; free orders and orders with payment history are refused. |
| 10 | Mode switched back to `PAYMENTS_DISABLED`: beta authorizations stop authorizing (fail closed) and resume in `BETA_FREE`. |
| 11 | Mandatory controls: beta mission quota, budget policy, ToolBroker consent, allowlist and tool budget. |
| 12 | Global invariant: every beta order has its authorization; zero payments, payment events or refunds; no order is `PAID` or `CAPTURED`. |

**Mutation checks.** Each was run and then reverted:

| Mutation | Result |
|---|---|
| Delivery uses the authorization without validating it | suite FAILS |
| Retry beta re-check removed | suite FAILS |
| Grant status ignored by evaluation | suite FAILS |

**Honest boundary:**
- No worker, Hermes engine, orchestrator or external provider ran. Step attempts move to RUNNING and complete through the real `StepProgression`.
- Providers are local fakes behind the real ToolBroker: Brave through its transport seam, World Bank through a replay connector that reuses the real tool definitions.
- Expiry is simulated by moving the stored timestamp into the past.
- No browser ran; web changes are covered by typecheck, build and `test:smoke`.

Shared fixtures: `VALID_PACK_REQUESTS` and `buildValidDeliverables()` moved to `apps/api/scripts/qa-pack-fixtures.ts`. `qa:business-packs` imports them unchanged.

## Not verified

- Browser rendering of the beta block and the conversion button.
- A real worker or Hermes run on a beta order.
- Any production environment or deployment.

## Operator follow-ups

- Set `QEYNOX_COMMERCE_MODE=BETA_FREE` only when beta testers should run priced packs at no charge. Under the default `PAYMENTS_DISABLED`, existing beta authorizations are suspended (they fail closed).
- Revoking a grant stops start, retry, redo and delivery of every order it authorized. Issuing a new grant does **not** revive them: the tester accepts a fresh quote, or uses conversion on a `PAYMENT_REQUIRED` order.
- When paid mode exists in the future, beta orders stay identifiable (`BETA_*` states plus their authorization rows) and are never billable by the webhook path.
