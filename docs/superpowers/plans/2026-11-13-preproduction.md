# QeyNox preproduction implementation plan

Goal: independent Coolify resources in preproduction, without changing production or other projects.
Baseline: main 6de7455; operator request supplied 2026-11-13.

- [x] Verify target via instance-specific MCP token; create preproduction idempotently.
- [x] Create stopped PostgreSQL Core, Hatchet DB, Redis and three Git applications.
- [ ] Reuse 2cb31f4 context/network corrections; root-context production Dockerfiles.
- [ ] Test explicit private Web/API and Hermes origins; distributed Redis quota gate.
- [ ] Add guarded empty-preproduction migration command; versioned disabled integration registry.
- [ ] Configure independent runtime services, volumes, health and resource URLs.
- [ ] Run frozen install, typecheck, build, disposable QA and independent Docker builds.
- [ ] Commit verified changes, push only fast-forward-compatible main, deploy only preproduction.
- [ ] Measure VPS before starting heavy services; prove connections, persistence and exports.

Access gates: existing local SSH key rejected; never bypass host authentication. No model credentials supplied. Never attest Hermes confinement without evidence. No domain ownership inferred. Maintain exact resource UUID inventory in infra/PREPRODUCTION.md.
