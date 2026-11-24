# Publication readiness checklist (Mission A03)

Status when this document landed: **PUBLICATION_BLOCKED** — every essential verified publication
field is still unsupplied. This is the honest state: nothing legal, commercial or hosting-related is
invented anywhere in the repository or its pages. The release gate
(`pnpm qa:publication`) exits 1 and lists the exact missing variables until the operator supplies
them through the web deployment environment.

## 1. How publication data flows

- One source of truth: `apps/web/src/lib/publication.ts`. It maps each publication field to one
  environment variable, validates every supplied value, and classifies it `VERIFIED` / `MISSING` /
  `INVALID`. Only `VERIFIED` values are ever rendered or counted toward readiness.
- The public pages (contact + legal notice / privacy / terms, plus the site-wide footer) read this
  state **at request time** (`export const dynamic = 'force-dynamic'`), so an operator can supply or
  correct values without rebuilding the web image.
- Rendering is derived, never invented: pending fields show the pending block (warning tokens);
  verified fields show a verified-details block (success tokens) with the values exactly as supplied;
  missing fields show nothing but the pending label.
- The public contact address is published **only** when it validates; an invalid configured value
  fails closed (the page shows the pending state and the value never reaches the HTML).

## 2. Exact remaining operator inputs

Set these on the **web** deployment environment (Coolify env vars for `qeynox-web`). Required means
publication-blocking; optional entries stay visible as pending but never block.

| Environment variable | Required | Rendered on |
| --- | --- | --- |
| `QEYNOX_CONTACT_EMAIL` | **yes** (validated as a public e-mail address) | `/[lang]/contact` public enquiries card (`mailto:`) |
| `QEYNOX_LEGAL_ENTITY_NAME` | **yes** | legal notice → Publisher |
| `QEYNOX_LEGAL_ENTITY_FORM` | **yes** | legal notice → Publisher |
| `QEYNOX_LEGAL_REGISTERED_OFFICE` | **yes** | legal notice → Publisher |
| `QEYNOX_LEGAL_REGISTRATION_NUMBER` | **yes** | legal notice → Publisher |
| `QEYNOX_LEGAL_PUBLICATION_DIRECTOR` | **yes** | legal notice → Publication director |
| `QEYNOX_HOSTING_PROVIDER_NAME` | **yes** | legal notice → Hosting |
| `QEYNOX_HOSTING_PROVIDER_ADDRESS` | **yes** | legal notice → Hosting |
| `QEYNOX_HOSTING_PROVIDER_CONTACT` | **yes** | legal notice → Hosting |
| `QEYNOX_LEGAL_JURISDICTION` | **yes** | legal notice; terms → IP & liability |
| `QEYNOX_LEGAL_RETENTION_TRANSFERS` | **yes** | privacy → Legal basis and retention |
| `QEYNOX_LEGAL_LEGAL_BASIS` | **yes** | privacy → Legal basis and retention |
| `QEYNOX_LEGAL_VAT_NUMBER` | no (if applicable) | legal notice → Publisher (verified block) |
| `QEYNOX_LEGAL_DPO_CONTACT` | no (if designated) | privacy → Your rights (verified block) |
| `QEYNOX_LEGAL_COOKIE_OWNER` | no (if added later) | cookies → Control (verified block) |

Separately, `QEYNOX_PUBLIC_URL` remains a **build-time** input for the web app: it fixes the
canonical URLs, hreflang alternates, sitemap and robots entries (and must be `https://`; the release
check reports a non-https site URL as a blocker). It is not a publication field — no legal fact is
derived from it.

The values themselves must come from the operator (company registers, hosting contract, legal
review). The repository intentionally contains no example legal values in production paths; the QA
scripts use `*.example` addresses and `QA`-labelled values on QA servers only.

## 3. Release check

```
pnpm qa:publication          # root; or in apps/web: node scripts/qa-publication.mjs
```

- Phase 1 — deterministic self-tests of the validation logic (8 groups; pass regardless of config).
- Phase 2 — release report for the current environment: per-field status table, then
  `PUBLICATION_READY` (exit 0) or `PUBLICATION_BLOCKED` (exit 1) with one reason line per missing or
  invalid variable. Reasons name variables, never values (a misconfigured value is never echoed into
  CI logs).

Verified behaviour (this branch, QA environment): self-tests pass; the shipped configuration reports
`PUBLICATION_BLOCKED` with all twelve required variables listed; a fully supplied environment reports
`PUBLICATION_READY` with only optional fields still marked pending.

## 4. Public error / 404 / noindex audit

| Area | Finding | Action in this mission |
| --- | --- | --- |
| Unmatched URLs (`/en/anything-unknown`, `/anything`) | Rendered the framework default 404 (unstyled, English-only) | Root `app/not-found.tsx` added: bilingual EN/FR page inside the public shell, real 404 status |
| Unsupported locale (`/es`, `/xyz`) | Layout `notFound()` hit the same default 404 | Same root boundary now renders, bilingual, real 404 status |
| Invalid identifier inside a matched route (e.g. missing offer id) | `[lang]/not-found.tsx` boundary renders the bilingual not-found UI in the correct locale shell | Added; honest nuance recorded: because the dynamic page has already streamed when `notFound()` fires, Next 16 may answer 200 with the not-found UI (soft 404). Unmatched URLs and unsupported locales answer a real 404. Impact is limited to session-gated, `noindex` surfaces. |
| Application error page (`app/[lang]/error.tsx`) | Minimal alert + retry, honest failure copy, no fake recovery | Kept as-is (audit only) |
| `robots.txt` | Disallowed authenticated paths but **not** the session-gated service catalogue | `/services` and `/*/services` added to the disallow list |
| Meta robots on authenticated routes | Absent (indexable by metadata despite the robots.txt disallow) | `robots: { index: false, follow: false }` added to every authenticated page (mydash, missions, results, soul, support, capabilities, connections, documents, notifications, workspaces, services, account except the public register page). `/en/results/shared/[token]` already carried it. |
| Public pages | Indexable with canonical/hreflang metadata | Unchanged; verified no accidental `noindex` |
| Sitemap | Public routes only | Unchanged; still excludes authenticated paths |

## 5. EN/FR consistency and accessibility

- The pending/verified blocks and the 404 are generated from one bilingual registry
  (`publication.ts` labels + `public-content.ts` copy), so the two locales cannot drift.
- Verified values are rendered exactly as supplied, in both locales, with `<dt>/<dd>` pairs;
  both blocks keep `role="note"`; the 404 is bilingual by construction where no locale context
  exists and localized inside a matched locale segment.
- Styling reuses the Professional Blue semantic tokens (`--qx-success`/`--qx-warning` families);
  no new colours were introduced.
- Verified by `apps/web/scripts/publication-pages-qa.mjs` (18 assertions, EN/FR, three
  environment scenarios) and the existing smoke (449) / flow2 (37) suites.

## 6. Honouring the mission constraints

- No company registration numbers, addresses, jurisdictions, DPO identities, hosting facts or
  retention terms are invented anywhere; the shipped state explicitly marks them pending.
- No legal commitment is written as approved: the legal pages describe implemented product
  behaviour only, with operator-supplied values shown as data, not as review approvals.
- No product logic was replaced and no interface redesigned: the blocks reuse the existing
  `.legal-pending` visual family plus a token-only `.legal-verified` sibling.
- No public functionality was disabled: the contact page gained a verified path instead of losing
  the pending one; the catalogue gained robots protection only (crawling of a session-gated page).
