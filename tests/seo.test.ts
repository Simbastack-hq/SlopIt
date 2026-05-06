import { describe, it, expect } from 'vitest'
import {
  extractDescription,
  escapeJsonForScript,
  resolveDescription,
  resolveTitle,
  normalizeBaseUrl,
  buildJsonLd,
  buildSeoMeta,
} from '../src/rendering/seo.js'
import type { Post, Blog } from '../src/schema/index.js'

describe('extractDescription', () => {
  it('returns empty string for empty input', () => {
    expect(extractDescription('')).toBe('')
    expect(extractDescription('   \n\n   ')).toBe('')
  })

  it('strips ATX headings, keeps text', () => {
    expect(extractDescription('# Hello\n\nWorld.')).toBe('Hello World.')
    expect(extractDescription('### A heading\n\nBody.')).toBe('A heading Body.')
  })

  it('removes fenced code blocks entirely', () => {
    const input = 'Intro.\n\n```js\nconst x = 1\n```\n\nOutro.'
    expect(extractDescription(input)).toBe('Intro. Outro.')
  })

  it('replaces images with alt text and links with link text', () => {
    expect(extractDescription('![cat](x.png) is cute')).toBe('cat is cute')
    expect(extractDescription('See [the docs](url) for more.')).toBe('See the docs for more.')
  })

  it('removes emphasis markers', () => {
    expect(extractDescription('This is **bold** and _italic_ and `code`.')).toBe(
      'This is bold and italic and code.',
    )
  })

  it('strips list and blockquote markers', () => {
    expect(extractDescription('- one\n- two\n- three')).toBe('one two three')
    expect(extractDescription('> quoted\n> line')).toBe('quoted line')
    expect(extractDescription('1. first\n2. second')).toBe('first second')
  })

  it('collapses whitespace and trims', () => {
    expect(extractDescription('a   \n\n  b')).toBe('a b')
  })

  it('truncates on word boundary with ellipsis when over max', () => {
    const input = 'one two three four five six seven eight nine ten'
    const out = extractDescription(input, 20)
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toContain('  ')
    // Walks back to a word boundary, never cuts mid-word
    expect(out).toMatch(/^(?:\w+ )+\w*…$/)
  })

  it('returns full string when within max', () => {
    expect(extractDescription('short.', 160)).toBe('short.')
  })

  it('default max is 160 chars', () => {
    const input = 'x'.repeat(200)
    const out = extractDescription(input)
    expect(out.length).toBeLessThanOrEqual(160)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('escapeJsonForScript', () => {
  it('produces valid JSON for plain values', () => {
    const out = escapeJsonForScript({ a: 1, b: 'hi' })
    expect(JSON.parse(out)).toEqual({ a: 1, b: 'hi' })
  })

  it('escapes < to \\u003c so </script> cannot break out', () => {
    const out = escapeJsonForScript({ x: 'hello </script><script>alert(1)</script>' })
    expect(out).not.toContain('</script>')
    expect(out).toContain('\\u003c/script')
    // Still valid JSON — JSON.parse decodes < back to <
    const parsed = JSON.parse(out) as { x: string }
    expect(parsed.x).toContain('</script>')
  })

  it('does not double-encode non-< characters', () => {
    const out = escapeJsonForScript({ greeting: 'hi & bye' })
    expect(JSON.parse(out)).toEqual({ greeting: 'hi & bye' })
  })
})

const baseDate = '2026-05-01T12:34:56Z'

const basePost: Post = {
  id: 'p1',
  blogId: 'b1',
  title: 'Title',
  slug: 'title',
  body: 'Hello world.',
  status: 'published',
  tags: [],
  publishedAt: baseDate,
  createdAt: baseDate,
  updatedAt: baseDate,
}

describe('resolveDescription', () => {
  it('returns post.seoDescription when set', () => {
    const post: Post = { ...basePost, seoDescription: 'Custom SEO desc.' }
    expect(resolveDescription(post)).toBe('Custom SEO desc.')
  })

  it('trims whitespace from post.seoDescription before returning', () => {
    const post: Post = { ...basePost, seoDescription: '  Custom SEO desc.  ' }
    expect(resolveDescription(post)).toBe('Custom SEO desc.')
  })

  it('falls back to post.excerpt when seoDescription is absent', () => {
    const post: Post = { ...basePost, excerpt: 'Curated excerpt.' }
    expect(resolveDescription(post)).toBe('Curated excerpt.')
  })

  it('treats empty-string seoDescription as absent and falls back', () => {
    const post: Post = { ...basePost, seoDescription: '', excerpt: 'Curated.' }
    expect(resolveDescription(post)).toBe('Curated.')
  })

  it('treats whitespace-only seoDescription as absent and falls back', () => {
    const post: Post = { ...basePost, seoDescription: '   \t\n  ', excerpt: 'Curated.' }
    expect(resolveDescription(post)).toBe('Curated.')
  })

  it('treats whitespace-only excerpt as absent and falls back to body', () => {
    const post: Post = { ...basePost, excerpt: '   ', body: 'Real body.' }
    expect(resolveDescription(post)).toBe('Real body.')
  })

  it('falls back to extractDescription(body) when both seoDescription and excerpt are absent', () => {
    expect(resolveDescription(basePost)).toBe('Hello world.')
  })

  it('seoDescription wins over excerpt when both are set', () => {
    const post: Post = {
      ...basePost,
      seoDescription: 'SEO wins.',
      excerpt: 'Should not appear.',
    }
    expect(resolveDescription(post)).toBe('SEO wins.')
  })

  it('returns empty string when all sources are empty', () => {
    const post: Post = { ...basePost, body: '   ' }
    expect(resolveDescription(post)).toBe('')
  })

  it('returns empty string when all three sources are blank/whitespace', () => {
    const post: Post = { ...basePost, seoDescription: '', excerpt: '   ', body: '   ' }
    expect(resolveDescription(post)).toBe('')
  })
})

describe('resolveTitle', () => {
  it('returns post.seoTitle when set', () => {
    const post: Post = { ...basePost, seoTitle: 'Custom SEO Title' }
    expect(resolveTitle(post)).toBe('Custom SEO Title')
  })

  it('trims whitespace from post.seoTitle before returning', () => {
    const post: Post = { ...basePost, seoTitle: '  Custom SEO Title  ' }
    expect(resolveTitle(post)).toBe('Custom SEO Title')
  })

  it('falls back to post.title when seoTitle is absent', () => {
    expect(resolveTitle(basePost)).toBe('Title')
  })

  it('treats empty-string seoTitle as absent and falls back', () => {
    const post: Post = { ...basePost, seoTitle: '' }
    expect(resolveTitle(post)).toBe('Title')
  })

  it('treats whitespace-only seoTitle as absent and falls back', () => {
    const post: Post = { ...basePost, seoTitle: '   \t  ' }
    expect(resolveTitle(post)).toBe('Title')
  })
})

describe('normalizeBaseUrl', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeBaseUrl('https://x.com/')).toBe('https://x.com')
  })

  it('returns input unchanged when no trailing slash', () => {
    expect(normalizeBaseUrl('https://x.com')).toBe('https://x.com')
  })

  it('preserves path components and strips only the trailing slash', () => {
    expect(normalizeBaseUrl('https://x.com/blog/')).toBe('https://x.com/blog')
  })

  it('strips only one slash even if input has multiple', () => {
    expect(normalizeBaseUrl('https://x.com//')).toBe('https://x.com/')
  })

  it('produces identical canonicals for slashed and non-slashed input when used in concatenation', () => {
    const slug = 'hello'
    const a = normalizeBaseUrl('https://x.com') + '/' + slug + '/'
    const b = normalizeBaseUrl('https://x.com/') + '/' + slug + '/'
    expect(a).toBe(b)
    expect(a).toBe('https://x.com/hello/')
  })
})

