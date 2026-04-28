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

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('MCP media tools', () => {
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
      baseUrl: 'https://b.example/',
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
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-media-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    await boot()
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('upload_media accepts base64 + content_type and returns a public URL', async () => {
    const result = await callTool(client, 'upload_media', {
      blog_id: blogId,
      filename: 'photo.png',
      content_type: 'image/png',
      data_base64: PNG_BYTES.toString('base64'),
    })
    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as { media: { id: string; url: string } }
    expect(sc.media.url).toMatch(/^https?:\/\/.+\/_media\/.+\.png$/)
  })

  it('upload_media rejects malformed base64 with SDK-shaped validation error', async () => {
    const result = await callTool(client, 'upload_media', {
      blog_id: blogId,
      filename: 'photo.png',
      content_type: 'image/png',
      data_base64: 'not!!!base64@@@',
    })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/Input validation error/i)
  })

  it('list_media returns uploaded items', async () => {
    await callTool(client, 'upload_media', {
      blog_id: blogId,
      filename: 'a.png',
      content_type: 'image/png',
      data_base64: PNG_BYTES.toString('base64'),
    })
    const result = await callTool(client, 'list_media', { blog_id: blogId })
    const sc = result.structuredContent as { media: unknown[] }
    expect(sc.media).toHaveLength(1)
  })

  it('delete_media removes the item', async () => {
    const u = await callTool(client, 'upload_media', {
      blog_id: blogId,
      filename: 'a.png',
      content_type: 'image/png',
      data_base64: PNG_BYTES.toString('base64'),
    })
    const upload = u.structuredContent as { media: { id: string } }
    const d = await callTool(client, 'delete_media', { blog_id: blogId, media_id: upload.media.id })
    const sc = d.structuredContent as { deleted: true }
    expect(sc.deleted).toBe(true)
  })
})
