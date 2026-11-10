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
