import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isoTimestamp } from '../src/time.js'
import { createStore } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
import { createPost, getPost } from '../src/posts.js'
import { createRenderer } from '../src/rendering/generator.js'
import { readFileSync } from 'node:fs'

describe('isoTimestamp', () => {
  it("turns SQLite datetime('now') output into ISO 8601 UTC", () => {
    expect(isoTimestamp('2026-10-21 00:00:53')).toBe('2026-10-21T00:00:53.000Z')
    expect(isoTimestamp('2026-08-27 13:55:47.5')).toBe('2026-08-27T13:55:47.500Z')
  })

  it('passes ISO values and null through unchanged', () => {
    expect(isoTimestamp('2026-10-15T20:37:43.278Z')).toBe('2026-10-15T20:37:43.278Z')
    expect(isoTimestamp(null)).toBeNull()
  })
})

describe('posts read back with ISO timestamps', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('normalises rows that still hold the column-default format', () => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-time-'))
    const store = createStore({ dbPath: join(dir, 'db.sqlite') })
    const { blog } = createBlog(store, { name: 'timeblog' })
    const outputDir = join(dir, 'out')
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://timeblog.example.com' })
    const { post } = createPost(store, renderer, blog.id, {
      title: 'Hi',
      body: 'x',
      status: 'published',
    })
    store.db
      .prepare(
        "UPDATE posts SET created_at = '2026-08-27 13:55:47', updated_at = '2026-08-27 13:55:47' WHERE id = ?",
      )
      .run(post.id)
    const read = getPost(store, blog.id, post.slug)
    expect(read.updatedAt).toBe('2026-08-27T13:55:47.000Z')
    expect(read.createdAt).toBe('2026-08-27T13:55:47.000Z')
    renderer.renderPost(blog.id, read)
    const sitemap = readFileSync(join(outputDir, blog.id, 'sitemap.xml'), 'utf8')
    expect(sitemap).toContain('<lastmod>2026-08-27T13:55:47.000Z</lastmod>')
    expect(sitemap).not.toMatch(/<lastmod>\d{4}-\d{2}-\d{2} /)
    store.close()
  })
})
