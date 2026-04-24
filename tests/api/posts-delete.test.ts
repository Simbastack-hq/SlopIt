import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'
import { createPost } from '../../src/posts.js'

describe('DELETE /blogs/:id/posts/:slug', () => {
  let dir: string
  let store: Store
  let apiKey: string
  let blogId: string
  let slug: string
  let outDir: string
  let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-post-delete-'))
    outDir = join(dir, 'out')
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({ store, outputDir: outDir, baseUrl: 'https://b.example' })
    app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    const post = createPost(store, renderer, blogId, { title: 'T', body: 'b' }).post
    slug = post.slug
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes the post + files and returns { deleted: true, _links }', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/${slug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deleted: boolean; _links: Record<string, string> }
    expect(body.deleted).toBe(true)
    expect(body._links.view).toBe('https://b.example')
    expect(existsSync(join(outDir, blogId, slug))).toBe(false)
  })

  it('404 POST_NOT_FOUND for unknown slug', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/ghost`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(404)
  })

  it('Idempotency-Key replays', async () => {
    const headers = { Authorization: `Bearer ${apiKey}`, 'Idempotency-Key': 'del-k1' }
    const r1 = await app.request(`/blogs/${blogId}/posts/${slug}`, { method: 'DELETE', headers })
    const r2 = await app.request(`/blogs/${blogId}/posts/${slug}`, { method: 'DELETE', headers })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(await r1.json()).toEqual(await r2.json())
  })
})
