import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../src/db/store.js'
import { idempotencyMiddleware } from '../src/api/idempotency.js'

describe('idempotency middleware (binary bodies)', () => {
  it('preserves binary multipart bytes through replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slopit-idem-'))
    const store = createStore({ dbPath: join(dir, 'test.db') })
    const app = new Hono<{ Variables: { apiKeyHash: string } }>()
    app.use('*', async (c, next) => {
      c.set('apiKeyHash', 'fake_key_hash')
      await next()
    })
    app.use('*', idempotencyMiddleware({ store }))
    app.post('/echo', async (c) => {
      const buf = new Uint8Array(await c.req.raw.arrayBuffer())
      return c.json({ first_byte: buf[0], length: buf.length })
    })

    const bin = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const headers = { 'Idempotency-Key': 'k1', 'Content-Type': 'application/octet-stream' }

    const r1 = await app.request('/echo', { method: 'POST', headers, body: bin })
    const j1 = (await r1.json()) as { first_byte: number; length: number }
    expect(j1).toEqual({ first_byte: 0xff, length: 6 })

    const r2 = await app.request('/echo', { method: 'POST', headers, body: bin })
    const j2 = (await r2.json()) as { first_byte: number; length: number }
    expect(j2).toEqual({ first_byte: 0xff, length: 6 })
  })
})
