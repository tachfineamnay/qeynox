# P19 — business-provider runtime integration

**Source/configuration integration, not live-provider certification.** No activation, credential access,
provider call, licence acceptance, database/configuration mutation, deployment or restart is authorized
by this document. Keep commerce BETA_FREE / INVITE_ONLY. No new provider, write adapter, migration or
scheduler is introduced. The existing ToolBroker, canonical DB, budget and consent boundaries remain.

## Inspected eight A16 packs: actual external-data requirements

Source: `infra/operator/a16-business-packs.json`, all eight `infra/operator/packs/*.json`, typed pack
contracts/planners/deliverables and the P09 Worker execution path. The default requirements are:

| Pack / slot | Reviewed runtime tool | Actual data / boundary |
| --- | --- | --- |
| research / 1 | `world-bank:indicator@1` | Official country/indicator observations, null gaps and macro publication limitations; not arbitrary company/market intelligence |
| strategy / 2 | `brave-search:web@1` | Public market structure, positioning and competitor discovery; no private revenue/churn or automatic Drive/Slides publishing |
| marketing / 3 | `brave-search:web@1` | Public category messaging/buyer research plus caller hypotheses; no ad-account telemetry, campaign launch or real spend booking |
| seo / 4 | `brave-search:web@1` | Search-discovered URLs/intents and caller-reported URL issues; not fetched HTML, technical crawl, Search Console/GA4 or Core Web Vitals field telemetry |
| sales / 5 | `brave-search:web@1` | Public company/product/announcement signals and caller deal inputs; no invented contacts, LinkedIn scraping, mailbox sending, calendar/CRM actions |
| operations / 6 | `brave-search:web@1` | Caller stage/SLA/cycle-time metrics and public process references; deterministic diagnostics are caller-input calculations, not imported ERP/process telemetry |
| financial-analysis / 7 | `world-bank:indicator@1` | Caller baseline/scenarios and official macro benchmarks; computed sensitivity is not measured future performance or Stripe/ledger ingestion |
| content / 8 | `brave-search:web@1` | Public source discovery and caller editorial requirements; drafts/citation ledger only, no CMS/social publishing or independent verification of page content |

The pack/provider mapping is fixed by the reviewed pack contract. P19 rejects substituting a different
or broader capability tool list for a pack, both during planning and Worker execution. Profile tools
cannot exceed the pack capability contract. Generic missions retain configurable reviewed tool
allowlists. Operations' numerical diagnostic phase does not itself call search, but the existing A16
pack's configured external reference capability still requires Brave; P19 does not silently downgrade
that contract or pretend a missing configured connector is optional.

Unimplemented business connectors remain explicitly BLOCKED in the existing per-pack declarations:
Google Workspace business data/writes, LinkedIn, Meta, GA4, Search Console, WordPress/WooCommerce,
GitHub business actions and Stripe. The existing Google Workspace hub profile requests **identity
only** (`openid email profile`). A CONNECTED identity account is not permission, provisioning or an
adapter for Drive, Gmail, Calendar, analytics or publication. No OAuth scope expansion or speculative
connector is added. Ordinary Git access is not a business GitHub connector either.

## One registration/resolution path

`packages/tools/src/providers/configured.ts` now supplies a shared configuration-only resolver:

- ACTIVE `tool_configurations` plus ACTIVE capabilities, exact reviewed adapter/tool version/mode,
  explicit deployment switches, credential presence where required, attested exact-host egress and
  production shared-quota configuration. No row/default switch registers a provider on its own.
- Known reviewed adapters are **only World Bank v1 and Brave Search v1**. Unknown/malformed/disabled/
  unprovisioned adapters expose no callable tools. A bad provider no longer crashes startup or hides
  an unrelated healthy configured provider: runtime resolution is partial and fail-closed per provider.
- The existing exported `createConfiguredToolRegistry` remains strict: an invalid explicitly ACTIVE
  provider still throws. API readiness and Worker execution share the underlying resolver rather than
  treating database manifest names as executable code. Worker reloads per attempt; the final broker
  authorization reloads provider/capability/profile after quota/ledger waits.
- A16 shipped the exact operation aliases `indicator.read` and `web.search`, while reviewed adapters
  declare `INDICATOR_RESEARCH` / `WEB_RESEARCH`. Only those two known per-provider aliases are normalized
  in memory. No immutable configuration row/version is rewritten. Other unknown operations are rejected;
  accepted region/operation/rate limits cannot widen reviewed declarations.
- Brave credential reference, if present, must be `env:QEYNOX_BRAVE_SEARCH_API_KEY`. World Bank has no
  credential. A row cannot select arbitrary env names, files, vault paths or OAuth account tokens.
- The agent gets actual reviewed input JSON schemas (`io: input`) for the intersection of capability
  and profile tools, as proposal guidance only. Inputs are strict: wrong `search_lang` keys cannot be
  silently stripped into an unintended default search. SEO instructions now pass `searchLang` as the
  two-letter language, country separately for geography, preserving the requested locale in the
  recorded request. Provider locale support still needs P22 validation; no regional precision promise.

