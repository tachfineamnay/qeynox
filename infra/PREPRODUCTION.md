# Independent preproduction resources

Only project gm3bynlnlsrkikanyzvxfew7 / environment girv53ul8pmfikflpxf9j2re is authorized.
Root build context `/`; Dockerfiles `/infra/Dockerfile.api`, `.worker`, `.web`.
Health endpoints are liveness only, never evidence of business/runtime readiness.
Worker Docker health checks process liveness; it has no inbound business port.
Runtime retains workspace source exports and the pinned tsx toolchain; do not prune required workspace packages.

Never enable Hermes attestations until native tools and egress have been independently contained.
Never start Hatchet, Hermes or AnythingLLM until host capacity is measured.
Host diagnostic commands for the VPS provider terminal:
```sh
nproc
free -h
df -h
docker system df
docker ps --format '{{.Names}} {{.Status}}'
docker network ls
```
No SSH configuration file exists locally; the sole local public key was refused for root.
The configured MCP bundle already targets Sociopulse. This session's loaded connector is stale;
all authorized operations use Streamable HTTP directly with the instance-specific token file.
No terminal/exec tool is exposed by the Coolify MCP catalog. Do not inject diagnostics into app commands.

Service manifests are prepared, not certified. Images must pass registry checks before creation.
The shared coolify bridge is only provisional reachability, not a tenant isolation boundary.
Hatchet default bootstrap identity must be rotated before activation; internal plaintext gRPC is preproduction-only.
Hermes must receive a reviewed model provider and an actual deny-by-default tool/egress policy before execution.
Storage needs a non-root scoped application credential, private bucket, tested SSE/KMS and a client-accessible TLS endpoint for signed downloads; root credentials must never be given to QeyNox.

Measured capacity (operator-provided VPS terminal output, 2026-11-13): 4 CPU; 15 GiB total RAM, 14 GiB available; root SSD 193 GiB, 182 GiB available; no swap. Docker: 8 images / 7 active, 7 containers active, 7 volumes / 6 active. These are not agent SSH measurements. Database/storage starts were requested only after receiving these measurements.

Inventory:
| Resource | Coolify UUID |
|---|---|
| qeynox-postgres | cris5cemg9ja3g3ur5tyiypg |
| qeynox-redis | lnclv7rbyekp5ks5iokxbxvj |
| qeynox-hatchet-db | 9zbn2burfbghxjz25cpb45xv |
| qeynox-hatchet | povviyiod3fxzrbhe4hzhmn1 |
| qeynox-hermes | i57klnidhv6rqawzvqf5a7tz |
| qeynox-storage | 4uufasc903is4vb504v3bw9e |
| qeynox-api | d8owo32umum050d4w7k2wvzp |
| qeynox-worker | urabqgudjsqnycnicygon1vv |
| qeynox-web | gu5pde4uim045cfyhbzvatyn |
| qeynox-anythingllm | optional, deferred until foundation runtime validation |

Configured hostnames are proposals until Docker DNS is tested on VPS. Database resource UUIDs and service aliases are used; no public data/runtime ports. No domain configured. Production environment q5x4rw8twte2qim9qbmqex2k remains empty.

Private Web/API authorization: QEYNOX_API_PRIVATE_ORIGIN must equal the exact HTTP origin; URL credentials, paths, query, fragment and other origins are rejected. Hermes equivalent is HERMES_PRIVATE_ORIGIN; API base includes /v1/.

Redis: QEYNOX_REDIS_URL configures a process-shared client, atomic server-time sliding quota window and fail-closed provider reservations. Production BrokeredAgentExecutor requires it. Redis AOF enabled, noeviction, 128 MiB data ceiling inside 256 MiB container. Core budgets and intent ledger stay PostgreSQL canonical. Health endpoints are liveness only.

Migration: `pnpm --filter @qeynox/persistence exec tsx scripts/migrate-preproduction.ts` requires QEYNOX_DEPLOYMENT_ENV=preproduction, QEYNOX_ALLOW_PREPRODUCTION_MIGRATIONS=true, QEYNOX_MIGRATION_DATABASE=qeynox and exact database name qeynox. It only initializes an empty database. Existing QA CLI guards remain intact. Populated upgrades require a separate backup-controlled procedure; do not put this initial-only CLI in a restart command.

