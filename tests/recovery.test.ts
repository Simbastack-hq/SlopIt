import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createApiKey, createBlog } from '../src/blogs.js'
import { verifyApiKey } from '../src/auth/api-key.js'
import { consumeRecoveryToken, requestRecoveryByEmail } from '../src/recovery.js'

describe('requestRecoveryByEmail', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-recover-req-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns shouldSend: true and a token when at least one blog matches', () => {
    createBlog(store, { name: 'aa', email: 'user@example.com' })
    const result = requestRecoveryByEmail(store, 'user@example.com')
    expect(result.shouldSend).toBe(true)
    expect(result.token).toMatch(/^rt_/)
    expect(result.token.length).toBeGreaterThan(20)
  })

  it('returns shouldSend: false (but still issues a token) when no blog matches', () => {
    // Always issuing a token keeps the platform code path uniform; the
    // shouldSend flag — not the response shape — drives the email decision.
    const result = requestRecoveryByEmail(store, 'nobody@example.com')
    expect(result.shouldSend).toBe(false)
    expect(result.token).toMatch(/^rt_/)
  })

  it('normalizes the email before lookup (matches across casing/whitespace)', () => {
    createBlog(store, { name: 'bb', email: 'user@example.com' })
    const result = requestRecoveryByEmail(store, '  USER@Example.COM  ')
    expect(result.shouldSend).toBe(true)
  })

  it('persists the hash, not the plaintext token', () => {
    createBlog(store, { name: 'cc', email: 'a@b.com' })
    const { token } = requestRecoveryByEmail(store, 'a@b.com')
    const rows = store.db.prepare('SELECT token_hash FROM recovery_tokens').all() as Array<{
      token_hash: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).not.toBe(token)
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches multiple blogs registered under the same email', () => {
    createBlog(store, { name: 'd1', email: 'multi@example.com' })
    createBlog(store, { name: 'd2', email: 'multi@example.com' })
    const result = requestRecoveryByEmail(store, 'multi@example.com')
    expect(result.shouldSend).toBe(true)
  })

  it('cleanup-on-insert sweeps expired rows so the table is bounded', () => {
    // Insert an already-expired row directly, then trigger a request to
    // exercise the inline cleanup path.
    store.db
      .prepare('INSERT INTO recovery_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)')
      .run('deadbeef'.repeat(8), 'old@example.com', Date.now() - 1000)
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM recovery_tokens').get() as {
      n: number
    }
    expect(before.n).toBe(1)

    requestRecoveryByEmail(store, 'fresh@example.com')

    const remaining = store.db.prepare('SELECT email FROM recovery_tokens').all() as Array<{
      email: string
    }>
    expect(remaining).toHaveLength(1)
    expect(remaining[0].email).toBe('fresh@example.com')
  })
})

describe('consumeRecoveryToken', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-recover-consume-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rotates API keys atomically and returns the new keys for matched blogs', () => {
    const { blog } = createBlog(store, { name: 'rotme', email: 'a@b.com' })
    const oldKey = createApiKey(store, blog.id).apiKey
    expect(verifyApiKey(store, oldKey)).not.toBeNull()

    const { token } = requestRecoveryByEmail(store, 'a@b.com')
    const result = consumeRecoveryToken(store, token)

    expect(result).not.toBeNull()
    expect(result!.blogs).toHaveLength(1)
    expect(result!.blogs[0].blog.id).toBe(blog.id)
    expect(result!.blogs[0].apiKey).toMatch(/^sk_slop_/)
    expect(result!.blogs[0].apiKey).not.toBe(oldKey)

    // Old key is revoked
    expect(verifyApiKey(store, oldKey)).toBeNull()
    // New key works
    expect(verifyApiKey(store, result!.blogs[0].apiKey)?.id).toBe(blog.id)
  })

  it('revokes ALL keys for the blog (not just one), then issues a single new one', () => {
    const { blog } = createBlog(store, { name: 'multikey', email: 'a@b.com' })
    const k1 = createApiKey(store, blog.id).apiKey
    const k2 = createApiKey(store, blog.id).apiKey
    const k3 = createApiKey(store, blog.id).apiKey

    const { token } = requestRecoveryByEmail(store, 'a@b.com')
    const result = consumeRecoveryToken(store, token)

    expect(result!.blogs).toHaveLength(1)
    for (const old of [k1, k2, k3]) {
      expect(verifyApiKey(store, old)).toBeNull()
    }
    const count = store.db
      .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE blog_id = ?')
      .get(blog.id) as { n: number }
    expect(count.n).toBe(1)
  })

  it('rotates all blogs registered under the same email at consume time', () => {
    const { blog: a } = createBlog(store, { name: 'multi-a', email: 'shared@example.com' })
    const { blog: b } = createBlog(store, { name: 'multi-b', email: 'shared@example.com' })
    createApiKey(store, a.id)
    createApiKey(store, b.id)

    const { token } = requestRecoveryByEmail(store, 'shared@example.com')
    const result = consumeRecoveryToken(store, token)

    expect(result!.blogs.map((x) => x.blog.id).sort()).toEqual([a.id, b.id].sort())
    for (const issued of result!.blogs) {
      expect(verifyApiKey(store, issued.apiKey)?.id).toBe(issued.blog.id)
    }
  })

  it('returns { blogs: [] } when the token is valid but no blog currently matches the email', () => {
    // Token issued for a no-match request — consume should still mark
    // it consumed (single-use) and return an empty rotation set.
    const { token, shouldSend } = requestRecoveryByEmail(store, 'nobody@example.com')
    expect(shouldSend).toBe(false)

    const result = consumeRecoveryToken(store, token)
    expect(result).not.toBeNull()
    expect(result!.blogs).toEqual([])

    const row = store.db
      .prepare('SELECT consumed_at FROM recovery_tokens WHERE token_hash IS NOT NULL')
      .get() as { consumed_at: number | null }
    expect(row.consumed_at).not.toBeNull()
  })

  it('returns null for an unknown token (no enumeration leak)', () => {
    expect(consumeRecoveryToken(store, 'rt_nonsense')).toBeNull()
  })

  it('returns null for an already-consumed token (single-use)', () => {
    createBlog(store, { name: 'once', email: 'a@b.com' })
    const { token } = requestRecoveryByEmail(store, 'a@b.com')

    const first = consumeRecoveryToken(store, token)
    expect(first).not.toBeNull()

    const second = consumeRecoveryToken(store, token)
    expect(second).toBeNull()
  })

  it('returns null for an expired token', () => {
    createBlog(store, { name: 'expire', email: 'a@b.com' })
    const { token } = requestRecoveryByEmail(store, 'a@b.com')

    // Force-expire the row directly. Sentinel is past the current epoch.
    store.db
      .prepare('UPDATE recovery_tokens SET expires_at = ? WHERE expires_at IS NOT NULL')
      .run(Date.now() - 1)

    expect(consumeRecoveryToken(store, token)).toBeNull()
  })
})
