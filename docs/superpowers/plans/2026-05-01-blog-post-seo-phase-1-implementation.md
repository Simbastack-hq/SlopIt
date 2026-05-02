# Blog Post SEO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every published blog post ships a complete `<head>` — Open Graph, Twitter Card, JSON-LD `BlogPosting`, plus the existing canonical/title — even when the author left `seoTitle`/`seoDescription`/`coverImage` blank. Pure rendering change; zero schema or API impact.

**Architecture:** New pure module `src/rendering/seo.ts` exposes `buildSeoMeta`, `buildJsonLd`, `extractDescription`, `escapeJsonForScript`. `generator.ts` calls into it from `renderPost` and passes the results into the existing `{{{seoMeta}}}` slot plus a new `{{{jsonLd}}}` slot in `post.html`. No I/O outside the existing renderer write path. No new deps.

**Tech Stack:** TypeScript (strict), Node.js, Vitest. Existing `marked` for rendering; not used here. Existing `escapeHtml` from `src/rendering/templates.ts`.

**Spec:** [docs/superpowers/specs/2026-05-01-blog-post-seo-design.md](../specs/2026-05-01-blog-post-seo-design.md). Read the spec before starting — every "why" is answered there.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/rendering/seo.ts` | Create | `extractDescription`, `escapeJsonForScript`, `buildJsonLd`, `buildSeoMeta`. Pure helpers. |
| `src/rendering/generator.ts` | Modify | Drop `renderSeoMeta`. In `renderPost`: call `buildSeoMeta` and `buildJsonLd`, pass into template. |
| `src/themes/minimal/post.html` | Modify | Add `{{{jsonLd}}}` placeholder in `<head>` after `{{{seoMeta}}}`. |
| `tests/seo.test.ts` | Create | Unit tests for all four `seo.ts` exports + edge cases. |
| `tests/rendering.test.ts` | Modify | Replace `renderSeoMeta` tests with two integration tests on the new pipeline. |
| `docs/solutions/seo-meta-fallbacks.md` | Create | Capture: description-fallback algorithm, JSON-LD `</script>` escape rule, why we replaced rather than augmented `renderSeoMeta`. |

---

## Task 1: extractDescription — markdown → plain excerpt

**Files:**
- Create: `src/rendering/seo.ts`
- Test: `tests/seo.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/seo.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractDescription } from '../src/rendering/seo.js'

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/seo.test.ts`
Expected: FAIL — module `src/rendering/seo.js` doesn't exist.

- [ ] **Step 3: Implement `extractDescription`**

Create `src/rendering/seo.ts`:

```ts
/**
 * Strip markdown formatting, collapse whitespace, truncate on word boundary.
 * Used as the fallback for `<meta name="description">` when an author hasn't
 * set `seoDescription`. Returns '' for empty / pure-formatting input.
 *
 * NOTE: input is markdown only — `renderMarkdown` strips raw HTML at publish
 * time (see `2026-04-22-create-post-design.md` decision #13), so we don't
 * need an HTML parser here.
 */
