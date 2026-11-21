# MISSION A21.06 — Authenticated e-mail verification resend

Status: implemented on branch `arena/31248bfb-qeynox` (off `291ed00`) as a draft PR. Not merged, not deployed.

## Defect

On the account page, the "Send a confirmation link" button ran `requestVerificationAction`
(`apps/web/src/lib/actions.ts`). That action posted an **empty body** to the public route
`POST /v1/identity/verification/request`, which requires `{ email }`. Every resend therefore failed
with 400 `INVALID_INPUT`. The user saw a generic error, and no e-mail was sent.

The form also had a second fault. For every `CODE_SENT` result it rendered "delivery not configured",
so even a correct call could not have told the user what happened.

The obvious fix (have the browser send the e-mail) is unsafe. It would let the client decide whose
verification token is issued. It would also tie a signed-in user to the public route, which by design
returns the same anti-enumeration answer whatever happens.

## Decision

### A new authenticated route; the public route is unchanged

`POST /v1/identity/verification/resend` (`apps/api/src/auth/identity.controller.ts`):

- **Requires a session.** Anonymous callers and forged bearer tokens get 403 `DENIED`, the same as
  every other session-only identity route.
- **Binds no request body.** The recipient is read from `identity_users` by the session's `userId`
  (`IdentityLifecycleService.resendVerificationForUser`, `packages/application/src/identity-lifecycle.ts`).
  An `email`, `userId` or any other field in the body is ignored. QA proves that a body naming another
  account never changes the recipient or the owner of the token.
- **Suspended accounts** get `DENIED`.
- **Reuses the existing issuing path (`issue()`):** single-use 32-byte token, stored only as a SHA-256
  digest, 24-hour TTL. Issuing a new token supersedes earlier unconsumed ones. The `email_deliveries`
  ledger, the idempotency key and the real `ResendEmailTransport` are unchanged.

The public `POST /v1/identity/verification/request` keeps its anti-enumeration contract and its own
throttle. The web no longer calls it, and a regression pin asserts that it still refuses an empty body.

### Truthful outcomes (signed-in user, own address; no enumeration concern)

The user is authenticated and asking about their own address, so the route reports what happened:

| Outcome | HTTP | `sent` | `issued` | `notSentReason` | Meaning |
|---|---|---|---|---|---|
| `ACCEPTED` | 200 | true | true | null | The provider accepted the message (ledger `SENT` with provider id). This is acceptance, not proof of inbox delivery. |
| `NOT_CONFIGURED` | 200 | false | **false** | transport reason, e.g. `EMAIL_PROVIDER_NOT_CONFIGURED` | No provider on this deployment. **No token is issued**, so an earlier delivered link is not invalidated. Not throttled. |
| `DELIVERY_FAILED` | 200 | false | true | `EMAIL_DELIVERY_FAILED` | The provider rejected the message (4xx), failed (5xx) or was unreachable. The ledger row is `FAILED` with the real code. |
| `ALREADY_VERIFIED` | 200 | false | false | null | Nothing to do and nothing sent. Not throttled. |
| too many requests | **429** | — | — | — | `BUDGET_EXHAUSTED`; the provider is not called. |

### Rate limiting

The API service consumes a dedicated `verify-resend` budget of **5 per 15 minutes, keyed on the user
id** (`apps/api/src/auth/identity-lifecycle.service.ts`). It is consumed only when a send would
actually be attempted: transport configured and account unverified. This has two consequences:

- A deployment without a provider never shows a misleading "too many requests".
- A flood of the public `verify-request` route aimed at someone's address cannot lock that owner out
  of their own authenticated resend, because the buckets are separate.

### Web

- `apps/web/src/lib/verification-resend.ts` holds:
  - a zod schema for the response, rejecting inconsistent bodies such as `sent: true` on a failure;
  - mappers from the response or API error to a view;
  - all EN and FR copy.
- `requestVerificationAction` posts to `/v1/identity/verification/resend` with the session bearer and
  no body. With no session it refuses before any network call.
- `ResendVerification` (`components/forms.tsx`) renders one `Feedback` per view. Each view has a title
  and body text, so status is never conveyed by colour alone. The form exposes `data-resend-state` for tests.

| View | Shown when | Style |
|---|---|---|
| `ACCEPTED` | outcome ACCEPTED | neutral |
| `NOT_CONFIGURED` | outcome NOT_CONFIGURED | neutral |
| `DELIVERY_FAILED` | outcome DELIVERY_FAILED | error |
| `ALREADY_VERIFIED` | outcome ALREADY_VERIFIED | neutral |
| `TOO_MANY_REQUESTS` | 429 `BUDGET_EXHAUSTED` | error |
| `UNKNOWN` | malformed or inconsistent body, any other API error | error, never success |

The account page itself is unchanged. It offers the button only when `/v1/identity/state` reports a
configured transport; otherwise it states up front that e-mail is not configured.

## Verification

| Check | Result |
|---|---|
| `pnpm qa:verification-resend` (new, real HTTP, disposable PostgreSQL) | **PASS — 8 groups, 68 assertions** |
| `apps/web` smoke (fixture API, production build) | **PASS — 436** (386 at baseline; +50 for A21.06) |
| `apps/web` flow2 | PASS — 35 (unchanged) |
| `qa:identity` / `qa:registration` / `qa:backend` / `qa:agent-runtime` | PASS — 57 / 149 / 28 / 65 |
| `qa:payment-freeze` / `qa:beta-access` / `qa:beta-execution` / `qa:beta-journey` (A21.01–A21.04) | PASS — 369 / 126 / 440 / 128 |
| `qa:task02` | Fails on the same pre-existing schema-parity assertion as `main` (`email_deliveries_dedup_unique`); A21.06 adds no schema. |
| `pnpm typecheck`, `pnpm build` | PASS |
| Browser (headless Chromium, production build, fixture API) | All 5 outcomes in EN desktop 1280 and FR mobile 390 reach the right `data-resend-state`, with no horizontal overflow. Screenshots in `docs/design/screenshots/a21-06/`. |

### The local e-mail fixture

`qa:verification-resend` runs the API's real `AuthModule` over HTTP on a disposable database. It uses
the **real `ResendEmailTransport`**, whose existing `fetchImpl` seam redirects
`https://api.resend.com/emails` to a local `127.0.0.1` HTTP server. That server can accept, reject (422),
fail (500) or drop the connection, and it records a mailbox. No production endpoint override was added.

The suite asserts:

- the adapter contract: endpoint, bearer key, `From`, idempotency key, `TRANSACTIONAL` tag, and a ledger
  row with the provider id;
- the full journey: resend → link from the captured mail → inspect → confirm → `VERIFIED`, with
  superseded and replayed links refused;
- spoofing resistance, delivery failure and recovery, the FR link locale, and the throttle;
- the not-configured case, which boots the production `AppModule` with `QEYNOX_EMAIL_PROVIDER` unset.

Web smoke calls the real Next server action over HTTP (the `Next-Action` header, with the id read from
the production client bundle). It checks that each fixture API outcome maps to its view, that the
action sends the session and **no body**, and that without a session nothing is called.

## Boundaries

- **No real Resend delivery was tested.** The provider is a local fixture that speaks Resend's request
  contract. `ACCEPTED` means the provider accepted the message, not that it reached an inbox.
- Nothing was deployed. No migration was added.
- Per-account throttle state lives in the API process's existing rate limiter, like the other identity
  budgets.
