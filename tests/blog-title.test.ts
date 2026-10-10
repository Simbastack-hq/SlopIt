import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { buildLlmsTxt, buildRssFeed } from '../src/rendering/feeds.js'
import { createRenderer, type MutationRenderer } from '../src/rendering/generator.js'
import { blogDisplayName } from '../src/rendering/seo.js'
import { BlogPatchSchema, CreateBlogInputSchema } from '../src/schema/index.js'
import { attachAuth, callTool } from './mcp/helpers.js'

// Optional blog display title: `title ?? name ?? id` everywhere the blog
// names itself to readers.

describe('title schema', () => {
  it('trims, accepts 1–80 characters of any script, and null on a patch', () => {
    expect(BlogPatchSchema.parse({ title: '  SlopIt  ' }).title).toBe('SlopIt')
    expect(BlogPatchSchema.parse({ title: 'é 日本 🦁 مرحبا' }).title).toBe('é 日本 🦁 مرحبا')
    expect(BlogPatchSchema.parse({ title: 'x'.repeat(80) }).title).toHaveLength(80)
    expect(BlogPatchSchema.parse({ title: null }).title).toBeNull()
    expect(CreateBlogInputSchema.parse({ title: 'KaribuKit' }).title).toBe('KaribuKit')
    expect(CreateBlogInputSchema.parse({}).title).toBeUndefined()
  })

  it('rejects empty, blank, too long, multi-line and control characters', () => {
    for (const bad of [
      '',
      '   ',
      'x'.repeat(81),
      'one\ntwo',
      'one\r\ntwo',
      'tab\there',
      'nul\x00',
      'del\x7F',
      'c1\x85',
      'line\u2028sep',
    ]) {
      expect(BlogPatchSchema.safeParse({ title: bad }).success, JSON.stringify(bad)).toBe(false)
      expect(CreateBlogInputSchema.safeParse({ title: bad }).success, JSON.stringify(bad)).toBe(
        false,
      )
    }
  })

  it('signup does not accept null (omit it instead)', () => {
    expect(CreateBlogInputSchema.safeParse({ title: null }).success).toBe(false)
  })
})

describe('blogDisplayName', () => {
  it('is title, else name, else id', () => {
    expect(blogDisplayName({ id: 'abc12345', name: 'karibukit', title: 'KaribuKit' })).toBe(
      'KaribuKit',
    )
    expect(blogDisplayName({ id: 'abc12345', name: 'karibukit', title: null })).toBe('karibukit')
    expect(blogDisplayName({ id: 'abc12345', name: null, title: null })).toBe('abc12345')
  })

  it('heads llms.txt and titles the RSS channel', () => {
    const blog = { id: 'b1', name: 'slopit', title: 'SlopIt & Friends' }
    expect(buildLlmsTxt({ blog, posts: [] }).split('\n')[0]).toBe('# SlopIt & Friends')
    const rss = buildRssFeed({
      blog: { ...blog, language: 'en' },
      blogRoot: 'https://b.example/',
      feedUrl: 'https://b.example/feed.xml',
      posts: [],
    })
    expect(rss).toContain('<title>SlopIt &amp; Friends</title>')
  })
})

