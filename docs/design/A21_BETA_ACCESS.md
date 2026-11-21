# MISSION A21.02 — Invite-only beta access

Branch `arena/3e51529e-qeynox` (off `main` @ `1177489`, which includes A21.01). One scoped commit and one
draft PR, not merged. Nothing is deployed. Migration `0026_beta_access.sql` was applied only to
disposable QA databases.

## Decision

Beta access is a **durable, workspace-scoped grant** stored next to the existing identity model
(`identity_workspaces`, `identity_users`, `identity_memberships`). No new authentication system exists:
- operators authenticate through the existing platform session (`/v1/platform/auth/login`) and the
  platform role model;
- customers authenticate through the existing workspace session.

The gate is **mandatory and always on**. Once deployed, a workspace without an ACTIVE grant cannot
launch a mission or reserve provider spend. There is no environment switch that disables it, by design:
the gate fails closed.

## Data model (migration 0026, additive)

| Table | Purpose |
|---|---|
| `beta_grants` | One grant per row, for one workspace. Columns: status, `expires_at`, `mission_quota` (1–10 000), `concurrent_limit` (1–100), `max_provider_spend_minor` + `currency`, usage counters (`missions_used`, `reserved_minor`, `spent_minor`), invitation digest and expiry, and operator, activator and revoker identity and reasons. |
| `beta_grant_missions` | One row per (grant, operation) admission (unique). A mission consumes quota once. |
| `beta_grant_events` | Append-only ledger: `INVITED`, `ACTIVATED`, `ACTIVATION_DENIED`, `REVOKED`, `EXPIRED`, `MISSION_ADMITTED`, `MISSION_RESUMED`, `LAUNCH_DENIED`, `SPEND_RESERVED`, `SPEND_SETTLED`, `SPEND_DENIED`. |

Database backstops (named CHECKs, mirrored in Drizzle):
- `missions_used <= mission_quota`;
- `reserved_minor + spent_minor <= max_provider_spend_minor`;
- status range;
- revocation consistency (`REVOKED` ⇔ `revoked_at`);
- activation and invitation consistency;
- `expires_at > created_at`;
- justification length.

Uniqueness and idempotency indexes:
- the partial unique index `beta_grants_live_workspace_unique` allows at most one INVITED or ACTIVE grant
  per workspace;
- `beta_grant_events_reservation_unique` makes spend ledger rows idempotent per reservation.

## Lifecycle

```
operator POST /v1/platform/beta-grants ──► INVITED ──(OWNER/ADMIN activates with token)──► ACTIVE
                                             │                                              │
                                             └── invitation or grant deadline passes ──► EXPIRED ◄── deadline
                                             └──────────── operator revoke ─────────► REVOKED ◄── operator revoke
```

- **Invitation.** The token is 32 random bytes encoded as base64url (43 characters) and returned
  **once**. Only its SHA-256 digest is stored. It expires at the earlier of 7 days or the grant expiry.
  Delivery is manual: the API reports `delivery.email = "BLOCKED"`, because no e-mail is sent.
