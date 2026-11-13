# QeyNox preproduction implementation plan

Goal: independent Coolify resources in preproduction, without changing production or other projects.
Baseline: main 6de7455; operator request supplied 2026-11-13.

- [x] Verify target via instance-specific MCP token; create preproduction idempotently.
- [x] Create stopped PostgreSQL Core, Hatchet DB, Redis and three Git applications.
- [x] Reuse 2cb31f4 context/network corrections; root-context production Dockerfiles.
- [x] Test explicit private Web/API and Hermes origins; distributed Redis quota gate.
- [x] Add guarded empty-preproduction migration command; versioned disabled integration registry.
- [x] Configure independent runtime services, volumes, health and resource URLs.
- [x] Run frozen install, typecheck, build, disposable QA and independent Docker builds.
- [x] Commit verified changes, push only fast-forward-compatible main, deploy only preproduction.
- [x] Measure VPS before starting heavy services; prove connections, persistence and exports.

Access gates: existing local SSH key rejected; never bypass host authentication. No model credentials supplied. Never attest Hermes confinement without evidence. No domain ownership inferred. Maintain exact resource UUID inventory in infra/PREPRODUCTION.md.

Completion is limited to independently prepared resources and verified preproduction foundation. Hermes/client execution, optional RAG activation and public DNS/TLS are explicitly blocked; see docs/architecture/PREPRODUCTION_VERIFICATION.md. SSH and capacity gates were resolved by operator input.
