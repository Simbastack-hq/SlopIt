import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'
import { createPost } from '../../src/posts.js'

describe('GET /blogs/:id/posts and /:slug', () => {
  let dir: string
  let store: Store
  let apiKey: string
  let blogId: string
  let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-posts-read-'))
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
    createPost(store, renderer, blogId, { title: 'P1', body: 'b' })
    createPost(store, renderer, blogId, { title: 'D1', body: 'b', slug: 'd1', status: 'draft' })
    createPost(store, renderer, blogId, { title: 'P2', body: 'b', slug: 'p2' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('list: default returns published only', async () => {
    const res = await app.request(`/blogs/${blogId}/posts`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const body = (await res.json()) as { posts: { slug: string; status: string }[] }
    expect(body.posts.every((p) => p.status === 'published')).toBe(true)
    expect(body.posts.map((p) => p.slug)).toEqual(['p2', 'p1'])
  })

  it('list: ?status=draft returns drafts', async () => {
    const res = await app.request(`/blogs/${blogId}/posts?status=draft`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const body = (await res.json()) as { posts: { slug: string }[] }
    expect(body.posts.map((p) => p.slug)).toEqual(['d1'])
  })

  it('list: invalid ?status → 400', async () => {
    const res = await app.request(`/blogs/${blogId}/posts?status=scheduled`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(400)
  })

  it('single: returns the post + _links', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/p2`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { post: { slug: string }; _links: Record<string, string> }
    expect(body.post.slug).toBe('p2')
    expect(body._links.publish).toBe(`https://api.example/blogs/${blogId}/posts`)
  })

  it('single: POST_NOT_FOUND for unknown slug', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/ghost`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('POST_NOT_FOUND')
  })
})