const minimalBlog: Blog = {
  id: 'b1',
  name: 'My Blog',
  theme: 'minimal',
  createdAt: '2026-04-01T00:00:00Z',
}

const minimalPost: Post = {
  id: 'p1',
  blogId: 'b1',
  title: 'Post Title',
  slug: 'post-title',
  body: 'Hello world.',
  status: 'published',
  tags: [],
  publishedAt: baseDate,
  createdAt: baseDate,
  updatedAt: baseDate,
}

const canonical = 'https://blog.slopit.io/post-title/'

describe('buildJsonLd', () => {
  it('emits a script block with required BlogPosting keys', () => {
    const out = buildJsonLd({ post: minimalPost, blog: minimalBlog, canonicalUrl: canonical })
    expect(out.startsWith('<script type="application/ld+json">')).toBe(true)
    expect(out.endsWith('</script>')).toBe(true)
    const json = out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed['@context']).toBe('https://schema.org')
    expect(parsed['@type']).toBe('BlogPosting')
    expect(parsed.headline).toBe('Post Title')
    expect(parsed.datePublished).toBe(baseDate)
    expect(parsed.mainEntityOfPage).toBe(canonical)
  })

  it('omits optional keys when source data is absent', () => {
    const out = buildJsonLd({ post: minimalPost, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json).not.toHaveProperty('dateModified')
    expect(json).not.toHaveProperty('author')
    expect(json).not.toHaveProperty('image')
    expect(json).not.toHaveProperty('keywords')
  })

  it('emits dateModified when updatedAt differs from publishedAt', () => {
    const post: Post = { ...minimalPost, updatedAt: '2026-05-02T00:00:00Z' }
    const out = buildJsonLd({ post, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json.dateModified).toBe('2026-05-02T00:00:00Z')
  })

  it('emits author as Person object when set', () => {
    const post: Post = { ...minimalPost, author: 'Jane Doe' }
    const out = buildJsonLd({ post, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json.author).toEqual({ '@type': 'Person', name: 'Jane Doe' })
  })

  it('emits image when coverImage set', () => {
    const post: Post = { ...minimalPost, coverImage: 'https://blog.slopit.io/_media/abc.png' }
    const out = buildJsonLd({ post, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json.image).toBe('https://blog.slopit.io/_media/abc.png')
  })

  it('emits keywords as comma-joined when tags set', () => {
    const post: Post = { ...minimalPost, tags: ['ai', 'agents', 'slop'] }
    const out = buildJsonLd({ post, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json.keywords).toBe('ai,agents,slop')
  })

  it('escapes </script> in title without breaking the script block', () => {
    const post: Post = { ...minimalPost, title: 'evil </script><script>alert(1)' }
    const out = buildJsonLd({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).not.toContain('</script><script>')
    // The closing script tag at the end is the only one
    expect(out.match(/<\/script>/g)).toHaveLength(1)
    // Round-trip recovers the original
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json.headline).toBe('evil </script><script>alert(1)')
  })

  it('uses extracted body excerpt as description when seoDescription and excerpt absent', () => {
    const out = buildJsonLd({ post: minimalPost, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json.description).toBe('Hello world.')
  })

  it('uses post.excerpt as description when seoDescription is absent', () => {
    const post: Post = { ...minimalPost, excerpt: 'A curated excerpt.' }
    const out = buildJsonLd({ post, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json.description).toBe('A curated excerpt.')
  })

  it('seoDescription wins over excerpt when both are set', () => {
    const post: Post = {
      ...minimalPost,
      seoDescription: 'SEO override.',
      excerpt: 'Should not appear.',
    }
    const out = buildJsonLd({ post, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json.description).toBe('SEO override.')
  })

  it('falls back to post.title for headline when seoTitle is empty string', () => {
    const post: Post = { ...minimalPost, seoTitle: '' }
    const out = buildJsonLd({ post, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json.headline).toBe('Post Title')
  })

  it('falls back to post.title for headline when seoTitle is whitespace-only', () => {
    const post: Post = { ...minimalPost, seoTitle: '   ' }
    const out = buildJsonLd({ post, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json.headline).toBe('Post Title')
  })

  it('omits author key when post.author is whitespace-only', () => {
    const post: Post = { ...minimalPost, author: '   ' }
    const out = buildJsonLd({ post, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json).not.toHaveProperty('author')
  })
})

describe('buildSeoMeta', () => {
  it('always emits description, og:title, og:type, og:url, og:site_name, twitter:card', () => {
    const out = buildSeoMeta({ post: minimalPost, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta name="description"')
    expect(out).toContain('<meta property="og:title"')
    expect(out).toContain('<meta property="og:type" content="article">')
    expect(out).toContain(`<meta property="og:url" content="${canonical}">`)
    expect(out).toContain('<meta property="og:site_name" content="My Blog">')
    expect(out).toContain('<meta name="twitter:card"')
  })

  it('falls back to post.title for og:title when seoTitle absent', () => {
    const out = buildSeoMeta({ post: minimalPost, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta property="og:title" content="Post Title">')
  })

  it('uses seoTitle when present', () => {
    const post: Post = { ...minimalPost, seoTitle: 'Custom SEO Title' }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta property="og:title" content="Custom SEO Title">')
    // Twitter title also uses the same source
    expect(out).toContain('<meta name="twitter:title" content="Custom SEO Title">')
  })

  it('falls back to extracted body excerpt for description (no seoDescription, no excerpt)', () => {
    const out = buildSeoMeta({ post: minimalPost, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta name="description" content="Hello world.">')
    expect(out).toContain('<meta property="og:description" content="Hello world.">')
    expect(out).toContain('<meta name="twitter:description" content="Hello world.">')
  })

  it('uses post.excerpt when seoDescription absent and excerpt set', () => {
    const post: Post = { ...minimalPost, excerpt: 'Curated.' }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta name="description" content="Curated.">')
    expect(out).toContain('<meta property="og:description" content="Curated.">')
    expect(out).toContain('<meta name="twitter:description" content="Curated.">')
  })

  it('seoDescription wins over excerpt', () => {
    const post: Post = {
      ...minimalPost,
      seoDescription: 'SEO override.',
      excerpt: 'Should not appear.',
    }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta name="description" content="SEO override.">')
  })

  it('uses summary_large_image card and og:image when coverImage set', () => {
    const post: Post = { ...minimalPost, coverImage: 'https://blog.slopit.io/_media/abc.png' }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(out).toContain(
      '<meta property="og:image" content="https://blog.slopit.io/_media/abc.png">',
    )
    expect(out).toContain(
      '<meta name="twitter:image" content="https://blog.slopit.io/_media/abc.png">',
    )
    expect(out).toContain('<meta property="og:image:alt" content="Post Title">')
  })

  it('uses summary card and omits og:image without coverImage', () => {
    const out = buildSeoMeta({ post: minimalPost, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta name="twitter:card" content="summary">')
    expect(out).not.toContain('og:image')
    expect(out).not.toContain('twitter:image')
  })

  it('emits article:published_time and skips article:modified_time when equal', () => {
    const out = buildSeoMeta({ post: minimalPost, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain(`<meta property="article:published_time" content="${baseDate}">`)
    expect(out).not.toContain('article:modified_time')
  })

  it('emits article:modified_time when updatedAt differs', () => {
    const post: Post = { ...minimalPost, updatedAt: '2026-05-02T00:00:00Z' }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta property="article:modified_time" content="2026-05-02T00:00:00Z">')
  })

  it('emits author meta and article:author when author set', () => {
    const post: Post = { ...minimalPost, author: 'Jane Doe' }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta name="author" content="Jane Doe">')
    expect(out).toContain('<meta property="article:author" content="Jane Doe">')
  })

  it('emits article:tag per tag', () => {
    const post: Post = { ...minimalPost, tags: ['ai', 'agents'] }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta property="article:tag" content="ai">')
    expect(out).toContain('<meta property="article:tag" content="agents">')
  })

  it('falls back to blog.id for og:site_name when blog.name is null', () => {
    const blog: Blog = { ...minimalBlog, name: null }
    const out = buildSeoMeta({ post: minimalPost, blog, canonicalUrl: canonical })
    expect(out).toContain('<meta property="og:site_name" content="b1">')
  })

  it('escapes HTML special chars in user-controlled values', () => {
    const post: Post = { ...minimalPost, title: 'evil <script>x</script>' }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).not.toContain('<script>x</script>')
    expect(out).toContain('&lt;script&gt;x&lt;/script&gt;')
  })

  it('omits description tags when body and seoDescription are empty', () => {
    const post: Post = { ...minimalPost, body: '   ', seoDescription: undefined }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).not.toContain('<meta name="description"')
    expect(out).not.toContain('og:description')
    expect(out).not.toContain('twitter:description')
  })

  it('joins emitted tags with newlines for readability', () => {
    const out = buildSeoMeta({ post: minimalPost, blog: minimalBlog, canonicalUrl: canonical })
    // Every tag should be on its own line
    const lines = out.split('\n')
    expect(lines.length).toBeGreaterThan(5)
    for (const line of lines) {
      expect(line).toMatch(/^<meta /)
    }
  })

  it('falls back to post.title for og:title when seoTitle is empty string', () => {
    const post: Post = { ...minimalPost, seoTitle: '' }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta property="og:title" content="Post Title">')
    expect(out).not.toContain('content="">')
  })

  it('falls back to post.title for og:title when seoTitle is whitespace-only', () => {
    const post: Post = { ...minimalPost, seoTitle: '   ' }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta property="og:title" content="Post Title">')
  })

  it('omits description when seoDescription is whitespace-only and excerpt/body are empty', () => {
    const post: Post = { ...minimalPost, seoDescription: '   ', body: '   ' }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).not.toContain('<meta name="description"')
    expect(out).not.toContain('og:description')
    expect(out).not.toContain('twitter:description')
  })

  it('omits author tags when post.author is empty string', () => {
    const post: Post = { ...minimalPost, author: '' }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).not.toContain('<meta name="author"')
    expect(out).not.toContain('article:author')
  })

  it('omits author tags when post.author is whitespace-only', () => {
    const post: Post = { ...minimalPost, author: '   ' }
    const out = buildSeoMeta({ post, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).not.toContain('<meta name="author"')
    expect(out).not.toContain('article:author')
  })

  it('falls back to blog.id for og:site_name when blog.name is empty string', () => {
    const blog: Blog = { ...minimalBlog, name: '' }
    const out = buildSeoMeta({ post: minimalPost, blog, canonicalUrl: canonical })
    expect(out).toContain('<meta property="og:site_name" content="b1">')
  })
})
