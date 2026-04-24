/**
 * Self-hosted MCP stdio example.
 *
 * Pair with authMode: 'none' — stdio is a single-tenant local-dev/
 * desktop-agent scenario. Idempotency is api_key-mode only
 * (spec decision #16), so retries on this transport re-execute.
 *
 * Run: pnpm dlx tsx examples/self-hosted/mcp-stdio.ts
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createStore } from '../../src/db/store.js'

async function main(): Promise<void> {
  const store = createStore({ dbPath: process.env.SLOPIT_DB ?? './slopit.db' })
  const renderer = createRenderer({
    store,
    outputDir: process.env.SLOPIT_OUT ?? './out',
    baseUrl: process.env.SLOPIT_BASE_URL ?? 'http://localhost:8080',
  })

  const server = createMcpServer({
    store,
    rendererFor: () => renderer,
    baseUrl: process.env.SLOPIT_BASE_URL ?? 'http://localhost:8080',
    authMode: 'none',
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
