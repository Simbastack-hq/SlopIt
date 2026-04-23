import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
import { SlopItError } from '../src/errors.js'
import { createRenderer } from '../src/rendering/generator.js'
import { PostInputSchema } from '../src/schema/index.js'
import {
  createPost,
  isPostSlugConflict,
  autoExcerpt,
  listPublishedPostsForBlog,
} from '../src/posts.js'

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
      expect(() =>
        PostInputSchema.parse({
          title: '日本語のタイトル',
          body: 'x',
          slug: 'ja-title',
        }),
      ).not.toThrow()
    })

    it('accepts a valid title without explicit slug', () => {
      expect(() =>
        PostInputSchema.parse({
          title: 'Valid Title',
          body: 'x',
        }),
      ).not.toThrow()
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

    expect(
      isPostSlugConflict(new Error('UNIQUE constraint failed: posts.blog_id, posts.slug')),
    ).toBe(false)

    expect(isPostSlugConflict(null)).toBe(false)
    expect(isPostSlugConflict(undefined)).toBe(false)
    expect(isPostSlugConflict('not an error')).toBe(false)
    expect(
      isPostSlugConflict({
        code: 'SQLITE_CONSTRAINT_UNIQUE',
        message: 'posts.blog_id, posts.slug',
      }),
    ).toBe(false)
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
    insert.run('p1', blog.id, 'first', 'First', 'body1', '2025-01-01T00:00:00Z')
    insert.run('p2', blog.id, 'second', 'Second', 'body2', '2025-06-01T00:00:00Z')
    insert.run('p3', blog.id, 'third', 'Third', 'body3', '2025-03-01T00:00:00Z')

    const posts = listPublishedPostsForBlog(store, blog.id)
    expect(posts.map((p) => p.slug)).toEqual(['second', 'third', 'first'])
  })

  it('excludes drafts', () => {
    const { blog } = createBlog(store, { name: 'seed' })
    const insert = store.db.prepare(
      `INSERT INTO posts (id, blog_id, slug, title, body, status, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('p1', blog.id, 'pub', 'Pub', 'b', 'published', '2025-01-01T00:00:00Z')
    insert.run('p2', blog.id, 'draft', 'Draft', 'b', 'draft', null)

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

describe('createPost', () => {
  let dir: string
  let store: Store
  let outputDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function newRenderer(baseUrl = 'https://test.example.com') {
    return createRenderer({ store, outputDir, baseUrl })
  }

  it('creates a published post: DB row, post file, blog index, CSS', () => {
    const { blog } = createBlog(store, { name: 'my-blog' })
    const r = newRenderer()

    const { post, postUrl } = createPost(store, r, blog.id, {
      title: 'Hello World',
      body: '# Hello\n\nBody text.',
    })

    expect(post.slug).toBe('hello-world')
    expect(post.status).toBe('published')
    expect(post.publishedAt).not.toBeNull()
    expect(postUrl).toBe('https://test.example.com/hello-world/')

    expect(existsSync(join(outputDir, blog.id, 'hello-world', 'index.html'))).toBe(true)
    expect(existsSync(join(outputDir, blog.id, 'index.html'))).toBe(true)
    expect(existsSync(join(outputDir, blog.id, 'style.css'))).toBe(true)
  })

  it('creates a draft: DB row only, no files, no postUrl', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const result = createPost(store, r, blog.id, {
      title: 'Draft post',
      body: 'Draft body',
      status: 'draft',
    })

    expect(result.post.status).toBe('draft')
    expect(result.post.publishedAt).toBeNull()
    expect(result.postUrl).toBeUndefined()

    expect(existsSync(join(outputDir, blog.id, 'draft-post'))).toBe(false)
    expect(existsSync(join(outputDir, blog.id, 'index.html'))).toBe(false)
  })

  it('honors an explicit custom slug verbatim', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'Any title',
      body: 'x',
      slug: 'custom-slug',
    })

    expect(post.slug).toBe('custom-slug')
  })

  it('persists tags as a JSON array (round-trips)', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'Tagged',
      body: 'x',
      tags: ['ai', 'content', 'weekly'],
    })

    expect(post.tags).toEqual(['ai', 'content', 'weekly'])

    const row = store.db.prepare('SELECT tags FROM posts WHERE id = ?').get(post.id) as {
      tags: string
    }
    expect(JSON.parse(row.tags)).toEqual(['ai', 'content', 'weekly'])
  })

  it('auto-generates an excerpt when none is provided', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'Titled',
      body: '# Hi\n\nThis is the body content that should become an excerpt.',
    })

    expect(post.excerpt).toBeDefined()
    expect(post.excerpt).not.toBe('')
    expect(post.excerpt).toContain('body content')
  })

  it('uses an explicit excerpt when provided', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'T',
      body: 'anything',
      excerpt: 'Explicit summary.',
    })

    expect(post.excerpt).toBe('Explicit summary.')
  })

  it('throws BLOG_NOT_FOUND (with details.blogId) for a missing blog', () => {
    const r = newRenderer()
    let caught: unknown
    try {
      createPost(store, r, 'nonexistent', { title: 'T', body: 'x' })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('BLOG_NOT_FOUND')
    expect((caught as SlopItError).details).toEqual({ blogId: 'nonexistent' })
  })

  it('throws POST_SLUG_CONFLICT (with details.slug) on same-blog-same-slug', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()
    createPost(store, r, blog.id, { title: 'First', body: 'x', slug: 'taken' })

    let caught: unknown
    try {
      createPost(store, r, blog.id, { title: 'Second', body: 'y', slug: 'taken' })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('POST_SLUG_CONFLICT')
    expect((caught as SlopItError).details).toEqual({ slug: 'taken' })
  })

  it('allows the same slug across different blogs (no cross-blog conflict)', () => {
    const { blog: a } = createBlog(store, { name: 'alpha' })
    const { blog: b } = createBlog(store, { name: 'beta' })
    const r = newRenderer()

    createPost(store, r, a.id, { title: 'T', body: 'x', slug: 'shared' })
    createPost(store, r, b.id, { title: 'T', body: 'y', slug: 'shared' })

    expect(listPublishedPostsForBlog(store, a.id).map((p) => p.slug)).toEqual(['shared'])
    expect(listPublishedPostsForBlog(store, b.id).map((p) => p.slug)).toEqual(['shared'])
  })

  it('rejects bad input via Zod (pre-DB)', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    expect(() => createPost(store, r, blog.id, { title: '', body: 'x' })).toThrow()
    expect(() => createPost(store, r, blog.id, { title: 'a'.repeat(201), body: 'x' })).toThrow()
    expect(() => createPost(store, r, blog.id, { title: 'T', body: '' })).toThrow()
  })

  it('compensates by DELETEing the row when render fails and bubbles the original error', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    // Make the output path a file, so mkdirSync inside renderPost will fail
    // with ENOTDIR / EEXIST when it tries to create a directory with that name.
    writeFileSync(outputDir, 'not a dir')

    let caught: unknown
    try {
      createPost(store, r, blog.id, { title: 'T', body: 'x' })
    } catch (e) {
      caught = e
    }

    // Must be the original OS error, not a wrapped SlopItError — spec
    // decision #6: createPost always throws the original render error.
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(SlopItError)

    // The underlying failure is a filesystem error from node:fs. Assert the
    // code is one of the expected OS codes so we can confirm we did not
    // accidentally swallow the original error and rethrow something else.
    const code = (caught as NodeJS.ErrnoException).code
    expect(code === 'ENOTDIR' || code === 'EEXIST').toBe(true)

    // Compensation ran: no post row remains.
    const count = store.db
      .prepare('SELECT COUNT(*) AS n FROM posts WHERE blog_id = ?')
      .get(blog.id) as { n: number }
    expect(count.n).toBe(0)
  })

  it('returns the full Post shape with created_at and updated_at', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'T',
      body: 'x',
    })

    expect(typeof post.id).toBe('string')
    expect(typeof post.createdAt).toBe('string')
    expect(typeof post.updatedAt).toBe('string')
    expect(post.blogId).toBe(blog.id)
  })

  it('passes author / coverImage / seoTitle / seoDescription through to the DB', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'T',
      body: 'x',
      author: 'Agent 47',
      coverImage: 'https://example.com/img.png',
      seoTitle: 'SEO T',
      seoDescription: 'SEO D',
    })

    expect(post.author).toBe('Agent 47')
    expect(post.coverImage).toBe('https://example.com/img.png')
    expect(post.seoTitle).toBe('SEO T')
    expect(post.seoDescription).toBe('SEO D')
  })

  it('blog index includes the newly published post', () => {
    const { blog } = createBlog(store, { name: 'bb' })
    const r = newRenderer()
    createPost(store, r, blog.id, { title: 'First Post', body: 'x' })

    const indexHtml = readFileSync(join(outputDir, blog.id, 'index.html'), 'utf8')
    expect(indexHtml).toContain('>First Post<')
  })
})

describe('public barrel — createPost exports', () => {
  it('exposes createPost and PostInputSchema', async () => {
    const mod = await import('../src/index.js')
    expect(typeof mod.createPost).toBe('function')
    expect(typeof mod.PostInputSchema).toBe('object')
  })

  it('exposes the POST_SLUG_CONFLICT code through SlopItError', () => {
    const err = new SlopItError('POST_SLUG_CONFLICT', 'x', { slug: 's' })
    expect(err.code).toBe('POST_SLUG_CONFLICT')
  })
})

describe('createPost — INSERT-time narrow-match branch', () => {
  let dir: string
  let store: Store
  let outputDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('maps an INSERT-time UNIQUE conflict to POST_SLUG_CONFLICT even when preflight missed', () => {
    const { blog } = createBlog(store, {})
    const r = createRenderer({ store, outputDir, baseUrl: 'https://test.example.com' })

    // Seed a post with slug 'race'.
    createPost(store, r, blog.id, { title: 'First', body: 'x', slug: 'race' })

    // Stub the preflight SELECT so it reports no conflict. The INSERT will
    // then hit the real UNIQUE(blog_id, slug) violation, exercising the
    // narrow-match branch inside createPost's try/catch.
    const realPrepare = store.db.prepare.bind(store.db)
    vi.spyOn(store.db, 'prepare').mockImplementation(((sql: string) => {
      if (/SELECT 1 FROM posts WHERE blog_id = \? AND slug = \?/.test(sql)) {
        return { get: () => undefined } as any
      }
      return realPrepare(sql)
    }) as any)

    let caught: unknown
    try {
      createPost(store, r, blog.id, { title: 'Second', body: 'y', slug: 'race' })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('POST_SLUG_CONFLICT')
    expect((caught as SlopItError).details).toEqual({ slug: 'race' })
  })
})

describe('createPost — compensation DELETE best-effort', () => {
  let dir: string
  let store: Store
  let outputDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('swallows a DELETE failure during compensation and still throws the original render error', () => {
    const { blog } = createBlog(store, {})
    const r = createRenderer({ store, outputDir, baseUrl: 'https://test.example.com' })

    // Force render to fail: make output a file so mkdirSync throws.
    writeFileSync(outputDir, 'not a dir')

    // Stub the DELETE prepare to throw. Other queries are unaffected.
    const realPrepare = store.db.prepare.bind(store.db)
    vi.spyOn(store.db, 'prepare').mockImplementation((sql: string) => {
      if (/DELETE FROM posts WHERE id = \?/.test(sql)) {
        throw new Error('simulated DELETE failure')
      }
      return realPrepare(sql)
    })

    let caught: unknown
    try {
      createPost(store, r, blog.id, { title: 'T', body: 'x' })
    } catch (e) {
      caught = e
    }

    // Original render error bubbles, not the DELETE failure.
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).not.toContain('simulated DELETE failure')
    expect(caught).not.toBeInstanceOf(SlopItError)
  })
})
