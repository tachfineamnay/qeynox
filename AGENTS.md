# QeyNox engineering contract

PRODUCT: QeyNox expands each person's business intelligence and capabilities through daily-use, internationally accessible Results as a Service. The customer defines the business objective and gets evidence-backed, actionable deliverables. It is not a CRM, productivity OS or chatbot wrapper. No promises of financial or business success.

BOUNDARIES:
- PostgreSQL/QeyNox Core is canonical business truth.
- Hatchet is the single durable workflow executor; never recreate Temporal/Hatchet within QeyNox.
- Hermes Agent is the initial replaceable intelligence runtime; tools require ToolBroker mediation.
- Soul manages consented context; Pilot supports business decisions, plans and approvals without becoming a scheduler.
- Eight configurable business capability slots; unconfigured skills remain inactive.
- Users retain control of privacy context, operation history and revisions.
- The approved frontend visual direction is Professional Blue (docs/design/DESIGN_SYSTEM.md); customer UI remains a separate implementation wave.

IMPLEMENTATION AND CERTIFICATION:
- main is the canonical verified baseline. Use scoped working branches when appropriate, and never push/merge/deploy without explicit operator instruction.
- One deliberate commit per completed, verified task.
- No push, merge, deployment, history rewrite or destructive Git action without an explicit operator instruction.
- Verification runs against a disposable PostgreSQL database (`QEYNOX_QA_DATABASE_URL`); never production. Required checks: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, `pnpm qa:task02`, `pnpm qa:backend`, `pnpm qa:agent-runtime`, `pnpm qa:connectors`, `pnpm qa:raas`, where prerequisites exist.
- Each module must fail closed when permissions, pricing, credentials, evidence, isolation or SDK support are absent.
- No hardcoded credentials, dummy providers, invented contacts, citations, prices or false success statuses. Deterministic QA fixtures are test infrastructure, never product fallbacks.
- Do not weaken validations or tests to obtain a passing result; fix reproducible source defects instead.
- Never claim code is proven functional based on source review alone. Verified status and remaining blockers are recorded in docs/architecture/PROGRESS.md and docs/architecture/IMPLEMENTATION_MAP.md.
- External Hatchet/Hermes runtimes, production object storage, provider licensing/freshness review and public identity hardening remain unverified deployment gates.

SOURCE TRUTH: Latest product decisions and ADRs supersede historical custom runner suggestions. docs/architecture/IMPLEMENTATION_MAP.md lists exact blockers. Production readiness requires a separate independent certification phase.

## Approved UI design contract
Before web, UX, marketing page or component work, read `docs/design/DESIGN_SYSTEM.md` and `docs/design/design-tokens.css`. QeyNox uses the approved **Professional Blue** concept: deep-navy sidebar, cobalt hero, light workspace surfaces, outcome-first mission cards and evidence-backed results. Follow semantic tokens, responsive rules, accessibility and Definition of Done. Never invent business proof or replace backend status with cosmetic success. Resolve API/security conflicts in favor of business truth. Do not introduce another visual language without explicit product approval. The original screenshot is referenced at `docs/design/reference/concept-02-professional-blue.png`; if not present in the checkout, screenshot comparison must be reported BLOCKED, not PASS.
