import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
import { isBlogNameConflict } from '../src/blogs.js'
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
    expect(isBlogNameConflict({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'blogs.name' })).toBe(false)
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

  it('accepts all three valid themes', () => {
    for (const theme of ['minimal', 'classic', 'zine'] as const) {
      expect(CreateBlogInputSchema.parse({ theme }).theme).toBe(theme)
    }
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

    const row = store.db
      .prepare('SELECT id, name, theme FROM blogs WHERE id = ?')
      .get(blog.id) as { id: string; name: string; theme: string }
    expect(row.id).toBe(blog.id)
    expect(row.name).toBe('ai-thoughts')
    expect(row.theme).toBe('minimal')
  })

  it('creates a blog with an explicit theme', () => {
    const { blog } = createBlog(store, { theme: 'zine' })
    expect(blog.theme).toBe('zine')
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
})
