import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { escapeHtml, render, loadTheme } from '../src/rendering/templates.js'
import {
  formatDate,
  renderPostList,
  renderTagList,
  renderPoweredBy,
  renderSeoMeta,
  renderCoverImage,
  createRenderer,
} from '../src/rendering/generator.js'
import { renderMarkdown } from '../src/rendering/markdown.js'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
import type { Post } from '../src/schema/index.js'

describe('escapeHtml', () => {
  it('escapes the five canonical HTML entities', () => {
    expect(escapeHtml('&')).toBe('&amp;')
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('>')).toBe('&gt;')
    expect(escapeHtml('"')).toBe('&quot;')
    expect(escapeHtml("'")).toBe('&#39;')
  })

  it('handles a mix', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    )
  })

  it('passes through benign strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
    expect(escapeHtml('')).toBe('')
  })

  it('escapes ampersands first (order matters)', () => {
    expect(escapeHtml('<&')).toBe('&lt;&amp;')
  })
})

describe('render', () => {
  it('substitutes {{var}} with escaped value', () => {
    expect(render('<p>{{name}}</p>', { name: '<script>' })).toBe('<p>&lt;script&gt;</p>')
  })

  it('substitutes {{{var}}} with raw (unescaped) value', () => {
    expect(render('<div>{{{html}}}</div>', { html: '<b>bold</b>' })).toBe('<div><b>bold</b></div>')
  })

  it('handles both forms in the same template', () => {
    const out = render('<p>{{text}}</p><div>{{{html}}}</div>', {
      text: '<script>',
      html: '<b>ok</b>',
    })
    expect(out).toBe('<p>&lt;script&gt;</p><div><b>ok</b></div>')
  })

  it('throws when an escaped var is missing', () => {
    expect(() => render('<p>{{missing}}</p>', {})).toThrow(/missing template variable: missing/i)
  })

  it('throws when a raw var is missing', () => {
    expect(() => render('<p>{{{missing}}}</p>', {})).toThrow(/missing template variable: missing/i)
  })

  it('handles whitespace inside braces (tolerant)', () => {
    expect(render('<p>{{ name }}</p>', { name: 'Ada' })).toBe('<p>Ada</p>')
    expect(render('<p>{{{  html  }}}</p>', { html: '<b>b</b>' })).toBe('<p><b>b</b></p>')
  })

  it('supports multiple occurrences of the same var', () => {
    expect(render('{{x}}-{{x}}', { x: 'a' })).toBe('a-a')
  })

  it('does not substitute {{ three braces }}} incorrectly', () => {
    expect(render('{{{a}}}{{b}}', { a: '<x>', b: 'y' })).toBe('<x>y')
  })
})

describe('loadTheme', () => {
  it('loads the minimal theme files', () => {
    const theme = loadTheme('minimal')
    expect(theme.post.length).toBeGreaterThan(0)
    expect(theme.index.length).toBeGreaterThan(0)
    expect(theme.cssPath.endsWith('style.css')).toBe(true)
  })

  it('post template contains expected placeholders', () => {
    const theme = loadTheme('minimal')
    expect(theme.post).toContain('{{postTitle}}')
    expect(theme.post).toContain('{{{postBody}}}')
    expect(theme.post).toContain('{{themeCssHref}}')
    expect(theme.post).toContain('{{blogHomeHref}}')
  })

  it('index template contains expected placeholders', () => {
    const theme = loadTheme('minimal')
    expect(theme.index).toContain('{{blogName}}')
    expect(theme.index).toContain('{{{postList}}}')
    expect(theme.index).toContain('{{themeCssHref}}')
  })
})

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    blogId: 'b1',
    slug: 'hello',
    title: 'Hello',
    body: 'body',
    excerpt: undefined,
    tags: [],
    status: 'published',
    seoTitle: undefined,
    seoDescription: undefined,
    author: undefined,
    coverImage: undefined,
    publishedAt: '2025-01-15T12:00:00Z',
    createdAt: '2025-01-15T12:00:00Z',
    updatedAt: '2025-01-15T12:00:00Z',
    ...overrides,
  }
}

