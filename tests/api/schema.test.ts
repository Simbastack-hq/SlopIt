import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'

describe('GET /schema', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-schema-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the PostInput JSONSchema at the top level (not wrapped)', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const res = await app.request('/schema')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // Top-level JSONSchema: has type or $schema or properties
    expect(body.type ?? body.$schema ?? body.properties).toBeDefined()
    // And it's the PostInput — should have a `title` property in its schema shape
    expect(JSON.stringify(body)).toContain('title')
  })

  it('does not require auth', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      authMode: 'api_key',
    })
    const res = await app.request('/schema')
    expect(res.status).toBe(200)
  })
})
