# MISSION A14 — Connector hub and account connections

**Status: implemented and verified against isolated infrastructure only. Not merged; draft PR only.**
This note records what was built, what it refuses to do, and exactly what was verified — and what was
not.

Nothing in this mission makes a connector executable. The hub manages **workspace-scoped external
account connections** (OAuth consent, token lifecycle, audit) and exposes the credential resolver
that reviewed, ToolBroker-registered adapters will use. No adapter ships; every provider remains
BLOCKED in `infra/connectors.registry.json` until an operator provisions real OAuth client
credentials and a reviewed adapter exists.

## What shipped

```
Workspace member clicks Connect                          [Web /[lang]/connections (EN/FR)]
  → POST /v1/connections/google-workspace/authorize    [API: state+PKCE, fail-closed if unconfigured]
  → provider consent screen (browser never holds a token)
  → GET  /v1/connections/google-workspace/callback     [API: state-hash auth, membership re-check,
        └ single-use state consumed atomically → code exchanged server-side]
  → AES-256-GCM sealed material stored by the server-side vault (credential_ref only)
  → capabilities discovered from GRANTED scopes (never requested scopes)
  → every action written to the workspace-scoped connection audit trail
Disconnect                                             [OWNER/ADMIN or the connecting member]
  → best-effort remote revocation → unconditional local wipe → REVOKED (idempotent)
Selector for reviewed adapters                         [createCredentialResolver()]
  → scope-subset enforcement + lazy refresh before provider calls
  → ToolBroker remains mandatory; the resolver is an adapter input, never a broker bypass
```

### The one reviewed provider profile (least privilege, read-only identity)

`packages/application/src/connection-providers.ts` declares `google-workspace` version 1 — public
endpoints (accounts.google.com authorization, oauth2.googleapis.com token/revoke), requested scopes
**`openid email profile` only**, and a scope→capability map. No mail/calendar/drive scope exists
here; widening them is a new profile with its own review. A provider declaration is code, reviewed
in the repository; it activates nothing by itself.

Deployment variables (all required; absent ⇒ truthful NOT_CONFIGURED):
`QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID`, `QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET`,
`QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI` (HTTPS, loopback HTTP allowed for development),
`QEYNOX_CONNECTION_CREDENTIAL_KEY` (base64, exactly 32 bytes — `openssl rand -base64 32`),
optional `QEYNOX_PUBLIC_URL` for the post-callback browser redirect. `.env.example` documents all.

### OAuth lifecycle (`packages/application/src/connections.ts`)

- **authorize** — requires the reviewed provider, operator-provided client credentials, a valid
  redirect URI and a configured vault. Creates a 32-byte base64url `state`, stores only its SHA-256
  hash with a 10-minute TTL, generates a PKCE S256 verifier/challenge, and upserts a visible
  `PENDING_AUTHORIZATION` row so abandoned attempts are auditable. Refuses when anything is missing
  and audits the refusal.
- **callback** — unauthenticated by design (the provider cannot hold our bearer); the state hash
  authenticates the round trip. Validates state (unknown/replayed/expired refused), **re-verifies
  active workspace membership**, atomically flips the state to `CONSUMED` (a concurrent callback
  loses the race), exchanges the code server-side, seals the material in the vault, wipes any prior
  credential, records granted scopes and capabilities, audits, and returns a **view without any
  token material**.
- **refresh** — lazy (2-minute skew) through the resolver plus a manual `POST .../refresh`.
  Rotating refresh tokens are adopted; `invalid_grant` wipes the sealed credential, marks the
  connection `EXPIRED` and audits. Views derive `CONNECTED` / `EXPIRING_SOON` from real expiry.
- **disconnect** — OWNER/ADMIN or the connecting member. Best-effort remote revocation (failure is
  recorded, never blocks local wipe), then unconditional local wipe and `REVOKED`. Idempotent:
  disconnecting twice is `REVOKED` + an audit row, not an error.
- **capabilities** — derived only from granted scopes through the provider's declared map; the
  resolver enforces required-scopes ⊂ granted-scopes at call time (`DENIED` otherwise).

### Server-side credential vault (`packages/application/src/connection-vault.ts`)

The only plaintext boundary. AES-256-GCM, 32-byte key from `QEYNOX_CONNECTION_CREDENTIAL_KEY`; no
key ⇒ everything fails closed. Opaque refs (`cred_<32 hex>`), workspace-scoped read/wipe (a ref is
useless across tenants; cross-workspace reads are indistinguishable from nonexistent rows), auth-tag
verification on every read, hard delete on wipe. No logging, no error message ever carries material.

### Storage (`packages/persistence/migrations/0021_connector_connections.sql`)

Four workspace-scoped tables, FK `ON DELETE CASCADE`, idempotent migration:
`connections` (one row per workspace+provider, state machine
PENDING_AUTHORIZATION/ACTIVE/EXPIRED/ERROR/REVOKED), `connection_credentials` (iv/auth_tag/ciphertext
only — **no plaintext token column exists**), `oauth_authorization_states` (single-use, hashed,
10-minute TTL), `connection_audit_events` (workspace-visible; outcome SUCCESS/DENIED/FAILED; reason
and detail only, never credential material).