describe('formatDate', () => {
  it('formats an ISO string into a human-readable date (UTC-pinned)', () => {
    expect(formatDate('2025-01-15T12:00:00Z')).toBe('January 15, 2025')
  })

  it('is deterministic across host timezones (UTC, not local)', () => {
    expect(formatDate('2025-01-01T00:00:00Z')).toBe('January 1, 2025')
  })

  it('returns empty string for null', () => {
    expect(formatDate(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(formatDate(undefined)).toBe('')
  })
})

describe('renderPostList', () => {
  it('returns an empty string when given no posts', () => {
    expect(renderPostList([])).toBe('')
  })

  it('builds a post-item per post', () => {
    const out = renderPostList([
      makePost({ slug: 'first', title: 'First', publishedAt: '2025-01-01T00:00:00Z' }),
      makePost({ slug: 'second', title: 'Second', publishedAt: '2025-02-01T00:00:00Z' }),
    ])
    expect(out).toContain('<article class="post-item">')
    expect(out).toContain('href="first/"')
    expect(out).toContain('href="second/"')
    expect(out).toContain('>First<')
    expect(out).toContain('>Second<')
  })

  it('escapes post titles, excerpts, and slugs', () => {
    const evil = makePost({
      slug: 'evil',
      title: '<script>alert(1)</script>',
      excerpt: '"onerror=alert(1)"',
    })
    const out = renderPostList([evil])
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('&quot;onerror')
  })

  it('omits excerpt paragraph when excerpt is absent', () => {
    const p = makePost({ excerpt: undefined })
    const out = renderPostList([p])
    expect(out).not.toMatch(/<p[^>]*>undefined<\/p>/)
    const postItems = out.match(/<article class="post-item">[\s\S]*?<\/article>/g)
    expect(postItems).toHaveLength(1)
    expect(postItems![0]).not.toContain('<p>')
  })

  it('renders excerpt paragraph when present', () => {
    const p = makePost({ excerpt: 'A short summary.' })
    const out = renderPostList([p])
    expect(out).toContain('<p>A short summary.</p>')
  })
})

describe('renderTagList', () => {
  it('returns empty string for no tags', () => {
    expect(renderTagList([])).toBe('')
  })

  it('wraps tags in a div and span-pills with # prefix', () => {
    const out = renderTagList(['ai', 'content'])
    expect(out).toContain('<div class="tags">')
    expect(out).toContain('<span>#ai</span>')
    expect(out).toContain('<span>#content</span>')
  })

  it('escapes tag text', () => {
    const out = renderTagList(['<script>'])
    expect(out).not.toContain('<script>')
    expect(out).toContain('#&lt;script&gt;')
  })
})

describe('renderPoweredBy', () => {
  it('returns a link to slopit.io', () => {
    const out = renderPoweredBy()
    expect(out).toContain('https://slopit.io')
    expect(out).toContain('Powered by')
  })
})

describe('renderSeoMeta', () => {
  it('returns empty string when both seoTitle and seoDescription are absent', () => {
    expect(renderSeoMeta(undefined, undefined)).toBe('')
  })

  it('emits a description meta when seoDescription is present', () => {
    const out = renderSeoMeta(undefined, 'A description')
    expect(out).toContain('<meta name="description"')
    expect(out).toContain('content="A description"')
  })

  it('escapes user-derived content', () => {
    const out = renderSeoMeta(undefined, '<script>alert(1)</script>')
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('emits a title meta (og:title) when seoTitle is present', () => {
    const out = renderSeoMeta('My Title', undefined)
    expect(out).toContain('My Title')
  })
})

describe('renderCoverImage', () => {
  it('returns empty string when coverImage is undefined', () => {
    expect(renderCoverImage(undefined, 'Title')).toBe('')
  })

  it('emits an <img> with class="cover" when coverImage is present', () => {
    const out = renderCoverImage('https://example.com/img.png', 'My Post')
    expect(out).toContain('<img class="cover"')
    expect(out).toContain('src="https://example.com/img.png"')
    expect(out).toContain('alt="My Post"')
  })

  it('escapes attribute-injection attempts in URL and alt', () => {
    const out = renderCoverImage('"><script>alert(1)</script>', '<x>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&quot;')
    expect(out).toContain('alt="&lt;x&gt;"')
  })
})

describe('renderMarkdown — HTML stripping (v1 XSS defense)', () => {
  it('strips <script> blocks entirely', () => {
    const out = renderMarkdown('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('alert(1)')
  })

  it('strips inline HTML with event handlers', () => {
    const out = renderMarkdown('Hello <img src=x onerror=alert(1)>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<img')
  })

  it('strips <iframe> and other embed attempts', () => {
    const out = renderMarkdown('<iframe src="evil.com"></iframe>')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('evil.com')
  })

  it('strips mixed HTML within legitimate markdown', () => {
    const out = renderMarkdown('**bold text** <script>evil()</script> **more bold**')
    expect(out).toContain('<strong>bold text</strong>')
    expect(out).toContain('<strong>more bold</strong>')
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('evil()')
  })

  it('preserves legitimate markdown → HTML conversions', () => {
    expect(renderMarkdown('# Heading')).toContain('<h1>Heading</h1>')
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>')
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>')
    expect(renderMarkdown('[text](https://example.com)')).toContain(
      '<a href="https://example.com">text</a>',
    )
    expect(renderMarkdown('- item 1\n- item 2')).toContain('<li>item 1</li>')
    expect(renderMarkdown('> quoted')).toContain('<blockquote>')
    expect(renderMarkdown('`code`')).toContain('<code>code</code>')
  })

  it('escapes HTML-like content inside code blocks (not stripped, but entity-escaped)', () => {
    const out = renderMarkdown('```\n<script>inside code</script>\n```')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('inside code')
  })

  it('preserves HTML-like content inside ~~~ fenced code blocks', () => {
    const out = renderMarkdown('~~~html\n<script>alert(1)</script>\n~~~')
    // Content is preserved (entity-escaped by marked's code renderer), not stripped.
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('alert(1)')
    expect(out).toContain('&lt;/script&gt;')
  })

  it('strips <style> blocks entirely (including payload)', () => {
    const out = renderMarkdown('<style>body{background:red}</style>')
    expect(out).not.toContain('<style>')
    expect(out).not.toContain('background:red')
  })

  it('neutralizes <svg> with event handlers + embedded <script>', () => {
    const out = renderMarkdown('<svg onload=alert(1)><script>evil()</script></svg>')
    // The embedded <script>...</script> is stripped by the preprocess pass.
    expect(out).not.toContain('evil()')
    // The remaining <svg> tags are dropped by the renderer.html override.
    expect(out).not.toContain('<svg')
    expect(out).not.toContain('onload')
    expect(out).not.toContain('alert(1)')
  })
})

describe('renderMarkdown — URL scheme allowlist (v1 XSS defense, part 2)', () => {
  // Background: marked v18 no longer blocks javascript: hrefs. Markdown
  // [text](url) is a `link` token, not an `html` token, so the
  // renderer.html override and stripDangerousBlocks preprocess do not
  // intercept it. An allowlist in the link/image renderer is the fix.

  it('blocks javascript: in markdown link hrefs', () => {
    const out = renderMarkdown('[click me](javascript:alert(1))')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('<a') // no anchor at all
    expect(out).toContain('click me') // visible text preserved
  })

  it('blocks data: in markdown link hrefs', () => {
    const out = renderMarkdown('[payload](data:text/html,<script>alert(1)</script>)')
    expect(out).not.toContain('data:')
    expect(out).not.toContain('<a')
    expect(out).toContain('payload')
  })

  it('blocks vbscript: in markdown link hrefs', () => {
    const out = renderMarkdown('[old](vbscript:msgbox(1))')
    expect(out).not.toContain('vbscript:')
    expect(out).not.toContain('<a')
    expect(out).toContain('old')
  })

  it('blocks file: in markdown link hrefs', () => {
    const out = renderMarkdown('[local](file:///etc/passwd)')
    expect(out).not.toContain('file:')
    expect(out).not.toContain('<a')
    expect(out).toContain('local')
  })

  it('is case-insensitive on scheme matching', () => {
    expect(renderMarkdown('[x](JavaScript:alert(1))')).not.toContain('JavaScript:')
    expect(renderMarkdown('[x](JAVASCRIPT:alert(1))')).not.toContain('JAVASCRIPT:')
    expect(renderMarkdown('[x](DATA:text/html,xss)')).not.toContain('DATA:')
  })

  it('strips data: src in markdown images', () => {
    // Use a clean data URL so marked parses it as an image; the payload
    // example with embedded <svg> would be rejected by marked's URL
    // tokenizer before reaching our renderer override, which is a separate
    // happy accident. This test exercises the image renderer override directly.
    const out = renderMarkdown('![evil](data:image/png;base64,iVBORw0KGgo=)')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('src="data:')
    // Alt text is dropped too — unsafe images render as empty.
  })

  it('strips javascript: src in markdown images', () => {
    const out = renderMarkdown('![xss](javascript:alert(1))')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('<img')
  })

  it('preserves http:// links', () => {
    const out = renderMarkdown('[site](http://example.com)')
    expect(out).toContain('href="http://example.com"')
    expect(out).toContain('>site<')
  })

  it('preserves https:// links', () => {
    const out = renderMarkdown('[site](https://example.com/path?q=1)')
    expect(out).toContain('href="https://example.com/path?q=1"')
  })

  it('preserves mailto: links', () => {
    const out = renderMarkdown('[mail me](mailto:hi@example.com)')
    expect(out).toContain('href="mailto:hi@example.com"')
  })

  it('preserves relative URLs (path-based)', () => {
    const out = renderMarkdown('[relative](/foo/bar)')
    expect(out).toContain('href="/foo/bar"')
  })

  it('preserves fragment URLs', () => {
    const out = renderMarkdown('[anchor](#section)')
    expect(out).toContain('href="#section"')
  })

  it('preserves protocol-relative URLs (//example.com)', () => {
    const out = renderMarkdown('[cdn](//example.com/img.png)')
    expect(out).toContain('href="//example.com/img.png"')
  })

  it('preserves https:// images', () => {
    const out = renderMarkdown('![alt](https://example.com/pic.png)')
    expect(out).toContain('<img')
    expect(out).toContain('src="https://example.com/pic.png"')
  })

  it('escapes visible text of blocked links so it cannot smuggle HTML', () => {
    // If someone does [<script>alert(1)</script>](javascript:alert(1)), the
    // visible label must not execute either. Marked already tokenizes the
    // label as inline content, and our fallback escapeHtml call is a
    // belt-and-suspenders defense.
    const out = renderMarkdown('[<b>bold-ish</b>](javascript:alert(1))')
    expect(out).not.toContain('javascript:')
    // The literal <b>...</b> inside the link label is itself an html token
    // and is stripped by renderer.html. Either way, no live <b> leaks out.
    expect(out).not.toContain('<b>bold-ish</b>')
  })
})

describe('createRenderer — renderPost', () => {
  let dir: string
  let store: Store
  let outputDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes post HTML + CSS to disk at the expected path', () => {
    const { blog } = createBlog(store, { name: 'test-blog' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://test.example.com' })

    const post = makePost({ blogId: blog.id, slug: 'hello', title: 'Hello!' })
    renderer.renderPost(blog.id, post)

    const postPath = join(outputDir, blog.id, 'hello', 'index.html')
    const cssPath = join(outputDir, blog.id, 'style.css')
    expect(existsSync(postPath)).toBe(true)
    expect(existsSync(cssPath)).toBe(true)

    const html = readFileSync(postPath, 'utf8')
    expect(html).toContain('<title>Hello! — test-blog</title>')
    expect(html).toContain('<h1>Hello!</h1>')
  })

  it('uses relative hrefs (../style.css and ..) so path-based and subdomain blogs both work', () => {
    const { blog } = createBlog(store, {})
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://example.com/b/xxx' })
    renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 's' }))

    const html = readFileSync(join(outputDir, blog.id, 's', 'index.html'), 'utf8')
    expect(html).toContain('href="../style.css"')
    expect(html).toContain('href=".."')
  })

  it('shows blog.id as blogName for unnamed blogs', () => {
    const { blog } = createBlog(store, {})
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://ex.com' })
    renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 's' }))

    const html = readFileSync(join(outputDir, blog.id, 's', 'index.html'), 'utf8')
    expect(html).toContain(blog.id)
  })

  it('renders canonical URL as baseUrl + /slug/ (trailing slash matches directory layout)', () => {
    const { blog } = createBlog(store, { name: 'bb' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 'my-slug' }))

    const html = readFileSync(join(outputDir, blog.id, 'my-slug', 'index.html'), 'utf8')
    expect(html).toContain('href="https://b.example.com/my-slug/"')
  })

  it('ensureCss always overwrites (picks up CSS changes on re-render)', () => {
    const { blog } = createBlog(store, { name: 'bb' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 's' }))

    const cssPath = join(outputDir, blog.id, 'style.css')
    const fresh = readFileSync(cssPath, 'utf8')

    writeFileSync(cssPath, '/* STALE */', 'utf8')
    renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 't' }))
    const restored = readFileSync(cssPath, 'utf8')
    expect(restored).toBe(fresh)
  })

  it('renders the post body as HTML (markdown passes through renderMarkdown)', () => {
    const { blog } = createBlog(store, {})
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://ex.com' })
    renderer.renderPost(
      blog.id,
      makePost({
        blogId: blog.id,
        slug: 's',
        body: '# Heading\n\nParagraph.',
      }),
    )

    const html = readFileSync(join(outputDir, blog.id, 's', 'index.html'), 'utf8')
    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('<p>Paragraph.</p>')
  })
})

