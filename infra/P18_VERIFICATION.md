# P18 — document storage integration verification (2026-11-22)

Branch `arena/4c907d04-qeynox`, starting HEAD and fetched `origin/main` both
`bb07e3794ab0cb57a11db896aecdfd2f8dbd60c5`. `AGENTS.md` read before implementation.

**Verdict: operational source/configuration changes implemented; compilation passes. Actual S3,
queue/recovery, policy and browser-flow certification is deferred to P22. No live operations.**

## Implemented

1. **Consistent private configuration:** a shared loader/factory now supplies API vault, API
   result/Atlas exports and Worker. Explicit endpoint/region/bucket/scoped credentials; no implicit
   public endpoint or ambient AWS credential chain. Role templates and release checks agree on bounds.
   Actual live role env equivalence remains an operator/P22 check, not a claim from shared source.
2. **Upload/download signing:** preserve path-style SigV4; signed upload includes AES256 and conditional
   create-only If-None-Match. Explicit checksum policy avoids an unspecified-body checksum in the upload
   contract. Read grants HEAD-check existence/size before issuing links; missing/oversized objects fail
   before a known-bad URL is returned. No historical object/row/key/encryption data was changed.
3. **Browser routing:** existing authenticated Web relay forwards the supported signed PUT headers,
   keeps Host/path/query intact, bounds ticket lifetime by underlying signature expiry, rechecks lifetime
   before storage dispatch and maps safe errors/statuses without exposing S3 XML/signed URLs.
4. **Private policies/tenant keys:** offline-only policy renderer supplies prefix-scoped IAM, no public
   Allow, SSE/public-ACL guards and provider-specific public-access/anonymous-access desired settings.
   Adapter rejects unsafe/off-namespace keys; new dot-only name slugs are safe. No policy was applied.
5. **Availability:** read-only `GET /v1/platform/storage` requires existing platform OPERATIONS access,
   reports sanitized configuration, bounded ListBucket-prefix probe and read-only queue/retention facts.
   Probe success says READABLE_NOT_WRITE_VERIFIED. HEAD 404 is cross-checked against bucket readability
   rather than allowing a missing bucket to look like successful deletion.
6. **Lease recovery configuration:** bounded polling/lease/batch settings, default ingest/deletion batch
   1, deletion transport budget below the unchanged P12 lease, production refuses a disabled maintenance
   loop. API opportunistic ingestion also uses the shared ingest batch; Worker remains durable owner.
7. **Durable deletion:** existing P12 drain, tombstones, lease fencing, retries and verified-current-key
   absence retained. SDK deadlines/retries now bounded; storage client closes after worker drains.
8. **Retention/operator failures:** existing purge/read exclusion retained. Relay reauthorizes canonical
   document/artifact access on every request, including expiry/revocation after minting. Terminal queue
   failures remain visible through protected diagnostics; logs/job codes use sanitized storage categories.
9. **Atlas flow:** existing document/mission/result-share grant consumers still use the one private relay.
   No public bucket URL fallback; fresh/renewed tickets required. Real signing/browser behavior unproven.
10. **Bounds/retries:** S3 whole-operation deadline 1..20 seconds, max attempts 1..3 within it; read/write
    size <=10 MiB. Relay deadline 30 seconds including body reads, bounded buffering and no automatic PUT
    replay. Existing durable job retry/backoff semantics not replaced with a second scheduler.

P10–P12 core claim/publication/fencing/retrieval/revocation/retention/deletion SQL is unchanged.
`documents.ts` changes are limited to safe new slugs and storage error classification, not a feature
rewrite. Existing SQL files, persistent volume/image/KMS identity and financial history are preserved.
Versioned-bucket deletion remains current-key absence, **not** proof that historical versions/backups
were erased; no version purge or lifecycle expiration permission/automation was added.

## Executed local checks — minimal compilation only

| Check | Result / boundary |
| --- | --- |
| `pnpm install --frozen-lockfile` (9.15.9) | PASS; dependency versions/lockfile unchanged |
| `pnpm typecheck` | PASS, **6 tasks** plus dedicated release-tool TypeScript check; includes updated relay fixture source/policy script parsing |
| `pnpm --filter @qeynox/api --filter @qeynox/worker --filter @qeynox/web build` | PASS, **3 scoped builds** (API/Worker TypeScript + Web Next production compilation) |
| `git diff --check` | PASS |
| Migration/lockfile diff | Unchanged |

**No QA/test suites were executed**, as requested. The P16 relay fixture's URL now includes the required
SigV4 algorithm/date/expiry/signed-header fields; all existing assertions remain. It was compiled, not
run or certified. No disabled test, removed assertion, `any` escape or suppression was used to force
compilation. No full backend/provider campaign, Docker image build, app server or browser smoke run.

## Not performed / P22 gates

- No live inventory, S3 list/head/get/put/delete/signature validation, policy/IAM/ACL change, bucket/volume
  creation/recreation, object mutation, encryption/key rotation, deployment, restart or rollback.
- No live DB connection, lease/job reset, retention purge, ingestion/deletion drain, migration or
  customer/financial data action. No Stripe activation, `iasser` operation or merge.
- Signing header support, conditional PUT/encryption, actual MinIO policy support, region/clock behavior,
  scoped credentials and read/list/GET/HEAD/DELETE permissions need real isolated P22 verification.
- Atlas/document browser uploads/downloads/renewal, replay/tamper/revoked/expired/cross-workspace grants,
  missing vs denied objects/buckets, body stalls, size limits and retry outcomes are **not proven by
  compilation**. A resource may still change after a point-in-time grant check.
- Recovery under crashes/lease expiry, extraction/embedding latency, backlog/terminal alerts, safe
  shutdown and versioned/Object Lock/legal retention behavior need P22 evidence. No physical historical
  erasure claim; no unsafe terminal-job reset or version/lifecycle purge tool introduced.
- Current private routing/anonymous denial, retained object/KMS readability, backups and existing
  legacy storage-image security remain independent deployment certification gates.

Operator contract and careful rollout/rollback boundaries: [STORAGE_RELEASE.md](STORAGE_RELEASE.md).
