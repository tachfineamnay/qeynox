# QeyNox — Global platform administration

**Status:** source foundation implemented and authorization-verified without a database.
The isolated-PostgreSQL HTTP suite is **BLOCKED** in the current environment (no disposable
database available) and is **not** claimed as passing. No production change, push, merge or
deployment was performed.

## Why a separate layer

Workspace roles (`OWNER`, `ADMIN`, `MEMBER` in `identity_memberships`) describe authority inside one
customer workspace. They must never grant QeyNox-internal administration. Platform administration
therefore uses a disjoint vocabulary and its own storage:

| Concept | Workspace identity (unchanged) | Global platform administration (new) |
|---|---|---|
| Roles | `OWNER`, `ADMIN`, `MEMBER` | `PLATFORM_ADMIN`, `SUPPORT`, `OPERATIONS`, `AUDITOR` |
| Table | `identity_memberships` | `platform_admin_assignments` |
| Session | `identity_sessions` (24 h) | `platform_admin_sessions` (8 h) |
| Audit | `identity_audit` | `platform_admin_audit` |
| Principal | `Principal { userId, workspaceId, roles }` | `PlatformPrincipal { userId, sessionId, roles, permissions }` |

The platform repository port exposes **no** workspace-membership operation, so platform
authorization cannot accidentally read `identity_memberships`. A workspace bearer token is unknown
to `platform_admin_sessions`, and a platform bearer token is rejected by the workspace
`AuthenticationGuard`; the two session namespaces are strictly separate.

## Permissions (least privilege)

| Platform role | ADMINISTRATION | SUPPORT | OPERATIONS | CONSULTATION |
|---|---|---|---|---|
| `PLATFORM_ADMIN` | yes | – | – | yes |
| `SUPPORT` | – | yes | – | – |
| `OPERATIONS` | – | – | yes | – |
| `AUDITOR` | – | – | – | yes |

A person can hold several assignments (for example `PLATFORM_ADMIN` + `SUPPORT`); permissions are the
union, in canonical order. General administration deliberately does **not** absorb support or
runtime operations, and support/operations cannot read the administrator list or the audit trail:
consultation is an explicit capability for `PLATFORM_ADMIN` and `AUDITOR` only. Every authorization
decision is evaluated from `platform_admin_assignments` on each request; workspace roles are never
consulted.

## API surface (no UI yet)

All routes are under `/v1/platform` and authenticated with `Authorization: Bearer <platform token>`
(the public login route excepted). Every route declares an explicit access policy; a platform route
without one fails closed.

| Method | Route | Policy |
|---|---|---|
| POST | `/v1/platform/auth/login` | public login (identity credentials + active platform assignment) |
| POST | `/v1/platform/auth/logout` | any valid platform session |
| GET | `/v1/platform/auth/me` | any valid platform session |
| GET | `/v1/platform/admins` | `CONSULTATION` |
| GET | `/v1/platform/audit?limit=` | `CONSULTATION` (1–200) |
| POST | `/v1/platform/admins/:userId/assign` | `ADMINISTRATION` |
| POST | `/v1/platform/admins/:userId/revoke` | `ADMINISTRATION` |
| GET | `/v1/platform/support/operations/:operationId` | `SUPPORT` (read-only cross-workspace diagnostics) |
| GET | `/v1/platform/operations/:operationId/runtime` | `OPERATIONS` (read-only dispatch/execution/attempt state, never cancels or replays) |

Guarantees enforced in the services, not only in the controllers:

- assignment/revocation requires `ADMINISTRATION`, a 5–500 character reason, an existing, non-disabled
  identity account, and records the acting administrator in the assignment and the audit trail;
- a grant/revocation commits **atomically** with the target's session revocation and its audit row
  (one PostgreSQL transaction), so authority cannot change without a trail; a failed write attempts
  a best-effort `ERROR` audit row;
- a role change revokes the target's existing platform sessions so the new authority set takes effect;
- the last active `PLATFORM_ADMIN` cannot be revoked (no administration lock-out). The revocation
  locks the active administrator rows and re-counts **inside the same transaction**, so two
  concurrent revocations cannot both observe two administrators and leave zero;
- support/operations reads never mutate work and never expose credentials or raw prompts;
- every success and every denial is written to `platform_admin_audit` (actor, target, action,
  permission, date, result, reason, detail). Guard denials decided before authentication (missing or
  malformed bearer, missing policy) are audited with a null actor, and a validation rejection is
  audited with the authenticated actor; audit writes for denials are best-effort so an audit outage
  never turns a deny into a 5xx.
- `platform_admin_audit` is append-only at the database level: a trigger rejects all `UPDATE`/`DELETE`.

## Session and credential reuse

Platform administrators are credentialed humans stored in the existing `identity_users` /
`identity_credentials` tables. `AuthService.verifyCredentials()` was extracted from the existing
login path and is reused: same scrypt parameters (N=32768, r=8, p=1), same timing-safe comparison,
same 6-failure/15-minute lockout. It issues **no** workspace session and returns no workspace
authority. Platform session tokens are 48 random bytes; the token digest is computed with the same
`hashSessionToken` used by workspace sessions (injected by the API layer), with an 8 h TTL and
explicit revocation. No credential or hashing logic is duplicated in the platform module.

