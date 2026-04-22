import { describe, expect, it } from 'vitest'
import { escapeHtml, render, loadTheme } from '../src/rendering/templates.js'
import {
  formatDate,
  renderPostList,
  renderTagList,
  renderPoweredBy,
  renderSeoMeta,
} from '../src/rendering/generator.js'
import { renderMarkdown } from '../src/rendering/markdown.js'
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
      makePost({ slug: 'first',  title: 'First',  publishedAt: '2025-01-01T00:00:00Z' }),
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
    expect(renderMarkdown('[text](https://example.com)')).toContain('<a href="https://example.com">text</a>')
    expect(renderMarkdown('- item 1\n- item 2')).toContain('<li>item 1</li>')
    expect(renderMarkdown('> quoted')).toContain('<blockquote>')
    expect(renderMarkdown('`code`')).toContain('<code>code</code>')
  })

  it('escapes HTML-like content inside code blocks (not stripped, but entity-escaped)', () => {
    const out = renderMarkdown('```\n<script>inside code</script>\n```')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('inside code')
  })
})
