import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
import { PostInputSchema } from '../src/schema/index.js'
import { isPostSlugConflict, autoExcerpt, listPublishedPostsForBlog } from '../src/posts.js'

describe('PostInputSchema', () => {
  it('accepts the minimum well-formed input', () => {
    const parsed = PostInputSchema.parse({
      title: 'Hello',
      body: 'Hello world',
    })
    expect(parsed.title).toBe('Hello')
    expect(parsed.body).toBe('Hello world')
    expect(parsed.status).toBe('published')
    expect(parsed.tags).toEqual([])
  })

  it('trims leading/trailing whitespace from title and body', () => {
    const parsed = PostInputSchema.parse({ title: '  Hello  ', body: '  body content  ' })
    expect(parsed.title).toBe('Hello')
    expect(parsed.body).toBe('body content')
  })

  it('accepts all optional fields', () => {
    const parsed = PostInputSchema.parse({
      title: 'A post',
      slug: 'a-post',
      body: 'hello',
      excerpt: 'summary',
      tags: ['ai', 'content'],
      status: 'draft',
      seoTitle: 'SEO title',
      seoDescription: 'SEO description',
      author: 'Agent 47',
      coverImage: 'https://example.com/img.png',
    })
    expect(parsed.slug).toBe('a-post')
    expect(parsed.status).toBe('draft')
    expect(parsed.tags).toEqual(['ai', 'content'])
  })

  it.each([
    ['empty title', { title: '', body: 'x' }],
    ['whitespace-only title', { title: '   ', body: 'x' }],
    ['title over 200 chars', { title: 'a'.repeat(201), body: 'x' }],
    ['empty body', { title: 'T', body: '' }],
    ['whitespace-only body', { title: 'T', body: '   ' }],
    ['slug too short (1 char)', { title: 'T', body: 'x', slug: 'a' }],
    ['slug over 100 chars', { title: 'T', body: 'x', slug: 'a'.repeat(101) }],
    ['slug with uppercase', { title: 'T', body: 'x', slug: 'Not-Valid' }],
    ['slug with underscore', { title: 'T', body: 'x', slug: 'bad_slug' }],
    ['slug with leading hyphen', { title: 'T', body: 'x', slug: '-leading' }],
    ['slug with trailing hyphen', { title: 'T', body: 'x', slug: 'trailing-' }],
    ['invalid status', { title: 'T', body: 'x', status: 'archived' }],
    ['coverImage not a URL', { title: 'T', body: 'x', coverImage: 'not-a-url' }],
    ['seoTitle over 200 chars', { title: 'T', body: 'x', seoTitle: 'a'.repeat(201) }],
    ['seoDescription over 300 chars', { title: 'T', body: 'x', seoDescription: 'a'.repeat(301) }],
    ['author over 100 chars', { title: 'T', body: 'x', author: 'a'.repeat(101) }],
    ['excerpt over 300 chars', { title: 'T', body: 'x', excerpt: 'a'.repeat(301) }],
  ])('rejects %s', (_, input) => {
    expect(() => PostInputSchema.parse(input)).toThrow()
  })

  describe('auto-slug validation (superRefine)', () => {
    it('rejects titles that would produce empty auto-slug when slug is omitted', () => {
      expect(() => PostInputSchema.parse({ title: '!!!', body: 'x' })).toThrow()
      expect(() => PostInputSchema.parse({ title: '日本語のタイトル', body: 'x' })).toThrow()
    })

    it('accepts titles with no slug-compatible chars when caller supplies an explicit slug', () => {
      expect(() => PostInputSchema.parse({
        title: '日本語のタイトル',
        body: 'x',
        slug: 'ja-title',
      })).not.toThrow()
    })

    it('accepts a valid title without explicit slug', () => {
      expect(() => PostInputSchema.parse({
        title: 'Valid Title',
        body: 'x',
      })).not.toThrow()
    })
  })
})

