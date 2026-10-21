import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiRouter } from '../../src/api/index.js'
import { createApiKey, createBlog } from '../../src/blogs.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createRenderer } from '../../src/rendering/generator.js'

// The response fields these tests read.
interface Body {
  error?: { code: string; details: Record<string, unknown> }
  fact?: { value: string; confirmed_at: string }
  facts?: unknown[]
  affected_posts?: unknown[]
  render_pending?: boolean
  _links?: { view: string }
}

describe('REST /blogs/:id/facts', () => {
  let dir: string
  let out: string
  let store: Store
  let app: ReturnType<typeof createApiRouter>
  let blogId: string
  let otherId: string
  let apiKey: string

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    return { status: res.status, json: (await res.json()) as Body }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    dir = mkdtempSync(join(tmpdir(), 'slopit-api-facts-'))
    out = join(dir, 'out')
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({ store, outputDir: out, baseUrl: 'https://b.example' })
    app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    blogId = createBlog(store, { name: 'bb' }).blog.id
    apiKey = createApiKey(store, blogId).apiKey
    otherId = createBlog(store, { name: 'other' }).blog.id
  })

  afterEach(() => {
    vi.useRealTimers()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('PUT creates, a post uses it, GET lists and gets it, PUT changes the page', async () => {
    const put = await call('PUT', `/blogs/${blogId}/facts/pro_price`, { value: '$12/mo' })
    expect(put.status).toBe(200)
    expect(put.json).toMatchObject({
      fact: { name: 'pro_price', value: '$12/mo', used_by: [] },
      changed: true,
      dry_run: false,
      affected_posts: [],
      rerendered: 0,
    })
    expect(put.json._links?.view).toBe('https://b.example/')

    const created = await call('POST', `/blogs/${blogId}/posts`, {
      title: 'Pricing',
      body: 'Pro is {{fact:pro_price}}.',
    })
    expect(created.status).toBe(200)

    const list = await call('GET', `/blogs/${blogId}/facts`)
    expect(list.status).toBe(200)
    expect(list.json.render_pending).toBe(false)
    expect(list.json.facts).toEqual([
      expect.objectContaining({
        name: 'pro_price',
        used_by: [{ slug: 'pricing', status: 'published' }],
      }),
    ])
    const one = await call('GET', `/blogs/${blogId}/facts/pro_price`)
    expect(one.json.fact?.value).toBe('$12/mo')
    expect(one.json.render_pending).toBe(false)

    const changed = await call('PUT', `/blogs/${blogId}/facts/pro_price`, { value: '$15/mo' })
    expect(changed.json).toMatchObject({ changed: true, rerendered: 1 })
    expect(changed.json.affected_posts?.[0]).toMatchObject({
      slug: 'pricing',
      url: 'https://b.example/pricing/',
      lines: [{ line: 1, before: 'Pro is $12/mo.', after: 'Pro is $15/mo.' }],
    })
    expect(readFileSync(join(out, blogId, 'pricing', 'index.html'), 'utf8')).toContain(
      'Pro is $15/mo.',
    )
  })

  it('maps errors to statuses', async () => {
    await call('PUT', `/blogs/${blogId}/facts/a`, { value: '1' })
    await call('POST', `/blogs/${blogId}/posts`, { title: 'Uses a', body: '{{fact:a}}' })
    const cases: [string, string, unknown, number, string][] = [
      ['GET', 'nope', undefined, 404, 'FACT_NOT_FOUND'],
      ['DELETE', 'nope', undefined, 404, 'FACT_NOT_FOUND'],
      ['PUT', 'Bad-Name', { value: '1' }, 400, 'FACT_NAME_INVALID'],
      ['PUT', 'a', { value: 'a|b' }, 400, 'FACT_VALUE_INVALID'],
      ['PUT', 'a', { value: '1', confirmed_at: '2031-01-01' }, 400, 'FACT_CONFIRMED_AT_INVALID'],
      ['PUT', 'a', { value: '2', expected_value: '9' }, 409, 'FACT_CONFLICT'],
      ['PUT', 'a', { value: '1', extra: true }, 400, 'ZOD_VALIDATION'],
      ['PUT', 'a', '{not json', 400, 'BAD_REQUEST'],
      ['DELETE', 'a', undefined, 409, 'FACT_IN_USE'],
    ]
    for (const [method, name, body, status, code] of cases) {
      const res = await call(method, `/blogs/${blogId}/facts/${name}`, body)
      expect([res.status, res.json.error?.code], `${method} ${name}`).toEqual([status, code])
    }
    const heading = await call('POST', `/blogs/${blogId}/posts`, {
      title: 'H',
      body: '## {{fact:a}}',
    })
    expect([heading.status, heading.json.error?.code]).toEqual([400, 'FACT_IN_HEADING'])
    expect(heading.json.error?.details).toEqual({ name: 'a', line: 1 })
    const unknown = await call('POST', `/blogs/${blogId}/posts`, { title: 'U', body: '{{fact:z}}' })
    expect([unknown.status, unknown.json.error?.details]).toEqual([404, { names: ['z'] }])
  })

  it("another blog's id is BLOG_NOT_FOUND on every route; no key is UNAUTHORIZED", async () => {
    for (const [method, path, body] of [
      ['GET', `/blogs/${otherId}/facts`, undefined],
      ['GET', `/blogs/${otherId}/facts/a`, undefined],
      ['PUT', `/blogs/${otherId}/facts/a`, { value: '1' }],
      ['DELETE', `/blogs/${otherId}/facts/a`, undefined],
    ] as const) {
      const res = await call(method, path, body)
      expect([res.status, res.json.error?.code], `${method} ${path}`).toEqual([
        404,
        'BLOG_NOT_FOUND',
      ])
    }
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({ n: 0 })
    const res = await app.request(`/blogs/${blogId}/facts`)
    expect(res.status).toBe(401)
  })

  it('a dry run with an Idempotency-Key stores no replay record', async () => {
    const keys = () =>
      (store.db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get() as { n: number }).n
    const headers = { 'Idempotency-Key': 'dry-1' }
    const dry = await call(
      'PUT',
      `/blogs/${blogId}/facts/a`,
      { value: '1', dry_run: true },
      headers,
    )
    expect(dry.status).toBe(200)
    expect(dry.json).toMatchObject({ dry_run: true })
    expect(keys()).toBe(0)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({ n: 0 })
    await call('PUT', `/blogs/${blogId}/facts/a`, { value: '1' }, { 'Idempotency-Key': 'real-1' })
    expect(keys()).toBe(1)
  })

  it('Idempotency-Key on PUT replays the stored response (no re-stamped confirmation)', async () => {
    const headers = { 'Idempotency-Key': 'k-1' }
    const first = await call('PUT', `/blogs/${blogId}/facts/a`, { value: '1' }, headers)
    vi.setSystemTime(new Date('2030-01-02T00:00:00Z'))
    const replay = await call('PUT', `/blogs/${blogId}/facts/a`, { value: '1' }, headers)
    expect(replay).toEqual(first)
    expect(first.json.fact?.confirmed_at).toBe('2030-01-01T00:00:00.000Z')
    const stored = await call('GET', `/blogs/${blogId}/facts/a`)
    expect(stored.json.fact?.confirmed_at).toBe('2030-01-01T00:00:00.000Z')
    const conflict = await call('PUT', `/blogs/${blogId}/facts/a`, { value: '2' }, headers)
    expect([conflict.status, conflict.json.error?.code]).toEqual([422, 'IDEMPOTENCY_KEY_CONFLICT'])
  })
})
