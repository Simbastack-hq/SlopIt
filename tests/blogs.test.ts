import { mkdtempSync, rmSync } from 'node:fs'
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
} from '../src/blogs.js'
import { hashApiKey } from '../src/auth/api-key.js'
import { SlopItError } from '../src/errors.js'
import { CreateBlogInputSchema } from '../src/schema/index.js'

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
  it('exposes createBlog, createApiKey, getBlog, getBlogByName, getBlogsByEmail, signupBlog, recovery primitives, SlopItError, CreateBlogInputSchema', async () => {
    const mod = await import('../src/index.js')
    expect(typeof mod.createBlog).toBe('function')
    expect(typeof mod.createApiKey).toBe('function')
    expect(typeof mod.getBlog).toBe('function')
    expect(typeof mod.getBlogByName).toBe('function')
    expect(typeof mod.getBlogsByEmail).toBe('function')
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
