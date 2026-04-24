import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiKey, createBlog } from '../../src/blogs.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createPost } from '../../src/posts.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { attachAuth, callTool } from './helpers.js'

describe('MCP read tools', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-read-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    createPost(store, renderer, blogId, { title: 'Pub1', body: 'b', slug: 'pub1' })
    createPost(store, renderer, blogId, {
      title: 'Draft1',
      body: 'b',
      slug: 'draft1',
      status: 'draft',
    })
    await boot()
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('get_blog returns { blog }', async () => {
    const result = await callTool(client, 'get_blog', { blog_id: blogId })
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as { blog: { id: string } }).blog.id).toBe(blogId)
  })

  it('get_post happy path', async () => {
    const result = await callTool(client, 'get_post', { blog_id: blogId, slug: 'pub1' })
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as { post: { slug: string } }).post.slug).toBe('pub1')
  })

  it('get_post miss → POST_NOT_FOUND envelope', async () => {
    const result = await callTool(client, 'get_post', { blog_id: blogId, slug: 'nope' })
    expect(result.isError).toBe(true)
    expect((result.structuredContent as { error?: { code: string } }).error?.code).toBe(
      'POST_NOT_FOUND',
    )
  })

  it('list_posts default returns published only', async () => {
    const result = await callTool(client, 'list_posts', { blog_id: blogId })
    expect(result.isError).toBeFalsy()
    const posts = (result.structuredContent as { posts: { slug: string; status: string }[] }).posts
    expect(posts).toHaveLength(1)
    expect(posts[0].slug).toBe('pub1')
  })

  it("list_posts status: 'draft' returns drafts only", async () => {
    const result = await callTool(client, 'list_posts', { blog_id: blogId, status: 'draft' })
    expect(result.isError).toBeFalsy()
    const posts = (result.structuredContent as { posts: { slug: string; status: string }[] }).posts
    expect(posts).toHaveLength(1)
    expect(posts[0].slug).toBe('draft1')
  })
})
