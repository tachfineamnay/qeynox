# QeyNox — Public HTTPS and signed exports verification

Date: 2026-11-13 (Africa/Casablanca). This report supersedes the earlier preproduction report's missing-domain/public-download blockers. It is not production certification.

## Scope and identity

- Instance: Coolify 4.7.5 at `http://31.97.158.141:8000`.
- VPS: `srv1928975`; SSH interface `eth0` actually carries `31.97.158.141/24`.
- Coolify server: `l7k1ng0ir694dr1ftyipqnby`; its stored `host.docker.internal` address is the local execution connection, not a different public VPS.
- Frontend: `gu5pde4uim045cfyhbzvatyn`, on that server and the `coolify` destination network.
- Project/environment: Qeynox / preproduction (`gm3bynlnlsrkikanyzvxfew7` / `girv53ul8pmfikflpxf9j2re`). Production remained empty.
- Actual API/Web/worker images still run application code `541a60d0a9e1fffe9b3756b5918f225f3666d75f`. No application rebuild or business-code change was needed.

## DNS

| Check | Observed result |
|---|---|
| A, Cloudflare 1.1.1.1 | `31.97.158.141`, TTL 14400 |
| A, Google 8.8.8.8 | `31.97.158.141`, TTL 14400 |
| A, authoritative nebula.dns-parking.com | `31.97.158.141` |
| A, authoritative aurora.dns-parking.com | `31.97.158.141` |
| AAAA, Cloudflare | No AAAA answer returned |
| CAA, Google DNS JSON endpoint | NOERROR, no CAA answer |

No DNS mutation or Hostinger access was necessary. No additional subdomain was introduced for S3. These resolver checks do not claim propagation at every resolver worldwide.

## Public URLs and actual authentication

| Request | Result |
|---|---|
| `http://qeynox.io/fr/account` | **302**, Location `https://qeynox.io/fr/account` |
| `https://qeynox.io/` | **307**, Location `/en` (existing application locale behavior) |
| `https://qeynox.io/fr/account` | **200**, actual login form |
| POST actual rendered login form with existing operator verification account | **303**, Location `/fr/mydash` |
| Session cookie | `Secure` and `HttpOnly` observed; cookie/token not disclosed |
| `https://qeynox.io/fr/mydash`, authenticated | **200**, existing mission title visible |
| `https://qeynox.io/fr/missions/2a3474e2-c372-440a-a669-4c777106f7e7`, authenticated | **200**, existing mission visible |

The actual Next.js form metadata was fetched and submitted over public HTTPS, not replaced with a fabricated session. Tests used an HTTP client with browser-conformant multipart serialization; no browser visual/hydration certification is claimed. A first test-client multipart serialization produced a FormData parsing error before authentication; correcting the test serialization validated the unchanged application. Account credentials and session cookies remain encrypted locally, not in Git or this report.

Web → API remains private at `http://qeynox-api:4000`, with the exact private-origin authorization retained. `/v1/operations` on the public host returned **404**; the internal API was not published separately.

## TLS

A normal Windows/.NET TLS handshake with hostname and trust validation succeeded, without skipping certificate checks:

- Protocol observed: **TLS 1.3**.
- Certificate subject/DNS: **qeynox.io**.
- Issuer: **Let's Encrypt YR1**.
- Valid from **2026-11-13 21:46:22 UTC** to **2027-02-11 21:46:21 UTC**.
- Native frontend router uses the existing `letsencrypt` ACME resolver. Automatic certificate management is configured; a future renewal was not simulated.

## Signed HTTPS S3 exports

The storage service alone owns a dedicated Traefik router on `Host(qeynox.io)` and the exact bucket path `/qeynox-preproduction` or prefix `/qeynox-preproduction/`. Its priority is 200, above the frontend catch-all. The full request Host/path are preserved; no StripPrefix or signature URL rewriting is used. Only port 9000 is used internally; no host port or console route was added.

`QEYNOX_ARTIFACT_ENDPOINT=https://qeynox.io` is actually loaded by API and worker. Existing bucket-scoped application credentials and AES256 SSE-S3 remained in use; root credentials were not shared with clients.

| Public export test | API process | Worker process |
|---|---|---|
| Existing JSON signed HTTPS read | **200**, exact SHA-256 | **200**, exact SHA-256 |
| Existing HTML signed HTTPS read | **200**, exact SHA-256 | **200**, exact SHA-256 |
| New small technical object uploaded through configured HTTPS endpoint | Write/HEAD/read **passed** | Write/HEAD/read **passed** |
| Encryption header | **AES256** | **AES256** |
| Download protection | attachment, CSP sandbox, no-store | attachment, CSP sandbox, no-store |

Anonymous reads of existing private exports returned **403**. The previous 30-second signed JSON/HTML URLs returned **403** with an explicit expiry error after expiry. No still-valid signature or storage credential is published here. Stable unsigned object paths are intentionally denied; functional download URLs must be generated with a fresh signature.

The existing JSON technical export at `/qeynox-preproduction/verification/mission-2a3474e2-c372-440a-a669-4c777106f7e7.json` is an example of that private path, not an anonymous public download. Its HTML counterpart was also tested. These remain technical exports of a real DRAFT mission; no completed business result or Hermes output was invented.

Response headers on the bucket router force `Content-Disposition: attachment`, CSP `sandbox; default-src 'none'; style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`. This prevents exported HTML from executing with the login origin's authority and prevents signed-query caching/referrer leakage.

`/minio/admin/v3/info` and `/minio/health/live` on the public host returned frontend **404**, not the MinIO management/health API. No console exposure was configured.

## Changes and persistence

Only these existing QeyNox resources were restarted; no image rebuild was required:

1. Web, to apply its native Coolify domain/TLS labels.
2. Storage, to apply its bucket-specific HTTPS/download labels (followed by final security headers).
3. API and worker, to load the verified public HTTPS S3 endpoint.

No shared proxy restart, other-project mutation, production deployment, database restart or data deletion was performed. A brief route **404** occurred while the storage router was being recreated; all expiry/privacy checks were repeated after storage was healthy. Zero-downtime changes are not claimed.

After the restarts, authenticated public login/MyDash/mission tests passed again. Core still contains mission `2a3474e2-c372-440a-a669-4c777106f7e7` in **DRAFT**. Both existing export digests still match after storage restart. Final application states are `running:healthy`; storage is `running:healthy`.

All PostgreSQL Core, Hatchet PostgreSQL, Redis, storage and application `HostConfig.PortBindings` inspected are `{}`. Traffic is through existing Traefik 80/443. Hermes and AnythingLLM remain **exited**, deliberately inactive. Production environment still reports 0 applications, 0 services and 0 databases.

## Remaining gates

- No DNS or TLS blocker remains for qeynox.io or this same-host export path.
- Hermes still needs a real provider and proven native-tool/network confinement before client agent execution. AnythingLLM remains optional and unconfigured.
- Public reachability does not certify public identity/gateway hardening, MFA/recovery, external backups/restore, production KMS/key backup, maintained storage-image security, tenant egress isolation, configured business capabilities or pricing/provider policies. Registration and unverified agent execution remain disabled.
- No custom business operation was executed or declared successful. Existing mission state stayed DRAFT.

Configuration reference: `infra/services/storage.yml`. Routing semantics follow the [Traefik rule documentation](https://doc.traefik.io/traefik/reference/routing-configuration/http/routing/rules-and-priority/).
