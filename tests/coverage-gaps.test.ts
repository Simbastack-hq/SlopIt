/**
 * Targeted tests to close coverage gaps on modules requiring ≥95%
 * line + branch coverage: src/api/errors.ts, src/api/auth.ts,
 * src/api/routes.ts, src/auth/api-key.ts, src/posts.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog, createApiKey } from '../src/blogs.js'
import { createPost, updatePost, getPost, listPosts } from '../src/posts.js'
import { createRenderer } from '../src/rendering/generator.js'
import { createApiRouter } from '../src/api/index.js'
import { authMiddleware } from '../src/api/auth.js'
import { errorMiddleware } from '../src/api/errors.js'
import { verifyApiKey } from '../src/auth/api-key.js'

describe('coverage gaps', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-cov-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('src/api/errors.ts — generic 500 path', () => {
    it('errorMiddleware returns 500 for a non-SlopItError, non-ZodError', async () => {
      const app = new Hono()
      app.onError(errorMiddleware)
      app.get('/boom', () => {
        throw new Error('unexpected')
      })
      const res = await app.request('/boom')
      expect(res.status).toBe(500)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('INTERNAL_ERROR')
    })

    it('errorMiddleware maps SlopItError with unknown code to 500 via ?? fallback', async () => {
      const { SlopItError } = await import('../src/errors.js')
      // Bypass TypeScript by casting — this exercises the `?? 500` branch in CODE_TO_STATUS lookup

      const err = new SlopItError('UNKNOWN_CODE' as any, 'test', {})
      const app = new Hono()
      app.onError(errorMiddleware)
      app.get('/bad-code', () => {
        throw err
      })
      const res = await app.request('/bad-code')
      expect(res.status).toBe(500)
    })
  })

  describe('src/auth/api-key.ts — orphaned key catch branches', () => {
    it('verifyApiKey returns null when key hash exists but blog is deleted (BLOG_NOT_FOUND catch branch)', () => {
      // With ON DELETE CASCADE, deleting the blog removes api_keys.
      // Simulate an orphan key by disabling FK enforcement and deleting only the blog row.
      const { blog } = createBlog(store, { name: 'orphan' })
      const { apiKey } = createApiKey(store, blog.id)
      store.db.exec('PRAGMA foreign_keys = OFF')
      store.db.prepare('DELETE FROM blogs WHERE id = ?').run(blog.id)
      // Key row still exists but blog is gone → getBlogInternal throws BLOG_NOT_FOUND
      // verifyApiKey catch branch (line 41) returns null
      const result = verifyApiKey(store, apiKey)
      expect(result).toBeNull()
      store.db.exec('PRAGMA foreign_keys = ON')
    })

    it('verifyApiKey rethrows non-BLOG_NOT_FOUND errors from getBlogInternal (throw e branch)', () => {
      // Simulate by inserting an orphan api_key row pointing to a blog_id whose
      // blogs table SELECT causes an unexpected DB error. Easiest way: drop the
      // blogs table so getBlogInternal throws a generic DB error (not SlopItError).
      const { blog } = createBlog(store, { name: 'rethrow' })
      const { apiKey } = createApiKey(store, blog.id)
      store.db.exec('PRAGMA foreign_keys = OFF')
      // Rename the blogs table so getBlogInternal's SELECT throws a generic DB error
      store.db.exec('ALTER TABLE blogs RENAME TO _blogs_hidden')
      // verifyApiKey finds the key hash but getBlogInternal throws (not SlopItError)
      // so the catch rethrows on line 42
      expect(() => verifyApiKey(store, apiKey)).toThrow()
      // Restore
      store.db.exec('ALTER TABLE _blogs_hidden RENAME TO blogs')
      store.db.exec('PRAGMA foreign_keys = ON')
    })
  })

  describe('src/posts.ts — empty PATCH on draft post', () => {
    it('empty patch on draft post returns { post } with no postUrl', () => {
      const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
      const { blog } = createBlog(store, { name: 'draftblog' })
      const { post } = createPost(store, renderer, blog.id, {
        title: 'T',
        body: 'B',
        status: 'draft',
      })
      // Empty patch on a draft — the branch returns { post } without postUrl
      const result = updatePost(store, renderer, blog.id, post.slug, {})
      expect(result.post.slug).toBe(post.slug)
      expect(result.postUrl).toBeUndefined()
    })

    it('PATCH with explicit optional fields exercises "in parsed" ternary branches', () => {
      const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
      const { blog } = createBlog(store, { name: 'patchblog' })
      // Create with optional fields set
      const { post } = createPost(store, renderer, blog.id, {
        title: 'T',
        body: 'B',
        status: 'draft',
        excerpt: 'orig-excerpt',
        seoTitle: 'orig-seo',
        seoDescription: 'orig-desc',
        author: 'orig-author',
        coverImage: 'https://img.example/orig.jpg',
      })
      // Patch with explicit optional fields (exercises "in parsed" true branch on each)
      const result = updatePost(store, renderer, blog.id, post.slug, {
        excerpt: 'new-excerpt',
        seoTitle: 'new-seo',
        seoDescription: 'new-desc',
        author: 'new-author',
        coverImage: 'https://img.example/new.jpg',
      })
      expect(result.post.excerpt).toBe('new-excerpt')
      expect(result.post.seoTitle).toBe('new-seo')
      expect(result.post.author).toBe('new-author')
    })

    it('getPost and listPosts return posts with optional fields set (exercises non-null ?? branches)', () => {
      const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
      const { blog } = createBlog(store, { name: 'optblog' })
      const { post } = createPost(store, renderer, blog.id, {
        title: 'T',
        body: 'B',
        status: 'published',
        excerpt: 'ex',
        seoTitle: 'st',
        seoDescription: 'sd',
        author: 'a',
        coverImage: 'https://img.example/c.jpg',
        tags: ['foo'],
      })
      // getPost with optional fields set exercises non-null ?? undefined branches
      const fetched = getPost(store, blog.id, post.slug)
      expect(fetched.excerpt).toBe('ex')
      expect(fetched.seoTitle).toBe('st')
      expect(fetched.author).toBe('a')
      // listPosts with optional fields set
      const listed = listPosts(store, blog.id, { status: 'published' })
      expect(listed[0]?.excerpt).toBe('ex')
    })
  })

  describe('src/api/auth.ts — authMode none with no blog id path', () => {
    it("authMode 'none': route without :id passes through without setting blog", async () => {
      const app = new Hono<{
        Variables: { blog: import('../src/schema/index.js').Blog; apiKeyHash: string }
      }>()
      app.onError(errorMiddleware)
      app.use('*', authMiddleware({ store, authMode: 'none' }))
      // Use a path that is NOT in SKIP_PATHS and has no blog :id — hits line 47
      app.get('/ping', (c) => c.json({ ok: true }))
      const res = await app.request('/ping')
      expect(res.status).toBe(200)
    })

    it("authMode 'api_key': OPTIONS request skips auth (exercises OPTIONS early-return branch)", async () => {
      const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
      const app = createApiRouter({
        store,
        rendererFor: () => renderer,
        baseUrl: 'https://api.example',
      })
      const res = await app.request('/health', { method: 'OPTIONS' })
      // OPTIONS passes through auth middleware; no 401
      expect(res.status).not.toBe(401)
    })
  })

  describe('src/api/routes.ts — signup with mcpEndpoint', () => {
    it('POST /signup includes mcp_endpoint in response when configured', async () => {
      const renderer = createRenderer({
        store,
        outputDir: join(dir, 'out'),
        baseUrl: 'https://b.example',
      })
      const app = createApiRouter({
        store,
        rendererFor: () => renderer,
        baseUrl: 'https://api.example',
        mcpEndpoint: 'https://api.example/mcp',
      })
      const res = await app.request('/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'mcpblog' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { mcp_endpoint?: string }
      expect(body.mcp_endpoint).toBe('https://api.example/mcp')
    })
  })

  describe('src/api/routes.ts — POST /blogs/:id/posts with text/markdown', () => {
    it('creates a post from text/markdown body', async () => {
      const renderer = createRenderer({
        store,
        outputDir: join(dir, 'out'),
        baseUrl: 'https://b.example',
      })
      const app = createApiRouter({
        store,
        rendererFor: () => renderer,
        baseUrl: 'https://api.example',
      })
      const { blog } = createBlog(store, { name: 'mdblog' })
      const { apiKey } = createApiKey(store, blog.id)
      const res = await app.request(`/blogs/${blog.id}/posts?title=Markdown+Title`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'text/markdown' },
        body: 'Some content here.',
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { post: { title: string } }
      expect(body.post.title).toBe('Markdown Title')
    })
  })
})