describe('blog title: store, render, re-render', () => {
  let dir: string
  let store: Store
  let outputDir: string
  let renderer: MutationRenderer

  const read = (...parts: string[]) => readFileSync(join(outputDir, ...parts), 'utf8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-blog-title-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
    renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('createBlog persists the title; every read path returns it; default is null', () => {
    const { blog } = createBlog(store, { name: 'karibukit', title: 'KaribuKit', email: 'o@x.io' })
    expect(blog.title).toBe('KaribuKit')
    expect(getBlog(store, blog.id).title).toBe('KaribuKit')
    expect(getBlogsByEmail(store, 'o@x.io')[0].title).toBe('KaribuKit')
    expect(createBlog(store, {}).blog.title).toBeNull()
  })

  it('every surface uses the title: masthead, <title>, og:site_name, JSON-LD, RSS, llms.txt', () => {
    const { blog } = createBlog(store, { name: 'simbastack', title: 'SimbaStack' })
    createPost(store, renderer, blog.id, { title: 'Hello', slug: 'hello', body: 'Hi.' })

    const home = read(blog.id, 'index.html')
    expect(home).toContain('<title>SimbaStack</title>')
    expect(home).toContain('<h1 class="masthead-name">SimbaStack</h1>')

    const post = read(blog.id, 'hello', 'index.html')
    expect(post).toContain('<title>Hello — SimbaStack</title>')
    expect(post).toContain('>SimbaStack</a>')
    expect(post).toContain('<meta property="og:site_name" content="SimbaStack">')
    expect(post).toContain('"isPartOf":{"@type":"Blog","name":"SimbaStack"}')

    expect(read(blog.id, 'feed.xml')).toContain('<title>SimbaStack</title>')
    expect(read(blog.id, 'llms.txt').split('\n')[0]).toBe('# SimbaStack')
    // The URL name no longer shows as the site name anywhere.
    expect(home).not.toContain('>simbastack<')
  })

  it('updateBlog sets the title and re-renders pages, feeds and llms.txt (not .md)', () => {
    const { blog } = createBlog(store, { name: 'slopit-blog' })
    createPost(store, renderer, blog.id, { title: 'Hello', slug: 'hello', body: 'Hi.' })
    expect(read(blog.id, 'index.html')).toContain('<title>slopit-blog</title>')
    const md = vi.spyOn(renderer, 'renderPostMarkdown')

    const updated = updateBlog(store, renderer, blog.id, { title: 'SlopIt' })

    expect(updated.title).toBe('SlopIt')
    expect(getBlog(store, blog.id).title).toBe('SlopIt')
    expect(read(blog.id, 'index.html')).toContain('<title>SlopIt</title>')
    expect(read(blog.id, 'hello', 'index.html')).toContain('<title>Hello — SlopIt</title>')
    expect(read(blog.id, 'feed.xml')).toContain('<title>SlopIt</title>')
    expect(read(blog.id, 'llms.txt').split('\n')[0]).toBe('# SlopIt')
    expect(md).not.toHaveBeenCalled()
  })

  it('null clears the title and the URL name comes back; same value is a no-op', () => {
    const { blog } = createBlog(store, { name: 'karibukit', title: 'KaribuKit' })
    createPost(store, renderer, blog.id, { title: 'Hello', slug: 'hello', body: 'Hi.' })
    const pages = vi.spyOn(renderer, 'renderBlogPosts')

    updateBlog(store, renderer, blog.id, { title: 'KaribuKit' })
    expect(pages).not.toHaveBeenCalled()

    const cleared = updateBlog(store, renderer, blog.id, { title: null })
    expect(cleared.title).toBeNull()
    expect(pages).toHaveBeenCalledTimes(1)
    expect(read(blog.id, 'index.html')).toContain('<title>karibukit</title>')
    expect(read(blog.id, 'llms.txt').split('\n')[0]).toBe('# karibukit')
  })

  it('an invalid title is rejected before any write', () => {
    const { blog } = createBlog(store, { name: 'kk', title: 'KaribuKit' })
    expect(() => updateBlog(store, renderer, blog.id, { title: 'two\nlines' })).toThrow()
    expect(getBlog(store, blog.id).title).toBe('KaribuKit')
  })

  it('a render failure restores the prior title', () => {
    const { blog } = createBlog(store, { name: 'kk', title: 'Old' })
    createPost(store, renderer, blog.id, { title: 'Hello', slug: 'hello', body: 'Hi.' })
    const spy = vi.spyOn(renderer, 'renderManifests').mockImplementationOnce(() => {
      throw new Error('synthetic manifests failure')
    })
    expect(() => updateBlog(store, renderer, blog.id, { title: 'New' })).toThrow(
      'synthetic manifests failure',
    )
    spy.mockRestore()
    expect(getBlog(store, blog.id).title).toBe('Old')
    // Recovery re-derived the output from the restored row.
    expect(read(blog.id, 'index.html')).toContain('<title>Old</title>')
  })

  it('HTML-escapes a hostile title on every page and XML-escapes it in the feed', () => {
    const evil = '<script>alert("x")</script> & \'Co\''
    const { blog } = createBlog(store, { name: 'evil', title: evil })
    createPost(store, renderer, blog.id, { title: 'Hello', slug: 'hello', body: 'Hi.' })

    const escaped = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;'
    for (const page of [read(blog.id, 'index.html'), read(blog.id, 'hello', 'index.html')]) {
      expect(page).not.toContain('<script>alert')
      expect(page).toContain(escaped)
    }
    const post = read(blog.id, 'hello', 'index.html')
    expect(post).toContain(`<meta property="og:site_name" content="${escaped}">`)
    // JSON-LD: `<` is <-escaped so `</script>` cannot close the block.
    expect(post).toContain('"name":"\\u003cscript>alert(\\"x\\")\\u003c/script> & \'Co\'"')

    const feed = read(blog.id, 'feed.xml')
    expect(feed).toContain(
      '<title>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &apos;Co&apos;</title>',
    )
  })

  it('shows on the empty-state home and on every language home and feed', () => {
    const { blog } = createBlog(store, { name: 'multi' })
    updateBlog(store, renderer, blog.id, { title: 'Multi Blog' })
    // No posts yet: the home is the empty state, named by the title.
    const empty = read(blog.id, 'index.html')
    expect(empty).toContain('class="empty-state"')
    expect(empty).toContain('<h1 class="masthead-name">Multi Blog</h1>')

    createPost(store, renderer, blog.id, { title: 'Hello', slug: 'hello', body: 'Hi.' })
    createPost(store, renderer, blog.id, {
      title: 'Hallo',
      slug: 'hallo',
      body: 'Hi.',
      language: 'de',
    })
    for (const tag of ['en', 'de']) {
      expect(existsSync(join(outputDir, blog.id, 'lang', tag, 'index.html')), tag).toBe(true)
      expect(read(blog.id, 'lang', tag, 'index.html')).toContain(
        '<h1 class="masthead-name">Multi Blog</h1>',
      )
      expect(read(blog.id, 'lang', tag, 'feed.xml')).toContain('<title>Multi Blog</title>')
    }
  })
})

describe('blog title over REST', () => {
  let dir: string
  let store: Store
  let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-blog-title-rest-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const json = (method: string, path: string, body: unknown, apiKey?: string) =>
    app.request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey !== undefined ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    })

  it('signup takes a title; GET returns it; PATCH changes and clears it', async () => {
    const signup = await json('POST', '/signup', { name: 'kk', title: 'KaribuKit' })
    expect(signup.status).toBe(200)
    const { blog_id, api_key } = (await signup.json()) as { blog_id: string; api_key: string }

    const get = await app.request(`/blogs/${blog_id}`, {
      headers: { Authorization: `Bearer ${api_key}` },
    })
    expect(((await get.json()) as { blog: { title: string } }).blog.title).toBe('KaribuKit')

    const patch = await json('PATCH', `/blogs/${blog_id}`, { title: 'KaribuKit PMS' }, api_key)
    expect(patch.status).toBe(200)
    expect(((await patch.json()) as { blog: { title: string } }).blog.title).toBe('KaribuKit PMS')

    const clear = await json('PATCH', `/blogs/${blog_id}`, { title: null }, api_key)
    expect(((await clear.json()) as { blog: { title: null } }).blog.title).toBeNull()
  })

  it('400 ZOD_VALIDATION on a bad title, at signup and on PATCH', async () => {
    const signup = await json('POST', '/signup', { title: 'x'.repeat(81) })
    expect(signup.status).toBe(400)
    expect(((await signup.json()) as { error: { code: string } }).error.code).toBe('ZOD_VALIDATION')

    const { blog } = createBlog(store, { name: 'kk' })
    const { apiKey } = createApiKey(store, blog.id)
    const patch = await json('PATCH', `/blogs/${blog.id}`, { title: 'a\nb' }, apiKey)
    expect(patch.status).toBe(400)
    expect(((await patch.json()) as { error: { code: string } }).error.code).toBe('ZOD_VALIDATION')
    expect(getBlog(store, blog.id).title).toBeNull()
  })
})

