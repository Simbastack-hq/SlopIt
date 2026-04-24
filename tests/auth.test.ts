import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog, createApiKey } from '../src/blogs.js'
import { verifyApiKey } from '../src/auth/api-key.js'
import { Hono } from 'hono'
import { authMiddleware } from '../src/api/auth.js'
import { createRenderer } from '../src/rendering/generator.js'
import { errorMiddleware } from '../src/api/errors.js'

describe('verifyApiKey', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-verifykey-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the blog for a valid key', () => {
    const { blog } = createBlog(store, { name: 'authblog' })
    const { apiKey } = createApiKey(store, blog.id)
    const result = verifyApiKey(store, apiKey)
    expect(result?.id).toBe(blog.id)
    expect(result?.name).toBe('authblog')
  })

  it('returns null for an unknown key', () => {
    expect(verifyApiKey(store, 'sk_slop_doesnotexist')).toBeNull()
  })

  it('returns null for a malformed key', () => {
    expect(verifyApiKey(store, 'not-a-key')).toBeNull()
    expect(verifyApiKey(store, '')).toBeNull()
  })

  it('returns null for a key hash that exists but is for a deleted blog', () => {
    // FK ON DELETE CASCADE handles the row removal; this test just guards
    // against a regression where verifyApiKey returns a dangling blog.
    const { blog } = createBlog(store, { name: 'tmpblog' })
    const { apiKey } = createApiKey(store, blog.id)
    store.db.prepare('DELETE FROM blogs WHERE id = ?').run(blog.id)
    expect(verifyApiKey(store, apiKey)).toBeNull()
  })
})

describe('authMiddleware', () => {
  let dir: string
  let store: Store

  const makeApp = (authMode: 'api_key' | 'none') => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const config = { store, rendererFor: () => renderer, baseUrl: 'https://api.example', authMode }
    const app = new Hono<{
      Variables: { blog: import('../src/schema/index.js').Blog; apiKeyHash: string }
    }>()
    app.onError(errorMiddleware)
    app.use('*', authMiddleware(config))
    app.get('/blogs/:id', (c) => c.json({ blogId: c.var.blog.id, hash: c.var.apiKeyHash }))
    app.get('/signup', (c) => c.json({ ok: true })) // in skip list
    app.get('/health', (c) => c.json({ ok: true })) // in skip list
    return app
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-auth-mw-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('api_key mode: missing Authorization → 401 UNAUTHORIZED', async () => {
    const app = makeApp('api_key')
    const { blog } = createBlog(store, { name: 'bb' })
    const res = await app.request(`/blogs/${blog.id}`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('api_key mode: malformed Authorization → 401', async () => {
    const app = makeApp('api_key')
    const { blog } = createBlog(store, { name: 'bb' })
    const res = await app.request(`/blogs/${blog.id}`, {
      headers: { Authorization: 'NotBearer x' },
    })
    expect(res.status).toBe(401)
  })

  it('api_key mode: unknown key → 401', async () => {
    const app = makeApp('api_key')
    const { blog } = createBlog(store, { name: 'bb' })
    const res = await app.request(`/blogs/${blog.id}`, {
      headers: { Authorization: 'Bearer sk_slop_doesnotexist' },
    })
    expect(res.status).toBe(401)
  })

  it('api_key mode: valid key → attaches blog + hash', async () => {
    const app = makeApp('api_key')
    const { blog } = createBlog(store, { name: 'bb' })
    const { apiKey } = createApiKey(store, blog.id)
    const res = await app.request(`/blogs/${blog.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { blogId: string; hash: string }
    expect(body.blogId).toBe(blog.id)
    expect(body.hash.length).toBeGreaterThan(0)
  })

  it('cross-blog access: :id mismatches resolved blog → 404 BLOG_NOT_FOUND (leak-free)', async () => {
    const app = makeApp('api_key')
    const { blog: b1 } = createBlog(store, { name: 'b1' })
    const { blog: b2 } = createBlog(store, { name: 'b2' })
    const { apiKey } = createApiKey(store, b1.id)
    // Request b2 with b1's key — must 404, not 401 or 403
    const res = await app.request(`/blogs/${b2.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('BLOG_NOT_FOUND')

    // Sanity: the same response shape as a genuinely-unknown id
    const res2 = await app.request(`/blogs/nonexistent`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res2.status).toBe(404)
    const body2 = (await res2.json()) as { error: { code: string } }
    expect(body2.error.code).toBe('BLOG_NOT_FOUND')
  })

  it('skip list: /health passes without auth', async () => {
    const app = makeApp('api_key')
    const res = await app.request('/health')
    expect(res.status).toBe(200)
  })

  it('skip list: /signup passes without auth', async () => {
    const app = makeApp('api_key')
    const res = await app.request('/signup')
    expect(res.status).toBe(200)
  })

  it("authMode 'none': resolves blog from :id without a key", async () => {
    const app = makeApp('none')
    const { blog } = createBlog(store, { name: 'bb' })
    const res = await app.request(`/blogs/${blog.id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { blogId: string; hash: string }
    expect(body.blogId).toBe(blog.id)
    expect(body.hash).toBe('')
  })

  it("authMode 'none': unknown :id → 404 BLOG_NOT_FOUND", async () => {
    const app = makeApp('none')
    const res = await app.request(`/blogs/ghost`)
    expect(res.status).toBe(404)
  })
})
