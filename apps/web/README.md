# QeyNox web

Next.js App Router / React / TypeScript inside the existing pnpm/Turbo workspace.

Run `pnpm install --frozen-lockfile`, then `pnpm dev:web` from the repository root.
Copy this app's `.env.example` to `apps/web/.env.local` and set `QEYNOX_API_URL` to the existing API origin. It stays server-only. Without it the UI explicitly reports unavailable integration. Production requires HTTPS; local HTTP is restricted to loopback. No backend or external runtime is started automatically.

Routes: `/en` and `/fr`, with `/mydash`, `/missions`, `/missions/:id`, `/capabilities`, `/account` under each locale. `/` redirects to `/en`.

The web server calls only existing login/logout, recent operations, operation detail and draft creation contracts. The bearer/workspace session is kept in a SameSite HTTP-only cookie (Secure in production); it is never sent as page data or placed in browser storage. Next Server Actions supply the same-origin mutation boundary. Responses are not cached. Session storage and public identity still require independent deployment certification.

Mission creation uses the shared Zod contract and creates a draft only. A timed-out mutation reports an unknown outcome and is not automatically replayed. Capability availability cannot be inferred from operator configuration: no customer catalogue exists, so the UI reports unavailable rather than inventing configured skills. Initial plan/price/approval/start, redo/revision and complete Library discovery remain blocked by missing customer read/readiness contracts.

Mission detail now reads the operation, summary, full timeline, cursor-paginated activity, Pilot next-action/overview, documents and consented Soul facts. Sections fail independently. Active missions refresh every 10 seconds while visible and no form has focus; refresh performs reads only. Recorded event kinds are shown verbatim without exposing raw event payloads. Stop requests recheck the operation version and require explicit confirmation; a request never claims confirmed cancellation. The document reader preserves draft/partial/review/deliverable and finding statuses, sources, limitations and unresolved claims. Exports use the existing JSON/HTML save and signed-grant APIs; access can be renewed with the returned artifact ID. No signed URL enters browser storage. Artifact discovery/reconciliation after an unknown export outcome remains a contract/UI limitation.

Soul supports explicit purpose-scoped read/write consent grants, saving text against a real consent ID, and confirmed deletion/revocation of returned facts/consents. The new grant ID is displayed for use in the save form; the API has no consent listing endpoint. Revocation can therefore hide facts whose consent metadata is no longer discoverable. Local deletion does not imply third-party erasure. Soul conversation and Pilot proposals are not invoked without real attempt/capability scope.

Shared presentation lives in `src/components`, EN/FR copy in `src/lib/copy.ts`, API/session handling in `src/lib/api.ts`, mutations in `src/lib/actions.ts`. Canonical Professional Blue tokens are imported directly from `docs/design/design-tokens.css`.

Focused checks: `pnpm --filter @qeynox/web typecheck`, `pnpm --filter @qeynox/web build`, then `pnpm --filter @qeynox/web test:smoke`. The smoke test starts the built app and an isolated HTTP contract fixture, verifies EN/FR and empty/loaded/denied/malformed states, and checks that bearer tokens never enter page HTML. It does not certify login/draft mutations against a real backend. No production database or live agent runtime is necessary. Reference screenshot comparison is BLOCKED until `docs/design/reference/concept-02-professional-blue.png` exists.
