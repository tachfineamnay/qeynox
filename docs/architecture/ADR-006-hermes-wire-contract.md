# ADR-006: Hermes HTTP contract

Use the documented POST /v1/chat/completions OpenAI-compatible endpoint in the Hermes API server. Model is configured (default hermes-agent); send a full stateless message list. API reports id, finish_reason and optional usage. Stream/tool-progress/cancellation APIs are deliberately not assumed for this foundation.

A JSON envelope kind=tool_proposals can be extracted from Hermes' plain text response, but it is UNTRUSTED and cannot be a tool invocation. Only explicit QeyNox ToolBroker authorization can invoke registered connectors. No LLM instructions are treated as permissions.

REQUIRED DEPLOYMENT CONTROL: Hermes' built-in tool runtime and outbound connectivity must be disabled/isolated before enabling this adapter with user data. Setting HERMES_NATIVE_TOOLS_ISOLATED=true is an operator attestation, not technical proof. This is BLOCKED until deployment review. No live Hermes requests made.
