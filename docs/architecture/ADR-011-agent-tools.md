# ADR-011 — QeyNox-authorized agent tool execution

Hermes emits *proposals* via its OpenAI-compatible response, not raw privileged tool calls. QeyNox parses bounded tool descriptions and independently routes them through a ToolBroker with tenant, operation, attempt, profile, capability, consent, budget and exact WRITE-intent approval checks. No provider credentials are sent to Hermes.

BrokeredAgentExecutor records actual tool provenance, source IDs and unverified evidence; these are never automatically SUPPORTED claims. Absent connectors remain disabled: no operational provider is registered by default. READ actions can proceed only when explicitly configured, allowed and within a nonzero budget; WRITE actions require specific preapproved intent IDs. Iterations are bounded.

IMPORTANT: Hermes native tools/MCP/shell/browser are NOT yet physically sandboxed by this repository. The `nativeToolsIsolated` flag is an operator assertion and **does not prove containment**. Real tenant execution MUST remain disabled until isolation is enforced and verified in deployment; network egress firewall and tool configuration must prevent bypass at runtime.

UNTESTED / NOT BUILT / NOT DEPLOYED.
