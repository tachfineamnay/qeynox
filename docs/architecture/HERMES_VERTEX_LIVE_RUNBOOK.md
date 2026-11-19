# Runbook — Hermes → Vertex AI / Gemini real-inference validation

Purpose: take a deployment from "configuration is present" to **real inference proven**, without
fabricating access, without setting a security attestation without proof, and without exposing the
Hermes API server publicly.

Result states (A01 vocabulary, unchanged): `BLOCKED` · `UNVERIFIED` · `CONFIGURED` · `OPERATIONAL`.

> A contract-only run is never evidence of inference. `pnpm qa:hermes-contract` passing means the
> wire is understood, not that a model answered. The only PASS for inference is
> `pnpm qa:hermes-live` printing `PASS: real inference verified`.

---

## 0. Prerequisites (operator-supplied, never committed)

| Item | Where it lives | Notes |
| --- | --- | --- |
| Vertex AI enabled on a GCP project | GCP console | billing + Vertex API enabled |
| Service-account JSON with `roles/aiplatform.user` | host path, mounted read-only into Hermes | **never** in the QeyNox repo or app env |
| Hermes `API_SERVER_KEY` | deployment secret (`HERMES_API_KEY`) | shared by API/worker, not a Google credential |
| Private route to Hermes | `http://qeynox-hermes:8642/v1/` on the Coolify network, or an SSH tunnel | the API server is never routed publicly |

Do **not** put `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEX_CREDENTIALS_PATH` or the service-account
JSON into the QeyNox API/worker environment. QeyNox does not use them; Hermes does.

---

## 1. Grant Hermes a Vertex credential

On the Hermes host (inside the container's volume, `/opt/data`), place the key file read-only:

```
/opt/data/gcp/vertex-sa.json      # chmod 0400, owner hermes
```

`config.yaml` (`/opt/data/config.yaml`, Hermes re-reads by mtime — no restart needed for config,
but a credential **file** is read on use):

```yaml
model:
  provider: vertex
  default: google/gemini-3-pro-preview   # or any model your project can serve

vertex:
  project_id: your-gcp-project-id
  region: global                          # Gemini 3.x preview needs "global"

platform_toolsets:
  api_server: []                          # native-tool confinement (must stay empty)
```

Environment for the Hermes container (if you prefer env over `config.yaml`; env wins):

```
VERTEX_CREDENTIALS_PATH=/opt/data/gcp/vertex-sa.json   # wins over GOOGLE_APPLICATION_CREDENTIALS
VERTEX_PROJECT_ID=your-gcp-project-id
VERTEX_REGION=global
```

Hermes needs `google-auth` (its `[vertex]` extra). If the image was built without it, Hermes
lazy-installs it on first use; a missing package surfaces as a provider failure, never as an answer.

---

## 2. Reach Hermes privately

The API server listens on `8642` inside the Docker network and is **not** routed by Traefik (only
the dashboard on `9119` is). Two supported ways to test:

**A. From another container on the same network (API or worker):**

```
HERMES_API_BASE_URL=http://qeynox-hermes:8642/v1/
HERMES_PRIVATE_ORIGIN=http://qeynox-hermes:8642
```

**B. From an operator workstation, through an SSH tunnel (never a public port):**

```
ssh -N -L 8642:qeynox-hermes:8642 operator@<host>
# then locally: QEYNOX_QA_HERMES_URL=http://127.0.0.1:8642/v1/
```

`http://127.0.0.1` and `http://localhost` are already authorized by `hermesEndpoint()`; any other
plain-HTTP origin must be listed in `HERMES_PRIVATE_ORIGIN` and match exactly (scheme + host + port).

---

## 3. Diagnose before asserting anything

```
HERMES_API_BASE_URL=http://qeynox-hermes:8642/v1/ \
HERMES_API_KEY=$HERMES_API_KEY \
HERMES_MODEL=google/gemini-3-pro-preview \
pnpm hermes:diagnose
```

Expected healthy output (exit 0):

```
  reachable          : true
  platform / version : hermes-agent / <version>
  authenticated      : true
  advertised models  : google/gemini-3-pro-preview
  native tools       : no toolset enabled (isolation evidenced by /v1/toolsets)
```

Exit **3 (BLOCKED)** means one of: endpoint unreachable, key rejected, no model advertised, or an
enabled toolset still present. Each is named in the output. Fix it there — do not set an
attestation to get past it.

If the toolset line reads `ENABLED TOOLSETS PRESENT`, Hermes can still execute its own tools.
Apply `platform_toolsets.api_server: []` and re-check. Isolation is *evidenced* only when the
inventory is readable and shows no enabled toolset.

---

## 4. Prove inference (the mandatory positive test)

```
cd apps/worker    # or anywhere with the workspace installed

QEYNOX_QA_HERMES_URL=http://qeynox-hermes:8642/v1/ \
QEYNOX_QA_HERMES_KEY=$HERMES_API_KEY \
QEYNOX_QA_HERMES_MODEL=google/gemini-3-pro-preview \
QEYNOX_QA_HERMES_TIMEOUT_MS=90000 \
pnpm qa:hermes-live; echo "exit=$?"
```

Optional inputs:

- `QEYNOX_QA_HERMES_PROMPT` — a real prompt instead of the default one-sentence check.
- `QEYNOX_QA_ALLOW_UNATTESTED=true` — run the probe when the toolset inventory is unreadable or
  still shows enabled toolsets. The inference proof stands; **isolation is then reported UNPROVEN**
  and must not be recorded as attested.

### Reading the result

| Exit | Meaning | What to do |
| --- | --- | --- |
| `0` + `PASS: real inference verified` | the model answered | record the run id as evidence (step 5) |
| `3` + `BLOCKED: ...` | deployment gap: no endpoint/key, key rejected, no provider, isolation unproven | fix the named item; **never** record this as a pass |
| `1` + `FAILED: ...` | contract violation: provider error disguised as success, native tool call, wrong key accepted, malformed body | treat as a defect and investigate |

A successful run prints: model, engine run id, `finish_reason`, latency, usage (or
`not observed … never as zero`), and a 200-character redacted excerpt of the answer.

What the run does **not** do: it creates no mission, touches no database, sets no attestation, and
does not write `QEYNOX_RUNTIME_VERIFIED_LIVE`.

---

## 5. Record the evidence (A01 gate)

Only after step 4 returns PASS may the deployment claim a verified live runtime:

```
QEYNOX_RUNTIME_VERIFIED_LIVE=true
QEYNOX_RUNTIME_VERIFICATION_EVIDENCE="hermes-vertex <date> run=<engine run id> model=<model> latency=<ms>"
```

Until then the API reports the engine as `UNVERIFIED` and capabilities stay non-executable — which
is the correct, fail-closed state.

---

## 6. What remains unproven after a PASS

- **Network egress containment.** `QEYNOX_NETWORK_POLICY_ATTESTED=true` is an operator claim. A
  successful inference says nothing about whether Hermes could reach other hosts.
- **Server-side cancellation.** Not exposed for non-streaming chat completions; QeyNox cancels the
  client request and reports the outcome as unconfirmed.
- **Token accounting fidelity.** Hermes reports zeros when its runtime observes nothing; QeyNox
  then records `ESTIMATED`, never provider-metered tokens.
- **Provider licensing / data-residency review** for the chosen Gemini model and region.

---

## 7. Rollback

Unset `HERMES_MODEL` / `model.provider` to return Hermes to its previous provider, and unset
`QEYNOX_RUNTIME_VERIFIED_LIVE` so the platform falls back to `UNVERIFIED`. No QeyNox migration,
schema change or credential is involved in this feature.
