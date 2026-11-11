import { DomainError } from '@qeynox/domain';
/**
 * MCP boundary contract. No MCP gateway, server, transport or endpoint is configured by QeyNox.
 * MCP tools must never bypass ToolBroker: a future gateway must be registered as a reviewed
 * connector with fixed tool versions, scopes, egress policy and provenance.
 */
export interface McpGatewayRequest { readonly server: string; readonly tool: string; readonly version: string; readonly input: unknown }
export interface McpGatewayResult { readonly value: unknown; readonly sourceUri?: string; readonly publishedAt?: string }
export interface McpGateway { call(request: McpGatewayRequest, signal: AbortSignal): Promise<McpGatewayResult> }
export class UnconfiguredMcpGateway implements McpGateway {
  async call(): Promise<never> {
    throw new DomainError('UNSUPPORTED', 'MCP transport is not configured; MCP tools cannot bypass ToolBroker');
  }
}
