# MISSION A21.05 — Registration policy (one authority, invite-only beta signup)

Status: implemented on branch `arena/6d6d13aa-qeynox` (off `c2d2f62`), draft PR. Not merged, not deployed.

## Problem

Registration had two switches that disagreed:

| Layer | Variable | Default | Effect |
|---|---|---|---|
| API `POST /v1/auth/register` | `QEYNOX_ALLOW_REGISTRATION` | off (only `'true'` opens) | 503 `NOT_CONFIGURED` |
| Web `/[lang]/account/register` | `QEYNOX_REGISTRATION_ENABLED` | **on** (only `'false'` hides) | renders the form |

With neither variable set, the default production configuration showed an enabled form, and every
submission was refused. Registration also had no notion of beta invitations. Any enabled signup
produced a workspace outside the beta, and the only beta path (A21.02 grants) required an existing
workspace plus a second activation step.

## Decision

### One server-side policy

`QEYNOX_REGISTRATION_MODE` is resolved by `resolveRegistrationPolicy()` in
`packages/application/src/registration.ts`. Nothing else decides.

| Mode | `POST /v1/auth/register` |
|---|---|
| `CLOSED` (default; unset/blank) | 503 `NOT_CONFIGURED`, before any input is read |
| `INVITE_ONLY` | needs a valid registration invitation for the same e-mail, otherwise 403 `INVITATION_INVALID` |
| `OPEN` | anyone may register. With an invitation token, the token must be valid and is redeemed (enrolled); without one, the workspace is created **not** enrolled |
| any other value | `CLOSED` (fail closed), reported internally as `UNSUPPORTED_REGISTRATION_MODE` |

The policy is resolved on every call and never cached. Enforcement (`AuthService.register`) and
publication (`GET /v1/auth/registration-policy`, public) therefore always agree.

The published projection is exactly `{ mode, acceptingRegistrations, invitationRequired }`.

**Why fail closed rather than refuse to boot** (which is what `QEYNOX_COMMERCE_MODE` does): refusing to
boot would also take down login and every other identity route. Closing only registration is the
narrower failure.

**Deprecated alias.** `QEYNOX_ALLOW_REGISTRATION=true` still means `OPEN`, but only when
`QEYNOX_REGISTRATION_MODE` is unset. Existing deployments and the roughly 18 QA suites that set it keep
their behaviour. `QEYNOX_REGISTRATION_MODE` always wins, and an unsupported mode is never rescued by
the alias.

`QEYNOX_REGISTRATION_ENABLED` is no longer read anywhere.

### The web renders the policy, nothing else

`apps/web/src/app/[lang]/account/register/page.tsx` reads the policy server-side (no-store) through
`lib/registration.ts` and renders one of these states:

| API answer | Page |
|---|---|
| `OPEN` | the form; no invitation field unless the visitor came through an invitation link (then pre-filled, optional, "enrolls the new workspace in the free beta") |
| `INVITE_ONLY` | the "Private beta: invitation required" notice and the form with a **required** invitation field (pre-filled from `?invitation=`) |
| `CLOSED` | "Registration is closed" with a sign-in link; **no form** |
| API not configured | the existing "API connection is not configured" state; no form |
| read failure / inconsistent payload | "Registration status unavailable" (alert); **no form** |

Supporting details:

- **Invitation links:** only a well-formed 43-character token is pre-filled; anything else is ignored
  and never echoed. The page sets `referrer: no-referrer` so the token cannot leak through `Referer`.
- **Policy changes between render and submit:** if the policy closes between page render and submit,
  the API refuses and the form says "Registration is closed. No account was created."
- **Duplicate e-mail:** this now has its own generic message. The previous mapping wrongly reused the
  "link already used" copy for `CONFLICT`.
- **Copy:** all text is EN/FR in `lib/registration-copy.ts`.

### Invite-only registration: a registration invitation (migration 0028, additive)

Beta grants are bound to an existing workspace, so they cannot gate the creation of one. The smallest
coherent design is a separate operator-issued object, `registration_invitations`, that is bound to an
e-mail address rather than a workspace.

**Issuance** (`POST /v1/platform/registration-invitations`):

- Requires ADMINISTRATION and a 10–500 character justification.
- Takes the invited e-mail and the beta terms: expiry 5 minutes–366 days ahead, quota, concurrency,
  provider-spend cap and currency. These are the same bounds as A21.02 grants.
- The token is 256-bit base64url. It is returned exactly once, together with `registrationPath`. Only
  its SHA-256 digest is stored, and it never enters the audit trail.
- E-mail delivery is reported `BLOCKED / MANUAL_DELIVERY_REQUIRED`: nothing claims to have been sent.
- The invitation TTL is 7 days, and never longer than the beta term.
- One `PENDING` invitation per e-mail. A time-expired one is materialised `EXPIRED` when a new one is
  issued.
