import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  createApiKey,
  createBlog,
  createMcpServer,
  createRenderer,
  createStore,
  wrapTool,
  type Store,
} from '../../src/index.js'
import { attachAuth } from './helpers.js'

// A consumer (the hosted platform) registers its own read-only tool on the
// server createMcpServer() returns, wrapped with the exported wrapTool.
// docs/solutions/consumer-registered-mcp-tools.md.
describe('consumer-registered MCP tools', () => {
  let dir: string
  let store: Store
  let blogId: string
  let otherBlogId: string
  let apiKey: string
  let closer: () => Promise<void>

  const boot = async (token?: string): Promise<Client> => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const config = { store, rendererFor: () => renderer, baseUrl: 'https://api.example' }
    const server = createMcpServer(config)
    server.registerTool(
      'consumer_whoami',
      {
        title: 'Who am I',
        description: "Return the authenticated blog's id.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        inputSchema: z.object({ blog_id: z.string().optional() }).strict(),
        // Loose, optional success fields, error declared: mcp-output-schemas.md.
        outputSchema: z.looseObject({
          whoami: z.string().optional(),
          error: z.looseObject({ code: z.string(), message: z.string() }).optional(),
        }),
      },
      wrapTool<{ blog_id?: string }>(
        config,
        'consumer_whoami',
        { auth: 'required', crossBlogGuard: true },
        (_args, ctx) => ({ whoami: ctx.blog!.id }),
      ),
    )
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' }, {})
    if (token !== undefined) attachAuth(clientT, token)
    await client.connect(clientT)
    // Primes the client's outputSchema validators: callTool() below throws
    // if structuredContent (errors included) doesn't match.
    await client.listTools()
    closer = async () => {
      await client.close()
      await server.close()
    }
    return client
  }

  const call = async (client: Client, args: Record<string, unknown>) =>
    (await client.callTool({ name: 'consumer_whoami', arguments: args })) as CallToolResult

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-consumer-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    blogId = createBlog(store, { name: 'bb' }).blog.id
    apiKey = createApiKey(store, blogId).apiKey
    otherBlogId = createBlog(store, { name: 'other' }).blog.id
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is listed next to the core tools', async () => {
    const client = await boot(apiKey)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('consumer_whoami')
    expect(names).toContain('get_blog')
  })

  it('no key → UNAUTHORIZED envelope', async () => {
    const client = await boot()
    const result = await call(client, {})
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  })

  it("valid key → success, blog_id defaults to the key's blog", async () => {
    const client = await boot(apiKey)
    for (const args of [{}, { blog_id: blogId }]) {
      const result = await call(client, args)
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual({ whoami: blogId })
    }
  })

  it("another blog's id → BLOG_NOT_FOUND envelope", async () => {
    const client = await boot(apiKey)
    const result = await call(client, { blog_id: otherBlogId })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'BLOG_NOT_FOUND' } })
  })
})
