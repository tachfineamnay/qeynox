# Runbook — Hermes → Vertex AI / Gemini

**P17 implements source/deployment contracts only. Actual Vertex authentication, model access,
inference, token fidelity and runtime isolation certification are deferred to P22.** Nothing in this
runbook authorizes a live credential change, deployment, restart or inference call. All operational
steps below are for a separately authorized operator session.

Hermes remains the agent runtime; Hatchet remains the single durable workflow orchestrator. No
Google SDK, service-account JSON or OAuth token belongs in QeyNox API/Worker/Web/Control. Those apps
use only the **Hermes bearer key**, private endpoint and exact model route. Never expose Hermes API
or dashboard publicly. `BETA_FREE` / `INVITE_ONLY` and the existing runtime readiness gates remain.

## 0. Configuration is not certification

States remain `BLOCKED` · `UNVERIFIED` · `CONFIGURED` · `OPERATIONAL`. Runtime probe `VERIFIED`
means fresh prerequisite evidence for that component, **not** proof of Vertex inference or IAM.
`GET /v1/models` advertises Hermes configuration; it does not query Google's authorized model catalog.
The only inference PASS is a separately authorized P22 `qa:hermes-live` actual model answer with
reviewed evidence. Deterministic fixtures never provide that evidence.

Prerequisites supplied by the operator, never committed:
- GCP project with billing and Vertex API enabled, approved model/region/data-residency policy.
- Dedicated service-account JSON with least-privilege Vertex access (typically
  `roles/aiplatform.user` on the target project; do not grant owner/editor as a shortcut).
- Existing private Hermes resource/home volume, verified image, host file paths and runtime UID/GID.
- Hermes bearer key, private network routing and independent egress/native-tool confinement evidence.

## 1. Desired deployment contract (not applied by P17)

`infra/services/hermes.yml` retains the existing image/service/network alias/home volume, with no
Traefik router and no host port publishing. Reconcile the existing resource **in place** after current
inventory and separate authorization; do not create a second service or replace its volume.

Two mandatory regular-file bind mounts, read-only, `create_host_path:false`:

| Host operator variable | Container target | Content / ownership |
| --- | --- | --- |
| `QEYNOX_HERMES_CONFIG_FILE` | `/opt/data/config.yaml` | reviewed generated JSON (valid YAML), readable by Hermes, no secrets |
| `QEYNOX_VERTEX_CREDENTIAL_FILE` | `/run/secrets/qeynox-vertex-service-account.json` | existing SA JSON, mode 0400, readable by the actual Hermes UID/GID |

The credential is **outside the home volume**, repository and image layers. Missing bind sources
must fail rather than becoming empty directories. Verify the deployment engine supports the long
bind syntax and does not silently drop `read_only` or `create_host_path`. Rootless/user-remapped
hosts must map ownership correctly; never make the credential world-readable to pass health.

The config bind masks the old file without editing/deleting the underlying volume. Snapshot the old
config and volume binding securely first; never reset the volume or overwrite profiles to apply P17.
Both Hermes' agent loader and its gateway loader must read the same `/opt/data/config.yaml`:
**`HERMES_CONFIG` alone is insufficient**, because this image's gateway loader reads
`HERMES_HOME/config.yaml` directly.

Use the service-only example `infra/services/hermes-vertex.env.example`. Required non-secret routing:
`QEYNOX_HERMES_VERTEX_PROJECT`, `QEYNOX_HERMES_VERTEX_REGION`, `QEYNOX_HERMES_VERTEX_MODEL`.
The model must be an approved **`google/gemini-*`** ID, never a guessed default or `hermes-agent` alias.
Gemini 3 routes require `global`; all models/regions still need actual access validation in P22.

Render offline from those supplied values (no credential file is read, no network call):

```sh
# Operator environment contains only the three reviewed non-secret routing values for rendering.
# Use a NEW protected output path, review before any separately authorized application of settings.
node infra/services/render-hermes-vertex.mjs > "$REVIEWED_NEW_CONFIG_FILE"
```

The renderer reuses `infra/services/hermes-config.yaml` and produces:
- `model.provider: vertex`, exact `model.default`, explicit `vertex.project_id` and `vertex.region`.
- `platforms.api_server.extra.model_routes[<exact model>] = {provider: vertex, model: <exact model>}`.
  This is necessary: `/v1/models` lists primary/route aliases, not necessarily `model.default`.
- `platform_toolsets.api_server: []`, no MCP servers, empty fallback-provider chain, no direct arbitrary
  model passthrough, and multiplex profiles disabled. This is a **desired configuration**, not isolation
  evidence. Do not enable native web/browser/terminal/filesystem/code/skills/delegation tools.

