# QeyNox — Workspaces & organisations

**Status:** source implemented and **verified end-to-end on an isolated PostgreSQL 16.6 instance**
(87 assertions, disposable database created and destroyed by the QA harness). No push, merge or
deployment; no other project touched. Legacy limit: the sandbox cannot complete `DROP DATABASE`
(PostgreSQL checkpoint signal denied), so the harness reported a teardown warning; the disposable
instance itself was stopped and deleted afterwards.

## One organisation entity (no second system)

Organisations are the existing **workspaces** (`identity_workspaces`) with memberships
(`identity_memberships`). No second organisation table, no duplicate invitation entity, no second
authentication system. Migration `0014_workspace_membership_lifecycle.sql` is additive: it only adds
nullable lifecycle columns (`invited_by`, `invited_at`, `joined_at`, `updated_at`) and two indexes.
Migration `0015_invitation_acceptance_tokens.sql` adds a hashed single-use token and expiry to the
same membership row. 0001–0013 are untouched.

## API surface

Platform administration (`/v1/platform/organizations`, platform session required):

| Method | Route | Access | Behaviour |
|---|---|---|---|
| GET | `/` | ADMINISTRATION or SUPPORT | paginated organisation list (name search, counts) |
| GET | `/:workspaceId` | ADMINISTRATION or SUPPORT | detail: creator, created date, member/role counts |
| GET | `/:workspaceId/members` | ADMINISTRATION or SUPPORT | paginated members (role/status filters, joined/invited dates) |
| POST | `/:workspaceId/invitations` | ADMINISTRATION | invite an **existing identity account**; returns a single-use acceptance token (delivery BLOCKED, no e-mail) |
| POST | `/:workspaceId/members/:membershipId/role` | ADMINISTRATION | change OWNER/ADMIN/MEMBER (justification, before/after audited) |
| POST | `/:workspaceId/members/:membershipId/revoke` | ADMINISTRATION | revoke access or cancel a pending invitation |

Tenant identity (`/v1/auth`, workspace bearer):

| Method | Route | Behaviour |
|---|---|---|
| GET | `/workspaces` | active workspace contexts of the authenticated identity |
| GET | `/me` | current workspace, roles (re-derived from membership each request) and contexts |
| POST | `/switch-workspace` | validates target membership, **revokes the presented session**, issues a new token |

Invitations (`/v1/invitations`):

| Method | Route | Behaviour |
|---|---|---|
| GET | `/` | invitations of the authenticated user only |
| POST | `/:membershipId/accept` / `/decline` | own invitation, workspace session required |
| POST | `/token/accept` / `/token/decline` | public, single-use hashed token for accounts with **no active membership** (they cannot open a session) |

## Invitations without e-mail

No e-mail transport exists (Mission 02). An invitation therefore records `status=INVITED` on the
membership row, invites only **existing, non-suspended identity accounts** (unknown e-mail returns
`404` with the reason "account required; e-mail onboarding blocked"), and returns a
cryptographically random single-use token (hashed at rest, 7-day expiry) to the authenticated
administrator. The response always carries `delivery.email = BLOCKED`; **no message is ever claimed
or sent**. The operator delivers the token out of band. The token path is what prevents an
irreversible lock-out: an account whose last membership was revoked cannot log in, but it can still
accept a re-invitation via the token and then log in again (QA-verified).

Terminal states are distinct: `DECLINED` = the invitee refused; `REVOKED` = the administration
cancelled/revoked access. Both are retained as history; nothing is deleted.

## Roles, last-owner protection, sessions

- Roles are `OWNER` / `ADMIN` / `MEMBER`. Demoting or revoking a membership takes a per-workspace
  PostgreSQL advisory transaction lock, counts **enabled** owners inside the same transaction
  (suspended accounts do not count) and refuses to leave zero usable owners (`LAST_OWNER`).
  Mission 02 suspension now also refuses to suspend the last enabled owner of any workspace
  (`LAST_WORKSPACE_OWNER`), closing the cross-module zero-owner path found in review.
- Role changes are immediately reflected because the workspace principal (including roles) is
  re-derived from `identity_memberships` on every request; QA verifies the same session sees the new
  role without re-login.
- Explicit switch rotates the session: the old token is revoked and a new one is issued; QA verifies
  the old token is rejected afterwards. Switching to a workspace without an active membership is
  denied.
- Revoking a membership invalidates that workspace context immediately; if the user is left with
  **zero active memberships**, all their workspace sessions are revoked in the same transaction, so
  existing tokens stop working (QA-verified).
- No deletion anywhere: memberships move to `REVOKED`/`DECLINED`, workspaces and user rows remain.

## Isolation

- Workspace bearer tokens are rejected on every `/v1/platform/*` route (platform guard, separate
  session namespace); platform sessions cannot call tenant routes.
- A member of organisation A cannot read organisation B operations, cannot select workspace B via the
  `X-Qeynox-Workspace` header (membership is re-checked), and cannot accept another user's invitation
  (scoped by `user_id`, verified by QA with two distinct organisations and a third user).
- Member/invitation data is tenant-scoped in every query; no cross-tenant enumeration path was found
  in review; DTOs expose e-mail/role/status only, never credentials or token digests.

## Concurrency & data integrity

- Invitations take the workspace advisory lock and map a concurrent unique-constraint race to
  `CONFLICT` (one success + one 409, never a 500); QA exercises two parallel first invitations.
- Role change/revocation + audit row commit atomically; every refusal is audited (last owner,
  unknown membership, invalid role, non-member invitation, cross-user invitation).
- Member pagination caps the page size at 100 while still fetching 101 rows to compute `hasMore`;
  organisation cursors use millisecond-truncated keyset ordering.

## Verification

| Check | Result |
|---|---|
| `pnpm --filter @qeynox/api typecheck` | PASS |
| `pnpm typecheck` (root) | PASS |
| `pnpm qa:platform-organizations` (isolated PostgreSQL 16.6) | **PASS — 87 assertions** |
| `pnpm qa:platform-users` (regression, isolated PostgreSQL) | PASS — 165 assertions |
| `pnpm qa:platform-admin` (regression, isolated PostgreSQL) | PASS — 70 assertions |

The QA database is created per run and dropped by the harness. In this sandbox PostgreSQL cannot
signal its checkpointer during `DROP DATABASE`, so teardown logs a warning and the disposable server
was stopped/deleted manually; every assertion ran against the real database.

## Known limits

- No customer-facing organisation settings UI; the API is exposed (platform admin + tenant identity).
- Invitation delivery is manual by design until a reviewed e-mail transport and acceptance/onboarding
  policy exist; onboarding a brand-new person still requires the blocked registration/identity flow.
- Invitation tokens are returned once in the API response (never e-mailed, never logged); the operator
  is responsible for delivering them.
- Cursors are unsigned (tampering only shifts a page window already authorized); audit retention and
  ingress rate limiting remain the identity-hardening gates recorded in `IMPLEMENTATION_MAP.md`.
- No workspace creation/deletion via this API: workspaces are created by the existing registration
  flow; deletion would be irreversible and is deliberately out of scope.
