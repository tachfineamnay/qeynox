# ADR-023 — Customer identity completion

- **Status:** Accepted
- **Date:** 2026-11-19
- **Mission:** A04
- **Extends:** ADR-009 (native short-lived opaque bearer sessions). Introduces no second identity system.

## Context

ADR-009 explicitly listed what the identity layer still lacked: *"IP rate limiting, email verification,
password recovery, optional MFA, abuse mitigation remain follow-up work before public use."* A04
closes the registration, verification and recovery gaps.

> **Update (2026-11-20, MISSION A19):** QeyNox now ships a real provider path (`ResendEmailTransport`, env-selected; self-service verification/recovery/invitation sends inline post-commit; notification deliveries via the worker drain). The transport is still **not assumed configured** — with deployment secrets unset every send fails closed exactly as described below. Operator-triggered lifecycle sends remain blocked by design. Deployment secrets (`QEYNOX_RESEND_API_KEY`, `QEYNOX_EMAIL_FROM`, `QEYNOX_PUBLIC_URL`) hold the credentials; none live in the repository. See [A19_NOTIFICATIONS.md](../design/A19_NOTIFICATIONS.md).

The constraint that shaped every decision: **QeyNox ships no e-mail provider.** `createEmailTransport()`
returns `NotConfiguredEmailTransport`, and that has been the truthful state since platform user
administration was built. A04 must add the flows without inventing a delivery capability.

## Decision 1 — the transport reports, the flow does not assume

Every lifecycle method returns the transport's real state:

```ts
{ sent: boolean; notSentReason: string | null; issued: boolean }
```

`sent` is `true` **only** when a configured transport accepted the message. On the shipped deployment a
verification or recovery request returns `sent: false, issued: true,
notSentReason: 'EMAIL_PROVIDER_NOT_CONFIGURED'`: the single-use token exists and is stored, and nothing
was delivered. The web UI states exactly that instead of "check your inbox".

This is the difference between a fixture and a provider, and it is asserted in the QA.

## Decision 2 — tokens are single-use and digest-only

- The bearer value is 48 random bytes, base64url. Only its SHA-256 digest is stored.
- Consumption is a **conditional UPDATE** on `used_at IS NULL`, returning the claimed row. Two
  concurrent submissions produce exactly one winner; the loser receives `CONFLICT`. Proven in the QA
  (`1 ok / 1 conflict` from a simultaneous pair).
- A partial unique index permits **one live token per user and purpose**, so issuing a new link
  supersedes the old one rather than accumulating usable links.
- `purpose` is part of the match: a verification token cannot complete a password reset.
- An expired token is **not** marked used, so the audit trail does not claim a consumption that never
  happened.

Replay, expiry, cross-purpose use, and concurrent duplicates are all refused with the same
`CONFLICT` message, so a caller cannot probe which links were ever issued.

## Decision 3 — anti-enumeration by construction

Verification and recovery requests for an unknown address return the same status and the same body
shape as for a known one. Timing is flattened by consuming the rate-limit bucket **before** the
lookup. A suspended account is treated exactly like an unknown one: suspension must not be
discoverable through the recovery form either.

## Decision 4 — the rate limiter is durable, not per-process

`identity_attempts` lives in PostgreSQL and the check runs inside a transaction guarded by
`pg_advisory_xact_lock(hashtext(bucket))`. An in-process window would let a caller multiply its
allowance by the number of API replicas. An advisory lock is used rather than `SELECT … FOR UPDATE`
because PostgreSQL rejects row locks combined with aggregates, and locking the whole table would
serialise unrelated buckets.

The bucket key is a salted hash: the ledger holds no raw e-mail address or IP.

## Decision 5 — recovery revokes sessions in the same transaction

`resetPassword` consumes the token, rewrites the credential and revokes every live session inside one
transaction. A password change that left a stolen session alive would be a false recovery, and a
rollback must not consume the token without changing the password. The response reports the number of
sessions actually revoked, so the API cannot claim a revocation that did not occur.

Scrypt hashing happens **before** the transaction opens: it is intentionally slow and must not hold a
row lock.

## Decision 6 — verification does not gate authentication

Registration still creates the account and an owner session, matching the existing contract and every
existing QA suite. `identity_users.verified_at` carries an explicit unverified state that `/v1/identity/state`
reports and the account page surfaces. Verification is a visibility and recovery capability, not a
login gate — and it is never *implied* by registration.

## Decision 7 — workspace and platform separation are untouched

The lifecycle module reads and writes `identity_users`, `identity_credentials`, `identity_sessions` and
the two new tables. It does not read `identity_memberships` authority and grants no workspace role.
The QA re-proves, after the new flows: workspace listing works, explicit switching still rotates the
session, and a workspace session still gets `DENIED` on `/v1/platform/admins`.

## Decision 8 — the QA transport override cannot reach production

`AuthModule` is a static module holding the production graph. `AuthModule.forTest(transport)` is a
separate dynamic module used only by the QA harness, and it deliberately registers no second
`APP_GUARD`. Nothing reads an override from environment configuration, so a deployment cannot select a
pretend provider.

The QA runs the lifecycle twice: once with the shipped `NOT_CONFIGURED` transport (proving no false
delivery claim) and once with a recording transport that performs **no network I/O** (proving token
handling end to end). The recording run is labelled in its own output as evidence about token handling,
never about delivery.

## Consequences

- Public registration remains off unless `QEYNOX_ALLOW_REGISTRATION=true`. The registration **UI**
  additionally hides itself unless the API is configured and `QEYNOX_REGISTRATION_ENABLED !== 'false'`.
- Enabling real e-mail requires implementing `EmailTransport`, wiring it in `email-transport.provider.ts`
  behind an explicit provider switch, and independent review. Until then the flows are correct and
  undeliverable, which the API states plainly.
- `pnpm qa:identity` is the gate: 57 assertions against a disposable PostgreSQL.
- MFA and abuse mitigation beyond these windows remain open; they are not claimed.
