import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'

/**
 * Regression tests for three PR-review findings on feat/rest-routes-mcp:
 *   P1 — mounted-router breaks auth scoping
 *   P1 — /signup idempotency replays API keys to other callers
 *   P2 — malformed JSON silently parsed as empty object
 */
describe('review fixes', () => {
  let dir: string
  let store: Store
  let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-review-fixes-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://blog.example',
    })
    app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // ------------------------------------------------------------------
  // P1 — Mounted router: consumers should be able to mount createApiRouter
  // under a path prefix (app.route('/api', createApiRouter(...))) per the
  // "factories, not servers" contract in ARCHITECTURE.md.
  // ------------------------------------------------------------------

  describe('P1 mounted router', () => {
    it('GET /api/health works (public route, no auth)', async () => {
      const outer = new Hono()
      outer.route('/api', app)
      const res = await outer.request('/api/health')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    })

    it('POST /api/signup works (public route, no auth required)', async () => {
      const outer = new Hono()
      outer.route('/api', app)
      const res = await outer.request('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'my-blog' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { blog_id: string; api_key: string }
      expect(body.blog_id).toBeTruthy()
      expect(body.api_key).toMatch(/^sk_slop_/)
    })

    it('cross-blog guard still fires under a mount prefix', async () => {
      const alpha = createBlog(store, { name: 'alpha' }).blog
      const beta = createBlog(store, { name: 'beta' }).blog
      const keyA = createApiKey(store, alpha.id).apiKey

      const outer = new Hono()
      outer.route('/api', app)

      const res = await outer.request(`/api/blogs/${beta.id}`, {
        headers: { Authorization: `Bearer ${keyA}` },
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('BLOG_NOT_FOUND')
    })
  })

  // ------------------------------------------------------------------
  // P1 — /signup idempotency must NOT replay the original response
  // (which contains api_key) to a second caller sharing the same key.
  // Without a pre-auth caller identity, idempotency is unsafe here.
  // ------------------------------------------------------------------

  describe('P1 signup idempotency leak', () => {
    it('second caller with same Idempotency-Key + payload gets a fresh signup, not the original api_key', async () => {
      // First caller
      const res1 = await app.request('/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'attacker-reused-key',
        },
        body: JSON.stringify({ name: 'alpha' }),
      })
      expect(res1.status).toBe(200)
      const body1 = (await res1.json()) as { blog_id: string; api_key: string }

      // Second caller — different human, same key + payload (the exact leak scenario)
      const res2 = await app.request('/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'attacker-reused-key',
        },
        body: JSON.stringify({ name: 'alpha' }),
      })
      // We expect either:
      //   - a distinct fresh signup (different api_key), OR
      //   - a clean conflict (409) from createBlog's BLOG_NAME_CONFLICT
      // What must NOT happen: replay body1 verbatim (leaking its api_key).
      const text2 = await res2.text()
      expect(text2).not.toContain(body1.api_key)
    })
  })

  // ------------------------------------------------------------------
  // P2 — Malformed JSON must not be silently converted to {}.
  // Currently POST /signup and PATCH swallow parse errors; that turns
  // garbage input into a successful no-op/unnamed-blog creation.
  // ------------------------------------------------------------------

  describe('P2 malformed JSON → 400', () => {
    it('POST /signup with malformed JSON returns 400', async () => {
      const res = await app.request('/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      })
      expect(res.status).toBe(400)
    })

    it('POST /blogs/:id/posts with malformed JSON returns 400 (not 500)', async () => {
      const { blog } = createBlog(store, { name: 'alpha' })
      const { apiKey } = createApiKey(store, blog.id)
      const res = await app.request(`/blogs/${blog.id}/posts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: '{not valid json',
      })
      expect(res.status).toBe(400)
    })

    it('PATCH /blogs/:id/posts/:slug with malformed JSON returns 400', async () => {
      const { blog } = createBlog(store, { name: 'alpha' })
      const { apiKey } = createApiKey(store, blog.id)
      // Seed a post first
      const create = await app.request(`/blogs/${blog.id}/posts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Hello', body: 'hi' }),
      })
      const { post } = (await create.json()) as { post: { slug: string } }

      const res = await app.request(`/blogs/${blog.id}/posts/${post.slug}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: '{not valid json',
      })
      expect(res.status).toBe(400)
    })

    it('POST /signup with empty body still succeeds (empty body = {} is legitimate)', async () => {
      // Preserve the legitimate case: no body → unnamed blog, theme defaults.
      const res = await app.request('/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(200)
    })

    it('PATCH with empty body still succeeds (no-op patch is legitimate per spec)', async () => {
      const { blog } = createBlog(store, { name: 'alpha' })
      const { apiKey } = createApiKey(store, blog.id)
      const create = await app.request(`/blogs/${blog.id}/posts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Hello', body: 'hi' }),
      })
      const { post } = (await create.json()) as { post: { slug: string } }

      const res = await app.request(`/blogs/${blog.id}/posts/${post.slug}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      expect(res.status).toBe(200)
    })
  })
})
