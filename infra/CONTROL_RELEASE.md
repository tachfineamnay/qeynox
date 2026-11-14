# QeyNox Control — release preparation (Mission 09)

Prepared, not deployed. Creating this configuration is **not** an authorization to deploy. No Coolify
resource, deployment, restart or production change was performed. PostgreSQL, Redis, Hatchet, Hermes,
object storage and the qeynox-api/qeynox-worker/qeynox-web resources are not recreated or modified.

## Inspected baseline (Coolify 4.7.5, read-only via MCP)

| Field | qeynox-web (actual) |
|---|---|
| UUID | gu5pde4uim045cfyhbzvatyn |
| Project / environment | Qeynox gm3bynlnlsrkikanyzvxfew7 / preproduction girv53ul8pmfikflpxf9j2re |
| Server / destination | l7k1ng0ir694dr1ftyipqnby / vim4ypxtuvsidpfanzu6qfqa (coolify network) |
| Repository / branch / commit | tachfineamnay/qeynox / main / 541a60d0a9e1fffe9b3756b5918f225f3666d75f |
| Build | dockerfile, /infra/Dockerfile.web, base /, port 3000 |
| Domain / health | https://qeynox.io / GET /en (HTTP 200) |
| Env key names | NODE_ENV, QEYNOX_DEPLOYMENT_ENV, QEYNOX_API_URL, QEYNOX_API_PRIVATE_ORIGIN |

## Control resource (prepared)

- Name: **qeynox-control**, same project/environment/server/destination, same GitHub repository.
- Branch: **feat/workspaces-organizations** (candidate; not yet pushed — see blockers).
- Build: **dockerfile /infra/Dockerfile.control**, base `/`, exposed port **3001**.
- Domain: **https://qeynox.io/admin**, health **GET /admin/en** on port 3001.
- `instant_deploy: false`; `custom_network_aliases: ["qeynox-control"]`.
- Runtime variables (values set in Coolify only, never committed):
  - NODE_ENV=production
  - QEYNOX_DEPLOYMENT_ENV=preproduction
  - QEYNOX_PLATFORM_API_URL=https://qeynox.io (platform API through the existing TLS proxy)
  - QEYNOX_PUBLIC_URL=https://qeynox.io
- Declarative payload: `infra/coolify/qeynox-control.application.json`.

## Build

```sh
# Local/CI build of the image (NOT executed in this mission)
docker build -f infra/Dockerfile.control -t qeynox-control:<sha> .
# The Dockerfile runs: pnpm fetch/install --frozen-lockfile,
# pnpm --filter @qeynox/control typecheck && build, then next start on port 3001.
```

The pnpm lockfile now contains the `apps/control` importer, so `pnpm install --frozen-lockfile`
inside Docker is consistent. `apps/control` depends only on next/react/react-dom/zod; no QeyNox
workspace package and no additional service is duplicated.

## Reverse proxy / Next.js routing

Control uses **Next.js `basePath: '/admin'`** and routes live at `/[lang]/...`, so public paths,
server actions and `/_next` assets are all under `/admin`. One rule is enough:

```text
Host(`qeynox.io`) && PathPrefix(`/admin`)  ->  qeynox-control:3001 (path preserved)
```

Give this router a higher priority than the existing qeynox-web Host(`qeynox.io`) router. Do **not**
add a broad `/` rule for control: it would shadow existing web routes, private API calls and the
signed S3 download router. If the Coolify domain field does not accept a path, add the equivalent
Traefik dynamic router on the server; no reverse-proxy change is made by this repository.

Preserved and untouched: qeynox-web routes at `/`, private API routing, private object storage and
signed S3 download router, qeynox-api/qeynox-worker containers, PostgreSQL/Redis/Hatchet/Hermes.

## Manual creation and deployment procedure (operator only)

1. Push the candidate branch (requires explicit authorization) and confirm GitHub has
   `infra/Dockerfile.control` and `apps/control`.
2. Create the application from `infra/coolify/qeynox-control.application.json` (or UI) with
   `instant_deploy=false`.
3. Set the four runtime variables and the domain/health values above.
4. Verify the proxy rule for `/admin` and that `/_next`, `/v1`, S3 export paths still reach their
   existing services.
5. Deploy manually, watch the build, then GET `https://qeynox.io/admin` (redirect to `/admin/en`) and
   check platform login. Do not deploy from this mission.
6. Run the additive migration procedure (`infra/MIGRATIONS_0012_0017_PREPRODUCTION.md`) before
   relying on Control features that need migration 0012+.

## Rollback

- Control is a separate application: stop/pause it and remove the `/admin` proxy rule; web, API,
  worker, storage, database and signed download routes are unaffected.
- No database rollback is normally needed because migrations 0012–0017 are additive. If a full
  candidate rollback is required, restore the pre-migration backup; never DROP tables manually.
- Roll back the Git candidate by deploying the previous qeynox-control image/commit; deleting the
  application resource is an operator decision, not part of this preparation.

## Blockers / not tested

- Candidate branch is not pushed; origin `feat/workspaces-organizations` points to 7190819 and lacks
  `apps/control`. Local HEAD contains commits 04–09.
- No Docker build, no candidate typecheck/build, no Coolify resource creation, no proxy change, no
  migration and no deployment was executed.
- Coolify path-domain support and Traefik priority must be verified on the server before deployment.
- Public-site legal content, Chatwoot provisioning and Coolify/ops environment remain external gates.
