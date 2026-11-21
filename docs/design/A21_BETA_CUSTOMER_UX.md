# MISSION A21.04: Free beta customer UX (EN/FR)

Status: implemented on branch `arena/846bce88-qeynox` (off `6676229`, which includes A21.01–A21.03), draft PR. Not merged, not deployed.

## Decision

Before this mission the web read nothing about the customer's beta access. The A21.02 status endpoint existed, but it said nothing about the commerce mode or the runtime. Rather than have the browser combine three sources and guess, **one read-only, server-composed read model** now drives every free-beta surface:

`GET /v1/workspaces/current/beta-access/journey` → `BetaJourneyView` (`packages/application/src/beta-journey.ts`)

| Field | Source of truth |
| --- | --- |
| `freeBeta.enabled`, `mode`, `waiverPercent` (100 or null) | A21.01 commerce policy (`QEYNOX_COMMERCE_MODE`, read once at boot) |
| `freeBeta.cardRequired: false`, `paymentsAvailable: false`, `amountDueTodayMinor: 0` | Literal: payments are frozen in every supported mode (A21.01) |
| `freeBeta.waiverApplies` | `BETA_FREE` and an ACTIVE grant. This is the same rule A21.03 applies at quote acceptance. It is a preview, never an authorization. |
| `account.*` (status, expiry, invitation expiry, quota, used, remaining, active missions, concurrency, provider budget) | A21.02 `WorkspaceBetaAccessService.status()` (effective status from the clock; tenant-scoped by the session) |
| `account.canActivate` | Mirrors `activate()` exactly: a single OWNER or ADMIN role |
| `runtime.state` / `canExecute` | `apiRuntimeReadiness()`, the same source as service availability and readiness |
| `state`, `canLaunch` | Derived server-side with a fixed precedence (below) |

The read model writes nothing. Its auth, tenancy and member visibility are those of the A21.02 status read, which is verified.

### State precedence

`NOT_CONFIGURED` (not `BETA_FREE`)
→ `NOT_ENROLLED` (no grant)
→ `INVITATION_PENDING`
→ `EXPIRED`
→ `REVOKED`
→ `QUOTA_EXHAUSTED`: missions used up (`quotaReason: MISSIONS`) or provider budget used up (`PROVIDER_BUDGET`)
→ `CONCURRENT_LIMIT_REACHED`
→ `RUNTIME_UNAVAILABLE` (runtime not `OPERATIONAL`: blocked **or** configured-but-unverified)
→ `ACTIVE`.

`canLaunch` is true only in `ACTIVE`. It is a display hint. The server's launch gate (A21.02/A21.03) and readiness remain authoritative, and `StartMission` still uses readiness.

The order is: the deployment first, then what the customer or an operator can act on, then the platform runtime.

## Web

- `lib/beta.ts`: server-only zod parse of the journey. `cardRequired`, `paymentsAvailable` and `amountDueTodayMinor` are **literal** in the schema, with cross-field checks (`waiverApplies ⇒ enabled`, `canLaunch ⇔ ACTIVE`). If a response would ask for a card or claim a charge, it is rejected and rendered as "Beta status unavailable (INVALID_RESPONSE)", never as free beta. Any API failure is stated with its code, and nothing is assumed.
- `lib/beta-copy.ts`: all EN/FR copy (no strings in component logic). Money uses `formatMoney` (Intl). Dates use `Intl.DateTimeFormat(lang, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' })`.
- `components/beta-offer.tsx`:
  - `BetaOfferSummary`: "Free beta — no card required", the list price (crossed out with a screen-reader label **only** when the waiver applies), "Beta waiver (100%) −list price", "Amount due today €0.00", remaining allowance, expiry or invitation expiry, the account status tag, then the blocking state notice;
  - `BetaPriceTag` (catalogue);
  - `BetaInlineBanner` (mission creation);
  - `BetaStateNotice`;
  - `BetaAccountCard` (MyDash).
  
  Every status has a text label and a glyph (✓ i ! ×), never colour alone.
- `components/beta-activate-form.tsx` + `lib/beta-actions.ts`: the first customer UI for redeeming an A21.02 invitation token. It is shown only when the server says `canActivate`. The API enforces role, single use, expiry, tenant binding and no self-activation.

