import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../src/db/store.js'
import { createApiRouter } from '../src/api/index.js'
import { createRenderer } from '../src/rendering/generator.js'
import { createApiKey, createBlog } from '../src/blogs.js'
import { createMcpServer } from '../src/mcp/server.js'
import { generateSkillFile } from '../src/skill.js'
import type { PreviewUrlFor } from '../src/preview.js'
import { attachAuth, callTool } from './mcp/helpers.js'

// A stand-in for the host's signed link. Core only passes it through.
const previewUrlFor: PreviewUrlFor = (blog, post) =>
  `https://b.example/${post.slug}/?preview=tok-${blog.id}-${post.id}`

describe('draft preview_url (host hook)', () => {
  let dir: string
  let store: Store
  let apiKey: string
  let blogId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-preview-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const renderer = () =>
    createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.example/' })

  describe('REST', () => {
    const router = (withHook: boolean) => {
      const r = renderer()
      return createApiRouter({
        store,
        rendererFor: () => r,
        baseUrl: 'https://api.example',
        ...(withHook ? { previewUrlFor } : {}),
      })
    }
    const send = (
      app: ReturnType<typeof createApiRouter>,
      method: string,
      path: string,
      body?: unknown,
    ) =>
      app.request(path, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })

    it('create, get and patch return preview_url for a draft, and only for a draft', async () => {
      const app = router(true)
      const created = (await (
        await send(app, 'POST', `/blogs/${blogId}/posts`, {
          title: 'Draft',
          body: 'b',
          slug: 'd1',
          status: 'draft',
        })
      ).json()) as { post: { id: string }; preview_url?: string; post_url?: string }
      expect(created.post_url).toBeUndefined()
      expect(created.preview_url).toBe(
        `https://b.example/d1/?preview=tok-${blogId}-${created.post.id}`,
      )

      const got = (await (await send(app, 'GET', `/blogs/${blogId}/posts/d1`)).json()) as {
        preview_url?: string
      }
      expect(got.preview_url).toBe(created.preview_url)

      const published = (await (
        await send(app, 'PATCH', `/blogs/${blogId}/posts/d1`, { status: 'published' })
      ).json()) as { preview_url?: string; post_url?: string }
      expect(published.post_url).toBe('https://b.example/d1/')
      expect(published.preview_url).toBeUndefined()

      const live = (await (
        await send(app, 'POST', `/blogs/${blogId}/posts`, { title: 'Live', body: 'b', slug: 'p1' })
      ).json()) as { preview_url?: string }
      expect(live.preview_url).toBeUndefined()
    })

    it('no hook, no preview_url (self-hosted default)', async () => {
      const app = router(false)
      const created = (await (
        await send(app, 'POST', `/blogs/${blogId}/posts`, {
          title: 'Draft',
          body: 'b',
          status: 'draft',
        })
      ).json()) as Record<string, unknown>
      expect('preview_url' in created).toBe(false)
    })
  })

  describe('MCP', () => {
    let client: Client
    let closer: () => Promise<void>

    beforeEach(async () => {
      const r = renderer()
      const server = createMcpServer({
        store,
        rendererFor: () => r,
        baseUrl: 'https://api.example',
        previewUrlFor,
      })
      const [clientT, serverT] = InMemoryTransport.createLinkedPair()
      await server.connect(serverT)
      client = new Client({ name: 'test', version: '0' }, {})
      attachAuth(clientT, apiKey)
      await client.connect(clientT)
      closer = async () => {
        await client.close()
        await server.close()
      }
    })

    afterEach(async () => {
      await closer?.()
    })

    it('create_post and get_post return preview_url for a draft; update to published drops it', async () => {
      const created = await callTool(client, 'create_post', {
        title: 'Draft',
        body: 'b',
        slug: 'd1',
        status: 'draft',
      })
      expect(created.isError).toBeFalsy()
      const c = created.structuredContent as { post: { id: string }; preview_url?: string }
      expect(c.preview_url).toBe(`https://b.example/d1/?preview=tok-${blogId}-${c.post.id}`)

      const got = await callTool(client, 'get_post', { slug: 'd1' })
      expect((got.structuredContent as { preview_url?: string }).preview_url).toBe(c.preview_url)

      const updated = await callTool(client, 'update_post', {
        slug: 'd1',
        patch: { status: 'published' },
      })
      const u = updated.structuredContent as { preview_url?: string; post_url?: string }
      expect(u.post_url).toBe('https://b.example/d1/')
      expect(u.preview_url).toBeUndefined()
    })
  })

  describe('SKILL.md', () => {
    it('documents preview_url only when the host has previews', () => {
      expect(generateSkillFile({ baseUrl: 'https://api.example' })).not.toContain('preview_url')
      const withPreviews = generateSkillFile({
        baseUrl: 'https://api.example',
        draftPreviews: true,
      })
      expect(withPreviews).toContain('**Draft previews.**')
      expect(withPreviews).toContain('`preview_url`')
    })
  })
})
