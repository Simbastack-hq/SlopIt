import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBlog } from '../src/blogs.js'
import { createStore, type Store } from '../src/db/store.js'
import { createPost, getPost } from '../src/posts.js'
import { createRenderer } from '../src/rendering/generator.js'

// Live facts must not change a single byte of a blog that uses none. The
// snapshot below was written by the renderer as it was BEFORE live facts
// existed (this file landed in its own commit, ahead of the feature), so a
// diff here is a change to existing posts' output. Posts include things
// that look like fact tokens but are not ones (wrong case, spaces, inside
// code), which must stay literal.
//
// Theme assets (style.css, favicon.svg) are not post output and are left
// out: the theme gains a style for the facts note.

const POSTS = [
  {
    title: 'Everything at once',
    slug: 'everything',
    tags: ['ai', 'notes'],
    author: 'Ada',
    coverImage: 'https://img.example/cover.png',
    body: [
      'Intro paragraph with **bold**, _emphasis_, a [link](https://example.com "t") and `code`.',
      '',
      '## A section',
      '',
      '- item one',
      '- item {{ fact:spaced }} two',
      '1. first',
      '',
      '> quoted {{fact:Upper}} text',
      '',
      '| Plan | Price |',
      '|---|---|',
      '| Pro | $12/mo |',
      '',
      '```js',
      'const t = "{{fact:in_fence}}"',
      '```',
      '',
      'Inline `{{fact:in_span}}` stays literal, as does {fact:single}.',
      '',
      '![alt text](https://img.example/a.png)',
      '',
      'https://youtu.be/3mlRiF-LeMc',
      '',
      'Setext heading',
      '---',
      '',
      '<script>alert(1)</script>',
    ].join('\n'),
  },
  {
    title: 'Explicit excerpt',
    slug: 'explicit',
    excerpt: 'A hand-written summary.',
    seoTitle: 'SEO title',
    seoDescription: 'SEO description.',
    body: 'Short body.\n\n### Small heading\n\nText.',
  },
  { title: 'Hallo Welt', slug: 'hallo', language: 'de', body: 'Ein deutscher Beitrag.' },
  {
    title: 'Hello world',
    slug: 'hello',
    body: 'An English post.',
    translationOf: 'hallo',
    language: 'en',
  },
  // The auto-excerpt drops the backticks, so it holds a bare token-like string.
  { title: 'Code excerpt', slug: 'code-excerpt', body: 'Write `{{fact:in_code}}` in a body.' },
  { title: 'Still a draft', slug: 'draft', status: 'draft' as const, body: 'Not live.' },
]

/** Every file under `dir`, path → content, theme assets excluded. */
function readTree(dir: string): string {
  const files: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name !== 'style.css' && name !== 'favicon.svg') files.push(p)
    }
  }
  walk(dir)
  return files.map((p) => `=== ${relative(dir, p)} ===\n${readFileSync(p, 'utf8')}`).join('\n')
}

describe('posts without fact tokens render byte-identical to before live facts', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-golden-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('pages, homes, .md twins, feeds, sitemap, llms.txt and a draft preview', async () => {
    const { blog } = createBlog(store, { name: 'golden', title: 'Golden' })
    const scratch = createRenderer({ store, outputDir: join(dir, 'scratch'), baseUrl: 'x' })
    for (const p of POSTS) createPost(store, scratch, blog.id, p)

    // Pin every timestamp (SQLite's own clock fills created_at/updated_at).
    const stamp = (n: number) => `2026-0${n}-01T10:00:00.000Z`
    POSTS.forEach((p, i) => {
      store.db
        .prepare(
          `UPDATE posts SET created_at = ?, updated_at = ?,
                  published_at = CASE status WHEN 'published' THEN ? ELSE NULL END
            WHERE blog_id = ? AND slug = ?`,
        )
        .run(stamp(i + 1), i === 0 ? stamp(i + 2) : stamp(i + 1), stamp(i + 1), blog.id, p.slug)
    })
    store.db.prepare('UPDATE blogs SET created_at = ? WHERE id = ?').run(stamp(1), blog.id)

    const out = join(dir, 'out')
    const renderer = createRenderer({ store, outputDir: out, baseUrl: 'https://golden.example/' })
    renderer.renderBlog(blog.id)
    renderer.renderBlogPosts(blog.id)
    renderer.renderManifests(blog.id)
    for (const p of POSTS.filter((x) => x.status !== 'draft')) {
      renderer.renderPostMarkdown(blog.id, getPost(store, blog.id, p.slug))
    }
    // A draft rendered the way a host's preview does it.
    const preview = join(dir, 'preview')
    createRenderer({ store, outputDir: preview, baseUrl: 'https://golden.example/' }).renderPost(
      blog.id,
      getPost(store, blog.id, 'draft'),
    )

    const tree =
      readTree(join(out, blog.id)) + '\n=== PREVIEW ===\n' + readTree(join(preview, blog.id))
    await expect(tree).toMatchFileSnapshot('./__golden__/no-facts-output.txt')
  })
})