Hermes-only env from the service manifest:

```text
HERMES_HOME=/opt/data
HERMES_CONFIG=/opt/data/config.yaml
VERTEX_CREDENTIALS_PATH=/run/secrets/qeynox-vertex-service-account.json
VERTEX_PROJECT_ID=<reviewed project>
VERTEX_REGION=<reviewed region>
API_SERVER_MODEL_NAME=<exact approved google/gemini model>
API_SERVER_KEY=<secret Hermes bearer key, not a Google credential>
```

Inspect existing home `.env`, `gateway.json`, profile/managed overlays, platform credentials, plugins
and routing overrides before rollout. They must not re-enable native tools, alternate providers,
MCP, multiplexing or public listeners. The mounted config must agree with service routing env. Do not
bulk-copy secrets into a generated config, app env or PR. Never remove an existing secret as a shortcut.

### Provider dependency and local health

Hermes owns `google-auth`, service-account parsing, OAuth `cloud-platform` token mint/refresh and
provider retry-on-expired-token behavior. QeyNox does not mint, persist or forward Google tokens.
The desired Docker healthcheck verifies, **inside Hermes only**:
- `google.auth.transport.requests` imports without lazy installation;
- the mounted credential is a private regular file and parses as a service account (no OAuth call);
- generated config matches env/model route and disables API native tools/MCP/fallbacks;
- private local `/health` reports Hermes liveness.

This is not Vertex authentication. A missing dependency or unreadable key stays unhealthy with a
static diagnostic; do not permit runtime package installation or broaden credential file permissions
to manufacture success. If the existing image lacks `google-auth`/transport dependencies, build and
review a pinned dependency-complete image separately before P22. Image build/s6/file-mount behavior
is not certified by P17. Credential rotation may require an explicitly authorized runtime recycle
because Hermes caches credential/token objects; do not assume replacing a file hot-reloads the key.

## 2. QeyNox-side private endpoint and settings

API and Worker share `hermesSettingsFromEnv`:

```text
HERMES_API_BASE_URL=http://qeynox-hermes:8642/v1/
HERMES_PRIVATE_ORIGIN=http://qeynox-hermes:8642
HERMES_PROVIDER=vertex
HERMES_MODEL=<same exact model route as generated Hermes config>
HERMES_REQUEST_TIMEOUT_MS=60000
HERMES_NATIVE_TOOLS_ISOLATED=false
QEYNOX_NETWORK_POLICY_ATTESTED=false
```

Attestations stay **false** until independent actual isolation/egress evidence exists. Never set them
true just to clear a blocker. They are required preconditions and cannot replace live probe evidence.
Do not set `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEX_*`, Google/Gemini provider API keys, or service-
account JSON/private keys in any app environment. P16 release checks now reject these leaks for all
four apps. Web/Control do not need the Hermes bearer key either. Common credential filenames are
excluded from Git/Docker contexts; arbitrary filenames still require operator review outside Git.

No public URL is required. A future operator may use an SSH tunnel for diagnosis (`localhost` is
supported by `hermesEndpoint`), but must not add a public ingress rule. `/admin` is unrelated to
Hermes; do not route Hermes through Control or Web.

## 3. Model discovery, auth and independent readiness

After separately authorized deployment/configuration, `pnpm hermes:diagnose` uses private read-only
GETs; it does not infer or change config. It exits BLOCKED if the exact model, authenticated inventory,
valid identity, native-tool inventory or required attestations are missing.

`probeHermes` now:
1. Reads `/health` identity/version/status.
2. Reads authenticated `/v1/models` and requires the configured exact model.
3. Sends a random **wrong** bearer key to `/v1/models` and requires 401/403. A server accepting every
   key is not authenticated merely because the correct key also returned 200.
4. Reads `/v1/toolsets`, requiring nonempty documented inventory with explicit boolean `enabled` /
   `configured` and string tool names. Every toolset must report `enabled:false`. Missing/empty/
   malformed inventory is **UNKNOWN**, not proof of isolation.

The entire probe shares one deadline (maximum 15 seconds; production monitor policy remains clamped).
No probe sends a completion or Google API request. It cannot prove Vertex IAM/model access or egress.
API and Worker retain their **own** in-memory Hermes and Hatchet evidence. Probe failures do not
verify/invalidate the other component. Endpoint/key/model/**provider**/request-timeout changes invalidate
Hermes evidence; restart, expiry, auth rejection or missing discovery evidence remains non-executable.
Both components must satisfy unchanged readiness/attestation rules before mission execution.

Control's existing runtime view exposes component status, failure code, evidence reference, observed
identity, probe time and expiry. No operator environment boolean marks a component verified.

