import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'
import { createPost } from '../../src/posts.js'

describe('PATCH /blogs/:id/posts/:slug', () => {
  let dir: string
  let store: Store
  let apiKey: string
  let blogId: string
  let slug: string
  let outDir: string
  let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-post-update-'))
    outDir = join(dir, 'out')
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({ store, outputDir: outDir, baseUrl: 'https://b.example' })
    app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    const post = createPost(store, renderer, blogId, { title: 'Orig', body: 'b' }).post
    slug = post.slug
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('patches title; returns updated post + post_url + _links', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/${slug}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Edited' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      post: { title: string }
      post_url?: string
      _links: Record<string, string>
    }
    expect(body.post.title).toBe('Edited')
    expect(body.post_url).toMatch(/^https:\/\/b\.example\/.+\/$/)
  })

  it('published → draft: removes post files', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/${slug}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'draft' }),
    })
    expect(res.status).toBe(200)
    expect(existsSync(join(outDir, blogId, slug))).toBe(false)
  })

  it('rejects slug in the patch with 400', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/${slug}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'renamed' }),
    })
    expect(res.status).toBe(400)
  })

  it('404 POST_NOT_FOUND for unknown slug', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/ghost`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)
  })
})
