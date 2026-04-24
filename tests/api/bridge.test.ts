import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'

describe('POST /bridge/report_bug', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-bridge-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 501 NOT_IMPLEMENTED with details.use pointing to bug-report URL when configured', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      bugReportUrl: 'https://platform.example/bridge/report_bug',
    })
    const res = await app.request('/bridge/report_bug', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string; details: { use?: string } } }
    expect(body.error.code).toBe('NOT_IMPLEMENTED')
    expect(body.error.details.use).toBe('https://platform.example/bridge/report_bug')
  })

  it('omits details.use when not configured', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const res = await app.request('/bridge/report_bug', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: { code: string; details: { use?: string } } }
    expect(body.error.details.use).toBeUndefined()
  })
})
