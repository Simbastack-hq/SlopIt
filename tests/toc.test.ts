import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBlog } from '../src/blogs.js'
import { createStore, type Store } from '../src/db/store.js'
import { createPost, updatePost } from '../src/posts.js'
import { createRenderer } from '../src/rendering/generator.js'
import { renderMarkdown } from '../src/rendering/markdown.js'
import { stringsFor, THEME_LANGUAGES } from '../src/rendering/strings.js'
import { countWords, renderToc } from '../src/rendering/toc.js'

// Section anchors + the contents rail beside a long post. Spec:
// docs/superpowers/specs/2026-10-08-contents-rail-design.md

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')

// A body with `sections` h2s and about `total` words of prose.
function longBody(sections: number, total = 1200): string {
  const per = Math.ceil(total / sections)
  return Array.from({ length: sections }, (_, i) => `## Part ${i + 1}\n\n${words(per)}`).join(
    '\n\n',
  )
}

describe('renderMarkdown — heading ids', () => {
  it('gives h2–h6 an id from their text and leaves h1 alone', () => {
    const html = renderMarkdown('# Title\n\n## Why it works\n\n### The fine print\n\n###### Six')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<h2 id="why-it-works">Why it works</h2>')
    expect(html).toContain('<h3 id="the-fine-print">The fine print</h3>')
    expect(html).toContain('<h6 id="six">Six</h6>')
  })

  it('slugs from the visible text: tags and entities dropped, apostrophes removed', () => {
    const html = renderMarkdown("## Don't use `<b>` & **panic**")
    expect(html).toContain('<h2 id="dont-use-b-panic">')
  })

  it('keeps letters, marks and digits from any script', () => {
    expect(renderMarkdown('## Über uns')).toContain('id="über-uns"')
    expect(renderMarkdown('## 概要と背景')).toContain('id="概要と背景"')
    expect(renderMarkdown('## विषय सूची')).toContain('id="विषय-सूची"')
  })

  it('suffixes repeats and never reuses an id the text already took', () => {
    const html = renderMarkdown('## Notes\n\n## Notes\n\n## Notes 2\n\n## Notes')
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
    expect(ids).toEqual(['notes', 'notes-2', 'notes-2-2', 'notes-3'])
  })

  it('falls back to "section" for a heading with no letters or digits', () => {
    expect(renderMarkdown('## ***')).not.toContain('id=""')
    expect(renderMarkdown('## — · —')).toContain('<h2 id="section">')
  })

  it('does not touch heading-like text inside code', () => {
    const html = renderMarkdown('```\n<h2>not a heading</h2>\n```')
    expect(html).not.toContain('id=')
  })

  it('keeps feed HTML plain (no ids)', () => {
    expect(renderMarkdown('## Hello', { embeds: false })).toContain('<h2>Hello</h2>')
  })
})

describe('countWords', () => {
  it('counts words, not tags', () => {
    expect(countWords('<p>one <em>two</em> three</p>', 'en')).toBe(3)
  })

  it('segments languages written without spaces', () => {
    expect(countWords('<p>私は学生です</p>', 'ja')).toBeGreaterThan(1)
  })
})

describe('renderToc', () => {
  it('lists every h2 as a link to its id, labelled for screen readers', () => {
    const toc = renderToc(renderMarkdown(longBody(3)), 'en', 'Contents')
    expect(toc).toContain('<nav class="toc" aria-label="Contents"><ol>')
    expect(toc).toContain('<li><a href="#part-1">Part 1</a></li>')
    expect(toc).toContain('<li><a href="#part-3">Part 3</a></li>')
    expect(toc).toContain('<script type="module">')
  })

  it('skips h3 and deeper', () => {
    const body = renderMarkdown(longBody(3) + '\n\n### Detail\n\nMore.')
    expect(renderToc(body, 'en', 'Contents')).not.toContain('#detail')
  })

  it('is empty with fewer than three sections, however long the post', () => {
    expect(renderToc(renderMarkdown(longBody(2, 5000)), 'en', 'Contents')).toBe('')
  })

  it('is empty for a short post, however many sections', () => {
    expect(renderToc(renderMarkdown(longBody(6, 400)), 'en', 'Contents')).toBe('')
  })

  it('shows heading text without its inline markup, still escaped', () => {
    const body = renderMarkdown(longBody(3) + '\n\n## Use `<b>` & [links](https://x.example)')
    expect(renderToc(body, 'en', 'Contents')).toContain('>Use &lt;b&gt; &amp; links</a>')
  })

  it('escapes the label', () => {
    expect(renderToc(renderMarkdown(longBody(3)), 'en', 'A "b"')).toContain(
      'aria-label="A &quot;b&quot;"',
    )
  })

  it('has a translated label for every theme language', () => {
    for (const tag of THEME_LANGUAGES) {
      expect(stringsFor(tag).contents.trim().length, tag).toBeGreaterThan(0)
    }
  })
})

describe('contents rail on the post page', () => {
  let dir: string
  let store: Store
  let outputDir: string
  let renderer: ReturnType<typeof createRenderer>
  let blogId: string

  const pageOf = (slug: string) => readFileSync(join(outputDir, blogId, slug, 'index.html'), 'utf8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-toc-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
    renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example' })
    blogId = createBlog(store, { name: 'toc' }).blog.id
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('renders the rail inside .post-body, before the body, for a long post', () => {
    createPost(store, renderer, blogId, { title: 'Long', slug: 'long', body: longBody(4) })
    const page = pageOf('long')
    expect(page).toMatch(/<div class="post-body"><nav class="toc" aria-label="Contents">/)
    expect(page.indexOf('class="toc"')).toBeLessThan(page.indexOf('<h2 id="part-1">'))
  })

  it('a short post gets section ids but no rail and no script', () => {
    createPost(store, renderer, blogId, { title: 'Short', slug: 'short', body: longBody(3, 200) })
    const page = pageOf('short')
    expect(page).toContain('<h2 id="part-1">')
    expect(page).not.toContain('class="toc"')
    expect(page).not.toContain('<script type="module">')
  })

  it('labels the rail in the post language', () => {
    createPost(store, renderer, blogId, {
      title: 'Deutsch',
      slug: 'deutsch',
      body: longBody(3),
      language: 'de',
    })
    expect(pageOf('deutsch')).toContain('<nav class="toc" aria-label="Inhalt">')
  })

  it('appears and disappears as the post is edited', () => {
    createPost(store, renderer, blogId, { title: 'Grow', slug: 'grow', body: 'Short.' })
    expect(pageOf('grow')).not.toContain('class="toc"')
    updatePost(store, renderer, blogId, 'grow', { body: longBody(3) })
    expect(pageOf('grow')).toContain('class="toc"')
  })
})
