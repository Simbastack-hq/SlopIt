import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'

describe('idempotency_keys table', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-idem-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('exists with expected columns', () => {
    const cols = store.db.prepare("PRAGMA table_info('idempotency_keys')").all() as {
      name: string
      type: string
      notnull: number
    }[]
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(byName.key).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.api_key_hash).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.method).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.path).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.request_hash).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.response_status).toMatchObject({ type: 'INTEGER', notnull: 1 })
    expect(byName.response_body).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.created_at).toMatchObject({ type: 'TEXT', notnull: 1 })
  })

  it('enforces composite primary key (key, api_key_hash, method, path)', () => {
    const insert = store.db.prepare(
      `INSERT INTO idempotency_keys (key, api_key_hash, method, path, request_hash, response_status, response_body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('k1', '', 'POST', '/signup', 'h1', 200, '{}')
    // Same PK → UNIQUE violation
    expect(() => insert.run('k1', '', 'POST', '/signup', 'h2', 200, '{}')).toThrow(
      /UNIQUE constraint failed/,
    )
    // Different path → OK
    expect(() => insert.run('k1', '', 'POST', '/other', 'h1', 200, '{}')).not.toThrow()
  })
})
