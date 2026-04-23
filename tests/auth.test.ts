import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog, createApiKey } from '../src/blogs.js'
import { verifyApiKey } from '../src/auth/api-key.js'

describe('verifyApiKey', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-verifykey-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the blog for a valid key', () => {
    const { blog } = createBlog(store, { name: 'authblog' })
    const { apiKey } = createApiKey(store, blog.id)
    const result = verifyApiKey(store, apiKey)
    expect(result?.id).toBe(blog.id)
    expect(result?.name).toBe('authblog')
  })

  it('returns null for an unknown key', () => {
    expect(verifyApiKey(store, 'sk_slop_doesnotexist')).toBeNull()
  })

  it('returns null for a malformed key', () => {
    expect(verifyApiKey(store, 'not-a-key')).toBeNull()
    expect(verifyApiKey(store, '')).toBeNull()
  })

  it('returns null for a key hash that exists but is for a deleted blog', () => {
    // FK ON DELETE CASCADE handles the row removal; this test just guards
    // against a regression where verifyApiKey returns a dangling blog.
    const { blog } = createBlog(store, { name: 'tmpblog' })
    const { apiKey } = createApiKey(store, blog.id)
    store.db.prepare('DELETE FROM blogs WHERE id = ?').run(blog.id)
    expect(verifyApiKey(store, apiKey)).toBeNull()
  })
})
