import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../../src/db/store.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createApiRouter } from '../../src/api/index.js'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function freshApi() {
  const dir = mkdtempSync(join(tmpdir(), 'slopit-api-media-'))
  const store = createStore({ dbPath: join(dir, 'test.db') })
  const renderer = createRenderer({
    store,
    outputDir: join(dir, 'out'),
    baseUrl: 'https://test.example/',
  })
  const app = new Hono()
  app.route(
    '/',
    createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://test.example',
    }),
  )
  // Sign up to get an api key. Use a fresh, schema-valid name each call.
  const name = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const signup = await app.request('/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const sj = (await signup.json()) as { blog_id: string; api_key: string }
  return { app, blogId: sj.blog_id, apiKey: sj.api_key, store, renderer }
}

describe('REST media upload', () => {
  it('POST /blogs/:id/media accepts a multipart upload and returns media + url', async () => {
    const { app, blogId, apiKey } = await freshApi()
    const fd = new FormData()
    fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'photo.png')

    const res = await app.request(`/blogs/${blogId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { media: { id: string; url: string }; _links: unknown }
    expect(body.media.id).toMatch(/^[A-Za-z0-9]+$/)
    expect(body.media.url).toMatch(/^https:\/\/test\.example\/_media\/.+\.png$/)
  })

  it('rejects an upload with no file field as BAD_REQUEST', async () => {
    const { app, blogId, apiKey } = await freshApi()
    const fd = new FormData()
    fd.append('not_file', 'oops')
    const res = await app.request(`/blogs/${blogId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('GET /blogs/:id/media lists uploads', async () => {
    const { app, blogId, apiKey } = await freshApi()
    const fd = new FormData()
    fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'a.png')
    await app.request(`/blogs/${blogId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    })
    const res = await app.request(`/blogs/${blogId}/media`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { media: { id: string }[]; _links: unknown }
    expect(body.media).toHaveLength(1)
  })

  it('infers image/png from filename when part type is application/octet-stream', async () => {
    const { app, blogId, apiKey } = await freshApi()
    const fd = new FormData()
    // explicit octet-stream — what default cURL / many browsers send
    fd.append('file', new Blob([PNG_BYTES], { type: 'application/octet-stream' }), 'photo.png')
    const res = await app.request(`/blogs/${blogId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { media: { url: string; contentType: string } }
    expect(body.media.contentType).toBe('image/png')
    expect(body.media.url).toMatch(/\.png$/)
  })

  it('still rejects octet-stream with an unrecognised filename extension', async () => {
    const { app, blogId, apiKey } = await freshApi()
    const fd = new FormData()
    fd.append('file', new Blob([PNG_BYTES], { type: 'application/octet-stream' }), 'photo.bin')
    const res = await app.request(`/blogs/${blogId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('MEDIA_TYPE_UNSUPPORTED')
  })

  it('honours plan-tier function form: pro = unlimited, free = capped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slopit-tier-media-'))
    const store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://test.example/',
    })
    const app = new Hono()
    app.route(
      '/',
      createApiRouter({
        store,
        rendererFor: () => renderer,
        baseUrl: 'https://test.example',
        // Per-blog tier function: blog 'free_test' is capped at 4 bytes,
        // blog 'pro_test' is unlimited (null).
        mediaMaxTotalBytesPerBlog: (blog) => (blog.name === 'pro' ? null : 4),
      }),
    )
    // Sign up as a free-tier blog (any name).
    const sFree = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'free' + Date.now().toString(36) }),
    })
    const free = (await sFree.json()) as { blog_id: string; api_key: string }

    // Sign up as a "pro" blog (function reads name === 'pro' to pick tier).
    // Use the literal name 'pro' so the function returns null.
    const sPro = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pro' }),
    })
    const pro = (await sPro.json()) as { blog_id: string; api_key: string }

    const fd1 = new FormData()
    fd1.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'a.png')
    const r1 = await app.request(`/blogs/${free.blog_id}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${free.api_key}` },
      body: fd1,
    })
    expect(r1.status).toBe(413)

    const fd2 = new FormData()
    fd2.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'a.png')
    const r2 = await app.request(`/blogs/${pro.blog_id}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pro.api_key}` },
      body: fd2,
    })
    expect(r2.status).toBe(200)
  })

  it('GET /blogs/:id/media/:mid returns a single record; DELETE removes it', async () => {
    const { app, blogId, apiKey } = await freshApi()
    const fd = new FormData()
    fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'a.png')
    const upload = await app.request(`/blogs/${blogId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    })
    const { media } = (await upload.json()) as { media: { id: string } }

    const get = await app.request(`/blogs/${blogId}/media/${media.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(get.status).toBe(200)

    const del = await app.request(`/blogs/${blogId}/media/${media.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(del.status).toBe(200)
    expect((await del.json()) as { deleted: true }).toMatchObject({ deleted: true })

    const after = await app.request(`/blogs/${blogId}/media/${media.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(after.status).toBe(404)
  })
})
