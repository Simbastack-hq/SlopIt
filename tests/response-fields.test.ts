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
import type { Blog } from '../src/schema/index.js'
import { attachAuth, callTool } from './mcp/helpers.js'

// A stand-in for the platform's plan fields. Core only passes them through.
const responseFieldsFor = (blog: Blog) => ({
  plan: 'free',
  upgrade_url: `https://pay.example/?ref=${blog.id}`,
})

describe('responseFieldsFor (host hook)', () => {
  let dir: string
  let store: Store
  let apiKey: string
  let blogId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-respfields-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const blog = createBlog(store, { name: 'rf' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const config = (withHook: boolean) => {
    const r = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.example/' })
    return {
      store,
      rendererFor: () => r,
      baseUrl: 'https://api.example',
      ...(withHook ? { responseFieldsFor } : {}),
    }
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

  describe('REST', () => {
    it('signup, create post and patch post carry the host fields for that blog', async () => {
      const app = createApiRouter(config(true))

      const signup = (await (
        await app.request('/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).json()) as { blog_id: string; plan?: string; upgrade_url?: string }
      expect(signup.plan).toBe('free')
      expect(signup.upgrade_url).toBe(`https://pay.example/?ref=${signup.blog_id}`)

      const created = (await (
        await send(app, 'POST', `/blogs/${blogId}/posts`, { title: 'T', body: 'b', slug: 'p1' })
      ).json()) as Record<string, unknown>
      expect(created.plan).toBe('free')
      expect(created.upgrade_url).toBe(`https://pay.example/?ref=${blogId}`)
      expect(created.post_url).toBe('https://b.example/p1/')

      const patched = (await (
        await send(app, 'PATCH', `/blogs/${blogId}/posts/p1`, { title: 'T2' })
      ).json()) as Record<string, unknown>
      expect(patched.plan).toBe('free')
      expect(patched.upgrade_url).toBe(`https://pay.example/?ref=${blogId}`)
    })

    it('reads are unchanged: GET post and GET blog carry no host fields', async () => {
      const app = createApiRouter(config(true))
      await send(app, 'POST', `/blogs/${blogId}/posts`, { title: 'T', body: 'b', slug: 'p1' })
      const got = (await (await send(app, 'GET', `/blogs/${blogId}/posts/p1`)).json()) as Record<
        string,
        unknown
      >
      expect('plan' in got).toBe(false)
      const blog = (await (await send(app, 'GET', `/blogs/${blogId}`)).json()) as Record<
        string,
        unknown
      >
      expect('plan' in blog).toBe(false)
    })

    it('no hook, no host fields (self-hosted default)', async () => {
      const app = createApiRouter(config(false))
      const created = (await (
        await send(app, 'POST', `/blogs/${blogId}/posts`, { title: 'T', body: 'b' })
      ).json()) as Record<string, unknown>
      expect('plan' in created).toBe(false)
      expect('upgrade_url' in created).toBe(false)
    })
  })

  describe('MCP', () => {
    it('tool results never carry the host fields, even with the same config object', async () => {
      // The platform builds REST and MCP from one config, so the hook
      // reaches createMcpServer too. MCP must ignore it.
      const server = createMcpServer(config(true))
      const [clientT, serverT] = InMemoryTransport.createLinkedPair()
      await server.connect(serverT)
      const client = new Client({ name: 'test', version: '0' }, {})
      attachAuth(clientT, apiKey)
      await client.connect(clientT)
      try {
        const created = await callTool(client, 'create_post', { title: 'T', body: 'b', slug: 'm1' })
        expect(created.isError).toBeFalsy()
        const c = created.structuredContent as Record<string, unknown>
        expect('plan' in c).toBe(false)
        expect('upgrade_url' in c).toBe(false)
        expect(JSON.stringify(created.content)).not.toContain('upgrade_url')

        const updated = await callTool(client, 'update_post', {
          slug: 'm1',
          patch: { title: 'T2' },
        })
        expect('plan' in (updated.structuredContent as Record<string, unknown>)).toBe(false)
      } finally {
        await client.close()
        await server.close()
      }
    })
  })
})