export function extractDescription(body: string, max = 160): string {
  let s = body
  // 1. Fenced code blocks (``` and ~~~), entire block.
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/~~~[\s\S]*?~~~/g, ' ')
  // 2. ATX headings — drop the leading hashes, keep the text.
  s = s.replace(/^#{1,6}\s+/gm, '')
  // 3. Setext underlines (=== / --- on their own line).
  s = s.replace(/^[=-]{2,}\s*$/gm, ' ')
  // 4. Blockquote markers.
  s = s.replace(/^\s*>\s?/gm, '')
  // 5. List markers (unordered + ordered).
  s = s.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
  // 6. Images: ![alt](url) → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 7. Links: [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // 8. Emphasis + inline code markers.
  s = s.replace(/(\*\*|__|\*|_|`)/g, '')
  // 9. Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim()
  // 10. Truncate on word boundary.
  if (s.length <= max) return s
  const head = s.slice(0, max - 1)
  const lastSpace = head.lastIndexOf(' ')
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head
  return cut + '…'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/seo.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/seo.ts tests/seo.test.ts
git commit -m "feat(seo): add extractDescription markdown-to-excerpt helper"
```

---

## Task 2: escapeJsonForScript — `</script>` injection defense

**Files:**
- Modify: `src/rendering/seo.ts`
- Modify: `tests/seo.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/seo.test.ts`:

```ts
import { escapeJsonForScript } from '../src/rendering/seo.js'

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/seo.test.ts -t escapeJsonForScript`
Expected: FAIL — `escapeJsonForScript` not exported.

- [ ] **Step 3: Implement `escapeJsonForScript`**

Append to `src/rendering/seo.ts`:

```ts
/**
 * JSON.stringify with `<` replaced by `<` so the output is safe to
 * embed inside a `<script>` block. JSON.parse on the result yields the
 * original value (the escape decodes back to `<`).
 *
 * HTML-escaping (`&lt;`) would corrupt the JSON — different context.
 */
export function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/seo.test.ts -t escapeJsonForScript`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/seo.ts tests/seo.test.ts
git commit -m "feat(seo): add escapeJsonForScript helper for safe JSON-LD embedding"
```

---

## Task 3: buildJsonLd — BlogPosting structured data

**Files:**
- Modify: `src/rendering/seo.ts`
- Modify: `tests/seo.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/seo.test.ts`:

```ts
import { buildJsonLd } from '../src/rendering/seo.js'
import type { Post, Blog } from '../src/schema/index.js'

const minimalBlog: Blog = {
  id: 'b1',
  name: 'My Blog',
  theme: 'minimal',
  createdAt: '2026-04-01T00:00:00Z',
}

const baseDate = '2026-05-01T12:34:56Z'

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

  it('uses extracted body excerpt as description when seoDescription absent', () => {
    const out = buildJsonLd({ post: minimalPost, blog: minimalBlog, canonicalUrl: canonical })
    const json = JSON.parse(out.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<
      string,
      unknown
    >
    expect(json.description).toBe('Hello world.')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/seo.test.ts -t buildJsonLd`
Expected: FAIL — `buildJsonLd` not exported.

- [ ] **Step 3: Implement `buildJsonLd`**

Append to `src/rendering/seo.ts`:

```ts
import type { Blog, Post } from '../schema/index.js'

export interface SeoInput {
  post: Post
  blog: Blog
  canonicalUrl: string
}

/**
 * Build a `<script type="application/ld+json">` block for the post.
 * Required keys: @context, @type, headline, datePublished, mainEntityOfPage.
 * Optional keys (emitted only when source data is present):
 *   dateModified, author, image, description, keywords.
 *
 * Uses escapeJsonForScript to neutralize </script> injection from any
 * user-controlled string (title, author, tags, etc.).
 */
export function buildJsonLd(input: SeoInput): string {
  const { post, canonicalUrl } = input
  const description = post.seoDescription ?? extractDescription(post.body)

  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.seoTitle ?? post.title,
    datePublished: post.publishedAt ?? post.createdAt,
    mainEntityOfPage: canonicalUrl,
  }

  if (post.updatedAt && post.publishedAt && post.updatedAt !== post.publishedAt) {
    data.dateModified = post.updatedAt
  }
  if (post.author) {
    data.author = { '@type': 'Person', name: post.author }
  }
  if (post.coverImage) {
    data.image = post.coverImage
  }
  if (description) {
    data.description = description
  }
  if (post.tags && post.tags.length > 0) {
    data.keywords = post.tags.join(',')
  }

  return `<script type="application/ld+json">${escapeJsonForScript(data)}</script>`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/seo.test.ts -t buildJsonLd`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/seo.ts tests/seo.test.ts
git commit -m "feat(seo): add buildJsonLd for BlogPosting structured data"
```

---

## Task 4: buildSeoMeta — full meta-tag block

**Files:**
- Modify: `src/rendering/seo.ts`
- Modify: `tests/seo.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/seo.test.ts`:

```ts
import { buildSeoMeta } from '../src/rendering/seo.js'

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

  it('falls back to extracted body excerpt for description', () => {
    const out = buildSeoMeta({ post: minimalPost, blog: minimalBlog, canonicalUrl: canonical })
    expect(out).toContain('<meta name="description" content="Hello world.">')
    expect(out).toContain('<meta property="og:description" content="Hello world.">')
    expect(out).toContain('<meta name="twitter:description" content="Hello world.">')
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
    expect(out).toContain(
      '<meta property="article:modified_time" content="2026-05-02T00:00:00Z">',
    )
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
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/seo.test.ts -t buildSeoMeta`
Expected: FAIL — `buildSeoMeta` not exported.

- [ ] **Step 3: Implement `buildSeoMeta`**

Append to `src/rendering/seo.ts`:

```ts
import { escapeHtml } from './templates.js'

/**
 * Build the full block of SEO `<meta>` tags for a post. Always emits
 * description (when derivable), og:title, og:type, og:url, og:site_name,
 * twitter:card. Conditional emit for image / author / tags / modified_time.
 *
 * Output is `\n`-joined for readable view-source. All user-controlled
 * values pass through escapeHtml.
 */
export function buildSeoMeta(input: SeoInput): string {
  const { post, blog, canonicalUrl } = input
  const lines: string[] = []

  const title = post.seoTitle ?? post.title
  const description = post.seoDescription ?? extractDescription(post.body)
  const siteName = blog.name ?? blog.id
  const hasImage = Boolean(post.coverImage)
  const hasModified =
    post.updatedAt && post.publishedAt && post.updatedAt !== post.publishedAt

  // Description (only when we have one)
  if (description) {
    lines.push(`<meta name="description" content="${escapeHtml(description)}">`)
  }
  if (post.author) {
    lines.push(`<meta name="author" content="${escapeHtml(post.author)}">`)
  }

  // Open Graph
  lines.push(`<meta property="og:title" content="${escapeHtml(title)}">`)
  if (description) {
    lines.push(`<meta property="og:description" content="${escapeHtml(description)}">`)
  }
  lines.push(`<meta property="og:type" content="article">`)
  lines.push(`<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`)
  lines.push(`<meta property="og:site_name" content="${escapeHtml(siteName)}">`)
  if (hasImage) {
    lines.push(`<meta property="og:image" content="${escapeHtml(post.coverImage!)}">`)
    lines.push(`<meta property="og:image:alt" content="${escapeHtml(title)}">`)
  }

  // Article namespace
  if (post.publishedAt) {
    lines.push(`<meta property="article:published_time" content="${escapeHtml(post.publishedAt)}">`)
  }
  if (hasModified) {
    lines.push(`<meta property="article:modified_time" content="${escapeHtml(post.updatedAt)}">`)
  }
  if (post.author) {
    lines.push(`<meta property="article:author" content="${escapeHtml(post.author)}">`)
  }
  if (post.tags) {
    for (const tag of post.tags) {
      lines.push(`<meta property="article:tag" content="${escapeHtml(tag)}">`)
    }
  }

  // Twitter Card
  lines.push(
    `<meta name="twitter:card" content="${hasImage ? 'summary_large_image' : 'summary'}">`,
  )
  lines.push(`<meta name="twitter:title" content="${escapeHtml(title)}">`)
  if (description) {
    lines.push(`<meta name="twitter:description" content="${escapeHtml(description)}">`)
  }
  if (hasImage) {
    lines.push(`<meta name="twitter:image" content="${escapeHtml(post.coverImage!)}">`)
  }

  return lines.join('\n')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/seo.test.ts`
Expected: PASS — all SEO tests (~34 across all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/rendering/seo.ts tests/seo.test.ts
git commit -m "feat(seo): add buildSeoMeta with full OG + Twitter Card + article namespace"
```

---

## Task 5: Wire seo.ts into the renderer

**Files:**
- Modify: `src/rendering/generator.ts`
- Modify: `src/themes/minimal/post.html`

- [ ] **Step 1: Update post.html template**

Edit `src/themes/minimal/post.html`. Replace:

```html
<title>{{postTitle}} — {{blogName}}</title>
{{{seoMeta}}}
<link rel="stylesheet" href="{{themeCssHref}}" />
<link rel="canonical" href="{{canonicalUrl}}" />
```

with:

```html
<title>{{postTitle}} — {{blogName}}</title>
<link rel="canonical" href="{{canonicalUrl}}" />
{{{seoMeta}}}
{{{jsonLd}}}
<link rel="stylesheet" href="{{themeCssHref}}" />
```

(Canonical moves above seoMeta so og:url has visual proximity to the canonical link in source view. Stylesheet stays last in `<head>` so the parser can start applying styles after metadata.)

- [ ] **Step 2: Replace renderSeoMeta call site in generator.ts**

In `src/rendering/generator.ts`:

1. Remove the `renderSeoMeta` function (lines ~123-145).
2. At the top of the file, add:

```ts
import { buildJsonLd, buildSeoMeta } from './seo.js'
```

3. Inside `createRenderer`'s `renderPost`, find the existing `seoMeta:` line in the `render(theme.post, { ... })` call. Replace:

```ts
seoMeta: renderSeoMeta(post.seoTitle, post.seoDescription),
```

with:

```ts
seoMeta: buildSeoMeta({ post, blog, canonicalUrl }),
jsonLd: buildJsonLd({ post, blog, canonicalUrl }),
```

(`canonicalUrl` is already computed in scope — same value passed to `canonicalUrl` template var.)

- [ ] **Step 3: Run the existing test suite**

Run: `pnpm test tests/rendering.test.ts`
Expected: FAIL — old `renderSeoMeta` tests reference an export that no longer exists.

- [ ] **Step 4: Replace renderSeoMeta tests with integration tests**

In `tests/rendering.test.ts`:

a) Remove the entire `describe('renderSeoMeta', ...)` block (4 tests around lines 219–240).

b) Remove the `renderSeoMeta,` line from the import block at the top of the file (around line 11).

c) Add new integration tests inside the existing `describe('createRenderer — renderPost', ...)` block (which already has `beforeEach`/`afterEach` setup with `mkdtempSync` + `createStore` + `outputDir` and uses `createBlog` + `makePost`). Append these tests to that block before its closing `})`:

```ts
  it('emits canonical link, OG meta, Twitter Card, and JSON-LD for a published post', () => {
    const { blog } = createBlog(store, { name: 'test-blog' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderPost(
      blog.id,
      makePost({ blogId: blog.id, slug: 'my-post', title: 'My Post', body: 'Hello world.' }),
    )

    const html = readFileSync(join(outputDir, blog.id, 'my-post', 'index.html'), 'utf8')
    expect(html).toContain('<link rel="canonical"')
    expect(html).toContain('<meta property="og:title" content="My Post">')
    expect(html).toContain('<meta property="og:type" content="article">')
    expect(html).toContain('<meta name="twitter:card"')
    expect(html).toContain('<script type="application/ld+json">')
    expect(html).toContain('"@type":"BlogPosting"')
  })

  it('uses seoTitle and seoDescription when present', () => {
    const { blog } = createBlog(store, { name: 'b' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderPost(
      blog.id,
      makePost({
        blogId: blog.id,
        slug: 's',
        title: 'Default',
        body: 'Body.',
        seoTitle: 'Override',
        seoDescription: 'Custom.',
      }),
    )

    const html = readFileSync(join(outputDir, blog.id, 's', 'index.html'), 'utf8')
    expect(html).toContain('<meta property="og:title" content="Override">')
    expect(html).toContain('<meta name="description" content="Custom.">')
  })
```

These piggyback on the existing fixture — no new helper required. The plan-writer verified these patterns against the file at lines 439–498 of `tests/rendering.test.ts`.

- [ ] **Step 5: Run the full check**

Run: `pnpm check`
Expected: PASS — typecheck, lint, format, all 450+ tests including new ones.

- [ ] **Step 6: Commit**

```bash
git add src/rendering/generator.ts src/themes/minimal/post.html tests/rendering.test.ts
git commit -m "feat(seo): wire buildSeoMeta + buildJsonLd into post rendering"
```

---

## Task 6: Capture learnings in docs/solutions/

**Files:**
- Create: `docs/solutions/seo-meta-fallbacks.md`

- [ ] **Step 1: Write the learning**

Create `docs/solutions/seo-meta-fallbacks.md`:

```md
---
title: SEO meta fallbacks and JSON-LD script-tag safety
tags: [rendering, seo, themes, security]
severity: p3
date: 2026-05-01
applies-to: [core, platform, self-hosted]
---

## Rule

Every published post emits a complete `<head>`: description, og:*, twitter:*, JSON-LD `BlogPosting`. Empty author-set SEO fields fall back deterministically — never produce a blank social preview.

## Fallback chain

| Tag source | Fallback when absent |
|------------|----------------------|
| description, og:description, twitter:description | `extractDescription(post.body)` — markdown stripped, whitespace collapsed, 160-char word-boundary truncation |
| og:title, twitter:title | `post.title` |
| og:image, twitter:image | omitted (no default image; YAGNI for v1) |
| og:site_name | `blog.name ?? blog.id` |
| article:modified_time | omitted when `updatedAt === publishedAt` |

## JSON-LD script-tag safety

User-controlled strings (title, author, tags) can contain `</script>`. HTML-escaping inside `<script>` is the wrong tool — it would corrupt the JSON. Instead, `escapeJsonForScript` does `JSON.stringify(...)` then replaces `<` with `<`. JSON.parse decodes `<` back to `<`, so consumers see the original string; the literal `</script>` byte sequence never appears in HTML output.

## Why the SEO module is separate from generator.ts

`generator.ts` orchestrates file-system writes (`mkdirSync`, `writeFileSync`, CSS copy, blog index re-render). `seo.ts` is pure: takes a Post + Blog + canonical URL, returns strings. Mixing them coupled testable pure logic to a sync I/O surface for no reason. Splitting also keeps `generator.ts` from growing past ~200 lines.

## Example / proof

- Implementation: `src/rendering/seo.ts`
- Pure-helper tests: `tests/seo.test.ts`
- Integration tests: `tests/rendering.test.ts` (`describe('post rendering — SEO surface')`)
```

- [ ] **Step 2: Commit**

```bash
git add docs/solutions/seo-meta-fallbacks.md
git commit -m "docs: capture SEO meta fallbacks and JSON-LD script-tag safety"
```

---

## Task 7: Final verification + PR

- [ ] **Step 1: Run the full check**

Run: `pnpm check`
Expected: PASS — typecheck, lint, format, all tests.

- [ ] **Step 2: Render a sample post and inspect the HTML**

Run: `pnpm test tests/rendering.test.ts -t "SEO surface"`
Then inspect a generated post HTML file from a debug session if you want a sanity check of the actual `<head>` block. The integration tests already assert correctness; this is just for human eyeball confirmation.

- [ ] **Step 3: Push and open PR to dev**

```bash
git push -u origin feat/blog-post-seo
gh pr create --base dev --title "feat(seo): full <head> meta + JSON-LD on every post"
```

PR body should:
1. Link to this plan and the spec.
2. Include a before/after diff of a sample rendered `<head>`.
3. Note: rendering-only change. Backwards-compatible. Existing posts pick up the new metadata on their next publish (no migration; no manual rebuild required since the renderer always overwrites).

---

## Self-review checklist (run before marking plan ready)

- [ ] Spec coverage: every decision in `2026-05-01-blog-post-seo-design.md` has at least one task.
- [ ] No "TBD" / "implement later" / "add appropriate handling" placeholders.
- [ ] Type names consistent across tasks (`SeoInput`, `buildSeoMeta`, `buildJsonLd`, `extractDescription`, `escapeJsonForScript` — verify each is used identically in every task that references it).
- [ ] Each test in the plan is concrete code, not a description of a test.
- [ ] All file paths are exact (`src/rendering/seo.ts`, `tests/seo.test.ts`, etc.).
- [ ] Commit messages are present and aligned with repo convention (`feat(seo):`, `docs:`).
