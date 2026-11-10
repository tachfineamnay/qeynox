# ADR-004: Tool-first connectivity and policy

A connector must register a fixed tool version with input/output schemas, requested scopes, permitted business capabilities, method and timeout. No arbitrary URL, shell command or file path can originate from an agent response.

ToolBroker checks identity, capability, consent, limits and exact WRITE approval *before* invoking provider adapters, then reserves a durable ledger row with an idempotency key. Interrupted writes may have succeeded remotely: mark UNKNOWN and require reconciliation instead of blind retry.

The generic HttpJsonConnector provides a concrete configurable JSON HTTP adapter with a fixed operator-defined path and schemas. It is **not** a promise that a particular external API is connected. Network egress firewall, DNS rebinding protection and credentials provisioning remain deployment responsibilities.

Hermes' default native tools are dangerous to a broker-only policy; deployment isolation is a strict prerequisite. Untested. No tools have been called.
