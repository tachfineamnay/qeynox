# QeyNox web

Next.js App Router / React / TypeScript inside the existing pnpm/Turbo workspace.

Run `pnpm install --frozen-lockfile`, then `pnpm dev:web` from the repository root.
Copy this app's `.env.example` to `apps/web/.env.local` and set `QEYNOX_API_URL` to the existing API origin. It stays server-only. Without it the UI explicitly reports unavailable integration. Production requires HTTPS; local HTTP is restricted to loopback. No backend or external runtime is started automatically.

Routes: `/en` and `/fr`, with `/mydash`, `/missions`, `/missions/:id`, `/capabilities`, `/account` under each locale. `/` redirects to `/en`.

The web server calls only existing login/logout, recent operations, operation detail and draft creation contracts. The bearer/workspace session is kept in a SameSite HTTP-only cookie (Secure in production); it is never sent as page data or placed in browser storage. Next Server Actions supply the same-origin mutation boundary. Responses are not cached. Session storage and public identity still require independent deployment certification.

Mission creation uses the shared Zod contract and creates a draft only. A timed-out mutation reports an unknown outcome and is not automatically replayed. Capability availability cannot be inferred from operator configuration: no customer catalogue exists, so the UI reports unavailable rather than inventing configured skills. Plan/price/approval/execution, complete Library discovery and artifact delivery UI remain outside this frontend foundation.

Shared presentation lives in `src/components`, EN/FR copy in `src/lib/copy.ts`, API/session handling in `src/lib/api.ts`, mutations in `src/lib/actions.ts`. Canonical Professional Blue tokens are imported directly from `docs/design/design-tokens.css`.

Focused checks: `pnpm --filter @qeynox/web typecheck`, `pnpm --filter @qeynox/web build`, then `pnpm --filter @qeynox/web test:smoke`. The smoke test starts the built app and an isolated HTTP contract fixture, verifies EN/FR and empty/loaded/denied/malformed states, and checks that bearer tokens never enter page HTML. It does not certify login/draft mutations against a real backend. No production database or live agent runtime is necessary. Reference screenshot comparison is BLOCKED until `docs/design/reference/concept-02-professional-blue.png` exists.
