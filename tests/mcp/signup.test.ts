import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createMcpServer } from '../../src/mcp/server.js'

describe('MCP tool: signup', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: () => Promise<void>

  const boot = async (
    mcpEndpoint?: string,
    onSignup?: (params: { blog: { id: string }; apiKey: string; email: string }) => Promise<void>,
  ) => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      mcpEndpoint,
      onSignup,
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-signup-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('happy path: returns blog_id, blog_url, api_key, onboarding_text, email_sent: false', async () => {
    await boot()
    const result = (await client.callTool({
      name: 'signup',
      arguments: { name: 'hello' },
    })) as unknown as {
      structuredContent: {
        blog_id: string
        blog_url: string
        api_key: string
        onboarding_text: string
        email_sent: boolean
        mcp_endpoint?: string
      }
      isError?: boolean
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent.blog_id).toMatch(/^[a-z0-9]+$/)
    expect(result.structuredContent.blog_url).toBe('https://b.example/')
    expect(result.structuredContent.api_key).toMatch(/^sk_slop_/)
    expect(result.structuredContent.onboarding_text).toContain(
      'Published my first post to SlopIt: <url>',
    )
    expect(result.structuredContent.email_sent).toBe(false)
    expect(result.structuredContent).not.toHaveProperty('mcp_endpoint')
  })

  it('MCP signup fires onSignup hook (parity with REST) and reports email_sent: true on success', async () => {
    const calls: Array<{ blog_id: string; api_key: string; email: string }> = []
    await boot(undefined, async ({ blog, apiKey, email }) => {
      calls.push({ blog_id: blog.id, api_key: apiKey, email })
    })
    const result = (await client.callTool({
      name: 'signup',
      arguments: { name: 'mcp-mail', email: '  Foo@Bar.COM  ' },
    })) as unknown as {
      structuredContent: { email_sent: boolean; api_key: string; blog_id: string }
    }
    expect(result.structuredContent.email_sent).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].email).toBe('foo@bar.com') // normalized before hook
    expect(calls[0].blog_id).toBe(result.structuredContent.blog_id)
    expect(calls[0].api_key).toBe(result.structuredContent.api_key)
  })

  it('MCP signup reports email_sent: false when the hook throws; signup still succeeds', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await boot(undefined, async () => {
      throw new Error('hook down')
    })
    const result = (await client.callTool({
      name: 'signup',
      arguments: { name: 'mcp-fail', email: 'a@b.com' },
    })) as unknown as {
      isError?: boolean
      structuredContent: { email_sent: boolean; api_key: string }
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent.email_sent).toBe(false)
    expect(result.structuredContent.api_key).toMatch(/^sk_slop_/)
    errSpy.mockRestore()
  })

  it('includes mcp_endpoint when configured', async () => {
    await boot('https://mcp.example/mcp')
    const result = (await client.callTool({
      name: 'signup',
      arguments: {},
    })) as unknown as {
      structuredContent: { mcp_endpoint?: string }
    }
    expect(result.structuredContent.mcp_endpoint).toBe('https://mcp.example/mcp')
  })

  it('BLOG_NAME_CONFLICT envelope on duplicate name', async () => {
    await boot()
    await client.callTool({ name: 'signup', arguments: { name: 'taken' } })
    const result = (await client.callTool({
      name: 'signup',
      arguments: { name: 'taken' },
    })) as unknown as {
      isError: boolean
      structuredContent: { error: { code: string } }
    }
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('BLOG_NAME_CONFLICT')
  })

  it('regression guard (decision #22 parity): idempotency_key rejected by SDK schema validation', async () => {
    await boot()
    const result = (await client.callTool({
      name: 'signup',
      arguments: { name: 'idem', idempotency_key: 'nope' },
    })) as unknown as {
      isError: boolean
      content: { type: string; text: string }[]
      structuredContent?: unknown
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Input validation error')
    // SDK-shaped error has no structuredContent (decision #15)
    expect(result.structuredContent).toBeUndefined()
  })
})
