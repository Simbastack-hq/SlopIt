import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiKey, createBlog } from '../../src/blogs.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { attachAuth, callTool } from './helpers.js'

describe('MCP tool: create_post', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: () => Promise<void>
  let blogId: string
  let apiKey: string
  let otherBlogId: string

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
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-create-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    const other = createBlog(store, { name: 'other' }).blog
    otherBlogId = other.id
    await boot()
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('happy path: publishes a post and returns post + post_url', async () => {
    const result = await callTool(client, 'create_post', {
      blog_id: blogId,
      title: 'Hello',
      body: '# Hi\n\nBody.',
    })
    const sc = result.structuredContent as { post: { slug: string }; post_url?: string }
    expect(result.isError).toBeFalsy()
    expect(sc.post.slug).toBe('hello')
    expect(sc.post_url).toBe('https://b.example/hello/')
  })

  it('missing title → SDK-shaped validation error', async () => {
    const result = await callTool(client, 'create_post', { blog_id: blogId, body: 'x' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('Input validation error')
    expect(result.structuredContent).toBeUndefined()
  })

  it('cross-blog guard: other blog_id → BLOG_NOT_FOUND envelope', async () => {
    const result = await callTool(client, 'create_post', {
      blog_id: otherBlogId,
      title: 'x',
      body: 'y',
    })
    expect(result.isError).toBe(true)
    const sc = result.structuredContent as { error: { code: string } }
    expect(sc.error.code).toBe('BLOG_NOT_FOUND')
  })

  it('idempotency replay: same key + same args → identical response', async () => {
    const first = await callTool(client, 'create_post', {
      blog_id: blogId,
      title: 'Idem',
      body: 'x',
      idempotency_key: 'k-create-1',
    })
    const second = await callTool(client, 'create_post', {
      blog_id: blogId,
      title: 'Idem',
      body: 'x',
      idempotency_key: 'k-create-1',
    })
    expect(first.isError).toBeFalsy()
    expect(second.isError).toBeFalsy()
    expect(second.structuredContent).toEqual(first.structuredContent)
  })

  it('idempotency mismatch: same key + different args → IDEMPOTENCY_KEY_CONFLICT', async () => {
    await callTool(client, 'create_post', {
      blog_id: blogId,
      title: 'A',
      body: 'x',
      idempotency_key: 'k-create-2',
    })
    const result = await callTool(client, 'create_post', {
      blog_id: blogId,
      title: 'B',
      body: 'x',
      idempotency_key: 'k-create-2',
    })
    expect(result.isError).toBe(true)
    const sc = result.structuredContent as { error: { code: string } }
    expect(sc.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT')
  })

  it('POST_SLUG_CONFLICT on duplicate explicit slug (no idempotency)', async () => {
    await callTool(client, 'create_post', { blog_id: blogId, title: 'A', slug: 'same', body: 'x' })
    const result = await callTool(client, 'create_post', {
      blog_id: blogId,
      title: 'B',
      slug: 'same',
      body: 'y',
    })
    expect(result.isError).toBe(true)
    const sc = result.structuredContent as { error: { code: string } }
    expect(sc.error.code).toBe('POST_SLUG_CONFLICT')
  })
})
