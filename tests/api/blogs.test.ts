import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'

describe('GET /blogs/:id', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-blogs-get-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the blog + _links when authenticated', async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b1.example',
    })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const { blog } = createBlog(store, { name: 'b1' })
    const { apiKey } = createApiKey(store, blog.id)
    const res = await app.request(`/blogs/${blog.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      blog: { id: string; name: string }
      _links: Record<string, string>
    }
    expect(body.blog.id).toBe(blog.id)
    expect(body.blog.name).toBe('b1')
    expect(body._links.view).toBe('https://b1.example/')
  })

  it('401 without a key', async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b1.example',
    })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const { blog } = createBlog(store, { name: 'b1' })
    const res = await app.request(`/blogs/${blog.id}`)
    expect(res.status).toBe(401)
  })
})

describe('PATCH /blogs/:id', () => {
  let dir: string
  let store: Store
  let app: ReturnType<typeof createApiRouter>
  let blogId: string
  let apiKey: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-blogs-patch-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b1.example',
    })
    app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const { blog } = createBlog(store, { name: 'apit' })
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('200 — sets analytics on the blog', async () => {
    const res = await app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analytics: { umami: { scriptUrl: 'https://u/s.js', siteId: 's' } },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      blog: { analytics?: { umami?: { siteId: string } } }
      _links: Record<string, string>
    }
    expect(body.blog.analytics?.umami?.siteId).toBe('s')
    expect(body._links.view).toBe('https://b1.example')
  })

  it('200 — clears analytics with explicit null', async () => {
    // First set
    await app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analytics: { plausible: { scriptUrl: 'https://p/s.js', domain: 'd' } },
      }),
    })
    // Then clear
    const res = await app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ analytics: null }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { blog: { analytics?: unknown } }
    expect(body.blog.analytics).toBeUndefined()
  })

  it('200 — empty body is a no-op (200, blog returned unchanged)', async () => {
    const res = await app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: '',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { blog: { id: string } }
    expect(body.blog.id).toBe(blogId)
  })

  it('401 — no Authorization header', async () => {
    const res = await app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analytics: null }),
    })
    expect(res.status).toBe(401)
  })

  it('404 — wrong blog id for the API key (spec decision #18: do not leak existence)', async () => {
    const { blog: other } = createBlog(store, { name: 'other' })
    const res = await app.request(`/blogs/${other.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ analytics: null }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('BLOG_NOT_FOUND')
  })

  it('400 — unknown field in body', async () => {
    const res = await app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'minimal' }),
    })
    expect(res.status).toBe(400)
  })
})
