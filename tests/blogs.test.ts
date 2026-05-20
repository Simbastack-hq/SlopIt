import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import {
  createApiKey,
  createBlog,
  isBlogNameConflict,
  getBlogInternal,
  getBlog,
  getBlogByName,
  getBlogsByEmail,
  updateBlog,
} from '../src/blogs.js'
import { createPost } from '../src/posts.js'
import { createRenderer } from '../src/rendering/generator.js'
import { hashApiKey } from '../src/auth/api-key.js'
import { SlopItError } from '../src/errors.js'
import { CreateBlogInputSchema } from '../src/schema/index.js'

// Cast helper for direct INSERTs/UPDATEs in DB-state setup blocks.
// Tests need to seed `analytics_json` directly to exercise the read
// path; in production code the column is written through updateBlog.

function sqliteUniqueError(constraint: string): Error {
  const e = new Error(`UNIQUE constraint failed: ${constraint}`) as NodeJS.ErrnoException
  e.code = 'SQLITE_CONSTRAINT_UNIQUE'
  return e
}

describe('isBlogNameConflict', () => {
  it('is true for UNIQUE errors on blogs.name', () => {
    expect(isBlogNameConflict(sqliteUniqueError('blogs.name'))).toBe(true)
  })

  it('is false for UNIQUE errors on other columns', () => {
    expect(isBlogNameConflict(sqliteUniqueError('blogs.id'))).toBe(false)
    expect(isBlogNameConflict(sqliteUniqueError('api_keys.id'))).toBe(false)
    expect(isBlogNameConflict(sqliteUniqueError('api_keys.key_hash'))).toBe(false)
  })

  it('is false for non-UNIQUE DB errors, plain Errors, and non-errors', () => {
    const fkErr = new Error('FOREIGN KEY constraint failed') as NodeJS.ErrnoException
    fkErr.code = 'SQLITE_CONSTRAINT_FOREIGNKEY'
    expect(isBlogNameConflict(fkErr)).toBe(false)

    // Missing code field — bare message match is not enough
    expect(isBlogNameConflict(new Error('UNIQUE constraint failed: blogs.name'))).toBe(false)

    expect(isBlogNameConflict(null)).toBe(false)
    expect(isBlogNameConflict(undefined)).toBe(false)
    expect(isBlogNameConflict('not an error')).toBe(false)
    expect(isBlogNameConflict({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'blogs.name' })).toBe(
      false,
    )
  })
})

describe('CreateBlogInputSchema', () => {
  it('accepts empty input; name undefined, theme defaults to minimal', () => {
    const parsed = CreateBlogInputSchema.parse({})
    expect(parsed.name).toBeUndefined()
    expect(parsed.theme).toBe('minimal')
  })

  it('accepts valid DNS-safe names', () => {
    for (const name of ['ai', 'ai-thoughts', 'hot-takes-2026', 'abc', 'a2b', 'a'.repeat(63)]) {
      expect(() => CreateBlogInputSchema.parse({ name })).not.toThrow()
    }
  })

  it('accepts the minimal theme', () => {
    expect(CreateBlogInputSchema.parse({ theme: 'minimal' }).theme).toBe('minimal')
  })

  it('rejects classic and zine (narrowed to minimal-only in v1)', () => {
    expect(() => CreateBlogInputSchema.parse({ theme: 'classic' })).toThrow()
    expect(() => CreateBlogInputSchema.parse({ theme: 'zine' })).toThrow()
  })

  it('rejects invalid theme', () => {
    expect(() => CreateBlogInputSchema.parse({ theme: 'fancy' })).toThrow()
  })

  it.each([
    ['too short (1 char)', 'a'],
    ['leading hyphen', '-abc'],
    ['trailing hyphen', 'abc-'],
    ['uppercase', 'AiThoughts'],
    ['underscore', 'ai_thoughts'],
    ['space', 'ai thoughts'],
    ['too long (64 chars)', 'a'.repeat(64)],
    ['empty string', ''],
    ['only hyphens', '---'],
  ])('rejects name: %s', (_, name) => {
    expect(() => CreateBlogInputSchema.parse({ name })).toThrow()
  })

  it('email: accepts a valid address', () => {
    const parsed = CreateBlogInputSchema.parse({ email: 'user@example.com' })
    expect(parsed.email).toBe('user@example.com')
  })

  it('email: normalizes whitespace and casing', () => {
    const parsed = CreateBlogInputSchema.parse({ email: '  Foo@Example.COM  ' })
    expect(parsed.email).toBe('foo@example.com')
  })

  it('email: empty string and whitespace-only become undefined (treated as not provided)', () => {
    expect(CreateBlogInputSchema.parse({ email: '' }).email).toBeUndefined()
    expect(CreateBlogInputSchema.parse({ email: '   ' }).email).toBeUndefined()
  })

  it('email: omitted entirely is fine', () => {
    expect(CreateBlogInputSchema.parse({}).email).toBeUndefined()
  })

  it('email: rejects malformed addresses', () => {
    expect(() => CreateBlogInputSchema.parse({ email: 'not-an-email' })).toThrow()
    expect(() => CreateBlogInputSchema.parse({ email: '@nope.com' })).toThrow()
  })
})

