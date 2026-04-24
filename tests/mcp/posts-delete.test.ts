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

describe('MCP tool: delete_post', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-delete-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    const other = createBlog(store, { name: 'other' }).blog
    otherBlogId = other.id
    createPost(store, renderer, blogId, { title: 'Seed', body: 'Body', slug: 'seed' })
    await boot()
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('happy path returns { deleted: true }', async () => {
    const result = await callTool(client, 'delete_post', { blog_id: blogId, slug: 'seed' })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ deleted: true })
  })

  it('same-key retry replays { deleted: true } (hit-match)', async () => {
    const first = await callTool(client, 'delete_post', {
      blog_id: blogId,
      slug: 'seed',
      idempotency_key: 'k-del-1',
    })
    const second = await callTool(client, 'delete_post', {
      blog_id: blogId,
      slug: 'seed',
      idempotency_key: 'k-del-1',
    })
    expect(first.structuredContent).toEqual({ deleted: true })
    expect(second.structuredContent).toEqual({ deleted: true })
  })

  it('no-key retry after successful delete → POST_NOT_FOUND envelope', async () => {
    await callTool(client, 'delete_post', { blog_id: blogId, slug: 'seed' })
    const retry = await callTool(client, 'delete_post', { blog_id: blogId, slug: 'seed' })
    expect(retry.isError).toBe(true)
    expect((retry.structuredContent as { error?: { code: string } }).error?.code).toBe(
      'POST_NOT_FOUND',
    )
  })

  it('cross-blog guard: blog_id mismatch → BLOG_NOT_FOUND', async () => {
    const result = await callTool(client, 'delete_post', { blog_id: otherBlogId, slug: 'seed' })
    expect(result.isError).toBe(true)
    expect((result.structuredContent as { error?: { code: string } }).error?.code).toBe(
      'BLOG_NOT_FOUND',
    )
  })
})
