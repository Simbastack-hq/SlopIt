import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createBlog, createApiKey } from '../../src/blogs.js'
import { SlopItError } from '../../src/errors.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { wrapTool } from '../../src/mcp/wrap-tool.js'
import type { McpServerConfig } from '../../src/mcp/server.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

const makeExtra = (overrides: Partial<Extra> = {}): Extra =>
  ({
    signal: new AbortController().signal,
    sendRequest: async () => ({ _meta: undefined }) as never,
    sendNotification: async () => undefined,
    ...overrides,
  }) as Extra

describe('wrapTool', () => {
  let dir: string
  let store: Store
  let config: McpServerConfig
  let apiKey: string
  let blogId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-wrap-tool-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    config = {
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      authMode: 'api_key',
    }
    const blog = createBlog(store, { name: 'my-blog' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const authExtra = () => makeExtra({ authInfo: { token: apiKey, clientId: 'test', scopes: [] } })

  it('public tools run without auth and wrap results in structuredContent', async () => {
    const cb = wrapTool(config, 'noop', { auth: 'public' }, async () => ({ ok: true }))
    const result = await cb({}, makeExtra())
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ ok: true })
    expect(result.content?.[0]).toMatchObject({ type: 'text' })
  })

  it("auth: 'required' + no bearer → UNAUTHORIZED envelope", async () => {
    const cb = wrapTool(config, 'x', { auth: 'required' }, async () => ({ ok: true }))
    const result = await cb({}, makeExtra())
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { code: 'UNAUTHORIZED' },
    })
  })

  it("auth: 'required' + invalid bearer → UNAUTHORIZED envelope", async () => {
    const cb = wrapTool(config, 'x', { auth: 'required' }, async () => ({ ok: true }))
    const result = await cb(
      {},
      makeExtra({ authInfo: { token: 'sk_slop_nope', clientId: 't', scopes: [] } }),
    )
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  })

  it('valid bearer + no args → business handler receives ctx.blog and ctx.apiKeyHash', async () => {
    const cb = wrapTool<{ blog_id?: string }>(
      config,
      'x',
      { auth: 'required' },
      async (_args, ctx) => {
        return { blog_id_from_ctx: ctx.blog!.id, hash_len: ctx.apiKeyHash!.length }
      },
    )
    const res = await cb({}, authExtra())
    expect(res.structuredContent).toEqual({ blog_id_from_ctx: blogId, hash_len: 64 })
  })

  it('cross-blog guard: args.blog_id mismatches → BLOG_NOT_FOUND envelope', async () => {
    const cb = wrapTool<{ blog_id: string }>(
      config,
      'x',
      { auth: 'required', crossBlogGuard: true },
      async (_args) => ({ ok: true }),
    )
    const res = await cb({ blog_id: 'other' }, authExtra())
    expect(res.isError).toBe(true)
    expect(res.structuredContent).toMatchObject({
      error: { code: 'BLOG_NOT_FOUND', details: { blog_id: 'other' } },
    })
  })

  it('business-thrown SlopItError maps via envelope', async () => {
    const cb = wrapTool(config, 'x', { auth: 'required' }, async () => {
      throw new SlopItError('POST_NOT_FOUND', 'nope', { slug: 'x' })
    })
    const res = await cb({}, authExtra())
    expect(res.isError).toBe(true)
    expect(res.structuredContent).toMatchObject({
      error: { code: 'POST_NOT_FOUND', message: 'nope', details: { slug: 'x' } },
    })
    expect((res.content?.[0] as { type: string; text: string }).text).toBe('POST_NOT_FOUND: nope')
  })

  it("authMode: 'none' + crossBlogGuard: resolves blog from args.blog_id, no bearer required", async () => {
    const noneConfig: McpServerConfig = { ...config, authMode: 'none' }
    const cb = wrapTool<{ blog_id: string }>(
      noneConfig,
      'x',
      { auth: 'required', crossBlogGuard: true },
      async (_args, ctx) => ({ id: ctx.blog!.id }),
    )
    const res = await cb({ blog_id: blogId }, makeExtra())
    expect(res.isError).toBeUndefined()
    expect(res.structuredContent).toEqual({ id: blogId })
  })

  it('idempotency: same key + same args replays previous result', async () => {
    let calls = 0
    const cb = wrapTool<{ blog_id: string; idempotency_key?: string; name: string }>(
      config,
      'x',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      async (args) => {
        calls += 1
        return { call: calls, name: args.name }
      },
    )
    const a = await cb({ blog_id: blogId, idempotency_key: 'k1', name: 'a' }, authExtra())
    const b = await cb({ blog_id: blogId, idempotency_key: 'k1', name: 'a' }, authExtra())
    expect(calls).toBe(1)
    expect(b.structuredContent).toEqual(a.structuredContent)
  })

  it('idempotency: same key + different args → IDEMPOTENCY_KEY_CONFLICT', async () => {
    const cb = wrapTool<{ blog_id: string; idempotency_key?: string; name: string }>(
      config,
      'x',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      async (args) => ({ name: args.name }),
    )
    await cb({ blog_id: blogId, idempotency_key: 'k2', name: 'a' }, authExtra())
    const res = await cb({ blog_id: blogId, idempotency_key: 'k2', name: 'b' }, authExtra())
    expect(res.isError).toBe(true)
    expect(res.structuredContent).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_CONFLICT', details: { key: 'k2', method: 'MCP', path: 'x' } },
    })
  })

  it('idempotency is skipped when no idempotency_key is passed', async () => {
    let calls = 0
    const cb = wrapTool<{ blog_id: string; idempotency_key?: string }>(
      config,
      'x',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      async () => {
        calls += 1
        return { call: calls }
      },
    )
    await cb({ blog_id: blogId }, authExtra())
    await cb({ blog_id: blogId }, authExtra())
    expect(calls).toBe(2)
  })

  it("authMode:'none' + idempotency_key: both calls execute (no dedup, no INTERNAL_ERROR)", async () => {
    const noneConfig: McpServerConfig = { ...config, authMode: 'none' }
    let calls = 0
    const cb = wrapTool<{ blog_id: string; idempotency_key?: string }>(
      noneConfig,
      'x',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      async () => {
        calls += 1
        return { call: calls }
      },
    )
    const first = await cb({ blog_id: blogId, idempotency_key: 'idem-1' }, makeExtra())
    const second = await cb({ blog_id: blogId, idempotency_key: 'idem-1' }, makeExtra())
    // Both calls must succeed (no INTERNAL_ERROR, no IDEMPOTENCY_KEY_CONFLICT)
    expect(first.isError).toBeUndefined()
    expect(second.isError).toBeUndefined()
    // Business handler must have run twice (no dedup under authMode:'none')
    expect(calls).toBe(2)
  })
})