A failed configuration assessment does not make a network request. Configuration read failures surface
as unavailable requests rather than a fabricated empty/healthy snapshot. Production requires the
existing shared Redis provider limiter; local in-process quota is not a production fallback.

## Operator-managed configuration and credentials

Use the existing audited ConfigurationService/platform configuration workflow to review/dry-run/apply
an A16 suite or one pack; **do not apply anything as part of P19**. Maintain its operator allowlist,
workspace authorization, explicit reason and immutable version/idempotency rules. Provider TOOL and
capability/profile configuration are deployment-global in the existing schema; budget policies,
consents, operations and captured data remain workspace-scoped. Do not imply a customer can install a
global connector or view another tenant's credentials by opening the hub.

API and Worker must receive identical reviewed provider switches, secret revision and egress policy:

| Variable / config | Contract |
| --- | --- |
| `QEYNOX_WORLD_BANK_ENABLED` | opt-in `true`, default false; no API key required |
| `QEYNOX_BRAVE_SEARCH_ENABLED` | opt-in `true`, default false |
| `QEYNOX_BRAVE_SEARCH_API_KEY` | operator-held subscription token from backend secret store, header only |
| `QEYNOX_NETWORK_POLICY_ATTESTED` | true only after actual deployment network/isolation review |
| `QEYNOX_EGRESS_ALLOWED_HOSTS` | explicit authorized hosts `api.worldbank.org`, `api.search.brave.com`; no wildcard/URL/redirect permission |
| `QEYNOX_REDIS_URL` | existing private shared provider quota service; required in production |
| ACTIVE TOOL config | reviewed version/mode/tools/operations and rate <= reviewed ceiling (30/min each; A16 examples tighten to 15/min) |
| ACTIVE business capability/profile | correct pack tool and profile allowlist; profile role/version checked at point of use |
| ACTIVE verification policy | effective validFrom and approved provider matching the capability's tools |
| workspace consent | Brave query text leaves the deployment: active `web:search` consent re-read for each call; World Bank has no private-data scope |
| operation budget | explicit finite integer minor-unit ceilings for `hermes` and every required tool; Brave ceiling must be **positive**, WB may be explicitly zero |

Do not put provider secrets into configuration JSON, prompts, public env, Web/Control or Hermes. No new
secret-update API is introduced: use deployment secret management and a separately approved rollout.
The app cannot prove API/Worker env consistency or credential validity from presence booleans; compare
the actual restricted deployment inventory before activation. No live inventory was performed here.

Activation requires operator review of current provider terms, subscription entitlement, attribution,
retention/reuse restrictions and query-data exposure. Existing reviewed manifests supply terms links
and licence/freshness limitations; configured prose cannot override them. Historical example prices
or the A16 `unitMaxMinor` numbers are **not current provider tariffs** and are not proof of an adequate
ceiling. Select approved ceilings in the operation budget's currency; never invent conversions or
provider-reported costs. SDK/provider presence does not authorize collection or republishing.

Release validation now rejects enabled backend providers without attested egress and the exact
required host. Default examples remain disabled/unattested; no production gate is enabled by P19.
Real network egress must enforce isolation beyond the application's attestation flag.

## Readiness and status surfaces

- `GET /v1/platform/providers`: existing platform OPERATIONS guard **and** permission check; private,
  no-store configuration diagnostics, reviewed licence/freshness, resolved quota limit and pack matrix.
- `GET /v1/connections/business-providers`: authenticated workspace hub's separate business-provider
  view, same configuration-only facts. Existing OAuth connection endpoints retain their contracts.
  No account material, tokens, credential references/values, document content or tenant ledger exposed.
- Capability catalogue, service capability views, mission PlanRead/Pilot readiness now resolve actual
  adapters instead of trusting an ACTIVE manifest. Missing switch/key/host/adapter/version/shared-quota
  config yields BLOCKED and allowlisted reason codes. Profile/policy compatibility is also checked.
- Pilot sees the same readiness in its prompt and returned capability notes (and cache fingerprint),
  not just a list of ACTIVE names. Existing deterministic fallback remains labelled as such and does
  not invent provider observations. No customer visual redesign or additional model call is added.
- Provider `providerReady` means **configuration resolvable**, qualified by the explicit additive
  `providerStatus=CONFIGURED_NOT_LIVE_VERIFIED`; it is not credential validity/live-health evidence.
  `BLOCKED` means no provider execution authority. `NOT_REQUIRED` covers tool-less capabilities.
  The legacy overall capability OPERATIONAL calculation still uses its separately verified engine/
  orchestrator runtime plus compatible configuration; it must not be read as P22 provider certification.
  No flag, list view or successful compilation promotes a provider to LIVE_VERIFIED.

