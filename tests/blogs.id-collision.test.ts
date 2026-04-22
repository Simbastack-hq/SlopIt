import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Force randomBytes to return all zeros so generateShortId always
// produces the same id ("aaaaaaaa"). Mock is scoped to this file.
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return {
    ...actual,
    randomBytes: (size: number) => Buffer.alloc(size),
  }
})

// Import AFTER the mock so blogs.ts binds to the mocked randomBytes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
import { SlopItError } from '../src/errors.js'

describe('createBlog — narrow error mapping through the function', () => {
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

  it('lets a non-name UNIQUE error (blogs.id collision) bubble raw; does NOT mislabel as BLOG_NAME_CONFLICT', () => {
    // First call succeeds.
    const first = createBlog(store, {})

    // Second call generates the same id (mock) → blogs.id UNIQUE.
    let caught: unknown
    try {
      createBlog(store, {})
    } catch (e) {
      caught = e
    }

    expect(first.blog.id).toMatch(/^[a]{8}$/) // sanity: mock took effect
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(SlopItError)
    expect((caught as Error).message).toContain('blogs.id')
    // SQLite raises PRIMARYKEY (not UNIQUE) for PRIMARY KEY collisions —
    // isBlogNameConflict checks for SQLITE_CONSTRAINT_UNIQUE so it correctly
    // returns false and the raw error bubbles unwrapped.
    expect((caught as NodeJS.ErrnoException).code).toBe('SQLITE_CONSTRAINT_PRIMARYKEY')
  })
})
