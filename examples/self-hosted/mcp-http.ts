/**
 * Self-hosted MCP over HTTP example.
 *
 * Mounts WebStandardStreamableHTTPServerTransport under Hono at /mcp alongside the
 * REST router. authMode: 'api_key' — bearer arrives in the
 * Authorization header on the HTTP request, propagated into
 * extra.requestInfo.headers for resolveBearer.
 *
 * Run: pnpm dlx tsx examples/self-hosted/mcp-http.ts
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createApiRouter } from '../../src/api/index.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createStore } from '../../src/db/store.js'

function main(): void {
  const baseUrl = process.env.SLOPIT_BASE_URL ?? 'http://localhost:8080'
  const store = createStore({ dbPath: process.env.SLOPIT_DB ?? './slopit.db' })
  const renderer = createRenderer({
    store,
    outputDir: process.env.SLOPIT_OUT ?? './out',
    baseUrl,
  })

  const apiConfig = {
    store,
    rendererFor: () => renderer,
    baseUrl,
    mcpEndpoint: `${baseUrl}/mcp`,
  }

  const api = createApiRouter(apiConfig)

  const app = new Hono()
  // MCP route registered first so it isn't swallowed by the REST router's catch-all auth middleware.
  // Stateless MCP needs a fresh transport + server per request: the SDK refuses to reuse a
  // stateless transport across requests. createMcpServer only registers tool handlers (no I/O).
  app.all('/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    const mcp = createMcpServer(apiConfig)
    await mcp.connect(transport)
    return transport.handleRequest(c.req.raw)
  })
  app.route('/', api)

  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) })
}

main()
