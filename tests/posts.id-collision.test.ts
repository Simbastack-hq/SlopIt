import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock node:crypto so randomBytes is deterministic (all zeros → id 'aaaaaaaa').
// Mock is file-scoped; other test files get the real implementation.
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return {
    ...actual,
    randomBytes: (size: number) => Buffer.alloc(size),
  }
})

// Import AFTER the mock.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
import { createPost } from '../src/posts.js'
import { createRenderer } from '../src/rendering/generator.js'
import { SlopItError } from '../src/errors.js'

describe('createPost — narrow error mapping through the function', () => {
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

  it('lets posts.id PK collisions bubble raw (does NOT mislabel as POST_SLUG_CONFLICT)', () => {
    const { blog } = createBlog(store, { name: 'bb' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })

    // First createPost succeeds (generates id "aaaaaaaa" via the mock).
    const first = createPost(store, renderer, blog.id, {
      title: 'First',
      body: 'x',
      slug: 'first-slug',
    })
    expect(first.post.id).toMatch(/^a{8}$/) // sanity: mock took effect

    // Second createPost uses a DIFFERENT slug (so preflight passes) but
    // generates the same id via the mock → posts.id PK violation at INSERT.
    let caught: unknown
    try {
      createPost(store, renderer, blog.id, {
        title: 'Second',
        body: 'y',
        slug: 'second-slug',
      })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(SlopItError) // NOT wrapped
    expect((caught as Error).message).toContain('posts.id')
    expect((caught as NodeJS.ErrnoException).code).toBe('SQLITE_CONSTRAINT_PRIMARYKEY')
  })
})
