import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createApiRouter } from '../src/api/index.js'
import { createApiKey, createBlog, getBlog, getBlogsByEmail, updateBlog } from '../src/blogs.js'
import { createStore, type Store } from '../src/db/store.js'
import { createMcpServer } from '../src/mcp/server.js'
import { createPost } from '../src/posts.js'
import { accentReadability, contrastRatio } from '../src/rendering/brand.js'
import { createRenderer, type MutationRenderer } from '../src/rendering/generator.js'
import { BlogPatchSchema } from '../src/schema/index.js'
import type { Blog } from '../src/schema/index.js'
import { attachAuth, callTool } from './mcp/helpers.js'

// Blog brand: an accent color, a masthead logo and a favicon, so a blog
// on a company's domain looks like the company's and not like SlopIt's.

const THEME_DIR = join(import.meta.dirname, '..', 'src', 'themes', 'minimal')

describe('brand schema', () => {
  it('accepts #rrggbb in any case and stores it lowercase; null clears', () => {
    expect(BlogPatchSchema.parse({ accentColor: '#1F6FEB' }).accentColor).toBe('#1f6feb')
    expect(BlogPatchSchema.parse({ accentColor: null }).accentColor).toBeNull()
    expect(BlogPatchSchema.parse({ logoUrl: 'https://x.example/logo.svg' }).logoUrl).toBe(
      'https://x.example/logo.svg',
    )
    expect(BlogPatchSchema.parse({ faviconUrl: null }).faviconUrl).toBeNull()
  })

  it('rejects colors that are not #rrggbb and URLs that are not http(s)', () => {
    for (const bad of ['1f6feb', '#1f6', '#1f6febff', 'blue', 'rgb(0,0,0)', '#gggggg', '']) {
      expect(BlogPatchSchema.safeParse({ accentColor: bad }).success, bad).toBe(false)
    }
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', '/logo.svg', 'logo']) {
      expect(BlogPatchSchema.safeParse({ logoUrl: bad }).success, bad).toBe(false)
      expect(BlogPatchSchema.safeParse({ faviconUrl: bad }).success, bad).toBe(false)
    }
  })
})

