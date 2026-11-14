# QeyNox Control

Internal administration desk served under **/admin** (routes live at `/admin/en|fr/...`; no reverse
proxy change is made here — the proxy must later route `/admin` to this Next.js app).

- Reuses **only** the existing `/v1/platform/*` APIs from Missions 01–03.
- Platform sessions only: the bearer token is kept in an HTTP-only cookie and never sent to a
  workspace API; no identity backend is recreated and no workspace session is accepted.
- Server-side data fetching/actions (no browser token); official Professional Blue tokens imported
  from `docs/design/design-tokens.css`.
- EN/FR routes, desktop/tablet/mobile layouts, explicit unavailable/denied/blocked states.

Run locally: `pnpm --filter @qeynox/control dev` (port 3001), copy `.env.example` to `.env.local`.
Requires an existing QeyNox API and a platform account bootstrapped with `pnpm admin:bootstrap`.

Screens: platform login/logout, dashboard, users list/detail (suspend, reactivate, revoke sessions,
activity), organisations/members (invite with real BLOCKED delivery + one-time token, change role,
revoke), audit journal.