### API (`apps/api/src/connections/`)

Workspace session + `x-qeynox-workspace`, like the rest of the customer API — **except** the
callback, which is deliberately public and authenticated by the single-use state hash.
`GET /v1/connections`, `GET /v1/connections/audit`, `POST .../authorize`, `GET .../callback`,
`POST .../disconnect`, `POST .../refresh`. No endpoint returns token material, client secrets or
credential references. Mutations are authorized as OWNER/ADMIN-or-connector inside the service.

### Web (`apps/web/src/app/[lang]/connections/`, EN/FR)

Workspace-scoped page: provider card with real state (`NOT_CONFIGURED` / `CONNECT_REQUIRED` /
`CONNECTED` / `EXPIRING_SOON` / `EXPIRED` / `ERROR` / `REVOKED`), requested vs granted scopes,
discovered capabilities, expiry and last verification, Connect / Reconnect / Disconnect / Refresh
controls, operator guidance when the deployment is not configured, and the workspace audit trail.
Unconfigured deployments show the truthful state naming exactly which variables are missing; the
Connect button does not render. Nav item "Connections" (EN/FR).

## Verification (disposable PostgreSQL, never production)

- `pnpm qa:connector-hub` (new) — **79 assertions PASS** (PART 1 contracts/declarations/vault +
  PART 2 lifecycle) against a disposable, socket-only PostgreSQL created and dropped by the harness
  itself, with a **loopback fake OAuth server** (127.0.0.1, in-process) as the only OAuth authority:
  - PART 1: wire contracts parse/strip credential-like keys; redirect-URI rules (HTTPS required,
    loopback HTTP allowed, embedded credentials refused); availability names missing variables;
    vault honesty without a key; migration declares the four tables and no plaintext token column.
  - PART 2: truthful NOT_CONFIGURED list + audited refusal when unconfigured; authorize issues PKCE
    S256 URL with single-use hashed state and `openid email profile`; expired/unknown/replayed
    states refused; membership re-verified at callback; exactly-once consumption; token response
    produces CONNECTED view with capabilities from **granted** scopes; view contains no material;
    stored ciphertext never contains the access token; resolver returns usable tokens for granted
    scopes and DENIES `drive.readonly`; lazy refresh rotates the credential ref and audits;
    rotating refresh tokens adopt the rotation; `invalid_grant` wipes the vault row, marks EXPIRED
    and audits INVALID_GRANT; disconnect permission (intruder denied), remote revoke recorded, local
    wipe verified, idempotent re-disconnect; wrong-key vault read fails closed; cross-workspace
    isolation of list/audit/resolver; audit lifecycle coverage with a secret scan (client secret and
    token prefixes never appear).
- `pnpm typecheck` clean; `pnpm --filter @qeynox/api build` clean; `pnpm --filter @qeynox/web build`
  clean (route `/[lang]/connections` is dynamic).
- Live smoke (API + Web on disposable DB, `QEYNOX_ALLOW_REGISTRATION=true`): registered an account,
  `GET /v1/connections` returns the truthful NOT_CONFIGURED provider; the Web connections page (EN
  and FR) renders it with the named missing variables and the empty audit trail. No real OAuth
  provider was contacted at any point.

**NOT executed / not verified:**

- **No live call to any real OAuth provider has been made.** No Google OAuth client exists for this
  deployment, and the sandbox has no provider access. The callback, refresh and revoke paths are
  verified only against the loopback fake; production-readiness of the real token exchange follows
  the operator procedure below and remains BLOCKED until it is run.
- A real browser pass over the connections page (no installable Chromium); the page is covered by
  build + typecheck + the live HTTP smoke above, not by UI automation.
- ToolBroker-integrated adapters consuming the credential resolver: none ships in this mission;
  adapter work (with the broker's consent-scope and approval gates unchanged) is future work.
- `qa:backend` remains pre-existing-failing and was not chased or masked.

## Operator dependencies (unchanged fail-closed posture)

A workspace can connect Google Workspace only after an operator (1) creates an OAuth client in the
Google Cloud console (web application type), registers the redirect URI that matches
`QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI` exactly (HTTPS, e.g.
`https://<api-host>/v1/connections/google-workspace/callback`), and (2) sets
`QEYNOX_GOOGLE_WORKSPACE_CLIENT_ID`, `QEYNOX_GOOGLE_WORKSPACE_CLIENT_SECRET`,
`QEYNOX_GOOGLE_WORKSPACE_REDIRECT_URI` and a 32-byte base64 `QEYNOX_CONNECTION_CREDENTIAL_KEY`, and
(3) sets `QEYNOX_PUBLIC_URL` so the browser returns to the connections page after consent. Until
then the provider is honestly NOT_CONFIGURED and Connect does not work. After connecting, the value
of the connection is nil until a reviewed adapter (brokered, consent-scoped, separately approved)
consumes it — today, nothing does. `infra/connectors.registry.json` stays BLOCKED for
google-workspace; the registry is deployment truth and this mission does not grant itself an
activation.
