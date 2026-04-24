import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer, type MutationRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'
import type { Blog } from '../../src/schema/index.js'

describe('rendererFor(blog): no cross-blog URL leakage', () => {
  let dir: string
  let store: Store
  let renderers: Map<string, MutationRenderer>
  let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-multi-blog-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderers = new Map()
    app = createApiRouter({
      store,
      baseUrl: 'https://api.example',
      rendererFor: (blog: Blog) => {
        const cached = renderers.get(blog.id)
        if (cached) return cached
        // NOTE: createRenderer nests output under {outputDir}/{blogId}/
        // internally — pass the shared parent here, not a per-blog subdir.
        // Per-blog differentiation is baseUrl, not outputDir.
        const outDir = join(dir, 'out')
        const url = blog.name === 'alpha' ? 'https://alpha.example' : 'https://beta.example'
        const r = createRenderer({ store, outputDir: outDir, baseUrl: url })
        renderers.set(blog.id, r)
        return r
      },
    })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('two blogs, two distinct renderers: post_url, _links.view, and rendered canonical URLs all stay correct per blog', async () => {
    const alpha = createBlog(store, { name: 'alpha' }).blog
    const beta = createBlog(store, { name: 'beta' }).blog
    const keyA = createApiKey(store, alpha.id).apiKey
    const keyB = createApiKey(store, beta.id).apiKey

    // Publish a post to each blog
    const resA = await app.request(`/blogs/${alpha.id}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alpha post', body: 'hello alpha' }),
    })
    const bodyA = (await resA.json()) as {
      post: { slug: string }
      post_url: string
      _links: Record<string, string>
    }
    expect(bodyA.post_url).toMatch(/^https:\/\/alpha\.example\//)
    expect(bodyA._links.view).toBe('https://alpha.example')

    const resB = await app.request(`/blogs/${beta.id}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Beta post', body: 'hello beta' }),
    })
    const bodyB = (await resB.json()) as {
      post: { slug: string }
      post_url: string
      _links: Record<string, string>
    }
    expect(bodyB.post_url).toMatch(/^https:\/\/beta\.example\//)
    expect(bodyB._links.view).toBe('https://beta.example')

    // Confirm rendered files: each blog's post HTML references only its own canonical URL
    const alphaPostHtml = readFileSync(
      join(dir, 'out', alpha.id, bodyA.post.slug, 'index.html'),
      'utf8',
    )
    expect(alphaPostHtml).toContain('https://alpha.example/')
    expect(alphaPostHtml).not.toContain('https://beta.example')

    const betaPostHtml = readFileSync(
      join(dir, 'out', beta.id, bodyB.post.slug, 'index.html'),
      'utf8',
    )
    expect(betaPostHtml).toContain('https://beta.example/')
    expect(betaPostHtml).not.toContain('https://alpha.example')

    // Read-side: GET /blogs/:id returns the right view URL
    const getA = await app.request(`/blogs/${alpha.id}`, {
      headers: { Authorization: `Bearer ${keyA}` },
    })
    const getABody = (await getA.json()) as { _links: Record<string, string> }
    expect(getABody._links.view).toBe('https://alpha.example')

    const getB = await app.request(`/blogs/${beta.id}`, {
      headers: { Authorization: `Bearer ${keyB}` },
    })
    const getBBody = (await getB.json()) as { _links: Record<string, string> }
    expect(getBBody._links.view).toBe('https://beta.example')
  })

  it('cross-blog access: alpha key used for beta id → 404 (no URL leaks either way)', async () => {
    const alpha = createBlog(store, { name: 'alpha' }).blog
    const beta = createBlog(store, { name: 'beta' }).blog
    const keyA = createApiKey(store, alpha.id).apiKey

    const res = await app.request(`/blogs/${beta.id}`, {
      headers: { Authorization: `Bearer ${keyA}` },
    })
    expect(res.status).toBe(404)
    // Read as text first so we can check raw content before parsing JSON
    const raw = await res.text()
    const body = JSON.parse(raw) as { error: { code: string; details: Record<string, unknown> } }
    expect(body.error.code).toBe('BLOG_NOT_FOUND')
    // Response must not contain either blog's public URL
    expect(raw).not.toContain('alpha.example')
    expect(raw).not.toContain('beta.example')
  })
})
