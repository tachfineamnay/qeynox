# QeyNox — Global platform administration

**Status:** implemented and authorization-verified, including the Control console and the
platform configuration routes added in A09. The isolated-PostgreSQL HTTP suites are executed
against a disposable PostgreSQL created by the harnesses: `qa:platform-admin` — **70 assertions
PASS**, `qa:platform-configuration` — **70 assertions PASS** (created and dropped by the harness).
No production change, merge or deployment was performed as part of these missions.

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

## API surface

A platform console (the `@qeynox/control` application, served under `/admin`) ships read-mostly
administration pages: users, organizations, administrators, audit, settings, operations health and
releases — and, since A09, the operator configuration page described below. It is authenticated with
the platform session only.

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
| GET | `/v1/platform/configuration?workspaceId=` | `CONSULTATION` (read-only desired-state for the Control console) |
| POST | `/v1/platform/configuration/preview` | `ADMINISTRATION` (dry run: identical validation, persists nothing but the audit row) |
| POST | `/v1/platform/configuration/apply` | `ADMINISTRATION` (idempotency-guarded, same-transaction audit) |

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

## Platform configuration for the Control console (A09)

Capability slots, agent profiles, tools, verification policies, offers and budget policies are
configured by an operator for a workspace. A09 makes that configuration reachable from the platform
console **without creating a second, divergent configuration engine and without ever promoting a
platform session into a workspace session**.

Authorization is deliberately two-layered; both layers must pass:

1. **Platform layer** — reads (`GET /v1/platform/configuration?workspaceId=…`) require `CONSULTATION`
   (PLATFORM_ADMIN, AUDITOR). Previews and applications require `ADMINISTRATION` (PLATFORM_ADMIN
   only). SUPPORT and OPERATIONS hold no configuration permission. Permission failures are audited
   before any engine work happens.
2. **Operator layer** — the unchanged `ConfigurationService` engine still enforces
   `QEYNOX_OPERATOR_USER_IDS` (failing closed with `NOT_CONFIGURED` when unset), allowlist
   membership of the acting identity, and an ACTIVE `OWNER`/`ADMIN`/`OPERATOR` membership in the
   target workspace (read from `identity_memberships`). A platform session never becomes a
   workspace session: the platform route synthesizes an in-memory principal from the platform actor
   and its *real* membership role, and mints no workspace token.

The read path is additionally authorized by platform `CONSULTATION` plus an existing workspaces row,
so the console can report a not-yet-configured deployment instead of failing closed on every read.
Mutations never bypass the operator gate.

Rules enforced on every call:

- an explicit, validated `workspaceId` on every request (unknown workspace → `404 NOT_FOUND`);
- a mandatory written justification (10–500 chars) on preview/apply, carried into the audit row;
- preview computes the same outcomes as an apply (`CREATE`/`UNCHANGED`/`ACTIVATE`/`DEACTIVATE`),
  validates cross-references and writes **nothing** except its audit row;
- apply is guarded by an idempotency key (`configuration_records`); replaying the same key with the
  same bundle returns the stored outcome (`alreadyApplied: true`), reusing it with a different
  bundle returns `409 CONFLICT`;
- version content is immutable: changing the content of an existing version returns `409 CONFLICT`;
  activating a version automatically deactivates its siblings in the same scope;
- offers carry their **tax treatment** per version (`taxPolicy: CONFIG_REQUIRED | CONFIGURED`). The
  engine refuses to activate an offer whose tax treatment is `CONFIG_REQUIRED`; the state returned
  to the console surfaces `taxPolicy` and the offer label, so tax configuration is visible and
  actionable instead of implicit. There is no tax-rate store: tax is a two-state declaration on the
  offer, enforced at activation time and in the commerce engine;
- budget policies are workspace-scoped; at most one is ACTIVE per workspace (a newer ACTIVE version
  deactivates the previous one inside the same transaction);
- **both success and every denial are written to the append-only `platform_admin_audit`** (actions
  `READ_PLATFORM_CONFIGURATION`, `PREVIEW_PLATFORM_CONFIGURATION`, `APPLY_PLATFORM_CONFIGURATION`);
  the apply audit row commits **inside the same transaction** as the configuration mutation and its
  idempotency record, so an applied configuration can never exist without its audit trail. A dry run
  audits too, with `detail.dryRun = true`.

Control console page `/admin/[lang]/configuration` renders the live state (capability slots, profiles,
tools, verification policies, offers with tax, budget policies) and offers a preview → explicit
confirmation → apply flow; previews change nothing and every attempt is audited.

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
| `pnpm qa:platform-admin` (isolated PostgreSQL HTTP e2e) | **PASS — 70 assertions** against a disposable PostgreSQL 16.6 database created and dropped by the harness (sandbox teardown warning only; assertions ran against the real database). |
| `pnpm qa:platform-configuration` (isolated PostgreSQL HTTP e2e, A09) | **PASS — 70 assertions** against a disposable database created and dropped by the harness, incl. the read/mutation permission split, the operator-gate double check, fail-closed behaviour with the allowlist unset, the offer tax gate, version immutability, idempotency replay and same-transaction audit rows. |

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

- No admin UI (explicitly out of scope for this mission). The Control console described above is the
  platform console shipped later; since A09 it also serves the configuration page.
- Verification note: the isolated-PostgreSQL e2e suites now pass (70 + 70 assertions). They were
  initially blocked in the earlier sandbox; disposable PostgreSQL instances are started locally by
  the harnesses to run them.
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
