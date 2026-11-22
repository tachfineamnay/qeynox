# P18 — private document storage operational integration

**Source/configuration integration only. Real S3 certification is deferred to P22.** Nothing here
authorizes bucket/policy/object/KMS/credential mutation, deployment or restart. P10 mission retrieval,
P11 ingestion claims/fencing and P12 durable deletion/retention algorithms are retained, not replaced.
No new scheduler, database migration, bucket, volume or public endpoint is introduced.

## 1. One backend storage contract

API document vault, API result/Atlas exports and Worker maintenance now use the same
`createS3ArtifactStoreFromEnv` / `storageConfiguration` loader. Supply identical reviewed values from
the same scoped secret-store entries to API and Worker:

| Variable | Deployment contract |
| --- | --- |
| `QEYNOX_ARTIFACT_ENDPOINT` | `http://qeynox-storage:9000`, private origin, path-style signing |
| `QEYNOX_ARTIFACT_REGION` | explicit existing bucket signing region (example `us-east-1`); no guessed runtime region |
| `QEYNOX_ARTIFACT_BUCKET` | existing private bucket, not a new bucket or path in the endpoint |
| `QEYNOX_ARTIFACT_ACCESS_KEY`, `QEYNOX_ARTIFACT_SECRET_KEY` | same reviewed scoped application identity; never storage root/admin credentials |
| `QEYNOX_ARTIFACT_SERVER_SIDE_ENCRYPTION` | `AES256`; production refuses opt-out |
| `QEYNOX_STORAGE_TIMEOUT_MS` | default 10000; integer 1000..20000, whole operation including retries/body |
| `QEYNOX_STORAGE_MAX_ATTEMPTS` | default 2; integer 1..3, SDK standard retry strategy within overall deadline |

No ambient AWS credential chain, implicit public AWS endpoint or browser-facing S3 host rewrite is
used by the application factory. Missing/invalid configuration reports NOT_CONFIGURED; Atlas does
not claim storage configured from three credential strings alone. Entrypoint configuration checks
reject bad bounds, invalid bucket, encryption opt-out and root/KMS secret variables in application env.
The supported production private endpoint intentionally remains the existing P16 MinIO alias; do not
point it at public DNS to bypass these guards. A transport/TLS/managed-store migration is separate work.

Web receives **only** the same private endpoint and bucket, `QEYNOX_PUBLIC_URL` and a 32-byte base64
`QEYNOX_STORAGE_RELAY_KEY`. It needs neither S3 access keys nor root/KMS secrets. Control needs none.
Use the complete role examples under `infra/release/`; compare API/Worker secret revisions in the
restricted deployment inventory before any future rollout. Shared code cannot prove that live env
values match; no live inventory was performed by P18.

## 2. Signing and customer Atlas routing

Keep `qeynox-storage:9000` private, with no Traefik domain or host-published port. Do not reintroduce
the historical public bucket-path proxy. Document upload/download and result artifact export/renew
already use Web `/storage-transfer`; P18 completes that existing relay rather than creating another.

- Server S3 client uses explicit region/path-style endpoint and bounded SDK retries. Presigned URLs
  retain their original Host/path/query; they are never rewritten to a public domain after signing.
- Read grants first perform bounded HEAD (including the missing-bucket cross-check) and reject a
  missing/oversized object before issuing an Atlas/document link. This is a point-in-time check, not a
  promise the object cannot change/disappear later.
- Signed document PUT includes **SSE-S3 AES256** and **`If-None-Match: *`**. The relay forwards those
  exact signed headers, plus the content type. Objects cannot be overwritten by replaying an upload
  grant. API-only non-browser clients must also send the required signed headers.
- SDK checksum behavior is WHEN_REQUIRED, preventing an unsolicited checksum for an unspecified PUT
  body from breaking browser uploads. P10 completion still verifies actual size/SHA/type; no integrity
  assertion was removed. Existing encrypted objects are not re-encrypted or renamed.
- A relay ticket is encrypted/authenticated, session/workspace/method-bound, and expires at the earlier
  of 120 seconds or the underlying signed-URL expiry minus a five-second margin. Supported SigV4
  algorithm/headers/expiry and exact private endpoint/bucket/workspace prefix are checked. Keep clocks
  synchronized; future timestamps beyond one minute are rejected.
- Every relay request checks the live session **and the canonical resource**: document download reuses
  its retention/state authorization; PUT requires an unexpired PENDING_UPLOAD document; result exports
  reuse their operation/document/artifact grant authorization. A deletion/expiry after minting does not
  become a two-minute authorization bypass. A concurrent revocation after that check remains a normal
  request race; no claim of retroactive cancellation of already dispatched bytes is made.
- Recheck ticket/signature lifetime after API authorization/body buffering. Atlas must mint/renew a
  fresh grant instead of caching ticket links. An expired ticket returns 410, not a public fallback.
