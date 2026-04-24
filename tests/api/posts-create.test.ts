import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'

describe('POST /blogs/:id/posts', () => {
  let dir: string
  let store: Store
  let apiKey: string
  let blogId: string
  let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-post-create-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('JSON body: publishes a post and returns { post, post_url, _links }', async () => {
    const res = await app.request(`/blogs/${blogId}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hello', body: '# Hi\n\nBody.' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      post: { title: string }
      post_url?: string
      _links: Record<string, string>
    }
    expect(body.post.title).toBe('Hello')
    expect(body.post_url).toMatch(/^https:\/\/b\.example\/.+\/$/)
    expect(body._links.view).toBe('https://b.example')
  })

  it('text/markdown body: raw body + query params → post', async () => {
    const res = await app.request(`/blogs/${blogId}/posts?title=From%20Markdown&tags=a,b`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'text/markdown' },
      body: '# From MD\n\nBody.',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { post: { title: string; body: string; tags: string[] } }
    expect(body.post.title).toBe('From Markdown')
    expect(body.post.body).toBe('# From MD\n\nBody.')
    expect(body.post.tags).toEqual(['a', 'b'])
  })

  it('409 POST_SLUG_CONFLICT on duplicate slug', async () => {
    await app.request(`/blogs/${blogId}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T', body: 'b', slug: 'same' }),
    })
    const res = await app.request(`/blogs/${blogId}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T2', body: 'b2', slug: 'same' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: { slug: string } } }
    expect(body.error.code).toBe('POST_SLUG_CONFLICT')
    expect(body.error.details.slug).toBe('same')
  })

  it('draft: returns { post } without post_url; no files written', async () => {
    const res = await app.request(`/blogs/${blogId}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'D', body: 'b', status: 'draft' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { post: { status: string }; post_url?: string }
    expect(body.post.status).toBe('draft')
    expect(body.post_url).toBeUndefined()
  })
})
