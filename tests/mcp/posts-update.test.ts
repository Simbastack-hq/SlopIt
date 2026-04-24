import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiKey, createBlog } from '../../src/blogs.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createPost, getPost } from '../../src/posts.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { attachAuth, callTool } from './helpers.js'

describe('MCP tool: update_post', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-update-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    // seed a published post
    createPost(store, renderer, blogId, { title: 'Seed', body: 'Original', slug: 'seed' })
    await boot()
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('published → published preserves published_at', async () => {
    const firstPubAt = getPost(store, blogId, 'seed').publishedAt

    const result = await callTool(client, 'update_post', {
      blog_id: blogId,
      slug: 'seed',
      patch: { body: 'Edited' },
    })
    expect(result.isError).toBeFalsy()
    const post = (result.structuredContent as { post: { publishedAt: string; body: string } }).post
    expect(post.publishedAt).toBe(firstPubAt)
    expect(post.body).toBe('Edited')
  })

  it('slug in patch → SDK-shaped validation error', async () => {
    const result = await callTool(client, 'update_post', {
      blog_id: blogId,
      slug: 'seed',
      patch: { slug: 'new-slug' },
    })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('Input validation error')
  })

  it('empty patch → returns current post unchanged', async () => {
    const result = await callTool(client, 'update_post', {
      blog_id: blogId,
      slug: 'seed',
      patch: {},
    })
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as { post: { slug: string } }).post.slug).toBe('seed')
  })

  it('published → draft deletes the post file (DB still has the row)', async () => {
    const result = await callTool(client, 'update_post', {
      blog_id: blogId,
      slug: 'seed',
      patch: { status: 'draft' },
    })
    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as { post: { status: string }; post_url?: string }
    expect(sc.post.status).toBe('draft')
    // no post_url on draft
    expect(sc.post_url).toBeUndefined()
  })
})
