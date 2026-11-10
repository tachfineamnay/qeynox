# Architecture progress — QeyNox foundation wave

These are **SOURCE implementation claims only**, not verified runtime behavior.

| Lot | Area | Status / qualification |
| --- | --- | --- |
| 00 | Manifest, engineering rules, ADRs | CODED |
| 01 | pnpm workspace, API/worker entrypoints, packages | CODED · UNBUILT |
| 02 | Typed RaaS domain, plan/attempt/lineage states | CODED · UNTESTED |
| 03 | Drizzle/PostgreSQL mappings, migrations, API/services | CODED · migrations NOT APPLIED; identity BLOCKED |
| 04 | ToolRegistry, ToolBroker, HTTP JSON connector, ledger | CODED · zero active connectors; egress controls OPEN |
| 05 | Hatchet task, worker, orchestrator and outbox | PARTIAL · run-ID mapping/cancel/recovery NOT VERIFIED |
| 06 | Hermes API adapter, provider-neutral engine port | PARTIAL · Hermes native tool isolation BLOCKED |
| 07 | Interrupt/redo/revise/approval/reconciliation contracts | PARTIAL · cancellation observation UNSUPPORTED |
| 08 | Soul, Pilot, versioned profiles, eight capability slots | PARTIAL · no configured profiles/capabilities |
| 09 | Worker/API composition, result drafts, Docker/Coolify templates | PARTIAL · no external runtimes/images confirmed |

### Explicit limitations
- API routes deny access until an identity provider from phase 10 is integrated. No default users, insecure headers or mock credentials.
- No real vendor API, MCP or browser connector is configured or called.
- Tool proposals from Hermes are untrusted and **not executed automatically**; the worker refuses them pending a reviewed broker+approval routing integration.
- A draft with unverified agent text is **not** a deliverable and cannot be sold as a sourced result.
- Multi-step dispatch/plan progression and authenticated customer UX require further implementation.
- Business costs, offers, commercial payment, evidence verification, artifact exports, observability and hardening are subsequent milestones.
- Hatchet run-ID/cancellation exact runtime mapping is not validated; the outbox retains UNKNOWN delivery when ambiguous.
- No migrations have been run; no server, worker, containers or AI engine have been started.

**Global:** UNTESTED / NOT BUILT / NOT DEPLOYED. One final commit for tasks 00–09.