- Whole relay transfer deadline is 30 seconds (including body buffering), bytes <=10 MiB, redirects
  refused, same-origin PUT only, no-store/attachment/nosniff/sandbox download headers. Neither arbitrary
  browser auth headers nor upstream S3 XML bodies are forwarded.
- Statuses distinguish permission denial (403), expiry (410), too large (413), API auth dependency (503),
  upstream failure (502), deadline (504), existing conditional upload (409) and unavailable object (404).
  No automatic browser retry of PUT is added. After an ambiguous PUT, completion can verify the actual
  original bytes under P10 rules; never overwrite an object as a retry convenience.

Artifact exports already cap content below 10 MB; document size policy stays 10 MiB. Both fit the
relay/adapter limit. No larger-file feature or unbounded streaming fallback is added. The signing/relay
changes are compiled, **not real-S3 certified**; P22 must exercise the exact SDK/image/store combination.

## 3. Private policies and tenant-safe keys

`node infra/services/render-storage-policy.mjs` renders an **offline policy bundle** using the supplied
existing `QEYNOX_ARTIFACT_BUCKET`. It has no S3/admin client or apply command. Do not execute a policy
change from this task. A future authorized operator must inspect and merge existing policies in place:
never blindly replace a bucket policy or recreate a bucket to match a template.

The desired bundle contains:
- Application IAM policy: ListBucket only with `workspaces/` prefix, GetObject/PutObject/DeleteObject
  only under `workspaces/*`; explicit refusal of bucket administration and version purge.
- Bucket guard statements with **no public Allow**: require AES256 on new PUT and deny public object ACLs.
- AWS public-access-block settings (all true), or MinIO desired anonymous access **none**. These are
  provider-specific operator contracts, not interchangeable API payloads. Verify actual support.

No-public-Allow alone does not prove a bucket private: inspect existing ACLs, bucket/access-point
policies, anonymous rules and broad identity grants. App IAM is shared across workspaces and does not
replace tenant authorization. The canonical API authorizes the workspace/resource before signing;
the adapter additionally rejects off-namespace, dot/empty/control/encoded-traversal keys. Keys remain
`workspaces/{workspace}/documents/{id}/{slug}` and
`workspaces/{workspace}/operations/{operation}/results/{document}/{artifact}.{format}`. New literal
`.`/`..` upload-name slugs become `document`; existing objects/rows are not rewritten. Unsafe historical
keys fail closed for operator investigation, never normalize into another tenant's object.

Keep existing bucket, app identity where approved, object data/versions, persistent `s3-data` binding,
KMS secret/key identity, encryption configuration and backups. Root/admin/KMS credentials belong only
to storage/operator secret management. Do not use `mc anonymous set public`, public ACLs, root app
credentials, policy wildcards on all buckets, automatic bucket bootstrap, lifecycle expiration or
`DeleteObjectVersion` as shortcuts. Legacy MinIO image security and real network isolation remain
independent release gates; compilation is not a production security certification.

## 4. Ingestion lease recovery and durable maintenance

Reuse the existing Worker `SerialPoller`. Its positive ingest interval controls **all three** existing
maintenance drains, not only extraction. Production now refuses a disabled/misconfigured loop or absent
storage rather than silently leaving deletion/retention idle.

| Worker setting | Default / bounds |
| --- | --- |
| `QEYNOX_DOCUMENT_INGEST_INTERVAL_MS` | 5000; production 1000..60000; scheduled after the previous complete sweep |
| `QEYNOX_DOCUMENT_INGEST_LEASE_MS` | 300000; 30000..1800000, plus >= storage deadline + 30000 headroom |
| `QEYNOX_DOCUMENT_INGEST_BATCH` | 1; 1..10; prefer 1 until actual extraction timing is certified |
| `QEYNOX_DOCUMENT_RETENTION_BATCH` | 5; 1..10 |
| `QEYNOX_DOCUMENT_DELETION_BATCH` | 1; 1..10, additionally `batch * 2 * storage_timeout <= 100000` |

P11 keeps its three-attempt, SKIP LOCKED/fencing/renewal/atomic publication semantics. P12 keeps the
120-second deletion lease, verified-current-key absence, durable tombstones and bounded backoff
(1 minute up to 6 hours, terminal failure after its existing attempt policy). The deletion batch bound
leaves room below that existing lease for bounded DELETE + HEAD, including HEAD's missing-bucket
cross-check. Database/extraction/embedding latency still needs P22 measurement; no environment bound
is proof that an arbitrary extraction/CPU phase completes within a lease. Do not raise batches blindly.

