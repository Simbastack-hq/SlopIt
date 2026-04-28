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
})

describe('renderMarkdown', () => {
  it('produces HTML from markdown', () => {
    const html = renderMarkdown('# Hello\n\nSlop.')
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('<p>Slop.</p>')
  })
})
