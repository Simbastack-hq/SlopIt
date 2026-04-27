import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Store } from '../db/store.js'
import type { MutationRenderer } from '../rendering/generator.js'
import type { Blog } from '../schema/index.js'
import type { OnSignupHook } from '../signup.js'
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
  /**
   * Per-file upload cap in bytes. Default 5_000_000 (5 MB) when undefined.
   * Function form lets platform pass plan-tier values per-blog.
   * Platform passes plan-tier values; self-hosted leaves unset.
   */
  mediaMaxBytes?: number | ((blog: Blog) => number)
  /**
   * Per-blog total media cap in bytes. `null` = unlimited (default).
   * Function form lets platform return null for paid tiers and a finite
   * cap for free.
   * Platform passes plan-tier values; self-hosted leaves unset.
   */
  mediaMaxTotalBytesPerBlog?: number | null | ((blog: Blog) => number | null)
  /**
   * Mirrors ApiRouterConfig.onSignup so REST and MCP signup go through
   * the same hook. Both paths invoke signupBlog() under the hood; this
   * field is what the orchestration reads.
   */
  onSignup?: OnSignupHook
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
