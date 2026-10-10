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

// Connector clients (ChatGPT, Claude.ai) hold a key but never saw the
// signup response, so they have no blog_id. Every bearer tool must work
// without one and fall back to the key's blog — while a blog_id that is
// passed is still guarded against the key.

describe('MCP tools without blog_id (key is the identity)', () => {
  let dir: string
  let store: Store
  let blogId: string
  let apiKey: string
  let closers: Array<() => Promise<void>>

  const connect = async (opts: { authMode?: 'api_key' | 'none'; token?: string }) => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      ...(opts.authMode !== undefined ? { authMode: opts.authMode } : {}),
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' }, {})
    if (opts.token !== undefined) attachAuth(clientT, opts.token)
    await client.connect(clientT)
    closers.push(async () => {
      await client.close()
      await server.close()
    })
    return client
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-connector-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    blogId = createBlog(store, { name: 'conn' }).blog.id
    apiKey = createApiKey(store, blogId).apiKey
    closers = []
  })

  afterEach(async () => {
    for (const close of closers) await close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('get_blog with no arguments returns the blog the key belongs to', async () => {
    const client = await connect({ token: apiKey })
    const result = await callTool(client, 'get_blog', {})
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as { blog: { id: string } }).blog.id).toBe(blogId)
  })

  it('create_post with no blog_id publishes to the key’s blog', async () => {
    const client = await connect({ token: apiKey })
    const created = await callTool(client, 'create_post', { title: 'Hello', body: 'Hi.' })
    expect(created.isError).toBeFalsy()

    const listed = await callTool(client, 'list_posts', {})
    const posts = (listed.structuredContent as { posts: Array<{ slug: string }> }).posts
    expect(posts.map((p) => p.slug)).toEqual(['hello'])
  })

  it('a blog_id that is not the key’s blog is still rejected', async () => {
    const other = createBlog(store, { name: 'other' }).blog.id
    const client = await connect({ token: apiKey })
    const result = await callTool(client, 'list_posts', { blog_id: other })
    expect(result.isError).toBe(true)
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe(
      'BLOG_NOT_FOUND',
    )
  })

  it('without a key, omitting blog_id is still UNAUTHORIZED', async () => {
    const client = await connect({})
    const result = await callTool(client, 'get_blog', {})
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe(
      'UNAUTHORIZED',
    )
  })

  it("authMode 'none' still requires blog_id (there is no key to fall back on)", async () => {
    const client = await connect({ authMode: 'none' })
    const missing = await callTool(client, 'get_blog', {})
    expect((missing.structuredContent as { error: { code: string } }).error.code).toBe(
      'BLOG_NOT_FOUND',
    )
    const given = await callTool(client, 'get_blog', { blog_id: blogId })
    expect(given.isError).toBeFalsy()
  })
})

// Claude's Connectors Directory requires a title and readOnlyHint or
// destructiveHint on every tool; ChatGPT's app review wants all three
// hints explicit. Asserts the classification, not just presence: a read
// tool marked writable (or a delete marked safe) is the bug reviewers
// reject.
describe('MCP tool annotations', () => {
  const READ_ONLY = ['get_blog', 'get_post', 'list_posts', 'list_media', 'report_bug']
  const DESTRUCTIVE = ['update_post', 'delete_post', 'update_blog', 'delete_media']
  const OPEN_WORLD = [
    'signup',
    'create_post',
    'update_post',
    'delete_post',
    'update_blog',
    'upload_media',
    'delete_media',
  ]

  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-annotations-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('every tool has a title and explicit read-only / destructive / open-world hints', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.x' })
    const server = createMcpServer({ store, rendererFor: () => renderer, baseUrl: 'https://a.x' })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' }, {})
    await client.connect(clientT)

    const { tools } = await client.listTools()
    expect(tools).toHaveLength(12)
    for (const tool of tools) {
      expect(tool.title, tool.name).toMatch(/\S/)
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: READ_ONLY.includes(tool.name),
        destructiveHint: DESTRUCTIVE.includes(tool.name),
        openWorldHint: OPEN_WORLD.includes(tool.name),
      })
    }

    await client.close()
    await server.close()
  })
})