describe('createBlog', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates an unnamed blog; id matches the 32-char alphabet, 8 chars long', () => {
    const { blog } = createBlog(store, {})
    expect(blog.id).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{8}$/)
    expect(blog.name).toBeNull()
    expect(blog.theme).toBe('minimal')
    expect(typeof blog.createdAt).toBe('string')
  })

  it('creates a named blog and persists the name', () => {
    const { blog } = createBlog(store, { name: 'ai-thoughts' })
    expect(blog.name).toBe('ai-thoughts')

    const row = store.db.prepare('SELECT id, name, theme FROM blogs WHERE id = ?').get(blog.id) as {
      id: string
      name: string
      theme: string
    }
    expect(row.id).toBe(blog.id)
    expect(row.name).toBe('ai-thoughts')
    expect(row.theme).toBe('minimal')
  })

  it('creates a blog with an explicit theme', () => {
    const { blog } = createBlog(store, { theme: 'minimal' })
    expect(blog.theme).toBe('minimal')
  })

  it('generates a different id on each call', () => {
    const a = createBlog(store, {})
    const b = createBlog(store, {})
    expect(a.blog.id).not.toBe(b.blog.id)
  })

  it('throws SlopItError(BLOG_NAME_CONFLICT) when the name is reused', () => {
    createBlog(store, { name: 'taken' })
    let caught: unknown
    try {
      createBlog(store, { name: 'taken' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('BLOG_NAME_CONFLICT')
    expect((caught as SlopItError).message).toContain('taken')
  })

  it('rejects invalid input via Zod (bad name, too short)', () => {
    expect(() => createBlog(store, { name: 'BadName' })).toThrow()
    expect(() => createBlog(store, { name: 'a' })).toThrow()
  })

  it('persists the normalized email to the blogs row but keeps it off the public Blog shape', () => {
    const { blog } = createBlog(store, { name: 'with-email', email: '  User@Example.COM  ' })
    // Public Blog shape stays unchanged — email is private.
    expect(blog).not.toHaveProperty('email')
    // But the row holds the normalized value.
    const row = store.db.prepare('SELECT email FROM blogs WHERE id = ?').get(blog.id) as {
      email: string
    }
    expect(row.email).toBe('user@example.com')
  })

  it('persists null email when none was provided', () => {
    const { blog } = createBlog(store, { name: 'no-email' })
    const row = store.db.prepare('SELECT email FROM blogs WHERE id = ?').get(blog.id) as {
      email: string | null
    }
    expect(row.email).toBeNull()
  })
})

describe('getBlogsByEmail', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-blogs-by-email-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns all blogs persisted under the given (already-normalized) email', () => {
    const a = createBlog(store, { name: 'aa', email: 'shared@example.com' }).blog
    const b = createBlog(store, { name: 'bb', email: 'shared@example.com' }).blog
    createBlog(store, { name: 'cc', email: 'other@example.com' })

    const found = getBlogsByEmail(store, 'shared@example.com')
    expect(found.map((x) => x.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('returns an empty array when no blog matches', () => {
    expect(getBlogsByEmail(store, 'ghost@nowhere.com')).toEqual([])
  })

  it('does not match blogs with NULL email', () => {
    createBlog(store, { name: 'noemail' })
    expect(getBlogsByEmail(store, '')).toEqual([])
  })

  it('returns the public Blog shape — never leaks email back through the result', () => {
    createBlog(store, { name: 'leakcheck', email: 'a@b.com' })
    const [b] = getBlogsByEmail(store, 'a@b.com')
    expect(b).not.toHaveProperty('email')
    expect(b.id).toMatch(/^[a-z0-9]+$/)
    expect(b.name).toBe('leakcheck')
  })
})

describe('createApiKey', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a sk_slop_-prefixed plaintext key for an existing blog', () => {
    const { blog } = createBlog(store, {})
    const { apiKey } = createApiKey(store, blog.id)
    expect(apiKey).toMatch(/^sk_slop_/)
  })

  it('stores the sha256 hash only; plaintext is never persisted', () => {
    const { blog } = createBlog(store, {})
    const { apiKey } = createApiKey(store, blog.id)

    const hash = hashApiKey(apiKey)
    const row = store.db
      .prepare('SELECT key_hash FROM api_keys WHERE blog_id = ?')
      .get(blog.id) as { key_hash: string }
    expect(row.key_hash).toBe(hash)

    // No row where key_hash == plaintext (defense check)
    const plaintextRows = store.db.prepare('SELECT 1 FROM api_keys WHERE key_hash = ?').all(apiKey)
    expect(plaintextRows).toHaveLength(0)
  })

  it('allows multiple keys per blog (each call mints a new one)', () => {
    const { blog } = createBlog(store, {})
    const a = createApiKey(store, blog.id).apiKey
    const b = createApiKey(store, blog.id).apiKey
    expect(a).not.toBe(b)

    const count = store.db
      .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE blog_id = ?')
      .get(blog.id) as { n: number }
    expect(count.n).toBe(2)
  })

  it('throws SlopItError(BLOG_NOT_FOUND) for an unknown blog id', () => {
    let caught: unknown
    try {
      createApiKey(store, 'nonexistent')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('BLOG_NOT_FOUND')
  })

  it('leaves no api_keys row behind when the blog does not exist', () => {
    try {
      createApiKey(store, 'nonexistent')
    } catch {
      /* expected */
    }
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('public barrel exports', () => {
  it('exposes createBlog, createApiKey, getBlog, getBlogByName, getBlogsByEmail, updateBlog, signupBlog, recovery primitives, SlopItError, CreateBlogInputSchema', async () => {
    const mod = await import('../src/index.js')
    expect(typeof mod.createBlog).toBe('function')
    expect(typeof mod.createApiKey).toBe('function')
    expect(typeof mod.getBlog).toBe('function')
    expect(typeof mod.getBlogByName).toBe('function')
    expect(typeof mod.getBlogsByEmail).toBe('function')
    expect(typeof mod.updateBlog).toBe('function')
    expect(typeof mod.signupBlog).toBe('function')
    expect(typeof mod.requestRecoveryByEmail).toBe('function')
    expect(typeof mod.consumeRecoveryToken).toBe('function')
    expect(typeof mod.SlopItError).toBe('function') // class is callable
    expect(typeof mod.CreateBlogInputSchema).toBe('object') // Zod schema
  })
})

describe('getBlogByName', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-getblogbyname-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the blog for a known name', () => {
    const { blog } = createBlog(store, { name: 'my-blog' })
    const fetched = getBlogByName(store, 'my-blog')
    expect(fetched).toEqual(blog)
  })

  it('returns null for an unknown name (no throw — names are user input)', () => {
    expect(getBlogByName(store, 'nope')).toBeNull()
  })

  it('returns null for an unnamed blog (a name parameter never matches a NULL row)', () => {
    createBlog(store, {})
    expect(getBlogByName(store, '')).toBeNull()
  })
})

describe('getBlogInternal', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns a named blog', () => {
    const { blog } = createBlog(store, { name: 'ai-thoughts' })
    const fetched = getBlogInternal(store, blog.id)
    expect(fetched.id).toBe(blog.id)
    expect(fetched.name).toBe('ai-thoughts')
    expect(fetched.theme).toBe('minimal')
  })

  it('returns an unnamed blog', () => {
    const { blog } = createBlog(store, {})
    const fetched = getBlogInternal(store, blog.id)
    expect(fetched.name).toBeNull()
  })

  it('throws SlopItError(BLOG_NOT_FOUND) when the id does not exist', () => {
    let caught: unknown
    try {
      getBlogInternal(store, 'nonexistent')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('BLOG_NOT_FOUND')
    expect((caught as SlopItError).details).toEqual({ blogId: 'nonexistent' })
  })
})

