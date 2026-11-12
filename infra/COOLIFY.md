# VPS / Coolify foundation (SOURCE ONLY)

No infrastructure has been deployed. This compose file provides application and QeyNox-owned PostgreSQL services only. The Hatchet and Hermes runtimes must be installed using their **verified official self-host procedures** and connected over a scoped private network. Do not guess a Hatchet image, required migrations, topology, TLS port, login or secrets.

Before use:
- Assign private DNS/URLs, secrets, TLS, persistence, scoped network egress, separate Hatchet PostgreSQL storage and backups.
- Verify that Hermes native terminal/browser/filesystem/MCP tools are disabled or broker-mediated; the default integration intentionally fails closed.
- Use an actual identity provider and tenant isolation: API routes deliberately deny calls without a trusted authenticated principal.
- Apply QeyNox database migrations only after an explicit database backup and controlled migration procedure.
- Add monitoring, user consent policies, cost ceilings, artifact object store and key management.
- Review Dockerfiles and Compose with a build/lint/security/test wave before any deployment.
- Do not set HERMES_NATIVE_TOOLS_ISOLATED=true until actual isolation controls have been independently validated.
- No public database, Hermes or Hatchet management endpoint by default.

Official references: https://docs.hatchet.run/v1 and https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server .

## Runtime network correction

The original Compose source had only an `internal: true` network. That isolates
PostgreSQL as intended, but also blocks API/worker outbound connectivity to
separately hosted Hatchet, Hermes and allowlisted public providers.

The API and worker now join two networks: `qeynox-private` for PostgreSQL
and `qeynox-outbound` for configured external runtimes/providers.
PostgreSQL stays only on `qeynox-private` with no published port.

**Security gate:** a Docker bridge is NOT an egress firewall or a pinned
network policy. Do not set `QEYNOX_NETWORK_POLICY_ATTESTED=true` or
`HERMES_NATIVE_TOOLS_ISOLATED=true` merely because a route exists.
Apply an external firewall/allowlist and actual Hermes tool sandboxing, then
verify both in a controlled environment. The fail-closed defaults stay in place.

A root `.dockerignore` also prevents local `.env`, private keys, Git metadata,
build artifacts and host `node_modules` from entering Docker build contexts.
Do not bake credentials into images; provide them via runtime secret management.

This is a **source-level repair, not a completed deployment, live-test pass or
production security certification**. Check your local ahead-of-origin commits
before bringing this branch into a working tree; do not overwrite 08A or other
unpublished changes.
