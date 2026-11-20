# A11 — Customer experience audit and remediation

Date: 2026-11-20 · Branch: `arena/d04d8794-qeynox` (see "Branch note" below) · Base: `main` @ `229dddf` (post-A10)
Design contract: `docs/design/DESIGN_SYSTEM.md` (Professional Blue, Concept 2 — the only approved direction).

## Method

Real browser automation (headless Chromium 153 via puppeteer-core + @sparticuz/chromium) driving the
production build of the web app against the **real API and a real PostgreSQL 16 QA database** (disposable,
migrated, `qeynox_a11_ux`), not HTTP fixtures:

- 108 page-views: 36 routes × {390×844, 1024×768, 1440×900} × {EN, FR}, with console/page-error capture,
  horizontal-overflow detection, label/accessible-name/h1/skip-link/tabindex checks.
- Scripted interactive journeys in EN and FR: register → sign in/out → wrong-password → Soul onboarding
  (consent, questions, first mission creation) → MyDash → mission workspace → missions list → support → account.
- Keyboard-only spot checks (Tab order, first stop is the skip link, visible focus on every stop).
- Reduced-motion emulation (`prefers-reduced-motion: reduce`) — page renders with zero errors.
- Mobile menu (public and app shells) opened and exercised at 390px.
- Visual screenshots archived under `docs/design/evidence/a11/` (see `crawl-results.json`,
  `verify-results.json`, `journey-log-1440.json`, `crawl-*.png`, `journey-*.png`, `verify-*.png`).

## Findings and fixes

| ID | Severity | Defect | Fix |
| --- | --- | --- | --- |
| A11-01 | **High** | Language switcher on every public sub-page generated `/frlegal/notice`-style URLs (missing slash), producing 404 prefetch requests and a broken EN↔FR switch (customer clicked FR, landed on 404) | `public-shell.tsx` normalizes the route path once; switcher hrefs verified `/fr/legal/notice` etc., zero RSC 404s in re-crawl |
| A11-02 | Medium | Registration redirected new accounts to `/mydash` while sign-in redirects to `/soul` — first-time customers silently skipped the guided start | Shared `soulAwareDestination()` in `lib/actions.ts`: login and registration route identically (Soul while NOT_STARTED/IN_PROGRESS/PAUSED) |
| A11-03 | Medium | Wrong-password sign-in showed the generic authorization message ("Check your session and workspace permissions") — misleading for a credentials typo | New honest copy `credentialsDenied` (EN/FR) mapped only in the login form; no account oracle introduced |
| A11-04 | Low | Error branches of `missions/[id]` and `missions/[id]/results/[documentId]` rendered feedback with **no `<h1>`** (0 h1, status 200) | Both pages now render `PageHeader` with an h1 in every branch; verified in browser |
| A11-05 | Low | `[lang]/loading.tsx` showed only three placeholder bars — no textual state for screen readers or sighted users during streaming | Loading boundary now announces a bilingual "Loading… / Chargement…" caption via `role="status"` |
| A11-06 | Hygiene | Locale set hardcoded in three places (layout gate, hreflang, sitemap); adding ES/DE would drift | Single registry `lib/locales.ts` (`SUPPORTED_LOCALES`, `PENDING_LOCALES`, `isSupportedLocale`); layout gate, hreflang and sitemap derive from it; export catalog types (`CopySuite`, `MissionCopy`, `FlowCopy`); documented `docs/design/I18N.md` — **no ES/DE translations invented**; `/es`, `/de` stay 404 |

## Verified working (truthful backend states)

- Registration through the real form → lands on the guided start (`/en/soul`, `/fr/soul`); sign-out; wrong-password error; login round-trip.
- Soul onboarding: start → consent → questions → first mission created by the onboarding action; redirect to the new mission.
- MyDash after sign-in: real empty states, real counts; anonymous visit shows disabled capture with sign-in prompt.
- Mission workspace renders honestly: `Draft`, `No plan is recorded`, `The server summary is unavailable: no progress is inferred`, readiness-gated launch.
- Offer and payment on a plan-less mission: "A real quote is required before launch. No price or authorization is fabricated."
- Support without Chatwoot: explicit `NOT_CONFIGURED` with the missing server variables named — never a fake "all good".
- Account identity state: unverified + "No e-mail provider is configured … nothing was delivered."
- Missions list shows recorded operations from the API; invalid ids show a truthful "could not be loaded" page with h1.
- Keyboard: first Tab stop is the skip link on public and app shells; all stops show visible focus; no positive tabindex.
- 108/108 page-views pass: no console errors, no page errors, no horizontal overflow, no unlabeled controls, exactly one h1 per page, html `lang` matches route.

## Verification commands

- `pnpm --filter @qeynox/web typecheck` — clean.
- `pnpm --filter @qeynox/web build` — clean (Next 16.4.6).
- `pnpm --filter @qeynox/web test:smoke` — PASS: 146 HTTP assertions.
- Browser audit scripts (ephemeral `/tmp/browser-harness`, not committed): `crawl.mjs`, `journey.mjs`,
  `fr-journey.mjs`, `verify.mjs`, `payment-check.mjs`; evidence in `docs/design/evidence/a11/`.

## Not exercised / blocked / out of scope

- Approval → plan → execution → results pipeline end-to-end: requires the worker/engine; audited surfaces show
  truthful gated states instead. No completion state was fabricated for evidence.
- Quotes, Stripe checkout and refunds: provider not configured; surfaces render NOT_CONFIGURED truthfully. No payment was made.
- Chatwoot support: `NOT_CONFIGURED` until live verification (A10; capability fail-closed). Support page shows that state.
- Atlas results/downloads: exercised only up to the invalid-input paths; real deliverable rendering needs a recorded result.
- **Screenshot comparison vs the design reference remains BLOCKED** — `docs/design/reference/concept-02-professional-blue.png` is absent. Visual claims in this audit are from the implemented UI, not from parity against a reference.
- Authenticated journeys were exercised on a disposable QA database; this is not production verification.

## Branch note (must be read)

The brief named `arena/a11-product-ux`. The environment assigned `arena/d04d8794-qeynox` (branched from
`main` @ `229dddf`, the post-A10 baseline). Per the standing branch rules this work is committed on
`arena/d04d8794-qeynox`; the PR is opened from it. No merge, no deployment.