Preparation/preview can still be requestable while execution prerequisites are BLOCKED, as before;
requestable does not mean launchable. Launch refuses unresolved required tools or absent/invalid cost
ceilings before admission/outbox creation. The existing operation budget materialization may persist on
a later refused launch; no beta admission/spend is consumed by this new provider preflight. Mission
readiness checks the actual operation policy (or workspace policy before materialization) for all plan
provider ceilings. Execution retains locked operation/beta reservations and conservative ESTIMATED /
UNKNOWN settlement. Broker refuses a zero remaining paid-search ceiling even on a direct invocation.

## Reliable provenance, not fabricated evidence

ToolBroker preserves the existing request and normalized validated response digests. Reviewed adapters
add a separate SHA-256 `rawResponseDigest` over returned UTF-8 provider JSON text; this is not a hash of
compressed wire bytes. Ledger completion now retains full safe provenance: request/response digests,
raw-text digest, retrieval timestamp, freshness TTL, citation request URI and explicit notes. Publication
time is UNKNOWN unless actually supplied; Brave relative `age` text is not invented as a publication
instant. A TTL is an evidence freshness limit, not a new cache or claim that source data is current.

Brave's returned page URLs/titles become bounded, per-invocation deduplicated citation sources. This
fixes pack citation validation previously having only the search API query URL available. Each source
is bound to the **same captured search-response digest**, not an independently fetched page. Source
snapshots are metadata/digests, not archived provider bodies. Evidence explicitly says search discovery
snippet / page not fetched, remains UNVERIFIED, and pack prompts disclose that limitation. No generic
browser/crawler/full-page fetch is added; callers may not claim technical page inspection or independently
verified facts from those snippets. Existing claim assessment and human-review policy remain canonical.

World Bank verifies returned country/indicator scope and requires a non-null observation. Brave requires
at least one returned source. Empty/all-null results fail NOT_FOUND rather than producing a fabricated
source row or successful evidence-backed deliverable. Provider JSON/shape errors fail closed. Citation
metadata is limited to HTTP(S) URLs without embedded credentials and bounded source counts/titles;
returned URLs are **never automatically fetched**. Public search query URLs are still sensitive metadata
inside authorized operation records: do not log or export them indiscriminately.

## Bounds, errors, retries and WRITE boundary

The existing pinned HTTPS egress transport retains exact host allowlisting, public-address/DNS pinning,
TLS servername validation, private/reserved/IP-literal refusal, no redirects and 500 KB provider caps.
P19 extends the **whole deadline** across DNS, connection and response body, rather than relying only
on a socket inactivity timeout. An uninterruptible OS DNS operation may finish in the background but
cannot open a socket after the raced deadline. Transport errors contain no raw remote exception text,
request URL, token or provider body. The shared transport also serves existing embeddings: its current
30s/4MB request remains inside the accepted 100ms..60s / 1..10MiB bounds; no new endpoint or permission.

Both reviewed tools have a 10-second broker deadline, covering final authority rechecks and invocation;
a late/abort-ignoring adapter result cannot become a completed observation. World Bank/Brave use:
401/403 -> NOT_CONFIGURED, 429 -> BUDGET_EXHAUSTED, 5xx/connection/body/deadline -> UNAVAILABLE (unresolvable DNS remains NOT_CONFIGURED),
malformed/unexpected data -> INVALID_STATE, usable-data absence -> NOT_FOUND. Do not report a local
quota or provider 429 as successful empty data. No implicit provider fallback, paid HTTP retry, pagination
loop, rate-limit bypass or live probe was added. Existing durable workflow recovery remains bounded by
its operation/beta budgets; uncertain calls retain UNKNOWN reservations. Investigate before retrying;
never force-settle zero or reset a ledger intent to hide an ambiguous charge.

Only READ_ONLY World Bank/Brave bundles resolve at runtime. Existing ToolBroker WRITE-intent approval
checks remain; no approval, scope or broker bypass is added. Agents propose tools, never call providers
directly. Unconfigured MCP/generic HTTP, advertising, publishing, mailbox/CRM and billing actions remain
blocked. Connecting OAuth identity or making an operator TOOL row cannot manufacture a code adapter.

## Future rollout and certification

No deploy/restart/rotation/config apply is part of P19. For a separately authorized rollout, preserve
previous immutable images/config and reconcile global TOOL/profile configuration with both backend
roles. Strict request-field validation, required positive paid-search ceilings and profile/policy checks
can newly expose previously latent misconfiguration: correct the reviewed configuration rather than
weakening guards, enabling native Hermes tools, routing to an unreviewed proxy or marking failures done.
Do not change immutable versions in place or activate every example provider without rights/funding.

P22 must certify actual subscription/terms/attribution, clock/region/locale behavior, public egress and
secret isolation; registration transitions; scoped tenant/capability/profile/consent revocation; Redis
quota under concurrency/outage; real HTTP success/empty/429/auth/timeout/partial-body paths; ceiling and
beta reservation/uncertain-spend behavior; normalized/raw digest/citation linkage; and all eight pack
journeys through real broker observations, deliverable validation and human review. Compilation and
configuration inspection are not that evidence. No P19 production functionality PASS is asserted.
