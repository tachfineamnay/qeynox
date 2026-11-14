# Independent release audit — 2026-11-14

Verdict: **NO-GO**. Candidate base `a5af7869dbe6cb990144bd2f822d4c8099621946`, with local repairs in this commit. This is not production certification. No push, merge, deployment or preproduction database access occurred. `git ls-remote` confirmed main at 83e1d86f340e04ce57962e74dd00c18b46a1357e and the candidate at the reference SHA. The locally recorded origin/main is an ancestor of the candidate and exactly 11 commits precede the repairs; local main is behind origin/main.

## Verified locally

- Frozen install: PASS in a separate detached worktree, pnpm 9.15.9. The original checkout install failed with EPERM on a locked Next SWC binary and may have left its `node_modules` incomplete.
- Support service regression: PASS with deterministic port/repository fixtures. An unlinked foreign ID is excluded from lists and denied before read, reply and status mutation; customer/team direction and customer-list failure propagation are checked. This is not a live Chatwoot integration test.
- Control private-origin helper: PASS with local positive and negative cases; Control typecheck PASS. Control uses the same origin validation as Web. Login/logout and old root-path cookie migration remain unverified in a browser.
- `pnpm typecheck`: PASS on rerun; initial FAIL was a TypeScript narrowing error in the newly added test, then corrected.
- `pnpm build`: PASS on rerun; initial FAIL was the same test error. Local Node 24.21.0, not the Docker Node 22 runtime.
- `pnpm qa:task02`: PASS, 3295 assertions on disposable PostgreSQL 16.
- `pnpm qa:backend`: FAIL on initial registration assertion; rerun PASS, 28 assertions, with only failure-response diagnostics added to the test in the disposable worktree. Cause of initial failure is unresolved; do not treat as a stable pass.
- `pnpm qa:agent-runtime`: PASS, 62 assertions with QA fixtures.
- `pnpm qa:connectors`: PASS, 48 assertions including live read-only World Bank request.
- `pnpm qa:raas`: PASS, 47 assertions with disposable database and live World Bank read. External production runtimes remain unverified.
- Control HTTP smoke on `http://127.0.0.1:41983/admin/en/account`: 200; one `/admin/_next/static/` CSS asset: 200; `/admin/en`: HTTP 200 but server logged NOT_CONFIGURED because no API origin was supplied; this is not a successful dashboard check. No browser, login, Server Action or responsive certification claimed.
- Design screenshot comparison BLOCKED: `docs/design/reference/concept-02-professional-blue.png` is absent.

## Unresolved release blockers

- Support: remote contact/conversation creation is not atomic with PostgreSQL; duplicates and orphans remain possible after ambiguous or partial failure. Live Chatwoot contract, pagination, privacy and integration tests remain unverified. This repair must not be called complete support certification.
- Soul: refusal pauses onboarding, first-objective form requires memory consent, and completion precedes mission creation; failure can leave an inconsistent journey. Resume, revocation, multi-workspace and failed creation need integration coverage and correction.
- Coolify: the existing operations adapter enumerates team-wide servers/applications/services without QeyNox project/environment restriction; health and unknown states need independent verification. Read-only Coolify inspection through the QeyNox team connector found preproduction (3 applications, 4 services, 3 databases), no Control application, and API configured at historical SHA 541a60d with alias qeynox-api. The first connector belonged to a different team and did not find this project. Network reachability from Control or API to Coolify is not verified.
- The 0012–0017 runbook's `pg_read_file`/`digest` example depends on server-side file paths and an extension and is not reproducible as written. Checksums, upgrade from populated 0001–0011, backup and restore rehearsal remain BLOCKED. Do not execute the current procedure.
- Control: private API alias is configured in the prepared file based on the existing Web deployment documentation, but Control network reachability, platform login, logout/revocation, permissions and basePath actions are unverified. Old root-path session cookies need migration testing. No deployment is authorized by this file.
- Live browser/responsive/error flows, public routes/SEO/sitemap/MyDash regression, GitHub configuration and preproduction configuration were not certified. External Hatchet/Hermes, production object storage, provider licensing/freshness and identity hardening remain separate deployment gates.

Additional suite and Docker results are recorded below when complete. Never infer success from an unexecuted check.


- Platform authorization PASS (107 assertions); platform administration e2e PASS (70); users PASS (165); organizations PASS (87), with isolated PostgreSQL for the e2e suites.


The detached verification worktree `C:/Users/hp/Desktop/qeynox-cert-qa` was retained; it contains disposable test instrumentation and generated dependencies/build outputs, and is not the candidate branch. The original checkout's locked dependency install should be repaired after the processes holding SWC are closed. This audit did not stop those processes.

- Docker Control build PASS: `docker build -f infra/Dockerfile.control -t qeynox-control-cert-local .`, exit 0; local image manifest `sha256:5143b72411ef72c3eeeb0a5fbc7ba4d2a3afb460dcb0eccbc27aa88ffc7efe6c`. Image runtime, ingress and deployment were not verified. Docker build context was the detached QA worktree with the Support and Control code changes; its QA-only diagnostic edit was not included in the candidate.
- Evidence files preserve command output with trailing whitespace normalized; the instrumented backend rerun printed `Backend certification PASSED: 28 assertions` and its QA database was dropped.