describe('getBlog', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-getblog-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the blog for a known id', () => {
    const { blog } = createBlog(store, { name: 'my-blog' })
    const fetched = getBlog(store, blog.id)
    expect(fetched).toEqual(blog)
  })

  it('throws SlopItError(BLOG_NOT_FOUND) for an unknown id', () => {
    expect(() => getBlog(store, 'missing')).toThrow(
      expect.objectContaining({ code: 'BLOG_NOT_FOUND', details: { blogId: 'missing' } }),
    )
  })
})

describe('getBlog with analytics_json', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-getblog-analytics-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns analytics: undefined when column is NULL', () => {
    const { blog } = createBlog(store, { name: 'noan' })
    const fetched = getBlog(store, blog.id)
    expect(fetched.analytics).toBeUndefined()
  })

  it('returns the parsed analytics object when column is set', () => {
    const { blog } = createBlog(store, { name: 'wian' })
    store.db
      .prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?')
      .run(JSON.stringify({ umami: { scriptUrl: 'https://u/s.js', siteId: 's-1' } }), blog.id)
    const fetched = getBlog(store, blog.id)
    expect(fetched.analytics?.umami?.siteId).toBe('s-1')
  })

  it('throws on corrupted analytics_json (fail loud)', () => {
    const { blog } = createBlog(store, { name: 'bad' })
    store.db
      .prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?')
      .run('{not valid json', blog.id)
    expect(() => getBlog(store, blog.id)).toThrow()
  })

  it('getBlogByName also deserializes analytics_json', () => {
    const { blog } = createBlog(store, { name: 'name-route' })
    store.db
      .prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?')
      .run(JSON.stringify({ plausible: { scriptUrl: 'https://p/s.js', domain: 'd' } }), blog.id)
    const fetched = getBlogByName(store, 'name-route')
    expect(fetched?.analytics?.plausible?.domain).toBe('d')
  })
})

