import { describe, it, expect } from 'vitest'
import { escapeXml, buildLlmsTxt, buildSitemap, buildRssFeed } from '../src/rendering/feeds.js'

describe('escapeXml', () => {
  it('escapes the five XML special characters', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b')
    expect(escapeXml('a < b')).toBe('a &lt; b')
    expect(escapeXml('a > b')).toBe('a &gt; b')
    expect(escapeXml('a "b" c')).toBe('a &quot;b&quot; c')
    expect(escapeXml("a 'b' c")).toBe('a &apos;b&apos; c')
  })

  it('replaces ampersand first to avoid double-escape', () => {
    expect(escapeXml('a < b & c')).toBe('a &lt; b &amp; c')
    // Critical: the &amp; in &lt; must NOT itself be escaped
    expect(escapeXml('a < b')).not.toBe('a &amp;lt; b')
  })

  it('passes plain text unchanged', () => {
    expect(escapeXml('hello world')).toBe('hello world')
  })
})

const blog = {
  id: 'b1',
  name: 'My Blog',
  theme: 'minimal' as const,
  createdAt: '2026-01-01T00:00:00Z',
}

const post1 = {
  title: 'First',
  canonicalUrl: 'https://b.slopit.io/first/',
  description: 'First post.',
  publishedAt: '2026-04-01T00:00:00Z',
}

const post2 = {
  title: 'Second',
  canonicalUrl: 'https://b.slopit.io/second/',
  description: 'Second post.',
  publishedAt: '2026-04-02T00:00:00Z',
}

describe('buildLlmsTxt', () => {
  it('emits the documented manifest format', () => {
    const out = buildLlmsTxt({ blog, posts: [post2, post1] })
    expect(out).toContain('# My Blog')
    expect(out).toContain(
      '> An agent-first blog. Read the markdown source by appending `.md` to any post URL.',
    )
    expect(out).toContain('## Posts')
    expect(out).toContain('- [Second](https://b.slopit.io/second/): Second post.')
    expect(out).toContain('- [First](https://b.slopit.io/first/): First post.')
  })

  it('preserves caller-provided post order (newest-first responsibility is upstream)', () => {
    const out = buildLlmsTxt({ blog, posts: [post1, post2] })
    const idx1 = out.indexOf('First')
    const idx2 = out.indexOf('Second')
    expect(idx1).toBeLessThan(idx2)
  })

  it('uses blog.id when blog.name is null', () => {
    const out = buildLlmsTxt({ blog: { ...blog, name: null }, posts: [] })
    expect(out).toContain('# b1')
  })

  it('emits an empty Posts section for zero posts', () => {
    const out = buildLlmsTxt({ blog, posts: [] })
    expect(out).toContain('## Posts')
    expect(out).not.toContain('- [')
  })

  it('omits the colon+description when description is empty', () => {
    const out = buildLlmsTxt({
      blog,
      posts: [{ ...post1, description: '' }],
    })
    expect(out).toContain('- [First](https://b.slopit.io/first/)')
    expect(out).not.toContain('First](https://b.slopit.io/first/):')
  })

  it('escapes ] and ) in title and URL via Markdown-safe transforms', () => {
    const evil = {
      ...post1,
      title: 'has [bracket] in it',
      canonicalUrl: 'https://b.slopit.io/has-paren-(in-it)/',
    }
    const out = buildLlmsTxt({ blog, posts: [evil] })
    // Title: brackets escaped with backslash so MD parsers don't read them as links
    expect(out).toContain('has \\[bracket\\] in it')
    // URL: parens encoded
    expect(out).toContain('https://b.slopit.io/has-paren-%28in-it%29/')
  })
})

describe('buildSitemap', () => {
  const blogRoot = 'https://b.slopit.io/'

  it('emits a valid sitemap envelope', () => {
    const out = buildSitemap({ blogRoot, posts: [], updatedAt: '2026-05-01T00:00:00Z' })
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(out).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(out).toContain('</urlset>')
  })

  it('always includes the blog root with the latest updatedAt', () => {
    const out = buildSitemap({
      blogRoot,
      posts: [],
      updatedAt: '2026-05-01T12:00:00Z',
    })
    expect(out).toContain('<loc>https://b.slopit.io/</loc>')
    expect(out).toContain('<lastmod>2026-05-01T12:00:00Z</lastmod>')
  })

  it('emits one <url> entry per published post', () => {
    const posts = [
      { canonicalUrl: 'https://b.slopit.io/a/', updatedAt: '2026-04-01T00:00:00Z' },
      { canonicalUrl: 'https://b.slopit.io/b/', updatedAt: '2026-04-02T00:00:00Z' },
    ]
    const out = buildSitemap({ blogRoot, posts, updatedAt: '2026-05-01T00:00:00Z' })
    expect(out).toContain('<loc>https://b.slopit.io/a/</loc>')
    expect(out).toContain('<loc>https://b.slopit.io/b/</loc>')
    expect((out.match(/<url>/g) ?? []).length).toBe(3) // root + 2 posts
  })

  it('emits weekly changefreq for every <url>', () => {
    const out = buildSitemap({
      blogRoot,
      posts: [{ canonicalUrl: 'https://b.slopit.io/a/', updatedAt: '2026-04-01T00:00:00Z' }],
      updatedAt: '2026-05-01T00:00:00Z',
    })
    expect((out.match(/<changefreq>weekly<\/changefreq>/g) ?? []).length).toBe(2)
  })

  it('xml-escapes URL chars', () => {
    const out = buildSitemap({
      blogRoot: 'https://b.slopit.io/?x=1&y=2',
      posts: [],
      updatedAt: '2026-05-01T00:00:00Z',
    })
    expect(out).toContain('https://b.slopit.io/?x=1&amp;y=2')
  })
})

