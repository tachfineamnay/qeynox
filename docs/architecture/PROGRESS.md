# QeyNox 2027 — Source-only progress
Baseline: 964697624fa9168ca188a53e74418569f23113f3
Branch: feat/qeynox-2027-foundations. One commit per numbered task; no tests, builds or deployment.

| Lot | Source status |
|---|---|
| 00–09 | Foundation coded; integration partial |
| 10 | Identity: bearer session, workspace membership, guards + migration 0002 — CODED |
| 11 | Plan seal/hash, multi-step sequential Hatchet dispatch, persistent handoffs + migration 0003 — CODED |
| 12–20 | PENDING |

NEXT SESSION HANDOFF — task 12: implement Hermes proposals -> guarded ToolBroker. Worker currently rejects tool proposals with NOT_CONFIGURED; Hermes must never invoke native unmediated tools. Review ToolBroker ledger and session-scoped permissions. Fix capability-scoped context handoff before tenant execution.

Global: UNTESTED / NOT BUILT / NOT DEPLOYED.
