import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiKey, createBlog, getBlog } from '../../src/blogs.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { attachAuth, callTool } from './helpers.js'

describe('MCP tool: update_blog', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: () => Promise<void>
  let blogId: string
  let apiKey: string

  const boot = async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    attachAuth(clientT, apiKey)
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-update-blog-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const blog = createBlog(store, { name: 'mb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    await boot()
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('sets analytics on the blog', async () => {
    const result = await callTool(client, 'update_blog', {
      blog_id: blogId,
      patch: {
        analytics: { umami: { scriptUrl: 'https://u/s.js', siteId: 'sid' } },
      },
    })
    expect(result.isError).toBeFalsy()
    const blog = (
      result.structuredContent as {
        blog: { analytics?: { umami?: { siteId: string } } }
      }
    ).blog
    expect(blog.analytics?.umami?.siteId).toBe('sid')
    // Persistence round-trip
    expect(getBlog(store, blogId).analytics?.umami?.siteId).toBe('sid')
  })

  it('clears analytics with explicit null', async () => {
    store.db
      .prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?')
      .run(JSON.stringify({ umami: { scriptUrl: 'https://u/s.js', siteId: 's' } }), blogId)

    const result = await callTool(client, 'update_blog', {
      blog_id: blogId,
      patch: { analytics: null },
    })
    expect(result.isError).toBeFalsy()
    const blog = (result.structuredContent as { blog: { analytics?: unknown } }).blog
    expect(blog.analytics).toBeUndefined()
    expect(getBlog(store, blogId).analytics).toBeUndefined()
  })

  it('empty patch → returns the blog unchanged', async () => {
    const result = await callTool(client, 'update_blog', {
      blog_id: blogId,
      patch: {},
    })
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as { blog: { id: string } }).blog.id).toBe(blogId)
  })

  it('cross-blog blog_id → BLOG_NOT_FOUND envelope', async () => {
    const other = createBlog(store, { name: 'other' }).blog
    const result = await callTool(client, 'update_blog', {
      blog_id: other.id,
      patch: { analytics: null },
    })
    expect(result.isError).toBe(true)
    const sc = result.structuredContent as { error: { code: string } }
    expect(sc.error.code).toBe('BLOG_NOT_FOUND')
  })

  it('unknown patch field → SDK-shaped validation error', async () => {
    const result = await callTool(client, 'update_blog', {
      blog_id: blogId,
      patch: { theme: 'minimal' },
    })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('Input validation error')
  })
})
