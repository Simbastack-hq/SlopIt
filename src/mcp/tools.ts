import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpServerConfig } from './server.js'

/**
 * Register all 8 SlopIt MCP tools on the given server.
 * Tools are added in sequence; each is independently testable.
 *
 * Populated across Tasks 7–12.
 */
export function registerTools(_server: McpServer, _config: McpServerConfig): void {
  // intentionally empty — filled in Phase 2
}