| Surface | Change |
| --- | --- |
| Service catalogue (`services/page.tsx`) | Journey state notice above the grid. Priced cards show the list price crossed out plus "Free beta · nothing due today" when the waiver applies; otherwise the plain list price. Free offers are unchanged (never "waived"). |
| Service detail (`services/[offerId]/page.tsx`) | The price badge is labelled "List price". The request card carries the full beta offer summary. |
| Mission creation (MyDash focus card) | One line with the free-beta terms (0 due, allowance), plus the blocking state if any |
| MyDash (`workspace.tsx`) | "Your free beta access" card: status tag, state notice, allowance meter (`progressbar` with text), 0 due, expiry, concurrent missions, provider budget left, runtime state; activation form for a pending invitation |
| Quote acceptance (mission page) | Beta offer summary for the open quote before "Accept this quote" (waiver preview + "Accepting records the quote at its list price…") |
| Mission launch (mission page) | Beta summary in the launch card (allowance it consumes, expiry, status, blocking state), shown even when readiness cannot be read |
| Payment panels (mission page) | **In a beta flow** (journey says `BETA_FREE`, or the payment view's `commerce.betaFree` when the journey is unreadable), `PaymentPanel` is no longer rendered. The "payment required / payments frozen" prompt and "payment status unavailable" line are suppressed too. The beta summary takes their place ("No payment step: this order is handled under the free beta"). Outside a beta flow (`PAYMENTS_DISABLED`), the A21.01 frozen panel is unchanged. A21.03 beta-authorized orders are unchanged. |

Styling uses Professional Blue tokens only (`--qx-blue-*`, `--qx-success|warning|danger(-bg)`, radii). No new hex.

Each screen has exactly one dominant CTA: the beta summaries contain no buttons. The only new button is the activation submit, shown only in the pending-invitation state.

## Verification

All of it ran in the sandbox. No production system was touched.

- **New `qa:beta-journey`: 7 groups / 128 assertions PASS** on disposable real PostgreSQL 14.1 over the real `AppModule` HTTP API. It covers:
  - the pure precedence table;
  - session required;
  - spoofed workspace refused;
  - side-effect free (no grant, ledger or audit row written);
  - INVITATION_PENDING (owner may activate, member may not);
  - RUNTIME_UNAVAILABLE (blocked and unverified runtime) → ACTIVE;
  - CONCURRENT_LIMIT_REACHED and QUOTA_EXHAUSTED (missions, then provider budget) from real admissions and BudgetService reservations;
  - EXPIRED (stored timestamps moved into the past);
  - REVOKED (operator HTTP revoke);
  - NOT_CONFIGURED (second app boot in `PAYMENTS_DISABLED`).
  
  Allowance, limits and expiry are compared with the stored grant row in every state.
- **Web `test:smoke`: 329 HTTP assertions PASS** (218 before). The new fixtures cover each journey state, an unreadable journey (503) and a journey that asks for a card (rejected). Assertions cover MyDash, catalogue, service detail, quote acceptance, launch and payment replacement in EN and FR, including:
  - no `data-commerce-mode` panel, checkout or card prompt in beta flows;
  - the crossed-out price only when the waiver applies;
  - NOT_CONFIGURED never claims a free beta or a waiver.
  
  Earlier A21.01/A21.03 assertions that expected the BETA_FREE payment panel were updated to the new contract (panel replaced). The PAYMENTS_DISABLED panel assertions are unchanged. `test:flow2` 35 PASS.
- **Screenshots** (`docs/design/screenshots/a21-04/`, 73 captures):
  - Headless Chromium at 390×844, 1024×768 and 1440×900, EN and FR, against the smoke fixture API.
  - Full pages: MyDash, catalogue and service detail.
  - Card captures: quote, launch and payment replacement, plus every MyDash state card (not enrolled, invited, expired, revoked, quota, runtime, not configured, unavailable).
  - `report.json` records `scrollWidth`/`clientWidth` per capture: **no horizontal overflow** at any width.
  - The capture script is kept as `capture.mjs.txt`. It needs a local Chromium and puppeteer-core, which are not repository dependencies.
- **Screenshot reference comparison: BLOCKED.** The reference PNG named in `docs/design/reference/README.md` is absent from the repository, so captures were reviewed against `DESIGN_SYSTEM.md` only.
- Regressions:
  - `qa:beta-access` 126 PASS, `qa:beta-execution` 440 PASS, `qa:payment-freeze` 369 PASS;
  - `qa:backend` 28, `qa:agent-runtime` 65, `qa:stripe-payments` 108, `qa:business-packs` 370, `qa:service-catalogue` 63, `qa:runtime-readiness` 19, `qa:mission-lifecycle` 88 and 20 other suites PASS.
  - `pnpm typecheck` 4/4, `pnpm build` 4/4.

Pre-existing or environmental failures (unchanged from A21.03):
- `qa:task02` parity (`email_deliveries_dedup_unique`, …). A21.04 has no schema change.
- `qa:platform-authorization` and `qa:platform-users` part B: they fail identically on the untouched base `6676229`.
- `qa:connectors`, `qa:raas`, `qa:egress` and `qa:a03-service` part 2: BLOCKED by World Bank TLS from the sandbox.

## Not verified

- Screens rendered against a **real** API with real data. The screenshots use the labelled smoke fixture API; the API itself is verified by `qa:beta-journey`.
- Real assistive-technology testing. Labels, roles and glyphs were reviewed in markup only.
- Pixel comparison with the design reference (absent).

## Operator follow-ups

- No migration. The new route ships with the API.
- Invitation tokens are still handed over out of band. Customers can now redeem them on MyDash (OWNER/ADMIN).