## Explicit administrator assignment

There is no web self-service elevation. The first administrator is granted only by a CLI that
requires an environment gate, an explicit `--confirm` flag and a recorded reason:

```bash
QEYNOX_PLATFORM_BOOTSTRAP_ALLOW=true \
QEYNOX_BOOTSTRAP_PASSWORD='<12-256 chars, only when the identity account must be created>' \
pnpm admin:bootstrap -- \
  --email operator@example.com --role PLATFORM_ADMIN --confirm \
  --reason "initial platform operator"
```

The CLI refuses `NODE_ENV=production` / `QEYNOX_DEPLOYMENT_ENV=production`, never prints or stores the
password in clear text, creates no workspace membership, and writes a `BOOTSTRAP_ASSIGN_PLATFORM_ROLE`
audit row. Subsequent grants/revocations go through the audited `ADMINISTRATION` API.

## Storage (migration 0012 — additive only)

`packages/persistence/migrations/0012_platform_administration.sql` adds three tables; migrations
0001–0011 are untouched (the runner verifies their checksums):

- `platform_admin_assignments` — role per identity user, ACTIVE/REVOKED history, grant/revoke actor,
  reason and timestamps, one ACTIVE row per (user, role), CHECK constraints on role/status and
  revocation consistency.
- `platform_admin_sessions` — separate session namespace, SHA-256 token digest, expiry, revocation,
  last-used timestamp.
- `platform_admin_audit` — actor, session, target type/id, action, permission, outcome
  (`SUCCESS`/`DENIED`/`ERROR`), reason, JSON detail, timestamp, with time/actor/action indexes, plus
  an append-only trigger that rejects `UPDATE`/`DELETE`.
- The migration is additive and also creates the append-only audit trigger; it does not alter any
  earlier table.

Both admin tables reference `identity_users(id)`; nothing references workspace tables except the
read-only support/operations diagnostics that resolve a workspace name for display.

## Verification

| Check | Status in this environment |
|---|---|
| `pnpm --filter @qeynox/api typecheck` | PASS |
| `pnpm --filter @qeynox/api build` (tsc, production output) | PASS |
| `pnpm qa:platform-authorization` | **PASS — 107 assertions** (real service + real guard against in-memory ports; plus real NestJS HTTP wiring with an unreachable database URL) |
| `pnpm qa:platform-admin` (isolated PostgreSQL HTTP e2e) | **BLOCKED** — no `QEYNOX_QA_DATABASE_URL`; Docker daemon unreachable from this sandbox. Reports BLOCKED, never PASS. |

`qa:platform-authorization` asserts, among others: workspace roles are not platform roles; a
workspace bearer is rejected by the platform service and guard; a workspace owner with no platform
assignment gets no platform session; a workspace owner who receives an explicit assignment still
cannot administer or consult beyond it; the permission matrix is minimal (support/operations hold no
consultation); guard denials are audited (including pre-authentication denials with a null actor);
a `@PlatformAccess` declared without `@PlatformRoute` fails closed; undeclared platform handlers fail
closed; duplicate/unknown/invalid assignments are refused; revocation invalidates sessions and
future logins; the last administrator cannot be revoked; expired/logged-out sessions are rejected;
support can read diagnostics but not runtime, and operations the converse; the real HTTP surface
denies every platform route without a platform session and leaves workspace routes unchanged.
`qa:platform-admin` additionally exercises concurrent last-administrator revocation, which requires a
real PostgreSQL transaction.

Note: in this sandbox `tsx`/`esbuild` cannot spawn its helper process (EPERM on named pipes), so the
suite was executed from the `tsc` build output with a local ESM resolution hook
(`.tmp/qa-loader.mjs`, untracked). In a normal environment, `pnpm qa:platform-authorization` runs
directly.

## Known limits / remaining gates

- No admin UI (explicitly out of scope for this mission).
- Platform login reuses identity credential lockout but there is still **no ingress rate limiting,
  MFA, e-mail verification or account recovery** — the same public-identity gate recorded in
  `IMPLEMENTATION_MAP.md`. Do not expose the platform surface to untrusted networks without it.
- Permission checks use the principal resolved for the current request (re-authenticated per
  request); role changes revoke sessions, which is what invalidates live access.
- The audit table is append-only at the database level (trigger) but has no retention/archival
  policy yet, and each unauthenticated denial on the platform surface inserts one row.
- Support/operations diagnostics are read-only by design; write/replay operator actions remain in the
  existing workspace-scoped recovery service and were not expanded.
- Deployment ordering: migration 0012 is additive and can be applied to an existing preproduction
  database with the generic, explicitly allowed migration CLI. The empty-only preproduction CLI
  (`QEYNOX_ALLOW_PREPRODUCTION_MIGRATIONS`) intentionally rejects non-empty databases, so an upgrade
  must use the operator's backup-controlled procedure. Nothing was migrated or deployed in this task.
