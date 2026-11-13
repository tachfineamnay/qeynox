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

## Public domain and signed HTTPS exports (verified)

- Web resource gu5pde4uim045cfyhbzvatyn: native Coolify domains=https://qeynox.io; existing letsencrypt resolver. Keep the upstream application port 3000 private.
- API and worker: QEYNOX_ARTIFACT_ENDPOINT=https://qeynox.io (runtime only). Bucket qeynox-preproduction stays private, AES256 SSE-S3 enabled, app-scoped credentials only.
- Apply infra/services/storage.yml to the existing storage resource, preserving its volumes/secrets. Its named Traefik bucket-only router preserves Host and complete path for SigV4; it does not route MinIO root/admin/console. Do not add StripPrefix or rewrite signed URLs after signing.
- Existing root-domain HTTP→HTTPS redirection covers the export path. Export responses download as attachments under CSP sandbox with no-store/nosniff/no-referrer headers.
- No additional S3 DNS record is required. Public validation and remaining gates: docs/architecture/PUBLIC_ACCESS_VERIFICATION.md.
