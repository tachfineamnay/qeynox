# QeyNox — Customer workspace management (MISSION A18)

**Status:** source implemented and **verified end-to-end on an isolated PostgreSQL 16 instance**
(disposable database created and destroyed by the QA harness). The web UI builds and renders
signed-in and signed-out, in EN and FR. The API smoke run exercised the full HTTP surface against
a scratch database. **No push, merge or deployment is implied by this document.**

Scope: self-service profile, account settings, security (password + active sessions), context/
privacy pointer and account-deletion request; workspace list/create/switch; organization detail;
team management (invite/accept/decline/role change/revoke) with last-owner protection; EN/FR
responsive interfaces. Reuses `identity_workspaces`, `identity_memberships`, invitation tokens and
the switch-workspace session contract — **no second identity system, no second audit trail**.

## What shipped

### Persistence

- Migration `0023_account_deletion_requests.sql` — append-only account-deletion **requests**
  (`id`, `user_id`, `reason`, `status` REQUESTED/CANCELLED, timestamps). Additive; 0001–0022 untouched.
- `AccountStore` (`account-store.ts` + `account-schema.ts`) — profile read/locale update, active
  session list/revoke/revoke-others (current session matched by SHA-256 of the presented bearer,
  never stored), password change with failed-attempt lockout (6 attempts ⇒ 15 minutes), idempotent
  deletion request/cancel/status, identity_audit writes.
- `WorkspaceStore` — additive `createWorkspaceWithOwner` (creator becomes ACTIVE OWNER in one
  transaction, audited), `listMine` (the caller's active memberships for the switcher),
  `insertPlatformAudit` (self-service audit rows).

### Application services

- `WorkspaceTeamService` — workspace list/create; acting-workspace resolution **only** from the
  verified session principal; organization overview (stats OWNER/ADMIN-only); member directory with
  keyset pagination and role/status filters; invitation of **existing, non-disabled identity
  accounts** (e-mail delivery is honestly `BLOCKED`; single-use token returned once); role change
  with OWNER-fence (`ADMIN` cannot grant `OWNER` or target an `OWNER`); revoke/cancel-invitation;
  last-owner refusal inside the store's per-workspace advisory lock (never reimplemented in the
  service); every refusal and success audited (`SELF_SERVICE_*` platform
  audit actions).
- `AccountSettingsService` — profile get/locale update; sessions list/revoke-one/revoke-others;
  password change (scrypt, current-password check with the same lockout semantics as sign-in,
  revokes every other session, keeps the presented one); idempotent deletion request (second call
  returns `ALREADY_REQUESTED`), cancel, status; audited to `identity_audit`.

### API surface (session bearer + `x-qeynox-workspace`, workspace resolved from session only)

| Method | Route | Access | Behaviour |
|---|---|---|---|
| GET | `/v1/workspaces` | active member | caller's switchable workspaces + current id |
| POST | `/v1/workspaces` | active member | create workspace; creator becomes ACTIVE OWNER; audited |
| GET | `/v1/workspaces/current` | active member | org detail; stats OWNER/ADMIN only |
| GET | `/v1/workspaces/current/members` | OWNER/ADMIN | directory; `role`/`status`/`limit`/`cursor` |
| POST | `/v1/workspaces/current/invitations` | OWNER/ADMIN | invite existing account; token once; 404 unknown / 403 disabled |
| POST | `/v1/workspaces/current/members/:id/role` | OWNER/ADMIN | change role; ADMIN cannot grant/target OWNER; last-owner refused in store |
| POST | `/v1/workspaces/current/members/:id/revoke` | OWNER/ADMIN | revoke member or cancel pending invitation; last-owner refused |
| GET | `/v1/account/profile` | active member | e-mail, locale, created/verified, active workspace count |
| POST | `/v1/account/profile` | active member | update locale only |
| GET | `/v1/account/sessions` | active member | sessions with `current` marked (hash-matched) |
| POST | `/v1/account/sessions/:id/revoke` | owner of session | revoke one (current flag reported) |
| POST | `/v1/account/sessions/revoke-others` | active member | revoke all but the presented session |
| POST | `/v1/account/password` | active member | scrypt verify/change; other sessions revoked; lockout-aware |
| GET/POST | `/v1/account/deletion-request` | active member | status / idempotent request |
| POST | `/v1/account/deletion-request/cancel` | active member | cancel the pending request |

