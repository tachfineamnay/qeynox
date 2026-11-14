# QeyNox — Platform user administration

**Status:** source implemented and **verified end-to-end against an isolated PostgreSQL 16.6
database**: parts A+B (107 assertions) plus part C (**58 assertions**) total **165 assertions PASS**.
No push, merge or deployment was performed; no production data was touched.

## Scope and reuse

This API administers the **existing identity tables** through the platform administration layer built
in Mission 01. It does not create a second authentication system:

| Concern | Reused existing mechanism |
|---|---|
| Accounts, credentials, registration date | `identity_users`, `identity_credentials` (credentials are never read) |
| Workspace association and role | `identity_memberships`, `identity_workspaces` |
| Sessions | `identity_sessions` (existing workspace bearer sessions) |
| Suspension | `identity_users.disabled_at` — already enforced by every authentication path |
| Session revocation | `identity_sessions.revoked_at` |
| Platform authorization / audit | `platform_admin_assignments`, `platform_admin_sessions`, `platform_admin_audit` |
| Platform roles/permissions | `PLATFORM_ADMIN`, `SUPPORT`, `OPERATIONS`, `AUDITOR` — no new role vocabulary |

The user-admin port exposes **no delete operation**: no account, credential, membership or session row
is deleted anywhere in this module.

## Endpoints (/v1/platform/users)

All routes are platform-authenticated (separate session namespace); a workspace bearer token is
rejected. "Any-of" policies grant access when the principal holds at least one listed permission.

| Method | Route | Access policy | Behaviour |
|---|---|---|---|
| GET | `/v1/platform/users` | ADMINISTRATION or SUPPORT | paginated directory; `query` = e-mail substring, `status=ACTIVE\|SUSPENDED`, `limit` 1–100 (default 25), opaque `cursor` |
| GET | `/v1/platform/users/capabilities` | ADMINISTRATION, SUPPORT or CONSULTATION | explicit account-lifecycle capability status (all BLOCKED today) |
| GET | `/v1/platform/users/:userId` | ADMINISTRATION or SUPPORT | registration date, status, workspaces+roles, session summary; `platformRoles` only for ADMINISTRATION |
| GET | `/v1/platform/users/:userId/sessions` | ADMINISTRATION or SUPPORT | workspace session metadata + summary; platform-administration sessions are disclosed only to ADMINISTRATION; token digests are never selected or returned; `truncated` flags the 200-row cap |
| GET | `/v1/platform/users/:userId/activity` | ADMINISTRATION, SUPPORT or CONSULTATION | merged identity + platform timeline, paginated |
| POST | `/v1/platform/users/:userId/suspend` | ADMINISTRATION | reversible suspension; requires justification; revokes the target's workspace sessions |
| POST | `/v1/platform/users/:userId/reactivate` | ADMINISTRATION | clears `disabled_at`; requires justification |
| POST | `/v1/platform/users/:userId/sessions/revoke` | ADMINISTRATION | revokes all live sessions of exactly this user; requires justification |
| POST | `/v1/platform/users/invitations` | ADMINISTRATION | **blocked** — 503 NOT_CONFIGURED, no e-mail sent, no state written |
| POST | `/v1/platform/users/:userId/email-verification` | ADMINISTRATION | **blocked** — 503 NOT_CONFIGURED, no e-mail sent |
| POST | `/v1/platform/users/:userId/account-recovery` | ADMINISTRATION | **blocked** — 503 NOT_CONFIGURED, no e-mail sent |

### Pagination contract

- order: `identity_users.created_at DESC, id DESC` (stable, index `identity_user_created_idx`);
- cursor: base64url of `{at, id}`, treated as opaque by clients but **not** a security boundary
  (tampering only shifts the pagination window, never widens access). A malformed cursor is
  `400 INVALID_INPUT` and is audited (`reason=INVALID_CURSOR`); pages never overlap or skip because
  the tuple order is total;
- `limit` is clamped server-side to 1–100 (default 25); `nextCursor` is `null` on the last page;
- activity uses the same cursor shape over `(happenedAt, id)` and merges identity events
  (`identity_audit`) with **account-lifecycle** platform actions only
  (`SUSPEND_PLATFORM_USER`, `REACTIVATE_PLATFORM_USER`, `REVOKE_USER_SESSIONS`; target
  `IDENTITY_ACCOUNT`). Unrelated platform audit rows (role refusals, director reads) are deliberately
  excluded so SUPPORT/CONSULTATION cannot infer internal role operations.

### User detail fields

`userId`, `email`, `locale`, `createdAt` (registration date), `status` (ACTIVE/SUSPENDED),
`disabledAt`, `workspaces[]` (workspace id/name, role, membership status, workspace creation date),
`sessions {total, active, lastUsedAt}`, and — **only for ADMINISTRATION principals** —
`sessions.platformSessions` and `platformRoles`. The directory `workspaceCount` counts ACTIVE
memberships only. Passwords, salts and token digests are never selected by the store nor returned by
the API.

## Actions: protected, justified, audited, reversible

- Every mutation requires `ADMINISTRATION` on the server (never inferred from a workspace role).
- A written justification of **10–500 characters** is mandatory; an invalid one is refused and
  audited (`INVALID_JUSTIFICATION`).
- Suspension and reactivation are atomic with the platform audit row; suspension also revokes the
  target's workspace sessions and writes a `SUSPEND_PLATFORM_USER` audit row containing actor,
  target, action, permission, reason, date and result.
- An operator cannot suspend their own account (`SELF_SUSPENSION`, audited).
- The last enabled owner of any workspace cannot be suspended (`LAST_WORKSPACE_OWNER`, added with
  Mission 03) so suspension can never leave an organisation without a usable owner.