describe('createRenderer — renderBlog', () => {
  let dir: string
  let store: Store
  let outputDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the blog index HTML + CSS to disk', () => {
    const { blog } = createBlog(store, { name: 'bb' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderBlog(blog.id)

    expect(existsSync(join(outputDir, blog.id, 'index.html'))).toBe(true)
    expect(existsSync(join(outputDir, blog.id, 'style.css'))).toBe(true)
  })

  it('lists published posts newest-first in the index', () => {
    const { blog } = createBlog(store, { name: 'bb' })
    const insert = store.db.prepare(
      `INSERT INTO posts (id, blog_id, slug, title, body, status, published_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?)`,
    )
    insert.run('p1', blog.id, 'first', 'First', 'x', '2025-01-01T00:00:00Z')
    insert.run('p2', blog.id, 'second', 'Second', 'x', '2025-02-01T00:00:00Z')

    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderBlog(blog.id)

    const html = readFileSync(join(outputDir, blog.id, 'index.html'), 'utf8')
    const secondIdx = html.indexOf('>Second<')
    const firstIdx = html.indexOf('>First<')
    expect(secondIdx).toBeGreaterThan(-1)
    expect(firstIdx).toBeGreaterThan(-1)
    expect(secondIdx).toBeLessThan(firstIdx)
  })

  it('excludes drafts from the index', () => {
    const { blog } = createBlog(store, { name: 'bb' })
    const insert = store.db.prepare(
      `INSERT INTO posts (id, blog_id, slug, title, body, status, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('p1', blog.id, 'pub', 'Pub', 'x', 'published', '2025-01-01T00:00:00Z')
    insert.run('p2', blog.id, 'draft', 'Draft', 'x', 'draft', null)

    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderBlog(blog.id)

    const html = readFileSync(join(outputDir, blog.id, 'index.html'), 'utf8')
    expect(html).toContain('>Pub<')
    expect(html).not.toContain('>Draft<')
  })

  it('uses relative "style.css" href (not "../style.css") in the index', () => {
    const { blog } = createBlog(store, { name: 'bb' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderBlog(blog.id)

    const html = readFileSync(join(outputDir, blog.id, 'index.html'), 'utf8')
    expect(html).toContain('href="style.css"')
    expect(html).not.toContain('href="../style.css"')
  })
})

describe('renderPostList — null publishedAt branch', () => {
  it('renders an empty datetime attribute when publishedAt is null', () => {
    const out = renderPostList([makePost({ publishedAt: null })])
    expect(out).toContain('datetime=""')
  })
})

describe('renderPost — null publishedAt branch', () => {
  let dir: string
  let store: Store
  let outputDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('renders an empty datetime attribute when a post has no publishedAt (still writes file)', () => {
    const { blog } = createBlog(store, {})
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://ex.com' })
    renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 's', publishedAt: null }))

    const html = readFileSync(join(outputDir, blog.id, 's', 'index.html'), 'utf8')
    expect(html).toContain('datetime=""')
  })
})

describe('MutationRenderer.mediaDir', () => {
  it('returns <outputDir>/<blogId>/_media without creating the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slopit-mediadir-'))
    const store = createStore({ dbPath: join(dir, 'test.db') })
    const outputDir = join(dir, 'out')
    const renderer = createRenderer({ store, outputDir, baseUrl: 'http://x/' })

    const got = renderer.mediaDir('blog_abc123')
    expect(got).toBe(join(outputDir, 'blog_abc123', '_media'))
    expect(existsSync(got)).toBe(false)

    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
