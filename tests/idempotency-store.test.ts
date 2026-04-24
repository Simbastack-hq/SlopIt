import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import {
  lookupIdempotencyRecord,
  recordIdempotencyResponse,
  type IdempotencyScope,
} from '../src/idempotency-store.js'

describe('idempotency-store', () => {
  let dir: string
  let store: Store

  const makeScope = (overrides: Partial<IdempotencyScope> = {}): IdempotencyScope => ({
    key: 'k-1',
    apiKeyHash: 'hash-a',
    method: 'POST',
    path: '/blogs/b/posts',
    requestHash: 'req-1',
    ...overrides,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-idem-store-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lookup returns miss on empty table', () => {
    expect(lookupIdempotencyRecord(store, makeScope())).toEqual({ status: 'miss' })
  })

  it('record then lookup returns hit-match', () => {
    recordIdempotencyResponse(store, makeScope(), '{"ok":true}', 200)
    const result = lookupIdempotencyRecord(store, makeScope())
    expect(result).toEqual({ status: 'hit-match', body: '{"ok":true}', responseStatus: 200 })
  })

  it('record then lookup with different requestHash returns hit-mismatch', () => {
    recordIdempotencyResponse(store, makeScope(), '{"ok":true}', 200)
    const result = lookupIdempotencyRecord(store, makeScope({ requestHash: 'req-2' }))
    expect(result).toEqual({ status: 'hit-mismatch' })
  })

  it('scope isolates by method — same key different method is a miss', () => {
    recordIdempotencyResponse(store, makeScope({ method: 'POST' }), '{"ok":true}', 200)
    expect(lookupIdempotencyRecord(store, makeScope({ method: 'MCP' }))).toEqual({ status: 'miss' })
  })

  it('scope isolates by path (REST path vs MCP tool name)', () => {
    recordIdempotencyResponse(store, makeScope({ method: 'MCP', path: 'create_post' }), '{}', 200)
    expect(
      lookupIdempotencyRecord(store, makeScope({ method: 'MCP', path: 'update_post' })),
    ).toEqual({ status: 'miss' })
  })

  it('scope isolates by apiKeyHash — different callers, same key, independent', () => {
    recordIdempotencyResponse(store, makeScope({ apiKeyHash: 'a' }), '{"first":1}', 200)
    const second = lookupIdempotencyRecord(store, makeScope({ apiKeyHash: 'b' }))
    expect(second).toEqual({ status: 'miss' })
  })

  it('recordIdempotencyResponse throws when apiKeyHash is empty (defensive)', () => {
    expect(() =>
      recordIdempotencyResponse(store, makeScope({ apiKeyHash: '' }), '{}', 200),
    ).toThrow(/apiKeyHash must be non-empty/)
  })

  it('lookupIdempotencyRecord throws when apiKeyHash is empty (defensive)', () => {
    expect(() => lookupIdempotencyRecord(store, makeScope({ apiKeyHash: '' }))).toThrow(
      /apiKeyHash must be non-empty/,
    )
  })
})