## 4. P22 only — real inference certification

**Not executed for P17.** In the authorized private-network environment, with a dependency-complete
image, reviewed model route, valid credential and actual isolation evidence:

```sh
QEYNOX_QA_HERMES_URL=http://qeynox-hermes:8642/v1/ \
QEYNOX_QA_HERMES_KEY="$HERMES_API_KEY" \
QEYNOX_QA_HERMES_MODEL="$APPROVED_VERTEX_MODEL" \
QEYNOX_QA_HERMES_TIMEOUT_MS=90000 \
pnpm qa:hermes-live
```

The existing runner creates no mission/DB row and sets no attestation. It reports engine run ID,
finish reason, latency, observed usage (unknown is not zero), redacted answer excerpt and wrong-key
rejection. Only a genuine model answer can print `PASS: real inference verified`.

| Exit | Meaning |
| --- | --- |
| 0 + real inference PASS | actual model answered; other certification gates still apply |
| 3 / BLOCKED | endpoint/key/provider/isolation/config gap; not success |
| 1 / FAILED | contract/safety defect or provider failure disguised as answer |

Do not use the runner's optional unattested diagnostic override as P22 release evidence. Even if an
operator separately permits such a diagnostic call, isolation remains UNPROVEN and runtime readiness
must not be weakened. Record restricted operator evidence with timestamp/run/model/image/config
identity; never record service-account JSON, OAuth tokens, bearer keys or customer prompts in Git.

## 5. ToolBroker, accounting, failure and recovery semantics

The adapter sends bounded non-streaming text requests, with no OpenAI `tools`/`tool_choice` payload.
Hermes may propose JSON tool actions only. Actual external execution stays in existing ToolBroker:
workspace/operation scope, active profile/capability, fresh consent, approvals, budget, egress policy,
authorization and idempotency are enforced there. Any native `tool_calls`/`function_call` response is
refused; a prompt alone cannot prevent server-side native tools, hence the independent isolation gate.

- Inference timeout is an integer **250..120000 ms**. Response body is limited to **2 MiB**. Caller
  cancellation and timer expiry are distinct; server-side cancellation is **unconfirmed**. No adapter
  auto-retry, model fallback or second workflow scheduler is added.
- Hermes gateway auth failures differ from provider IAM/credential, quota/rate-limit, model/region,
  configuration, transport and malformed/native-tool failures. Classification is allowlisted and
  heuristic where Hermes collapses provider errors; generic failure remains generic, never an answer.
- API/Worker structured logs omit prompts, answers, remote error bodies and credentials. Worker failure
  events retain the original domain `errorCode` plus allowlisted `hermesFailure`, `recoveryState` and
  cancellation uncertainty. Recovery recommendations are not automatic retry authorization.
- Failed/timed-out calls settle cost **UNKNOWN** under existing rules and retain uncertain reservations;
  a provider might still have executed/billed a timed-out call. Never report zero cost or blind-replay it.
- Successful calls keep the configured per-call budget ceiling as a **conservative ESTIMATED cost**,
  not an invented price or provider invoice. Real observed token counters can accompany that estimate;
  all-zero/missing/invalid counters are withheld. Negative/fractional/unsafe/out-of-storage-range counts
  and inconsistent totals cannot become metered evidence. There is no static Gemini pricing table.
- No currency, beta spend ceiling, financial record, reservation policy, SQL schema or payment behavior
  is changed. Reserve fails closed when the reviewed `hermes` cost ceiling is absent.

Recovery states name concrete operator actions (fix Hermes auth; fix Vertex IAM/credential; review
model/region; quota backoff; reconcile unconfirmed run; restore isolation and reprobe). Successful fresh
prerequisite probes may recover readiness independently, but still do not retroactively certify a
failed inference or prove Google access. Hatchet remains responsible for durable execution.

## 6. Rollback and remaining gates

Use the coordinated immutable-release procedure in `infra/COOLIFY_RELEASE.md`. Retain old image/config
identities and the underlying home volume. Any rollback needs separate authorization and must preserve
private routing, no-native-tools posture and beta modes. Do not simply unset model/provider and silently
fall back to another provider; that could change data residency and invalidate evidence. Config changes
must be explicitly reviewed and reprobed. Never expose Hermes to make a rollback or diagnosis easier.

P22 must still prove actual IAM/token mint/refresh, exact served model, positive inference, rejected-key
handling on the real image, private routing/no stale public router, actual tool confinement/egress,
usage fidelity, isolation under adversarial prompts, timeout/recovery behavior and credential/mount
permissions across the real s6/runtime UID. P17 performed none of those live actions.
