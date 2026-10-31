import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../src/db/store.js'
import { createApiRouter } from '../src/api/index.js'
import { createRenderer, type MutationRenderer } from '../src/rendering/generator.js'
import { createMcpServer } from '../src/mcp/server.js'
import { SignupOutput } from '../src/mcp/output-schemas.js'
import { listPosts } from '../src/posts.js'
import type { InvitePolicy } from '../src/signup.js'
import { callTool } from './mcp/helpers.js'

type Res = Record<string, unknown> & {
  blog_id: string
  api_key: string
  post?: { slug: string; status: string }
  post_url?: string
  preview_url?: string
  post_error?: { code: string }
  invite?: { applied: boolean; note?: string }
  error?: { code: string }
}

describe('signup extras: first post and invite codes', () => {
  let dir: string
  let store: Store
  let renderer: MutationRenderer

  const invites = (): InvitePolicy & { redeemed: string[] } => {
    const redeemed: string[] = []
    return {
      redeemed,
      check: (code) =>
        code === 'VIP-1' ? { ok: true } : { ok: false, reason: 'Unknown or used invite code' },
      redeem: (code, blog) => {
        redeemed.push(`${code}:${blog.id}`)
        return { note: 'Pro for 12 months' }
      },
    }
  }

  const config = (extra: Record<string, unknown> = {}) => ({
    store,
    rendererFor: () => renderer,
    baseUrl: 'https://api.example',
    previewUrlFor: () => 'https://b.example/preview/x',
    ...extra,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-signup-extras-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.example/' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const signup = async (body: unknown, extra: Record<string, unknown> = {}) => {
    const res = await createApiRouter(config(extra)).request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Res }
  }

  describe('first post', () => {
    it('creates the blog and publishes the post in one request', async () => {
      const { status, body } = await signup({
        name: 'one-call',
        post: { title: 'Hello world', body: 'Our first post.' },
      })
      expect(status).toBe(200)
      expect(body.api_key).toMatch(/^sk_slop_/)
      expect(body.post).toMatchObject({ slug: 'hello-world', status: 'published' })
      expect(body.post_url).toBe('https://b.example/hello-world/')
      expect(existsSync(join(dir, 'out', body.blog_id, 'hello-world', 'index.html'))).toBe(true)
    })

    it('saves a draft first post with its preview link', async () => {
      const { body } = await signup({
        post: { title: 'Draft one', body: 'b', status: 'draft' },
      })
      expect(body.post?.status).toBe('draft')
      expect(body.post_url).toBeUndefined()
      expect(body.preview_url).toBe('https://b.example/preview/x')
    })

    it('keeps the blog and key when the post fails, and says why', async () => {
      const { status, body } = await signup({
        post: { title: 'Price', body: 'Now {{fact:price}}' },
      })
      expect(status).toBe(200)
      expect(body.api_key).toMatch(/^sk_slop_/)
      expect(body.post).toBeUndefined()
      expect(body.post_error?.code).toBe('FACT_NOT_FOUND')
      expect(listPosts(store, body.blog_id)).toHaveLength(0)
    })

    it('rejects an invalid post at the schema, before anything is created', async () => {
      const { status } = await signup({ name: 'bad-post', post: { title: 'No body' } })
      expect(status).toBe(400)
      const count = store.db.prepare('SELECT COUNT(*) AS n FROM blogs').get() as { n: number }
      expect(count.n).toBe(0)
    })
  })

  describe('invite codes', () => {
    it('redeems a valid code after the blog exists and reports the note', async () => {
      const policy = invites()
      const { status, body } = await signup({ name: 'vip', invite: 'VIP-1' }, { invites: policy })
      expect(status).toBe(200)
      expect(body.invite).toEqual({ applied: true, note: 'Pro for 12 months' })
      expect(policy.redeemed).toEqual([`VIP-1:${body.blog_id}`])
    })

    it('rejects an unknown code before creating anything', async () => {
      const { status, body } = await signup(
        { name: 'typo', invite: 'VIP-2' },
        { invites: invites() },
      )
      expect(status).toBe(400)
      expect(body.error?.code).toBe('INVITE_INVALID')
      const count = store.db.prepare('SELECT COUNT(*) AS n FROM blogs').get() as { n: number }
      expect(count.n).toBe(0)
    })

    it('rejects any code on a host without invites', async () => {
      const { status, body } = await signup({ invite: 'VIP-1' })
      expect(status).toBe(400)
      expect(body.error?.code).toBe('INVITE_INVALID')
    })

    it('keeps the signup when redeeming fails', async () => {
      const policy: InvitePolicy = {
        check: () => ({ ok: true }),
        redeem: () => {
          throw new Error('race: code just used')
        },
      }
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { status, body } = await signup({ invite: 'VIP-1' }, { invites: policy })
      err.mockRestore()
      expect(status).toBe(200)
      expect(body.api_key).toMatch(/^sk_slop_/)
      expect(body.invite).toEqual({ applied: false })
    })
  })

  it('MCP signup takes the same post and invite and returns the same fields', async () => {
    const server = createMcpServer({ ...config({ invites: invites() }), authMode: 'api_key' })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' }, {})
    await client.connect(clientT)
    try {
      const res = await callTool(client, 'signup', {
        name: 'mcp-one',
        invite: 'VIP-1',
        post: { title: 'From MCP', body: 'Hello.' },
      })
      expect(res.isError).toBeFalsy()
      const out = SignupOutput.parse(res.structuredContent) as Res
      expect(out.post_url).toBe('https://b.example/from-mcp/')
      expect(out.invite).toEqual({ applied: true, note: 'Pro for 12 months' })
    } finally {
      await client.close()
    }
  })
})