Local verification: frozen install, typecheck and production build passed; task02 2874, backend 28, agent-runtime 62, connectors 48, RaaS 47, storage 26, egress 47 assertions. Live World Bank read and real local S3 signed/anonymous/expired reads verified. Private-origin tests and concurrent Redis-client quota test passed, including Redis unavailability; Redis local AOF value survived restart. Initial empty preproduction migration applied all 11 migrations with NODE_ENV=production, then refused a nonempty database. These are local disposable checks, not VPS connectivity proof.

MinIO source tags tested on Docker Hub / Quay were unavailable. Storage is prepared using the exact existing QA-tested bitnamilegacy/minio digest; legacy distribution/security review and production SSE/KMS remain gates. No customer artifact credential is provisioned yet, no root storage credential shared with applications.

## Runtime verification update
SSH was unlocked by the operator adding the existing local public key. Host remeasured over SSH: 4 CPU, 15992 MiB RAM, 14241 MiB available, root disk 193 GiB / 181 GiB free at measurement. Core/Redis/Hatchet DB and storage are running healthy. Database UUID aliases and qeynox-storage resolve on the destination network. Redis authentication is enforced, AOF enabled, and the preproduction verification value survived its Coolify restart.

Core's 11 unchanged migrations were applied atomically by SSH/psql on the verified empty qeynox database with explicit database/user guard, transaction advisory lock and canonical Git LF SHA-256 ledger. No production database or QA CLI guard was altered. Hatchet independently created its own schema in its own database. Hatchet Lite is running healthy with a dedicated tenant, generated non-default administrator password and expiring 30-day worker token, all kept out of source/output.

S3 bucket qeynox-preproduction is private, SSE-S3 AES256 enabled with a separately generated preproduction static KMS key. The API and worker have only bucket-scoped app credentials, not root. Static KMS key backup/production KMS and legacy-image security review remain gates. Signed URLs currently use internal DNS and are not publicly accessible.

All three final Docker builds succeeded. Local API/Web returned HTTP 200; Web-to-API DNS fetch returned 200; API UID is 1000; pnpm 9.15.9 runs in the worker image with network disabled. API image restart succeeded. Public MyDash and real Hermes remain blocked pending domain/TLS and model+confinement. Application VPS deployment verification follows separately; no PASS is inferred from build success.

## Deployment compatibility correction
The first API deployment at code SHA 2782736 started NestJS but Coolify rejected its generated healthcheck because curl/wget was absent. Dockerfile.api and Dockerfile.web now install curl; platform health validation remains enabled. Unsupported --log-opt custom Docker arguments were removed through Coolify; applications use Coolify stdout/stderr capture, and bounded application log rotation is not claimed.

Optional RAG is now prepared and stopped: qeynox-anythingllm / qzgtwub6hxm3lvqomwwttbey, official mintplexlabs/anythingllm:1.19.0 manifest verified. Dedicated volumes and secrets; no SYS_ADMIN, no model/embedding configuration and no connector activation. Its configured check is liveness only; full readiness is required before activation.

Real Hatchet SDK verification on VPS succeeded: infrastructure-only task run 21744469-4441-45af-a9f7-13e37d6b0d87 registered, dispatched and returned its nonce through SDK 1.46.1, then the temporary probe worker stopped. No Hermes or business result was simulated. VPS ToolBroker→World Bank QA passed 48 assertions using dedicated non-superuser qeynox_qa_verifier and distinct qeynox_qa_control admin database; its random QA execution database was dropped by the isolated harness. Core connector activation remains off.

Healthcheck fix verification: both API/Web curl-enabled images built successfully, including fresh typecheck/build inside Docker. curl runs without network and returned 200 from the actual local API/Web endpoints. Hatchet tenant inspection shows only the internal system tenant and qeynox-preproduction; only the specified operator email exists, no default admin user.

Final observed state and proofs supersede the chronological preparation notes above: docs/architecture/PREPRODUCTION_VERIFICATION.md. Application aliases are native Coolify custom_network_aliases, not UUID assumptions. Eight resources healthy; Hermes and AnythingLLM stopped. Actual release SHA 541a60d0a9e1fffe9b3756b5918f225f3666d75f. No public MyDash URL; no client Hermes run or business success claimed.

Public access update: docs/architecture/PUBLIC_ACCESS_VERIFICATION.md supersedes earlier missing-domain statements. Web fqdn is https://qeynox.io; API/worker S3 endpoint is https://qeynox.io. Only the /qeynox-preproduction bucket path routes to S3; full signed Host/path preserved. Authenticated public MyDash and mission verified; signed 200 / anonymous and expired 403. All data ports remain private; Hermes/AnythingLLM stopped. App code/images unchanged at 541a60d.
