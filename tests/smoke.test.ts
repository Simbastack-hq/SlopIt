import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/db/store.js'
import { generateApiKey, hashApiKey, isApiKey } from '../src/auth/api-key.js'
import { renderMarkdown } from '../src/rendering/markdown.js'

describe('createStore', () => {
  it('opens a sqlite database and applies core migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    const store = createStore({ dbPath: join(dir, 'test.db') })

    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)

    expect(tables).toContain('blogs')
    expect(tables).toContain('posts')
    expect(tables).toContain('api_keys')
    expect(tables).toContain('schema_migrations')

    const applied = store.db
      .prepare('SELECT filename FROM schema_migrations')
      .all()
      .map((r) => (r as { filename: string }).filename)
    expect(applied).toContain('001_core_init.sql')

    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is idempotent across re-opens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    const path = join(dir, 'test.db')

    const first = createStore({ dbPath: path })
    first.close()
    const second = createStore({ dbPath: path })

    const rows = second.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()
    expect((rows as { n: number }).n).toBe(5)

    second.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('api-key', () => {
  it('generates prefixed keys and hashes deterministically', () => {
    const key = generateApiKey()
    expect(isApiKey(key)).toBe(true)
    expect(key.startsWith('sk_slop_')).toBe(true)
    expect(hashApiKey(key)).toBe(hashApiKey(key))
    expect(hashApiKey(key)).not.toBe(key)
  })

  // The key body must be alphanumeric only (no `-` or `_`) — those chars
  // are visually ambiguous next to the `-----` separators in the
  // onboarding credential block and silently truncated by consumers.
  // The full body is checked, not just the trailing position, because the
  // alphabet is constrained at the source — there is no scenario where
  // any position should be punctuation.
  it('produces keys whose body is alphanumeric only', () => {
    for (let i = 0; i < 1000; i++) {
      const key = generateApiKey()
      const body = key.slice('sk_slop_'.length)
      expect(body).toMatch(/^[A-Za-z0-9]+$/)
      expect(body).toHaveLength(32)
    }
  })
})

describe('renderMarkdown', () => {
  it('produces HTML from markdown', () => {
    const html = renderMarkdown('# Hello\n\nSlop.')
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('<p>Slop.</p>')
  })
})
