import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Store } from '../db/store.js'
import type { MutationRenderer } from '../rendering/generator.js'
import type { Blog } from '../schema/index.js'
import { registerTools } from './tools.js'

export interface McpServerConfig {
  store: Store
  rendererFor: (blog: Blog) => MutationRenderer
  baseUrl: string
  authMode?: 'api_key' | 'none'
  mcpEndpoint?: string
  docsUrl?: string
  skillUrl?: string
  bugReportUrl?: string
  dashboardUrl?: string
}

/**
 * Build an SDK McpServer with the 8 SlopIt tools registered. Returns
 * the server unattached — consumer calls `await server.connect(transport)`
 * with whichever transport they want (stdio, Streamable HTTP, etc).
 *
 * Config mirrors ApiRouterConfig field-for-field so platform can share
 * a single config object across both factories.
 */
export function createMcpServer(config: McpServerConfig): McpServer {
  const server = new McpServer({ name: '@slopit/core', version: '0.1.0' })
  registerTools(server, config)
  return server
}