- **Activation.** `POST /v1/workspaces/current/beta-access/activate`. The workspace is taken from the
  session, never from the body.
  - The caller must be OWNER or ADMIN of that workspace (`ROLE_REQUIRED` otherwise).
  - The issuing operator cannot activate their own grant (`SELF_ACTIVATION`).
  - A token belonging to another workspace returns 404 and reveals nothing (`WRONG_WORKSPACE` is
    ledgered on the grant's own workspace).
  - Activation clears the digest, so the token is single-use.
  - An expired invitation cannot be activated (409).
- **Expiry** is evaluated from the clock on every read and every gate (`effectiveBetaStatus`). A stored
  ACTIVE row past its deadline is treated as EXPIRED. The row is materialised to `EXPIRED`, with an
  event, when an operator issues the next grant for that workspace.
- **Revocation** sets `REVOKED`, `revoked_at`, `revoked_by` and the reason, and nulls the token. It takes
  effect on the very next gate evaluation. Revoking twice returns 409.

## Authorization

| Action | Who | Notes |
|---|---|---|
| Create grant | `ADMINISTRATION` (PLATFORM_ADMIN) | Self-grant forbidden: the operator must not be the workspace creator or hold **any** membership row in it, whatever its status. Requires a justification of 10–500 characters, a future expiry and limits within range. |
| Revoke grant | `ADMINISTRATION` | Justification required. |
| List / read grants and ledger | `ADMINISTRATION` or `SUPPORT` | AUDITOR and OPERATIONS are refused. |
| Activate | Workspace OWNER/ADMIN (same workspace) | Workspace session only. The platform session cannot activate. |
| Read status | Any ACTIVE member of the session workspace | The customer view omits operator identity and justification. |

Every operator mutation writes `platform_admin_audit` (through `buildAuditRecord`) and `beta_grant_events`
**in the same transaction**. Every operator denial (guard, permission, self-grant, invalid input, missing
workspace, conflicting live grant, double revoke) is audited with outcome `DENIED` and a reason.

## Enforcement (server side, fail closed)

1. **Launch gate.** `BetaAccessStore.admitMission(tx, …)` runs *inside* the caller's transaction for
   `OperationExecutionService.start` (START), `InterruptionService.retry` (RETRY) and
   `OperationControlService.requestRedo` (REDO), after the operation and budget locks. It takes
   `SELECT … FOR UPDATE` on the workspace's grant, so concurrent launches serialise on the grant row.
   - **Concurrency.** It counts the workspace's operations in RUNNING, WAITING_APPROVAL or
     INTERRUPT_REQUESTED, excluding the one being launched, and compares the count with
     `concurrent_limit`.
   - **Quota.** The first admission of an operation inserts `beta_grant_missions` and increments
     `missions_used`. A relaunch of an admitted operation records `MISSION_RESUMED` and consumes
     nothing.
2. **Spend gate.** `BudgetService.reserve` calls `reserveSpend(tx, …)` under the same row lock.
   - It refuses an operation never admitted under the grant (`MISSION_NOT_ADMITTED`) and a currency
     different from the budget's (`CURRENCY_MISMATCH`).
   - It enforces `spent + reserved + amount <= max_provider_spend_minor`.
   - `settleSpend` is never blocked, even after revocation or expiry, so truthful accounting always
     completes. It frees only the unspent part. An `UNKNOWN` outcome stays reserved, so it keeps
     counting against the cap.
3. **Denials** roll the launch or reservation transaction back. The denial is then appended to the
   ledger (`LAUNCH_DENIED` / `SPEND_DENIED`) by `withBetaDenialLedger`.
4. **Readiness** (`PlanReadService.readiness`) calls the read-only `previewAdmission` and adds a
   `BETA_ACCESS_REQUIRED` / `BETA_LIMIT_REACHED` blocker with category `AUTHORIZATION`, so the client
   never offers a launch that the server would refuse.
5. **Ordering with A21.01.** The commerce check runs first. A priced order under the payment freeze stays
   `PAYMENT_REQUIRED` and consumes no beta quota. A beta grant is not a payment entitlement.

| Error | HTTP | Reasons (`context.reason`) |
|---|---|---|
| `BETA_ACCESS_REQUIRED` | 403 | `NO_GRANT`, `GRANT_NOT_ACTIVATED`, `GRANT_EXPIRED`, `GRANT_REVOKED`, `MISSION_NOT_ADMITTED`, `CURRENCY_MISMATCH` |
| `BETA_LIMIT_REACHED` | 429 | `MISSION_QUOTA_REACHED`, `CONCURRENT_LIMIT_REACHED`, `PROVIDER_SPEND_CAP_REACHED` |

## API

| Route | Method | Purpose |
|---|---|---|
| `/v1/platform/beta-grants` | GET | List (filters: `workspaceId`, effective `status`, `limit`). |
| `/v1/platform/beta-grants` | POST | Create an INVITED grant. Returns the grant and the one-time token. |
| `/v1/platform/beta-grants/:grantId` | GET | Grant, usage and ledger. |
| `/v1/platform/beta-grants/:grantId/revoke` | POST | Revoke with a justification. |
| `/v1/workspaces/current/beta-access` | GET | Status of the session workspace: eligibility, blocker, limits and usage. |
| `/v1/workspaces/current/beta-access/activate` | POST | Activate with the token. |

## Control

The new `/[lang]/beta` page has:
- a list with status filters;
- a grant form (datetime treated as UTC; the one-time token is shown once after creation);
- inline revoke.

`/[lang]/beta/[id]` shows limits, usage, admitted missions and the ledger, with revoke. The pages are
gated by `READ_BETA` (ADMINISTRATION or SUPPORT) and `MANAGE_BETA` (ADMINISTRATION), and the API
re-checks every call. Navigation entries are under the customer group, plus a link from the
organization detail page.

## Verification

`pnpm qa:beta-access` (disposable PostgreSQL only; real services and real `AppModule` HTTP):

| Group | Proves |
|---|---|
| 0 | 0026 is additive; tables, CHECKs and the partial unique index exist. |
| 1 | No grant: 403 in-process and over HTTP; operation stays READY; no outbox row; ledgered; readiness blocker; status `NO_GRANT`. |
| 2 | Refused and audited, with no row written: anonymous, workspace OWNER/MEMBER sessions, SUPPORT/AUDITOR/OPERATIONS mutations, AUDITOR/OPERATIONS reads, self-grant by membership (even REVOKED) or by creation, past expiry, zero quota, short justification, unknown workspace. |
| 3 | Grant over HTTP (only the digest is stored; live-grant conflict). INVITED blocks launches. MEMBER, cross-tenant (404) and issuer activations refused. OWNER activates; token single-use; tenant-isolated status; customer view hides operator data. |
| 4 | 6 parallel launches → exactly 2 (concurrency limit). After one completion, 4 parallel → exactly 1 (quota 3). Free slots with an exhausted quota → all refused. Relaunch does not consume quota. Raw-SQL overshoot refused by the CHECK. |
| 5 | 6 parallel 200-unit reservations under a 500 cap → exactly 2. Settle frees only the unspent part. UNKNOWN stays reserved. Unadmitted mission refused. Raw-SQL overshoot refused by the CHECK. |
| 6 | Revocation blocks: racing launches (no admission after `revoked_at`), the next start in-process and over HTTP, retry, redo and new spend. A pre-revocation reservation still settles. SUPPORT and workspace sessions cannot revoke. Double revoke is 409. Audited. |
| 7 | Past the deadline (stored status still ACTIVE): launch, spend, status, operator filter and readiness all report EXPIRED. A new grant materialises the expiry. An expired invitation cannot be activated and blocks launches. |
| 8 | A priced order under the A21.01 freeze stays `PAYMENT_REQUIRED` and consumes no quota. |
| 9 | Every ledger kind present; SUPPORT reads detail; operator successes and denials audited; ledger reads workspace-scoped. |

Result: **11 groups / 126 assertions PASS** on real PostgreSQL 14.1. Mutation check: removing the START
gate makes group 1 fail.

Explicit fixture shortcuts:
- operation completion uses the domain transition (`store.transition`) instead of a worker run;
- expiry is simulated by moving stored timestamps into the past (the code reads the real clock);
- FAILED status for retry and redo is set directly;
- provider spend goes through the real `BudgetService.reserve/settle`, with no live provider.

Other suites that launch missions or reserve spend declare the precondition through
`apps/api/scripts/qa-beta-fixture.ts`. That fixture seeds an ACTIVE grant with generous limits, in the
workspace's budget currency (EUR for the A03 template). No gate or assertion was weakened. See
[PROGRESS.md](../architecture/PROGRESS.md) for the regression matrix and the pre-existing failures.

## Not verified

- Browser rendering of the Control `/beta` pages and of the web beta blocker copy (typecheck, build and
  web smoke only).
- Real worker, Hermes or provider spend end to end.
- Invitation e-mail delivery (not implemented; delivery is manual).
- Any production environment. Nothing was applied outside disposable databases.

## Operator follow-ups

- Apply migration 0026 through the normal release procedure only.
- **Before enabling customer traffic on a deployment with this code, grant and activate access for every
  workspace that must keep launching.** Without a grant, launches fail closed with
  `BETA_ACCESS_REQUIRED`.
- Hand invitation tokens over through a trusted out-of-band channel.
