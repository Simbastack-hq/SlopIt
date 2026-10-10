import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Store } from '../db/store.js'
import type { TranslationPolicy } from '../posts.js'
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
  requireEmail?: boolean
  termsUrl?: string
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
   * Mirrors ApiRouterConfig.translationPolicy so REST and MCP gate
   * `translationOf` identically. See that field's doc.
   */
  translationPolicy?: TranslationPolicy
  /**
   * Mirrors ApiRouterConfig.onSignup so REST and MCP signup go through
   * the same hook. Both paths invoke signupBlog() under the hood; this
   * field is what the orchestration reads.
   */
  onSignup?: OnSignupHook
}

/**
 * Build an SDK McpServer with every SlopIt tool registered. Returns
 * the server unattached — consumer calls `await server.connect(transport)`
 * with whichever transport they want (stdio, Streamable HTTP, etc).
 *
 * Config mirrors ApiRouterConfig field-for-field so platform can share
 * a single config object across both factories.
 */
export function createMcpServer(config: McpServerConfig): McpServer {
  const server = new McpServer(
    { name: '@slopit/core', title: 'SlopIt', version: '0.1.0' },
    { instructions: instructionsFor(config) },
  )
  registerTools(server, config)
  return server
}

/** Server `instructions` (initialize result): the shortest path to a live post. */
function instructionsFor(config: McpServerConfig): string {
  const access =
    config.authMode === 'none'
      ? 'No API key is needed on this server: call `signup` once if there is no blog yet, then pass its `blog_id` to every tool.'
      : "If your requests already carry an API key (for example, your app signed in for you), don't call `signup`: every tool works on that key's blog and `blog_id` is optional. With no key yet, call `signup` first, passing the human's email so they can recover the key, then send the returned `api_key` as a Bearer token (`Authorization: Bearer <api_key>`) on every later call."
  return [
    'SlopIt publishes markdown posts to a blog and returns live URLs.',
    access,
    '`create_post` takes a `title` and a markdown `body`, publishes immediately (unless `status` is "draft"), and returns the live `post_url`.',
  ].join(' ')
}
