import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createApiKey, createBlog, getBlog } from '../src/blogs.js'
import { createPost, getPost } from '../src/posts.js'
import { createRenderer } from '../src/rendering/generator.js'
import { createApiRouter } from '../src/api/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp/server.js'
import { attachAuth, callTool } from './mcp/helpers.js'

// `language` through the REST boundary — the contract an agent actually
// hits. Unit coverage of the schema and renderer lives in language.test.ts.

describe('language over REST', () => {
  let dir: string
  let store: Store
  let outputDir: string
  let renderer: ReturnType<typeof createRenderer>
  let app: ReturnType<typeof createApiRouter>

  const json = (method: string, path: string, body: unknown, apiKey?: string) =>
    app.request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-lang-rest-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
    renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example' })
    app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('POST /signup accepts language and persists it canonicalised', async () => {
    const res = await json('POST', '/signup', { name: 'ru-blog', language: 'RU' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { blog_id: string }
    expect(getBlog(store, body.blog_id).language).toBe('ru')
  })

  it('POST /signup rejects a language name with 400 ZOD_VALIDATION and an actionable message', async () => {
    const res = await json('POST', '/signup', { name: 'bad-lang', language: 'Russian' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details: unknown } }
    expect(body.error.code).toBe('ZOD_VALIDATION')
    expect(JSON.stringify(body.error.details)).toContain('BCP-47')
  })

  it('PATCH /blogs/:id sets the default language and re-renders', async () => {
    const { blog } = createBlog(store, { name: 'pb' })
    const apiKey = createApiKey(store, blog.id).apiKey
    createPost(store, renderer, blog.id, { title: 'T', slug: 'tt', body: 'b' })

    const res = await json('PATCH', `/blogs/${blog.id}`, { language: 'de' }, apiKey)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { blog: { language: string } }
    expect(body.blog.language).toBe('de')
    expect(readFileSync(join(outputDir, blog.id, 'tt', 'index.html'), 'utf8')).toContain(
      '<html lang="de"',
    )
  })

  it('PATCH /blogs/:id rejects language: null (a blog always has one)', async () => {
    const { blog } = createBlog(store, { name: 'pn' })
    const apiKey = createApiKey(store, blog.id).apiKey
    const res = await json('PATCH', `/blogs/${blog.id}`, { language: null }, apiKey)
    expect(res.status).toBe(400)
  })

  it('POST and PATCH on posts: set an override, then null clears it', async () => {
    const { blog } = createBlog(store, { name: 'pp', language: 'en' })
    const apiKey = createApiKey(store, blog.id).apiKey

    const created = await json(
      'POST',
      `/blogs/${blog.id}/posts`,
      { title: 'Hola', slug: 'hola', body: 'b', language: 'es' },
      apiKey,
    )
    expect(created.status).toBe(200)
    expect(((await created.json()) as { post: { language?: string } }).post.language).toBe('es')
    expect(readFileSync(join(outputDir, blog.id, 'hola', 'index.html'), 'utf8')).toContain(
      '<html lang="es"',
    )

    const cleared = await json('PATCH', `/blogs/${blog.id}/posts/hola`, { language: null }, apiKey)
    expect(cleared.status).toBe(200)
    expect(getPost(store, blog.id, 'hola').language).toBeUndefined()
    expect(readFileSync(join(outputDir, blog.id, 'hola', 'index.html'), 'utf8')).toContain(
      '<html lang="en"',
    )
  })
})

describe('language over MCP', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: () => Promise<void>

  const boot = async (apiKey?: string) => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    if (apiKey) attachAuth(clientT, apiKey)
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-lang-mcp-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('signup accepts language; update_blog changes it; a language name is rejected', async () => {
    await boot()
    const signup = await callTool(client, 'signup', { name: 'mcp-ru', language: 'ru' })
    expect(signup.isError).toBeFalsy()
    const { blog_id, api_key } = signup.structuredContent as { blog_id: string; api_key: string }
    expect(getBlog(store, blog_id).language).toBe('ru')
    await closer()

    await boot(api_key)
    const updated = await callTool(client, 'update_blog', { blog_id, patch: { language: 'ja' } })
    expect(updated.isError).toBeFalsy()
    expect((updated.structuredContent as { blog: { language: string } }).blog.language).toBe('ja')
    expect(getBlog(store, blog_id).language).toBe('ja')

    const bad = await callTool(client, 'update_blog', { blog_id, patch: { language: 'Japanese' } })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad)).toContain('BCP-47')
  })
})
