import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { idempotencyMiddleware } from '../src/api/idempotency.js'

describe('idempotencyMiddleware', () => {
  let dir: string
  let store: Store
  let callCount: number

  const makeApp = () => {
    const app = new Hono<{ Variables: { apiKeyHash: string } }>()
    app.use('*', async (c, next) => {
      // Stand-in for auth: set apiKeyHash on c.var
      c.set('apiKeyHash', c.req.header('X-Test-Key-Hash') ?? '')
      await next()
    })
    app.use('*', idempotencyMiddleware({ store }))
    app.post('/signup', async (c) => {
      callCount++
      const body = await c.req.json().catch(() => ({}))
      return c.json({ ok: true, echo: body, n: callCount })
    })
    app.post('/blogs/:id/posts', async (c) => {
      callCount++
      return c.json({ slug: `post-${callCount}` }, 200)
    })
    return app
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-idem-mw-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    callCount = 0
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('no Idempotency-Key → handler runs every time', async () => {
    const app = makeApp()
    await app.request('/signup', { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } })
    await app.request('/signup', { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } })
    expect(callCount).toBe(2)
  })

  it('replays stored response on repeat with same payload', async () => {
    const app = makeApp()
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' }
    const r1 = await app.request('/signup', { method: 'POST', body: '{"a":1}', headers })
    const r2 = await app.request('/signup', { method: 'POST', body: '{"a":1}', headers })
    expect(callCount).toBe(1)
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(await r1.json()).toEqual(await r2.json())
  })

  it('different payload, same key → 422 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const app = makeApp()
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'k2' }
    await app.request('/signup', { method: 'POST', body: '{"a":1}', headers })
    const r = await app.request('/signup', { method: 'POST', body: '{"a":2}', headers })
    expect(r.status).toBe(422)
    const body = await r.json() as { error: { code: string; details: { key: string } } }
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT')
    expect(body.error.details.key).toBe('k2')
  })

  it('scope isolation: same key, different path → independent', async () => {
    const app = makeApp()
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'shared', 'X-Test-Key-Hash': 'h1' }
    await app.request('/signup', { method: 'POST', body: '{}', headers })
    await app.request('/blogs/b/posts', { method: 'POST', body: '{}', headers })
    expect(callCount).toBe(2)
  })

  it('scope isolation: same key, different api_key_hash → independent', async () => {
    const app = makeApp()
    const common = { 'Content-Type': 'application/json', 'Idempotency-Key': 'k3' }
    await app.request('/signup', { method: 'POST', body: '{}', headers: { ...common, 'X-Test-Key-Hash': 'h1' } })
    await app.request('/signup', { method: 'POST', body: '{}', headers: { ...common, 'X-Test-Key-Hash': 'h2' } })
    expect(callCount).toBe(2)
  })

  it('does not record non-2xx responses', async () => {
    const app = new Hono<{ Variables: { apiKeyHash: string } }>()
    app.use('*', async (c, next) => { c.set('apiKeyHash', ''); await next() })
    app.use('*', idempotencyMiddleware({ store }))
    app.post('/fail', () => { throw new Error('boom') })
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'kfail' }
    try { await app.request('/fail', { method: 'POST', body: '{}', headers }) } catch { /* ok */ }
    // Table should be empty for this key
    const rows = store.db.prepare('SELECT 1 FROM idempotency_keys WHERE key = ?').all('kfail')
    expect(rows).toHaveLength(0)
  })
})
