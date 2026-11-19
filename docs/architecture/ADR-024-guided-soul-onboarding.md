# ADR-024 — Guided Soul onboarding before a mission exists

- **Status:** Accepted
- **Date:** 2026-11-19
- **Mission:** A05
- **Extends:** the pre-mission onboarding contract introduced with the 2026-11-14 Soul lot. Introduces
  no second onboarding, no second memory store and no change to `/v1/soul/converse`.

## Context

Soul onboarding shipped as a strictly deterministic questionnaire: one question at a time, status and
step persisted per user/workspace, answers written as consented `user_contexts` facts, and two view
fields that said so literally —

```ts
readonly deterministic: true;
readonly aiAvailable: false;
readonly aiReason: 'PRE_MISSION_CONTRACT';
```

Those literals were honest **when no engine was wired to onboarding at all**, but they were also
unconditional: they would have kept reporting "no AI, by contract" even after an operator configured a
Soul profile and a reachable Hermes endpoint. A field that cannot change is not a fact, it is a claim.
A05 had to make onboarding useful without making it dishonest, and without breaking any of the
guarantees the deterministic flow already provides.

Three constraints shaped the design:

1. `EngineRequest` requires a non-optional `operationId` and `stepAttemptId`. Pre-mission onboarding has
   no operation and must not fabricate one that could be mistaken for a real mission.
2. The operation-bound `POST /v1/soul/converse` contract must stay untouched; it exists to talk to Soul
   **about a running mission**, with that mission's identity.
3. Consent is the only gate to memory. Guidance must not become a side door that reads or writes facts.

## Decision 1 — guidance is an optional layer, never a writer

`SoulOnboardingService` remains the single writer of progress, consent and facts. The new
`POST /v1/soul/onboarding/guide` route calls `SoulOnboardingService.guide`, which:

- resolves the **current** step from the record and refuses anything else (`INVALID_STATE`, HTTP 409);
- refuses on steps that are not conversational (`WELCOME`, `LANGUAGE`, `CONSENT`, `DONE`);
- refuses once onboarding is `COMPLETED` or `DISMISSED`;
- returns `stepUnchanged: true` and never calls `answer`, `skip` or `advance`.

A guidance call cannot move the customer forward, cannot skip a question and cannot complete
onboarding. The state machine is unchanged, including its `INVALID_STATE` behaviour on a stale step.

## Decision 2 — operation-free inference with namespaced placeholder identity

`GuidedOnboardingService` (`packages/roles/src/soul-guidance.ts`) invokes the existing `EnginePort`
with an identity derived only from the onboarding row:

```ts
placeholderIdentity(onboardingId, step)
// { operationId: 'onboarding-op-<sha256[0..24]>',
//   stepAttemptId: 'onboarding-attempt-<sha256[24..48]>' }
```

The prefixes make a placeholder impossible to confuse with a real operation id, the value is stable per
(onboarding, step), and nothing is ever written to `operations`, `operation_steps` or
`command_idempotency` as a result of guidance. The QA gate asserts that a workspace with guidance
history still has exactly zero operations until the mission is created.

## Decision 3 — the fallback is a first-class result, not an exception

Every outcome is a `GuidanceResult` with explicit provenance:

```ts
{ source: 'AI' | 'DETERMINISTIC_FALLBACK', reason, aiGenerated, content, turns, engineAttempted }
```

Reasons: `OK`, `ENGINE_NOT_CONFIGURED`, `ENGINE_UNAVAILABLE`, `ENGINE_TIMEOUT`, `ENGINE_REFUSED`,
`ENGINE_EMPTY`, `TURN_LIMIT`. Nothing throws for an inference problem. Specifically:

| Condition | Result |
|---|---|
| No active Soul profile | `ENGINE_NOT_CONFIGURED`, fallback text |
| Missing endpoint / key / attestation | `ENGINE_NOT_CONFIGURED`, fallback text |
| Transport failure, 5xx, rate limit | `ENGINE_UNAVAILABLE`, fallback text |
| Outer timeout aborts the call | `ENGINE_TIMEOUT`, fallback text |
| Completion with empty content | `ENGINE_EMPTY`, fallback text |
| Completion with non-`COMPLETED` status | `ENGINE_UNAVAILABLE`, fallback text |
| Explicit refusal opener | `ENGINE_REFUSED`, fallback text |
| More than 12 customer turns | `TURN_LIMIT`, fallback text, **no model call** |

Refusal detection is deliberately conservative — an explicit refusal opener in the first 120
characters only — so ordinary business prose that happens to contain "cannot" is still treated as
guidance. Empty or refused completions are never rendered as AI.

Fallback text is locale-aware (`en`/`fr`) and comes from the onboarding record's locale, never from
guessing the language of the customer's message.

## Decision 4 — readiness is reported by the engine, not asserted by the view

`EnginePort` gains an optional, side-effect-free probe:

```ts
isAvailable?(): { available: boolean; reason: 'READY' | 'NO_ENDPOINT' | 'NO_CREDENTIAL'
                                          | 'NO_ATTESTATION' | 'INVALID_TIMEOUT' | 'UNKNOWN' }
```

`HermesAdapter.isAvailable()` mirrors `assertOperational()` exactly and performs no network I/O. An
adapter that does not implement it is treated as unavailable, never assumed working. The onboarding
view now reports:

```ts
readonly aiAvailable: boolean;   // engine attested readiness
readonly aiReason: OnboardingAiReason;  // 'READY' or the real refusal reason
readonly guidanceAvailable: boolean;
```

The hardcoded `deterministic` literal is gone. The UI badge prints `AI answer · READY` only when the
engine attested readiness, and otherwise `Deterministic guidance · <reason>` with the raw reason code
visible. Per-message provenance is shown separately, so a customer always knows whether a specific
reply was model-generated.

## Decision 5 — the model sees only this conversation

The prompt is built from exactly four inputs: the step being asked, the answers already given in this
onboarding (from the consented fact store via `viewContext`), the recent turns (last 8), and the new
message. `context: {}` is always sent — guidance never forwards consented facts to the provider. Since
`viewContext` already filters on a live `context:read` consent, revoking consent removes the grounding
without deleting anything.

Conversation history is client-held and echoed back per request. It is **not persisted**, so there is no
second memory system and nothing new to delete. The per-attempt result cache is in-process, scoped by
`workspaceId:userId:attemptKey`, and dies with the process.

## Decision 6 — bounded by construction

- 12 customer turns per onboarding conversation, then fallback with no model call.
- 8 prior turns maximum in any prompt; 2000 character message ceiling.
- `maxOutputTokens` bounded by the versioned Soul profile.
- 15 s outer timeout around a call the adapter already timeouts internally.
- One model call per `attemptKey`; a retry returns the cached result verbatim, so a double-submitted
  form never bills twice.

## Consequences

- Operators can now enable real guidance by publishing a Soul profile and configuring Hermes; until
  then the product says exactly why it cannot, instead of claiming a contract.
- Onboarding is usable with the model down. Refusal, timeout, offline and empty completions all degrade
  to the same deterministic question set that existed before A05.
- Two new obligations for future work: anything that adds a provider must keep `isAvailable()` truthful,
  and anything that adds a step must decide explicitly whether it accepts guidance.

## Not done

- No second onboarding, no new migration, no new table, no change to `/v1/soul/converse`.
- Conversation turns are not persisted; resuming a conversation after a page reload starts a fresh
  guidance history, while onboarding progress itself continues to resume exactly as before.
- No live provider call is asserted by the gate. Every AI-path assertion in `qa:soul-intelligence` runs
  against a scripted engine, so a green run proves the contract, never that a provider was reachable.