describe('blog title over MCP', () => {
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
    if (apiKey !== undefined) attachAuth(clientT, apiKey)
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-blog-title-mcp-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('signup takes a title; get_blog returns it; update_blog changes and clears it', async () => {
    await boot()
    const signup = await callTool(client, 'signup', { name: 'kk', title: 'KaribuKit' })
    expect(signup.isError).toBeFalsy()
    const apiKey = (signup.structuredContent as { api_key: string }).api_key
    await closer()
    await boot(apiKey)

    const got = await callTool(client, 'get_blog', {})
    expect((got.structuredContent as { blog: { title: string } }).blog.title).toBe('KaribuKit')

    const set = await callTool(client, 'update_blog', { patch: { title: 'KaribuKit PMS' } })
    expect(set.isError).toBeFalsy()
    expect((set.structuredContent as { blog: { title: string } }).blog.title).toBe('KaribuKit PMS')

    const cleared = await callTool(client, 'update_blog', { patch: { title: null } })
    expect((cleared.structuredContent as { blog: { title: null } }).blog.title).toBeNull()
  })

  it('rejects a bad title in signup and update_blog without writing', async () => {
    await boot()
    const signup = await callTool(client, 'signup', { name: 'kk', title: '' })
    expect(signup.isError).toBe(true)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM blogs').get()).toEqual({ n: 0 })

    const { blog } = createBlog(store, { name: 'kk2' })
    const { apiKey } = createApiKey(store, blog.id)
    await closer()
    await boot(apiKey)
    const res = await callTool(client, 'update_blog', { patch: { title: 'a\tb' } })
    expect(res.isError).toBe(true)
    expect(getBlog(store, blog.id).title).toBeNull()
  })

  it('documents title in both tools and their schemas', async () => {
    await boot()
    const { tools } = await client.listTools()
    const signup = tools.find((t) => t.name === 'signup')!
    const update = tools.find((t) => t.name === 'update_blog')!
    expect(signup.description).toContain('`title`')
    expect(update.description).toContain('otherwise the URL name is shown')
    const signupProps = signup.inputSchema.properties as Record<string, { description?: string }>
    expect(signupProps.title.description).toContain('URL name')
    const out = JSON.stringify(update.outputSchema)
    expect(out).toContain('"title"')
  })
})