Zod `.strict()` bodies; reasons 10–500 chars; `idSchema` on path params; cross-workspace references
return `404`; member-only mutation attempts return `403`; last-owner demotion/revocation returns
`403` from the store.

### Web UI (EN/FR, responsive, Professional Blue, inline SVG icons only)

- `/[lang]/workspaces` — switcher (switch = revoke presented session + fresh one via the existing
  `/v1/auth/switch-workspace` contract, then refresh), create-workspace form, organization detail,
  member directory with role editor and revoke (last-owner note), invitation inbox
  (accept/decline own invitations), invite form (token shown once), honest e-mail-BLOCKED copy.
- `/[lang]/account/settings` — profile (verified badge, active workspace count), locale switch,
  security (password change, active sessions with revoke/revoke-others), privacy summary with a
  pointer to `/soul`, account-deletion request/cancel flow with `window.confirm` gate.
- `/[lang]/account` — sign-in plus links to both new pages.

## Verification (recorded, not claimed)

| Check | Result |
|---|---|
| `pnpm typecheck --force` | 4/4 tasks, 0 errors |
| `pnpm qa:workspace-management` (PART 1 logic + PART 2 disposable PG) | PASS — **82 assertions** |
| `pnpm qa:task02` (regression) | PASS — 3891 assertions |
| `pnpm qa:agent-runtime` (regression) | PASS — 65 assertions |
| `pnpm qa:documents` (A17 regression) | PASS — 77 assertions |
| Web production build | PASS; routes `/[lang]/workspaces`, `/[lang]/account/settings` are dynamic (ƒ) |
| HTTP smoke on scratch API + disposable PG (`a18_smoke`, port 4400) | register → profile → sessions → overview → members → create workspace → switch → invite → inbox → accept → members directory; password wrong/right; deletion request/get/cancel; locale change; workspace list |
| Web render of signed-in and signed-out pages, EN and FR (`next start`, cookie-based) | 200 on `/{en,fr}/workspaces`, `/{en,fr}/account/settings`, `/en/account` |

PART 2 coverage: self-service creation (creator = ACTIVE OWNER, audit), invite gates
(member denied / short reason / unknown account 404 / disabled account denied / ADMIN cannot grant
OWNER), token acceptance via `WorkspaceAccessService` (cross-module), duplicate invitation 409,
directory scoping (tenant B invisible), filters and keyset pagination (no overlap), role change with
two-owner demotion ladder, ADMIN fence, cross-workspace 404s, revocation including zero-membership
session termination, re-invite as reinstated INVITED row, pending-invitation cancel, account
password path via the real `AccountStore`, deletion request idempotency/cancel, audit coverage
(`SELF_SERVICE_WORKSPACE_CREATE|INVITE_MEMBER|CHANGE_ROLE|REVOKE_MEMBER`).

## BLOCKED / honest limits

- **E-mail delivery**: no transport exists; invitation tokens are returned once via the API response
  and must be delivered out of band. The UI says so. Verification/recovery mail likewise unchanged.
- **Deletion is a request, not an erasure**: no data is deleted by the request flow; the operator
  runs erasure through platform procedures. The table stores intent only.
- **No new environment/provisioning was exercised**: migration `0023` has not been applied anywhere
  outside the disposable QA database and the scratch `a18_smoke` database.
- **Web forms exercise API contracts over HTTP**; there is no browser-driven (Playwright) E2E for
  the client-side interactions (role editor, invite form token display). Pages render-verified only.
- **Session list shows `identity_sessions` only**; platform-administration sessions are separate and
  unreachable from these routes by design.
- **`qa:backend` is pre-existing-failing** and was not chased (standing instruction).