- **Refused:** self-invitation (the operator's own e-mail) and e-mails that already have an account.
  For those, use an A21.02 grant on the existing workspace.
- Every decision, success or denial, is written to `platform_admin_audit`.

**Listing** (`GET`): ADMINISTRATION or SUPPORT, filtered on the effective status (PENDING, REDEEMED,
EXPIRED, REVOKED).

**Revocation** (`POST …/:id/revoke`): ADMINISTRATION only, pending invitations only, with a
justification, audited.

**Redemption** happens inside the single signup transaction in `RegistrationStore.register`:

1. Lock the invitation: `PENDING`, unexpired, same normalised e-mail. Otherwise roll back →
   `INVITATION_INVALID`.
2. Insert the user, credentials, workspace, ACTIVE OWNER membership and REGISTER audit row (unchanged).
3. Insert an **ACTIVE** beta grant for the new workspace with the invited terms. The grantor is the
   issuing operator and the activator is the registrant. Redeeming the single-use token is the
   activation, so no second token exists.
4. Write ledger events `INVITED` and `ACTIVATED` that reference the invitation.
5. Mark the invitation `REDEEMED`, linked to the user, workspace and grant.

What this guarantees:

- **Any failure writes nothing.** That includes a duplicate e-mail: the invitation stays `PENDING`.
- **Concurrent redemptions:** the `FOR UPDATE` lock means the loser re-reads the row as `REDEEMED`.
- **One refusal for every invitation problem.** Missing, malformed, unknown, used, revoked, expired
  and wrong-e-mail invitations all return 403 `INVITATION_INVALID`, so the response reveals nothing.
- **No public validation endpoint:** that would be an oracle.

### What "public signups must not bypass beta enrollment" means here

- In every mode, the only paths to beta enrollment are operator-issued: an A21.02 grant on an existing
  workspace, or a registration invitation.
- An uninvited `OPEN` signup gets a workspace with no grant. The journey reports `NOT_ENROLLED`, and the
  A21.02 launch and spend gate refuses beta missions. Verified in `qa:registration` group 4.
- **For the invite-only beta, deploy `QEYNOX_REGISTRATION_MODE=INVITE_ONLY`.** Every new account is then
  enrolled at signup, and no account exists outside the beta.
- `OPEN` is deliberately not coupled to `QEYNOX_COMMERCE_MODE`. The A21.02–A21.04 suites register
  uninvited workspaces under `BETA_FREE` on purpose, and the gate already makes such workspaces inert.

### Preserved

- **Validation:** password 12–256, workspace name 2–120, locale, and the e-mail rules are unchanged.
  An e-mail with surrounding spaces is still refused.
- **Accounts:** e-mail is normalised (lower-case, trimmed) and stored unverified. Workspace and OWNER
  membership creation are unchanged.
- **Sessions:** 24-hour owner session issued through the unchanged `issueSession`.
- **Duplicate e-mail:** still a generic 409 `CONFLICT` "Account could not be created", which does not
  reveal whether an account exists. Non-unique database errors are no longer disguised as `CONFLICT`;
  they surface as 500.
- **Earlier missions:**
  - A21.01 payment freeze is untouched.
  - A21.02 grant rules are untouched: only operators grant, no self-grant, tenant isolation.
  - A21.03 beta authorization is untouched.
  - A21.04 journey reads the grants written here like any other grant.

## Verification

| Suite | What it covers |
|---|---|
| `pnpm qa:registration` (new; real PostgreSQL 14.1, real NestJS HTTP API) | 9 groups, 149 assertions: policy resolution; the web/API agreement matrix (9 configurations, with `QEYNOX_REGISTRATION_ENABLED=true` set throughout); disabled; enabled; operator issuance; invalid invitations; valid invitation; duplicate e-mail; concurrency |
| Web smoke (fixture API) | Register page in OPEN, OPEN+invitation, INVITE_ONLY, CLOSED, malformed and failing policy, EN and FR. The retired web switch is set to `true` for the server to prove it is ignored, and the policy is read on every render |

Not verified:

- No browser-rendered production check.
- No real e-mail delivery of invitations; it is manual by design.
- No operator UI: invitations are API-only, which is an operator follow-up.

## Operator follow-ups

- Set `QEYNOX_REGISTRATION_MODE=INVITE_ONLY` for the beta (or keep the default `CLOSED`), and remove
  `QEYNOX_REGISTRATION_ENABLED` and `QEYNOX_ALLOW_REGISTRATION` from deployed environments.
- Apply migration `0028_registration_invitations.sql`. It is additive.
- An operator console screen for registration invitations and an e-mail delivery adapter remain open.
