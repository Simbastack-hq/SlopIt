import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'

describe('POST /signup', () => {
  let dir: string
  let store: Store

  const makeApp = (bugReportUrl?: string) => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://blog.example',
    })
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
    const body = (await res.json()) as {
      blog_id: string
      blog_url: string
      api_key: string
      onboarding_text: string
      email_sent: boolean
      _links: Record<string, string>
    }
    expect(body.blog_id).toMatch(/^[a-z0-9]+$/)
    expect(body.blog_url).toBe('https://blog.example/')
    expect(body.api_key).toMatch(/^sk_slop_/)
    expect(body.onboarding_text).toContain('Published my first post to SlopIt: <url>')
    expect(body.email_sent).toBe(false) // no email was provided
    expect(body._links.view).toBe('https://blog.example/')
    expect(body._links.bridge).toBe('https://api.example/bridge/report_bug')
  })

  it('email_sent: true when an email is provided and onSignup resolves', async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://blog.example',
    })
    const onSignup = async () => {}
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      onSignup,
    })
    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'mail-ok', email: 'a@b.com' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { email_sent: boolean; onboarding_text: string }
    expect(body.email_sent).toBe(true)
    expect(body.onboarding_text).toContain('We sent a copy of this key to your email')
  })

  it('email_sent: false when the onSignup hook throws (signup still succeeds)', async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://blog.example',
    })
    const onSignup = async () => {
      throw new Error('resend down')
    }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      onSignup,
    })
    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'mail-fail', email: 'a@b.com' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      email_sent: boolean
      api_key: string
      onboarding_text: string
    }
    expect(body.email_sent).toBe(false)
    expect(body.api_key).toMatch(/^sk_slop_/)
    expect(body.onboarding_text).toContain('Email send FAILED')
    errSpy.mockRestore()
  })

  it('returns 409 BLOG_NAME_CONFLICT when the name is taken', async () => {
    const app = makeApp()
    await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'taken' }),
    })
    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'taken' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('BLOG_NAME_CONFLICT')
  })

  it('Idempotency-Key does NOT replay /signup (pre-auth scope would leak api_key across callers)', async () => {
    // Security: signup has no caller identity yet, so the idempotency
    // middleware intentionally skips storage/replay for it — a second
    // caller submitting the same Idempotency-Key must NOT receive the
    // first caller's api_key. See src/api/idempotency.ts for the
    // apiKeyHash === '' early-return. Retries collide on the name
    // (409), which is correct: the first call created the blog.
    const app = makeApp()
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'signup-k1' }
    const r1 = await app.request('/signup', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'idem' }),
    })
    const r2 = await app.request('/signup', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'idem' }),
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(409)
    const b1 = (await r1.json()) as { api_key: string }
    const raw2 = await r2.text()
    expect(raw2).not.toContain(b1.api_key)
  })
})