describe('isPostSlugConflict', () => {
  function sqliteUniqueError(constraint: string): Error {
    const e = new Error(`UNIQUE constraint failed: ${constraint}`) as NodeJS.ErrnoException
    e.code = 'SQLITE_CONSTRAINT_UNIQUE'
    return e
  }

  it('is true for UNIQUE errors on posts.blog_id, posts.slug (compound key)', () => {
    expect(isPostSlugConflict(sqliteUniqueError('posts.blog_id, posts.slug'))).toBe(true)
  })

  it('is false for UNIQUE errors on other columns', () => {
    expect(isPostSlugConflict(sqliteUniqueError('posts.id'))).toBe(false)
    expect(isPostSlugConflict(sqliteUniqueError('posts.slug'))).toBe(false)
    expect(isPostSlugConflict(sqliteUniqueError('blogs.name'))).toBe(false)
    expect(isPostSlugConflict(sqliteUniqueError('blogs.id'))).toBe(false)
    expect(isPostSlugConflict(sqliteUniqueError('api_keys.key_hash'))).toBe(false)
  })

  it('is false for FK errors, plain Errors, and non-Error values', () => {
    const fkErr = new Error('FOREIGN KEY constraint failed') as NodeJS.ErrnoException
    fkErr.code = 'SQLITE_CONSTRAINT_FOREIGNKEY'
    expect(isPostSlugConflict(fkErr)).toBe(false)

    expect(isPostSlugConflict(new Error('UNIQUE constraint failed: posts.blog_id, posts.slug'))).toBe(false)

    expect(isPostSlugConflict(null)).toBe(false)
    expect(isPostSlugConflict(undefined)).toBe(false)
    expect(isPostSlugConflict('not an error')).toBe(false)
    expect(isPostSlugConflict({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'posts.blog_id, posts.slug',
    })).toBe(false)
  })
})

describe('autoExcerpt', () => {
  it('returns body unchanged when short enough', () => {
    expect(autoExcerpt('short body')).toBe('short body')
  })

  it('strips common markdown syntax', () => {
    expect(autoExcerpt('# Heading\n\nBody here.')).toBe('Heading Body here.')
    expect(autoExcerpt('**bold** and *italic* and `code`')).toBe('bold and italic and code')
    expect(autoExcerpt('> a blockquote')).toBe('a blockquote')
    expect(autoExcerpt('- item 1\n- item 2')).toBe('item 1 item 2')
    expect(autoExcerpt('[text](url)')).toBe('text')
    expect(autoExcerpt('![alt](url)')).toBe('')
  })

  it('collapses whitespace', () => {
    expect(autoExcerpt('a   b\n\nc')).toBe('a b c')
  })

  it('truncates at ~160 chars and appends an ellipsis', () => {
    const longBody = 'word '.repeat(50)
    const excerpt = autoExcerpt(longBody)
    expect(excerpt.length).toBeLessThanOrEqual(161)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('does not append ellipsis when under the threshold', () => {
    expect(autoExcerpt('short').endsWith('…')).toBe(false)
  })

  it('handles empty or whitespace-only body gracefully', () => {
    expect(autoExcerpt('')).toBe('')
    expect(autoExcerpt('   ')).toBe('')
  })
})

describe('listPublishedPostsForBlog', () => {
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

  it('returns an empty array when the blog has no posts', () => {
    const { blog } = createBlog(store, {})
    expect(listPublishedPostsForBlog(store, blog.id)).toEqual([])
  })

  it('returns published posts newest-first', () => {
    const { blog } = createBlog(store, { name: 'seed' })
    const insert = store.db.prepare(
      `INSERT INTO posts (id, blog_id, slug, title, body, status, published_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?)`,
    )
    insert.run('p1', blog.id, 'first',  'First',  'body1', '2025-01-01T00:00:00Z')
    insert.run('p2', blog.id, 'second', 'Second', 'body2', '2025-06-01T00:00:00Z')
    insert.run('p3', blog.id, 'third',  'Third',  'body3', '2025-03-01T00:00:00Z')

    const posts = listPublishedPostsForBlog(store, blog.id)
    expect(posts.map((p) => p.slug)).toEqual(['second', 'third', 'first'])
  })

  it('excludes drafts', () => {
    const { blog } = createBlog(store, { name: 'seed' })
    const insert = store.db.prepare(
      `INSERT INTO posts (id, blog_id, slug, title, body, status, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('p1', blog.id, 'pub',   'Pub',   'b', 'published', '2025-01-01T00:00:00Z')
    insert.run('p2', blog.id, 'draft', 'Draft', 'b', 'draft',     null)

    const posts = listPublishedPostsForBlog(store, blog.id)
    expect(posts.map((p) => p.slug)).toEqual(['pub'])
  })

  it('scopes by blog_id (does not leak posts from other blogs)', () => {
    const { blog: a } = createBlog(store, { name: 'alpha' })
    const { blog: b } = createBlog(store, { name: 'beta' })
    const insert = store.db.prepare(
      `INSERT INTO posts (id, blog_id, slug, title, body, status, published_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?)`,
    )
    insert.run('p1', a.id, 'a-post', 'A', 'x', '2025-01-01T00:00:00Z')
    insert.run('p2', b.id, 'b-post', 'B', 'x', '2025-02-01T00:00:00Z')

    expect(listPublishedPostsForBlog(store, a.id).map((p) => p.slug)).toEqual(['a-post'])
    expect(listPublishedPostsForBlog(store, b.id).map((p) => p.slug)).toEqual(['b-post'])
  })
})
