# QeyNox 2027 — Source architecture (ISOLATED-QA VERIFIED, NOT DEPLOYED)

Business user -> future MyDash/Soul -> NestJS API (workspace-scoped opaque sessions) -> application/domain -> PostgreSQL (plans, offers, consent, evidence, claims, results) -> transactional outbox -> Hatchet task worker -> EnginePort/Hermes -> authorized ToolBroker/provider registry -> captured sources -> evidence assessment -> ResultDocument -> private S3 export -> operation activity/read model.

Hatchet alone owns durable orchestration; QeyNox owns business plan identity, revisions, attempts and legal/business state. Hermes is the first agent runtime, registered via EngineRegistry with immutable attempt/profile selection; changing its model is not changing the agent runtime. ToolBroker controls external tools; unmanaged Hermes native tools remain a hard blocker until real isolation exists.

Runtime capabilities indicate SOURCE CODED, REQUIRES_CONFIG, UNSUPPORTED or NOT_VERIFIED. Do not infer actual compatibility from interfaces alone.

RaaS commercial fulfillment requires an immutable scope acceptance and an authorized order. Paid execution is blocked because payment provider is not configured; explicitly free offers alone may become authorized. Worker-level costs require configured budget policies. Final delivery requires real supported claims, human RESULT_REVIEW and a matching authorized order; partially evidenced findings remain drafts.

Source-limited connectors: only the documented World Bank Indicators V2 adapter is implemented; not enabled without network policy. Generic HTTP is disabled pending safe egress transport. No unrestricted MCP or browsing tools.

Deployment target VPS/Coolify. Infra templates are not a verified Hatchet/Hermes deployment. No user interface has been built as part of this source wave. The complete blockers and mapping are in IMPLEMENTATION_MAP.md.

Frozen-install, typecheck, production builds and five isolated-QA suites (database/configuration, backend HTTP/DI, agent runtime with local fixtures, connectors with real read-only World Bank calls, and an evidence-backed RaaS deliverable) have passed only against disposable QA resources. External Hatchet/Hermes runtimes, production object storage and deployment are **NOT VERIFIED / NOT DEPLOYED / NOT PRODUCTION-READY**; exact blockers are in IMPLEMENTATION_MAP.md.

