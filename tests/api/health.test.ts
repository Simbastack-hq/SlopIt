import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'

describe('GET /health', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-health-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns { ok: true } without auth', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('returns 503 when the DB connection is unusable', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    // Close the DB to simulate a broken backend — better-sqlite3 throws
    // synchronously on prepare() against a closed db, which is exactly
    // the failure mode the probe needs to catch.
    store.close()
    const res = await app.request('/health')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
  })
})
