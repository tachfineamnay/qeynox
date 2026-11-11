# ADR-017 — Business event projections for MyDash

A tenant-scoped OperationView presents status, steps, approvals, results and evidence availability rather than exposing raw Hatchet/Hermes internals. Existing append-only operation_events are canonical; projectors assign stable per-operation event sequence IDs into operation_event_envelopes and maintain a summary cache with serialized cursor updates. Duplicate events cannot produce duplicate envelopes.

Initial implementation reconciles projections on authorized GET requests and exposes polling with a numeric cursor. It does NOT claim SSE, push streaming, background live projection or true instantaneous state. Correlation and actor fields are populated only from existing recorded metadata; unknown fields remain missing. Projection output excludes secrets and raw prompts.

UI/Quiet Authority remains out of scope; consumer wording belongs in the frontend locale layer.