describe('accent readability', () => {
  it('measures WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })

  it('passes the default coral and dark brand colors', () => {
    expect(accentReadability('#ff4f00')).toEqual({ ok: true })
    expect(accentReadability('#1f6feb')).toEqual({ ok: true })
    expect(accentReadability('#000000')).toEqual({ ok: true })
  })

  it('refuses a color too light to read and suggests a darker shade of it that passes', () => {
    const verdict = accentReadability('#ffd400')
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.suggestion).toMatch(/^#[0-9a-f]{6}$/)
    expect(contrastRatio(verdict.suggestion, '#fafaf9')).toBeGreaterThanOrEqual(3)
    expect(verdict.message).toContain('#ffd400')
    expect(verdict.message).toContain(verdict.suggestion)
    expect(accentReadability('#ffffff').ok).toBe(false)
  })

  it('checks against the background the theme actually uses', () => {
    expect(readFileSync(join(THEME_DIR, 'style.css'), 'utf8')).toContain('--background: #fafaf9;')
    expect(readFileSync(join(THEME_DIR, 'favicon.svg'), 'utf8')).toContain('fill="#ff4f00"')
  })
})

describe('blog brand: store, render, re-render', () => {
  let dir: string
  let store: Store
  let outputDir: string
  let renderer: MutationRenderer

  const read = (...parts: string[]) => readFileSync(join(outputDir, ...parts), 'utf8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-blog-brand-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
    renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const publish = () => {
    const { blog } = createBlog(store, { name: 'simbastack', title: 'SimbaStack', email: 'o@x.io' })
    createPost(store, renderer, blog.id, { title: 'Hello', slug: 'hello', body: 'Hi.' })
    return blog
  }

  it('a new blog has no brand, and every read path says so with null', () => {
    const { blog } = createBlog(store, { name: 'kk', email: 'o@x.io' })
    for (const b of [blog, getBlog(store, blog.id), getBlogsByEmail(store, 'o@x.io')[0]]) {
      expect(b.accentColor).toBeNull()
      expect(b.logoUrl).toBeNull()
      expect(b.faviconUrl).toBeNull()
    }
  })

  it('unbranded pages are unchanged: theme CSS, theme favicon, text masthead', () => {
    const blog = publish()
    expect(read(blog.id, 'style.css')).toBe(readFileSync(join(THEME_DIR, 'style.css'), 'utf8'))
    expect(read(blog.id, 'favicon.svg')).toBe(readFileSync(join(THEME_DIR, 'favicon.svg'), 'utf8'))
    expect(read(blog.id, 'index.html')).toContain('<h1 class="masthead-name">SimbaStack</h1>')
    expect(read(blog.id, 'index.html')).toContain(
      '<link rel="icon" type="image/svg+xml" href="favicon.svg" />',
    )
    expect(read(blog.id, 'hello', 'index.html')).toContain(
      '<link rel="icon" type="image/svg+xml" href="../favicon.svg" />',
    )
  })

  it('accentColor overrides the accent in the blog CSS and recolors the default favicon', () => {
    const blog = publish()
    const updated = updateBlog(store, renderer, blog.id, { accentColor: '#1F6FEB' })
    expect(updated.accentColor).toBe('#1f6feb')

    const css = read(blog.id, 'style.css')
    expect(css.startsWith(readFileSync(join(THEME_DIR, 'style.css'), 'utf8'))).toBe(true)
    expect(css).toMatch(/:root \{\s*--accent: #1f6feb;\s*--accent-dark: #[0-9a-f]{6};\s*\}\s*$/)

    const favicon = read(blog.id, 'favicon.svg')
    expect(favicon).toContain('fill="#1f6feb"')
    expect(favicon).not.toContain('#ff4f00')
  })

  it('logoUrl replaces the masthead name with the logo, named by the blog title', () => {
    const blog = publish()
    updateBlog(store, renderer, blog.id, { logoUrl: 'https://simbastack.com/logo.svg' })
    const img = '<img class="masthead-logo" src="https://simbastack.com/logo.svg" alt="SimbaStack">'
    expect(read(blog.id, 'index.html')).toContain(`<h1 class="masthead-name">${img}</h1>`)
    expect(read(blog.id, 'hello', 'index.html')).toContain(
      `<a class="masthead-name" href="..">${img}</a>`,
    )
  })

  it('faviconUrl replaces the favicon on every page', () => {
    const blog = publish()
    updateBlog(store, renderer, blog.id, { faviconUrl: 'https://simbastack.com/icon.png' })
    const link = '<link rel="icon" href="https://simbastack.com/icon.png" />'
    expect(read(blog.id, 'index.html')).toContain(link)
    expect(read(blog.id, 'hello', 'index.html')).toContain(link)
    expect(read(blog.id, 'index.html')).not.toContain('favicon.svg')
  })

  it('null clears each field and the theme defaults come back', () => {
    const blog = publish()
    updateBlog(store, renderer, blog.id, {
      accentColor: '#1f6feb',
      logoUrl: 'https://simbastack.com/logo.svg',
      faviconUrl: 'https://simbastack.com/icon.png',
    })
    const cleared = updateBlog(store, renderer, blog.id, {
      accentColor: null,
      logoUrl: null,
      faviconUrl: null,
    })
    expect([cleared.accentColor, cleared.logoUrl, cleared.faviconUrl]).toEqual([null, null, null])
    expect(read(blog.id, 'style.css')).toBe(readFileSync(join(THEME_DIR, 'style.css'), 'utf8'))
    expect(read(blog.id, 'favicon.svg')).toBe(readFileSync(join(THEME_DIR, 'favicon.svg'), 'utf8'))
    expect(read(blog.id, 'index.html')).toContain('<h1 class="masthead-name">SimbaStack</h1>')
  })

  it('patching one brand field leaves the others alone', () => {
    const blog = publish()
    updateBlog(store, renderer, blog.id, { accentColor: '#1f6feb' })
    const after = updateBlog(store, renderer, blog.id, { logoUrl: 'https://s.example/l.svg' })
    expect(after.accentColor).toBe('#1f6feb')
    expect(read(blog.id, 'style.css')).toContain('--accent: #1f6feb;')
  })

  it('refuses an unreadable accent with a suggestion, before any write', () => {
    const blog = publish()
    let err: unknown
    try {
      updateBlog(store, renderer, blog.id, { accentColor: '#ffd400' })
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'BAD_REQUEST', details: { accentColor: '#ffd400' } })
    expect((err as { details: { suggestion: string } }).details.suggestion).toMatch(
      /^#[0-9a-f]{6}$/,
    )
    expect(getBlog(store, blog.id).accentColor).toBeNull()
  })

  it('escapes the logo URL and the alt text', () => {
    const { blog } = createBlog(store, { name: 'xx', title: 'A "quoted" <b>name</b>' })
    createPost(store, renderer, blog.id, { title: 'Hello', slug: 'hello', body: 'Hi.' })
    updateBlog(store, renderer, blog.id, { logoUrl: 'https://x.example/l.svg?a=1&b="2"' })
    const home = read(blog.id, 'index.html')
    expect(home).toContain('src="https://x.example/l.svg?a=1&amp;b=&quot;2&quot;"')
    expect(home).toContain('alt="A &quot;quoted&quot; &lt;b&gt;name&lt;/b&gt;"')
  })

  it('brands the empty-state home too', () => {
    const { blog } = createBlog(store, { name: 'empty', title: 'Empty' })
    updateBlog(store, renderer, blog.id, {
      accentColor: '#1f6feb',
      logoUrl: 'https://x.example/l.svg',
    })
    expect(read(blog.id, 'index.html')).toContain('class="masthead-logo"')
    expect(read(blog.id, 'style.css')).toContain('--accent: #1f6feb;')
  })

  it('a render failure restores the prior brand', () => {
    const blog = publish()
    updateBlog(store, renderer, blog.id, { accentColor: '#1f6feb' })
    const spy = vi.spyOn(renderer, 'renderBlog').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => updateBlog(store, renderer, blog.id, { accentColor: '#0a7d4f' })).toThrow(
      'disk full',
    )
    spy.mockRestore()
    expect(getBlog(store, blog.id).accentColor).toBe('#1f6feb')
    expect(read(blog.id, 'style.css')).toContain('--accent: #1f6feb;')
  })
})

describe('brand policy', () => {
  let dir: string
  let store: Store
  let renderer: MutationRenderer
  const refuse = (blog: Blog) => ({ ok: false as const, reason: `no brand for ${blog.id}` })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-brand-policy-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.example' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a refusing policy blocks setting any brand field, with its reason', () => {
    const { blog } = createBlog(store, { name: 'kk' })
    for (const patch of [
      { accentColor: '#1f6feb' },
      { logoUrl: 'https://x.example/l.svg' },
      { faviconUrl: 'https://x.example/i.png' },
    ]) {
      expect(() => updateBlog(store, renderer, blog.id, patch, { brandPolicy: refuse })).toThrow(
        expect.objectContaining({ code: 'BRANDING_DISABLED', message: `no brand for ${blog.id}` }),
      )
    }
    expect(getBlog(store, blog.id).accentColor).toBeNull()
  })

  it('is not consulted for clearing, for other fields, or for an unchanged value', () => {
    const { blog } = createBlog(store, { name: 'kk' })
    updateBlog(store, renderer, blog.id, { accentColor: '#1f6feb' })
    const policy = vi.fn(refuse)
    updateBlog(store, renderer, blog.id, { title: 'KK' }, { brandPolicy: policy })
    updateBlog(store, renderer, blog.id, { accentColor: '#1F6FEB' }, { brandPolicy: policy })
    updateBlog(store, renderer, blog.id, { accentColor: null }, { brandPolicy: policy })
    expect(policy).not.toHaveBeenCalled()
    expect(getBlog(store, blog.id).accentColor).toBeNull()
  })

  it('an allowing policy lets the write through', () => {
    const { blog } = createBlog(store, { name: 'kk' })
    const b = updateBlog(
      store,
      renderer,
      blog.id,
      { accentColor: '#1f6feb' },
      { brandPolicy: () => ({ ok: true }) },
    )
    expect(b.accentColor).toBe('#1f6feb')
  })
})

describe('blog brand over REST', () => {
  let dir: string
  let store: Store
  let renderer: MutationRenderer

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-brand-rest-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.example' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const patch = (
    app: ReturnType<typeof createApiRouter>,
    blogId: string,
    apiKey: string,
    body: unknown,
  ) =>
    app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })

  it('PATCH sets the brand and GET returns it', async () => {
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://a.example',
    })
    const { blog } = createBlog(store, { name: 'kk' })
    const { apiKey } = createApiKey(store, blog.id)
    const res = await patch(app, blog.id, apiKey, {
      accentColor: '#1f6feb',
      logoUrl: 'https://x.example/l.svg',
    })
    expect(res.status).toBe(200)
    const get = await app.request(`/blogs/${blog.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const got = ((await get.json()) as { blog: Blog }).blog
    expect(got).toMatchObject({
      accentColor: '#1f6feb',
      logoUrl: 'https://x.example/l.svg',
      faviconUrl: null,
    })
  })

  it('400 BAD_REQUEST with a suggestion for an unreadable accent', async () => {
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://a.example',
    })
    const { blog } = createBlog(store, { name: 'kk' })
    const { apiKey } = createApiKey(store, blog.id)
    const res = await patch(app, blog.id, apiKey, { accentColor: '#fff200' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { suggestion: string } }
    }
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.message).toContain(body.error.details.suggestion)
  })

  it('403 BRANDING_DISABLED when the host policy refuses', async () => {
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://a.example',
      brandPolicy: () => ({ ok: false, reason: 'Branding is a Pro feature' }),
    })
    const { blog } = createBlog(store, { name: 'kk' })
    const { apiKey } = createApiKey(store, blog.id)
    const res = await patch(app, blog.id, apiKey, { accentColor: '#1f6feb' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error).toMatchObject({
      code: 'BRANDING_DISABLED',
      message: 'Branding is a Pro feature',
    })
  })
})

describe('blog brand over MCP', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: (() => Promise<void>) | undefined

  const boot = async (
    apiKey: string,
    brandPolicy?: Parameters<typeof createMcpServer>[0]['brandPolicy'],
  ) => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      brandPolicy,
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    attachAuth(clientT, apiKey)
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-brand-mcp-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(async () => {
    await closer?.()
    closer = undefined
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('update_blog sets the brand; get_blog returns it', async () => {
    const { blog } = createBlog(store, { name: 'kk' })
    const { apiKey } = createApiKey(store, blog.id)
    await boot(apiKey)
    const set = await callTool(client, 'update_blog', {
      patch: { accentColor: '#1f6feb', faviconUrl: 'https://x.example/i.png' },
    })
    expect(set.isError).toBeFalsy()
    const got = await callTool(client, 'get_blog', {})
    expect((got.structuredContent as { blog: Blog }).blog).toMatchObject({
      accentColor: '#1f6feb',
      logoUrl: null,
      faviconUrl: 'https://x.example/i.png',
    })
  })

  it('update_blog surfaces BRANDING_DISABLED from the policy', async () => {
    const { blog } = createBlog(store, { name: 'kk' })
    const { apiKey } = createApiKey(store, blog.id)
    await boot(apiKey, () => ({ ok: false, reason: 'Branding is a Pro feature' }))
    const res = await callTool(client, 'update_blog', { patch: { accentColor: '#1f6feb' } })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.structuredContent)).toContain('BRANDING_DISABLED')
    expect(getBlog(store, blog.id).accentColor).toBeNull()
  })

  it('documents the brand fields in update_blog and its schemas', async () => {
    const { blog } = createBlog(store, { name: 'kk' })
    const { apiKey } = createApiKey(store, blog.id)
    await boot(apiKey)
    const { tools } = await client.listTools()
    const update = tools.find((t) => t.name === 'update_blog')!
    expect(update.description).toContain('`accentColor`')
    expect(update.description).toContain('`logoUrl`')
    expect(update.description).toContain('`faviconUrl`')
    const input = JSON.stringify(update.inputSchema)
    expect(input).toContain('"accentColor"')
    expect(input).toContain('#rrggbb')
    const out = JSON.stringify(update.outputSchema)
    expect(out).toContain('"accentColor"')
    expect(out).toContain('"logoUrl"')
    expect(out).toContain('"faviconUrl"')
  })
})
