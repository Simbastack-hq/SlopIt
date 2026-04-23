import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'

describe('POST /signup', () => {
  let dir: string; let store: Store

  const makeApp = (bugReportUrl?: string) => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://blog.example' })
    return createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      bugReportUrl,
      dashboardUrl: 'https://slopit.io/dashboard',
      docsUrl: 'https://slopit.io/agent-docs',
      skillUrl: 'https://slopit.io/slopit.SKILL.md',
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-signup-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns full shape on happy path', async () => {
    const app = makeApp()
    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hello' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      blog_id: string
      blog_url: string
      api_key: string
      onboarding_text: string
      _links: Record<string, string>
    }
    expect(body.blog_id).toMatch(/^[a-z0-9]+$/)
    expect(body.blog_url).toBe('https://blog.example')
    expect(body.api_key).toMatch(/^sk_slop_/)
    expect(body.onboarding_text).toContain('Published my first post to SlopIt: <url>')
    expect(body._links.view).toBe('https://blog.example')
    expect(body._links.bridge).toBe('/bridge/report_bug')
  })

  it('returns 409 BLOG_NAME_CONFLICT when the name is taken', async () => {
    const app = makeApp()
    await app.request('/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'taken' }) })
    const res = await app.request('/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'taken' }) })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BLOG_NAME_CONFLICT')
  })

  it('Idempotency-Key replays the same signup', async () => {
    const app = makeApp()
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'signup-k1' }
    const r1 = await app.request('/signup', { method: 'POST', headers, body: JSON.stringify({ name: 'idem' }) })
    const r2 = await app.request('/signup', { method: 'POST', headers, body: JSON.stringify({ name: 'idem' }) })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const b1 = await r1.json(); const b2 = await r2.json()
    expect(b1).toEqual(b2)
  })
})
