# MISSION A12 — Automatic Pilot planner

**Status: implemented and verified against isolated infrastructure. Not merged; draft PR only.**
This note records what was built, the contract it enforces, and exactly what was verified — and
what was not.

## What shipped

The complete customer journey: natural-language objective → structured, editable plan proposal →
explicit customer save → (unchanged) explicit approval and readiness-gated launch.

```
Objective (recorded on the mission)            [FlowHeader / mission page — existing]
  → Pilot plan proposal (advisory only)        [NEW: POST /v1/pilot/operations/:id/plan-proposal]
  → Plan preview / clarification questions     [NEW: ProposalPanel in plan-editor]
  → Edit freely (existing editor, unchanged)   [existing PlanEditor]
  → Explicit validation checkbox + Save        [existing savePlan — the ONLY persistence path]
  → Approvals / readiness / launch             [existing, unchanged]
```

### Server side

- `packages/roles/src/pilot-planner.ts` — `PlanProposalService`. Advisory only: **persists nothing**
  (verified: plan revisions, steps, events, outbox all byte-identical before/after). Uses the same
  replaceable `EnginePort` (Hermes) as Soul, the ACTIVE `PILOT_PROFILE`, and a bounded request:
  ≤40 steps, ≤24 KB output, ≤3 clarifying questions surfaced, per-attempt timeout enforced by a race
  (a hung engine cannot block the caller even if it ignores the abort signal), one model call per
  client attempt key (scoped `workspaceId:userId:operationId:key`).
- Strict validation, all-or-nothing. The model output never creates or partially creates a plan:
  unknown/inactive capability ids, per-capability `maximumSteps` ceilings, out-of-range/self/cyclic
  dependencies, EXTERNAL_ACTION without reviewed tools, or unparseable output → the whole proposal is
  refused (`INVALID_PROPOSAL`) with zero steps. A valid proposal still cannot execute anything.
- Honest readiness: the response carries per-used-capability operational state (CONFIGURED /
  OPERATIONAL / BLOCKED / UNVERIFIED, missing providers/policies) from the existing plan-read
  projection (`apiRuntimeReadiness`), and the workspace ACTIVE budget boundary (or
  `configured:false` when none exists — never an invented ceiling).
- Goal and constraints come from the recorded mission; no consented facts or documents are sent to
  the model; placeholder ids (`pilot-proposal-…`) are namespace-distinguishable from real attempts.
- Degradation: unconfigured/unreachable/timeout/refusal/empty/invalid engines all yield
  `DETERMINISTIC_FALLBACK` + a stated reason and **no steps**. Nothing fabricates a plan. When no
  capability is ACTIVE the engine is never called (`NO_CAPABILITIES`).

### Client side

- Mission page (Flow, `plan-editor.tsx`): new `ProposalPanel` — ask, review, then either apply the
  draft into the editor (topological order) or discard it. Capability readiness, budget boundary,
  deliverables, assumptions and the external-action/approval note are shown verbatim. The plan is
  persisted only by the existing save action with its mandatory “I have reviewed and validated…”
  checkbox. EN/FR copy provided.
- Applying a proposal never auto-saves; editing after apply is unrestricted; rev semantics
  (create vs revise + recorded reason) unchanged.

## Verification (disposable PostgreSQL, never production)

- `pnpm typecheck` clean; `pnpm build` clean.
- `pnpm qa:pilot-planner` (new) — service level with scripted engines + HTTP with the real
  (unconfigured in QA) `HermesAdapter`: 10 check groups pass, including zero persistence, whole-plan
  rejection rules, degradation table, attempt-key replay, workspace isolation, contract 400s.
- `pnpm qa:task02` 3783 assertions pass; `pnpm qa:agent-runtime` 65 pass; `pnpm qa:soul-intelligence`
  22 groups pass.
- Live API smoke: `plan-proposal` returns a validated AI draft against a fixture Hermes server;
  SSR of the mission page renders the proposal panel (verified in served HTML).

**NOT executed:** a real browser click-through of the panel (no Chromium/system libraries are
installable in this sandbox — `libnspr4` etc. are absent). The interactive path is covered by build
+ typecheck + the HTTP contract it calls; the unavailable-engine path was exercised end-to-end at
the HTTP layer and asserted in the page’s SSR output. A live browser pass remains recommended before
merge, plus `pnpm qa:backend` which was already failing pre-A12 and was left untouched.

## Honest limits / operator dependencies

- A *useful* proposal requires the operator to configure an ACTIVE capability and PILOT_PROFILE and
  to attest Hermes (endpoint, key, native-tool isolation, egress). Without those, the UI shows the
  stated reason and manual planning remains. This is the same fail-closed contract as the rest of
  the platform; nothing is reported OPERATIONAL without evidence.
- Readiness of individual capabilities stays provider/policy dependent; the proposal surfaces it, it
  does not decide it.
- The attempt cache is in-process (module scope), bounded to 200 entries; it dedupes retries, it is
  not a durability mechanism.
- Browser verification of the applied-draft flow is the one unexecuted path; screenshot parity
  remains BLOCKED (no reference PNG).
