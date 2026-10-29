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
import { PostWriteOutput } from '../src/mcp/output-schemas.js'
import { generateSkillFile } from '../src/skill.js'
import { attachAuth, callTool } from './mcp/helpers.js'

type Res = Record<string, unknown> & { next_post_hint?: string }

describe('next_post_hint (post-again nudge)', () => {
  let dir: string
  let store: Store
  let apiKey: string
  let blogId: string
  let app: ReturnType<typeof createApiRouter>

  const config = () => {
    const r = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.example/' })
    return { store, rendererFor: () => r, baseUrl: 'https://api.example' }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-nextpost-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const blog = createBlog(store, { name: 'np' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    app = createApiRouter(config())
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const send = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await app.request(path, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as Res
  }
  const create = (body: Record<string, unknown>) => send('POST', `/blogs/${blogId}/posts`, body)

  describe('REST', () => {
    it('fires on the first and second post with the count and topic, then stops', async () => {
      const first = await create({ title: 'Why we built it', body: 'b', slug: 'p1' })
      expect(first.next_post_hint).toBe(
        'This blog has 1 post; blogs with 3 or more get found more often. Offer to draft the next one for your human, e.g. a follow-up on "Why we built it".',
      )
      const second = await create({ title: 'Pricing', body: 'b', slug: 'p2' })
      expect(second.next_post_hint).toContain('This blog has 2 posts;')
      expect(second.next_post_hint).toContain('a follow-up on "Pricing".')
      const third = await create({ title: 'Three', body: 'b', slug: 'p3' })
      expect('next_post_hint' in third).toBe(false)
    })

    it('is one line with no pricing', async () => {
      const r = await create({ title: 'T', body: 'b' })
      expect(r.next_post_hint).not.toContain('\n')
      expect(r.next_post_hint).not.toMatch(/\$|pro\b|upgrade|price/i)
    })

    it('a draft gets none; publishing it later does', async () => {
      const draft = await create({ title: 'D', body: 'b', slug: 'd1', status: 'draft' })
      expect('next_post_hint' in draft).toBe(false)
      const live = await send('PATCH', `/blogs/${blogId}/posts/d1`, { status: 'published' })
      expect(live.next_post_hint).toContain('This blog has 1 post;')
    })

    it('editing a live post gets none', async () => {
      await create({ title: 'T', body: 'b', slug: 'p1' })
      const edited = await send('PATCH', `/blogs/${blogId}/posts/p1`, { title: 'T2' })
      expect('next_post_hint' in edited).toBe(false)
    })

    it('a translation gets none and does not count as a new post', async () => {
      await create({ title: 'Hello', body: 'b', slug: 'hello', language: 'en' })
      const de = await create({
        title: 'Hallo',
        body: 'b',
        slug: 'hallo',
        language: 'de',
        translationOf: 'hello',
      })
      expect('next_post_hint' in de).toBe(false)
      const next = await create({ title: 'Second', body: 'b', slug: 'second' })
      expect(next.next_post_hint).toContain('This blog has 2 posts;')
    })

    it('shortens a long title', async () => {
      const r = await create({ title: 'x'.repeat(150), body: 'b' })
      const topic = /follow-up on "(.*)"\.$/.exec(r.next_post_hint!)![1]
      expect(topic.length).toBe(80)
      expect(topic.endsWith('…')).toBe(true)
    })
  })

  describe('MCP', () => {
    it('create_post carries it in structured content and passes the output schema', async () => {
      const server = createMcpServer(config())
      const [clientT, serverT] = InMemoryTransport.createLinkedPair()
      await server.connect(serverT)
      const client = new Client({ name: 'test', version: '0' }, {})
      attachAuth(clientT, apiKey)
      await client.connect(clientT)
      try {
        const created = await callTool(client, 'create_post', {
          title: 'Hi',
          body: 'b',
          slug: 'm1',
        })
        expect(created.isError).toBeFalsy()
        const c = created.structuredContent as Res
        expect(c.next_post_hint).toContain('a follow-up on "Hi".')
        expect(PostWriteOutput.safeParse(c).success).toBe(true)

        const edited = await callTool(client, 'update_post', {
          slug: 'm1',
          patch: { title: 'Hi2' },
        })
        expect('next_post_hint' in (edited.structuredContent as Res)).toBe(false)
      } finally {
        await client.close()
        await server.close()
      }
    })
  })

  it('SKILL tells agents to suggest the next post after publishing', () => {
    const text = generateSkillFile({ baseUrl: 'https://svc.example/api' })
    expect(text).toContain('## After publishing: suggest the next post')
    expect(text).toContain('offer to draft the next post')
    expect(text).toContain('`next_post_hint`')
  })
})