describe('updateBlog', () => {
  let dir: string
  let store: Store
  let outputDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-update-blog-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('sets analytics from null when patch.analytics is provided', () => {
    const { blog } = createBlog(store, { name: 'setan' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })

    const updated = updateBlog(store, renderer, blog.id, {
      analytics: { umami: { scriptUrl: 'https://u/s.js', siteId: 's' } },
    })

    expect(updated.analytics?.umami?.siteId).toBe('s')
    expect(getBlog(store, blog.id).analytics?.umami?.siteId).toBe('s')
  })

  it('clears analytics when patch.analytics is null', () => {
    const { blog } = createBlog(store, { name: 'clear' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    store.db
      .prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?')
      .run(JSON.stringify({ umami: { scriptUrl: 'https://u/s.js', siteId: 's' } }), blog.id)

    const updated = updateBlog(store, renderer, blog.id, { analytics: null })
    expect(updated.analytics).toBeUndefined()
    expect(getBlog(store, blog.id).analytics).toBeUndefined()
  })

  it('no-op on empty patch returns the prior blog unchanged', () => {
    const { blog } = createBlog(store, { name: 'noop' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })

    const updated = updateBlog(store, renderer, blog.id, {})
    expect(updated.id).toBe(blog.id)
    expect(updated.analytics).toBeUndefined()
  })

  it('explicit { analytics: undefined } is treated as omitted (does NOT clear)', () => {
    const { blog } = createBlog(store, { name: 'expund' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    store.db
      .prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?')
      .run(JSON.stringify({ umami: { scriptUrl: 'https://u/s.js', siteId: 's' } }), blog.id)

    // Zod's .optional() preserves explicit undefined on parsed output.
    // updateBlog must treat this case as no-change, NOT as "clear".
    const updated = updateBlog(store, renderer, blog.id, { analytics: undefined })
    expect(updated.analytics?.umami?.siteId).toBe('s')
    expect(getBlog(store, blog.id).analytics?.umami?.siteId).toBe('s')
  })

  it('throws BLOG_NOT_FOUND on unknown blog id', () => {
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    let caught: unknown
    try {
      updateBlog(store, renderer, 'no-such-blog', { analytics: null })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('BLOG_NOT_FOUND')
  })

  it('rejects unknown patch fields via Zod strict()', () => {
    const { blog } = createBlog(store, { name: 'strict' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    // @ts-expect-error testing runtime rejection of unknown keys
    expect(() => updateBlog(store, renderer, blog.id, { theme: 'minimal' })).toThrow()
  })

  it('re-renders every published post when analytics changes', () => {
    const { blog } = createBlog(store, { name: 'rerend' })
    const calls: Array<{ html: string; blogId: string }> = []
    const renderer = createRenderer({
      store,
      outputDir,
      baseUrl: 'https://b.example.com',
      postprocessHtml: (html, blogId) => {
        calls.push({ html, blogId })
        return html.replace('</head>', '<!-- pp -->\n</head>')
      },
    })

    createPost(store, renderer, blog.id, { title: 'A', slug: 'aa', body: 'body' })
    createPost(store, renderer, blog.id, { title: 'B', slug: 'bb', body: 'body' })
    const beforeCount = calls.length

    updateBlog(store, renderer, blog.id, {
      analytics: { plausible: { scriptUrl: 'https://p/s.js', domain: 'd' } },
    })

    // Re-render produced at least 2 HTML writes (one per published post).
    expect(calls.length - beforeCount).toBeGreaterThanOrEqual(2)

    // The post HTML on disk now carries the new postprocess marker.
    const aaHtml = readFileSync(join(outputDir, blog.id, 'aa', 'index.html'), 'utf8')
    expect(aaHtml).toContain('<!-- pp -->')
    const bbHtml = readFileSync(join(outputDir, blog.id, 'bb', 'index.html'), 'utf8')
    expect(bbHtml).toContain('<!-- pp -->')
  })

  it('does NOT re-render when the patch is functionally a no-op (same value)', () => {
    const { blog } = createBlog(store, { name: 'samean' })
    let count = 0
    const renderer = createRenderer({
      store,
      outputDir,
      baseUrl: 'https://b.example.com',
      postprocessHtml: (html) => {
        count++
        return html
      },
    })
    createPost(store, renderer, blog.id, { title: 'A', slug: 'aa', body: 'body' })

    // Set analytics for the first time → re-render fires
    updateBlog(store, renderer, blog.id, {
      analytics: { umami: { scriptUrl: 'https://u/s.js', siteId: 's' } },
    })
    const afterSet = count

    // Re-apply the same analytics → no re-render
    updateBlog(store, renderer, blog.id, {
      analytics: { umami: { scriptUrl: 'https://u/s.js', siteId: 's' } },
    })
    expect(count).toBe(afterSet)
  })

  it('does NOT re-render on empty patch', () => {
    const { blog } = createBlog(store, { name: 'emptyp' })
    let count = 0
    const renderer = createRenderer({
      store,
      outputDir,
      baseUrl: 'https://b.example.com',
      postprocessHtml: (html) => {
        count++
        return html
      },
    })
    createPost(store, renderer, blog.id, { title: 'A', slug: 'aa', body: 'body' })
    const beforeUpdate = count

    updateBlog(store, renderer, blog.id, {})
    expect(count).toBe(beforeUpdate)
  })

  it('sets parentSiteUrl and re-renders so the link appears on disk', () => {
    const { blog } = createBlog(store, { name: 'setparent' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    createPost(store, renderer, blog.id, { title: 'A', slug: 'aa', body: 'body' })

    // Pre-update: no parent-site link in rendered HTML.
    expect(readFileSync(join(outputDir, blog.id, 'index.html'), 'utf8')).not.toContain(
      'class="parent-site"',
    )

    const updated = updateBlog(store, renderer, blog.id, {
      parentSiteUrl: 'https://example.com',
    })
    expect(updated.parentSiteUrl).toBe('https://example.com')
    expect(getBlog(store, blog.id).parentSiteUrl).toBe('https://example.com')

    const indexHtml = readFileSync(join(outputDir, blog.id, 'index.html'), 'utf8')
    expect(indexHtml).toContain('class="parent-site"')
    expect(indexHtml).toContain('href="https://example.com"')
    expect(indexHtml).toContain('← Main site')

    const postHtml = readFileSync(join(outputDir, blog.id, 'aa', 'index.html'), 'utf8')
    expect(postHtml).toContain('class="parent-site"')
  })

  it('clears parentSiteUrl when patch sets it to null', () => {
    const { blog } = createBlog(store, { name: 'clearparent' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    store.db
      .prepare('UPDATE blogs SET parent_site_url = ? WHERE id = ?')
      .run('https://example.com', blog.id)
    createPost(store, renderer, blog.id, { title: 'A', slug: 'aa', body: 'body' })

    const updated = updateBlog(store, renderer, blog.id, { parentSiteUrl: null })
    expect(updated.parentSiteUrl).toBeNull()
    expect(getBlog(store, blog.id).parentSiteUrl).toBeNull()
    expect(readFileSync(join(outputDir, blog.id, 'index.html'), 'utf8')).not.toContain(
      'class="parent-site"',
    )
  })

  it('does NOT re-render when parentSiteUrl is patched to the same value', () => {
    const { blog } = createBlog(store, { name: 'sameparent' })
    let count = 0
    const renderer = createRenderer({
      store,
      outputDir,
      baseUrl: 'https://b.example.com',
      postprocessHtml: (html) => {
        count++
        return html
      },
    })
    createPost(store, renderer, blog.id, { title: 'A', slug: 'aa', body: 'body' })

    updateBlog(store, renderer, blog.id, { parentSiteUrl: 'https://example.com' })
    const afterSet = count

    updateBlog(store, renderer, blog.id, { parentSiteUrl: 'https://example.com' })
    expect(count).toBe(afterSet)
  })

  it('rejects a non-URL parentSiteUrl in the patch', () => {
    const { blog } = createBlog(store, { name: 'badurl' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    expect(() => updateBlog(store, renderer, blog.id, { parentSiteUrl: 'not-a-url' })).toThrow()
  })
})