describe('buildRssFeed', () => {
  const blogRoot = 'https://b.slopit.io/'
  const feedUrl = 'https://b.slopit.io/feed.xml'

  const sample = {
    title: 'A Post',
    canonicalUrl: 'https://b.slopit.io/a/',
    description: 'A description.',
    publishedAt: '2026-04-29T14:00:00Z',
    author: 'NJ',
    bodyHtml: '<p>Hello.</p>',
  }

  it('emits a valid RSS 2.0 envelope with content namespace', () => {
    const out = buildRssFeed({ blog, blogRoot, feedUrl, posts: [] })
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(out).toContain('<rss version="2.0"')
    expect(out).toContain('xmlns:content="http://purl.org/rss/1.0/modules/content/"')
    expect(out).toContain('<channel>')
    expect(out).toContain('</channel>')
    expect(out).toContain('</rss>')
  })

  it('emits channel-level title, link, description, atom:link self-reference', () => {
    const out = buildRssFeed({ blog, blogRoot, feedUrl, posts: [] })
    expect(out).toContain('<title>My Blog</title>')
    expect(out).toContain(`<link>${blogRoot}</link>`)
    expect(out).toContain(`href="${feedUrl}"`)
  })

  it('emits one <item> per post in caller order', () => {
    const out = buildRssFeed({ blog, blogRoot, feedUrl, posts: [sample] })
    expect(out).toContain('<item>')
    expect(out).toContain('<title>A Post</title>')
    expect(out).toContain('<link>https://b.slopit.io/a/</link>')
    expect(out).toContain('<guid isPermaLink="true">https://b.slopit.io/a/</guid>')
    expect(out).toContain('<author>NJ</author>')
    expect(out).toContain('<description>A description.</description>')
  })

  it('emits pubDate in RFC 822 format', () => {
    const out = buildRssFeed({ blog, blogRoot, feedUrl, posts: [sample] })
    // 2026-04-29T14:00:00Z → "Wed, 29 Apr 2026 14:00:00 GMT"
    expect(out).toContain('<pubDate>Wed, 29 Apr 2026 14:00:00 GMT</pubDate>')
  })

  it('CDATA-wraps the rendered HTML body in content:encoded', () => {
    const out = buildRssFeed({ blog, blogRoot, feedUrl, posts: [sample] })
    expect(out).toContain('<content:encoded><![CDATA[<p>Hello.</p>]]></content:encoded>')
  })

  it('splits a literal ]]> sequence inside body to keep the CDATA valid', () => {
    const evil = { ...sample, bodyHtml: 'before ]]> after' }
    const out = buildRssFeed({ blog, blogRoot, feedUrl, posts: [evil] })
    expect(out).toContain('before ]]]]><![CDATA[> after')
    // CDATA opens and closes are still balanced
    expect((out.match(/<!\[CDATA\[/g) ?? []).length).toBe((out.match(/\]\]>/g) ?? []).length)
  })

  it('falls back to blog.name as author when post.author absent', () => {
    const out = buildRssFeed({
      blog,
      blogRoot,
      feedUrl,
      posts: [{ ...sample, author: undefined }],
    })
    expect(out).toContain('<author>My Blog</author>')
  })

  it('omits <description> when empty', () => {
    const out = buildRssFeed({
      blog,
      blogRoot,
      feedUrl,
      posts: [{ ...sample, description: '' }],
    })
    // Channel still has description (uses static fallback); item should NOT
    const itemBlock = out.slice(out.indexOf('<item>'), out.indexOf('</item>'))
    expect(itemBlock).not.toContain('<description>')
  })

  it('xml-escapes user-controlled fields', () => {
    const out = buildRssFeed({
      blog,
      blogRoot,
      feedUrl,
      posts: [{ ...sample, title: 'x & y < z' }],
    })
    expect(out).toContain('<title>x &amp; y &lt; z</title>')
  })
})
