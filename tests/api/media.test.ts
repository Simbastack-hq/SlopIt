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
})
