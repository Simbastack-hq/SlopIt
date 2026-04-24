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
    expect(body._links.view).toBe('https://b1.example')
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