- The last enabled `PLATFORM_ADMIN` cannot be suspended **and** cannot revoke their own last
  assignment: both operations now use the same rule (count only administrators whose identity account
  is enabled) under one coarse PostgreSQL advisory transaction lock
  (`qeynox.platform_admin_registry`), so suspension and revocation can no longer disagree and a
  legitimate API sequence cannot leave zero usable administrators. With the current role matrix the
  suspend path is unreachable over HTTP (only `PLATFORM_ADMIN` holds `ADMINISTRATION` and
  self-suspension is denied first); it remains transaction-level defense in depth.
- Suspension and the session-revocation endpoint revoke **both** session namespaces: workspace
  sessions (`identity_sessions`) and platform-administration sessions (`platform_admin_sessions`),
  atomically with the audit row. A platform bearer obtained before suspension therefore stays revoked
  after reactivation; it never revives.
- Session revocation is scoped to the requested user (`WHERE user_id = $1`), records the revoked
  count in the audit detail, and an unknown user is `404` (audited) rather than a silent success.
- Every refused action (permission denial, invalid justification, unknown user, already suspended,
  not suspended) is written to `platform_admin_audit` with outcome `DENIED`.

## Prepared but explicitly blocked account lifecycle

No e-mail provider is configured and no provider adapter exists. The application layer defines an
`EmailTransport` port and a `NotConfiguredEmailTransport` implementation; the API module wires the
not-configured transport by default (`QEYNOX_EMAIL_PROVIDER` unset → reason
`EMAIL_PROVIDER_NOT_CONFIGURED`; a name set without an implementation → reason
`EMAIL_TRANSPORT_NOT_IMPLEMENTED`). Consequences:

- invitation, e-mail verification and account recovery endpoints return **503 NOT_CONFIGURED**;
- each attempt is audited as `DENIED` with the blocking reason;
- **no e-mail is ever claimed or sent**, and **no account state is written** by these endpoints;
- `GET /capabilities` exposes the feature matrix as `BLOCKED` with the reason, so a future UI cannot
  pretend the flow exists;
- an invitation table is deliberately **not** created: persisting invitations with no transport and
  no acceptance flow would be dead data. Implementing these flows requires a reviewed transport,
  token/acceptance design and identity-policy decisions.

## Storage (migration 0013 — additive indexes only)

`packages/persistence/migrations/0013_identity_user_management_indexes.sql` adds four indexes and no
column, table or data change: user pagination (`identity_users(created_at,id)`), sessions per user
(`identity_sessions(user_id)`), per-user identity audit (`identity_audit(user_id,happened_at)`) and
platform audit by target (`platform_admin_audit(target_type,target_id,happened_at)`). Migrations
0001–0012 are untouched (checksums verified by the runner). Suspension uses the existing
`disabled_at` column, so no identity schema change is required.

## Verification

| Check | Status in this environment |
|---|---|
| `pnpm --filter @qeynox/api typecheck` | PASS |
| `pnpm --filter @qeynox/api build` (tsc, production output) | PASS |
| `pnpm qa:platform-users` | **PASS — 165 assertions** (parts A+B: 107 assertions; part C: 58 assertions against a disposable PostgreSQL 16.6 database) |
| `pnpm qa:platform-authorization` (Mission 01 regression) | PASS — 107 assertions |
| `pnpm qa:platform-admin` (Mission 01 DB e2e) | BLOCKED — no disposable PostgreSQL in this sandbox |

Part A covers: workspace bearer cannot reach the users API; real route policies (admin/support list,
auditor denied list but allowed activity, support denied suspend); pagination and no page overlap;
limit clamping; forged cursor rejected and audited; e-mail search and status filter; detail exposure
and `platformRoles` hidden from SUPPORT; session DTO secret hygiene; activity merge/pagination;
suspension/reactivation/revocation with justifications, audit rows and refusal cases; cross-user
session isolation; blocked lifecycle flows with zero e-mail calls and no state change; last-admin
transaction guard; no deletion operation exists. Part B proves the real HTTP surface denies all 11
users routes without a platform session and leaves workspace routes unchanged.

Part C (isolated PostgreSQL) exercises the full HTTP flow: every migration (including 0013) and its indexes,
registration through the existing identity flow, workspace-owner denial on every route,
pagination/search/detail, suspension → existing auth guard rejects the session and login, reactivation
→ login restored, session revocation limited to the target user, blocked lifecycle endpoints, activity
timeline, audit trail and preserved user rows. It also exercises two administrators: suspending one
revokes its live platform session (never revived by reactivation), and while only one enabled
administrator remains that administrator cannot revoke their own assignment (unified last-admin rule).
The suite reports **BLOCKED**, never PASS, when the QA database is absent. It additionally covers the Mission 03 invariant that a sole enabled workspace owner cannot be suspended (a co-owner is invited before the suspension scenario).

## Known limits

- No admin UI (out of scope); JSON API only.
- E-mail lifecycle flows are blocked by design until a transport and acceptance/verification/recovery
  design are reviewed; no e-mail is sent.
- User search is a bounded `ILIKE` substring on the unique e-mail column (no trigram extension); at
  very large scale a search index decision is required.
- The session list is capped at 200 rows per user (the response carries `truncated` when
  `summary.total` is larger); the summary counts all sessions.
- Audit retention/archival is not implemented (per Mission 01 limit); every denied users request
  inserts one row.
- Suspension is reversible and no deletion exists, but legal retention/erasure policy remains an
  identity-hardening decision recorded in `IMPLEMENTATION_MAP.md`.