Expired documents are already excluded by canonical reads/retrieval. Existing `purgeExpired` revokes
rows/chunks/attachments and queues deletion; existing `drainStorageDeletions` retries its durable
intents. Pending-upload deletion retains the existing **11-minute** late-PUT safety grace. SDK transport
retry never replaces durable DB job retry, and a 403/timeout is never interpreted as absent. On a HEAD
404 the adapter also confirms the bucket is readable, so a missing/misrouted bucket cannot be reported
as successful physical deletion. No claim/fencing/reconciliation SQL was rewritten.

The existing API same-process best-effort ingest drain also uses the shared ingest batch (default 1);
it is not the durable guarantee and does not replace Worker retention/deletion.

Graceful shutdown still stops/drains the existing poller before DB teardown. Retain the P16 init,
SIGTERM and 300-second grace settings. Configure backlog/failed-job alerts from operations diagnostics;
do not rely only on Docker PID/heartbeat liveness, and never run an extra deletion scheduler in API.

## 5. Availability and operator-visible failures

`GET /v1/platform/storage` is private, no-store and requires the existing **platform OPERATIONS**
permission/session, not a customer/workspace role. It performs only:
- Sanitized configuration diagnostics and maintenance range reporting (no keys, signed URLs or secrets).
- Bounded scoped `ListObjectsV2(Prefix=workspaces/, MaxKeys=1)`, discarding keys/content. Success is
  **READABLE_NOT_WRITE_VERIFIED**, not an encryption/PUT/GET/delete/isolation certification.
- A READ ONLY DB snapshot with five-second per-statement timeout: pending/processing/abandoned/failed
  ingestion counts, expired-awaiting-revocation count, due/pending/failed deletion counts, and at most
  25 latest terminal failures with IDs/attempts/error codes. No content/name/storage-key disclosure.

This endpoint is an operator API, not a new Control UI or public health assertion. No database/S3
request was executed against real services in P18. Existing lease-less PROCESSING rows are flagged as
recovery candidates; the P11 worker, not this report, decides when a legacy claim is reclaimable.
A BLOCKED probe or DB report failure is not an empty healthy queue. Read/list permission is required
by the supplied scoped policy; absence of that permission stays BLOCKED, not a fabricated outage PASS.

Worker `QEYNOX_STORAGE` structured logs expose phase/counts/allowlisted failure and operator-attention
facts, never remote SDK messages, keys or document content. Ingestion/deletion rows retain sanitized
`STORAGE_*` / `S3_*` categories (auth, throttling, timeout, unavailable) for persistent diagnosis.
Terminal FAILED rows remain visible after the sweep that failed them. P18 adds **no automatic reset,
replay, retry-now, force-delete, lease stealing or administrative mutation endpoint**.

Review storage auth/network/KMS/capacity and queue age. Let unexpired active leases drain. Do not mark
jobs DONE/DELETED, zero attempts or drop a tombstone to silence an alert. An ambiguous object write or
failed physical erasure requires a separately authorized, audited recovery procedure after cause and
current ledger/object identity are inspected. No live retry/reset is authorized here.

### Versioned buckets and honest retention

P12 DELETE + HEAD verifies **current-key absence**, not deletion of noncurrent versions. With versioning,
old encrypted versions/delete markers may remain under the existing approved backup/legal-retention
policy. P18 deliberately does not grant version purge, add lifecycle rules or erase retained versions.
P22 must document real versioning/Object Lock/retention behavior and any separately authorized physical
purge process. Do not describe a DELETED job as proof that every backup/version was erased.

## 6. Future cutover, rollback and P22 certification

Before separately authorized rollout, inspect current storage resource/bucket/policies/anonymous access,
network/routers, volume/KMS binding, backups and role env values. Preserve previous immutable images
and matching configuration. Compare API/Worker credentials/region/bucket and Web relay origin/secret.
Never apply this manifest as a new storage stack. Policy enforcement can invalidate old non-SSE PUT
grants: quiesce uploads and allow the existing grant/grace window before a separately approved cutover.
No maintenance/deploy/policy operation was performed in P18.

P22 must use an isolated approved bucket/database to certify real conditional encrypted PUT, signature
headers/region/path, browser Atlas export/renew/download, pending-upload complete/ingest/retrieval,
expired/revoked/cross-workspace tickets, missing keys vs denied/missing bucket, stalled-body deadlines,
SDK/durable retries, crash/lease recovery, retention, deletion verification, version semantics and
operator authorization/redaction. Also prove actual private routing/anonymous denial and retained data/
KMS readability. No fixture, successful compilation or read-only list probe can replace those checks.

Rollback requires explicit authorization and a coordinated compatible API/Worker/Web release. Preserve
private routing, encryption and data. Never make the bucket public or disable SSE to revive an old
signed link. Keep writers closed if old code cannot honor the new signed-header/policy contract; use
a reviewed compatible forward fix. No rollback, credential rotation, migration or deployment here.
