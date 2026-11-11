# ADR-019 — Runtime portability and local data policy

QeyNox stores an immutable engine selection per step attempt, including agent profile and version. Future EngineRegistry adapters require their own capability manifest, but already-started attempts remain bound to the runtime they selected; no live migration is implied. Hermes invocation is source-coded and REQUIRES_CONFIG, while Hatchet run-ID/cancel are NOT_VERIFIED/UNSUPPORTED. A new engine cannot be silently treated as interchangeable merely because it speaks a chat-completions API.

Local consent erasure marks owned context values deleted and revokes future context access; data erasure requests distinguish local context, backup/retention obligations and unconfirmed external copies. This implementation does NOT promise immediate third-party erasure or removal of legally required audit/commercial records.

The project is still SOURCE ONLY and must not be used for live tenant data until identity, egress and retention policies are certified.
