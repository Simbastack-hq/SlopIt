# Agent-Readable File Outputs — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every published post is accessible at `<slug>.md` (raw markdown source). Every blog has an `llms.txt` manifest, a `feed.xml` RSS 2.0 feed, and a `sitemap.xml`. All four files written at publish time alongside the existing HTML output. Caddy serves them; Node never reads them.

**Architecture:** Two new pure modules: `src/rendering/frontmatter.ts` (YAML frontmatter builder) and `src/rendering/feeds.ts` (RSS/sitemap/llms.txt builders, plus `escapeXml`). Four new templates in `src/themes/minimal/`. `MutationRenderer` interface gains four methods; `createRenderer` implements them and wires them into the existing `renderPost` flow. `unpublishPost` and `deletePost` invoke the cleanup methods. No new deps.

**Tech Stack:** TypeScript (strict), Node.js, Vitest, existing `escapeHtml` and template rendering. No XML or YAML library.

**Spec:** [docs/superpowers/specs/2026-05-01-blog-post-seo-phase-2-design.md](../specs/2026-05-01-blog-post-seo-phase-2-design.md).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/rendering/frontmatter.ts` | Create | `buildFrontmatter(record)` |
| `src/rendering/feeds.ts` | Create | `escapeXml`, `buildRssFeed`, `buildSitemap`, `buildLlmsTxt` |
| `src/rendering/generator.ts` | Modify | Extend `MutationRenderer` interface + `createRenderer` factory |
| `src/themes/minimal/post.md.template` | Create | YAML frontmatter + body |
| `src/themes/minimal/llms.txt.template` | Create | Manifest format |
| `src/themes/minimal/feed.xml.template` | Create | RSS 2.0 envelope |
| `src/themes/minimal/sitemap.xml.template` | Create | Standard sitemap |
| `src/posts.ts` | Modify | Wire cleanup into `unpublishPost` / `deletePost` |
| `src/skill.ts` | Modify | Document new endpoints |
| `examples/self-hosted/Caddyfile` | Modify | `Content-Type` rules |
| `tests/feeds.test.ts` | Create | Unit tests for `feeds.ts` exports |
| `tests/frontmatter.test.ts` | Create | Unit tests for `buildFrontmatter` |
| `tests/rendering.test.ts` | Modify | Lifecycle integration tests |
| `tests/skill.test.ts` | Modify | Drift tests for new agent docs |
| `docs/solutions/agent-readable-file-outputs.md` | Create | Capture lifecycle table + atomicity pattern |

---

## Task 1: escapeXml helper

**Files:**
- Create: `src/rendering/feeds.ts`
- Create: `tests/feeds.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { escapeXml } from '../src/rendering/feeds.js'

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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test tests/feeds.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
/**
 * Escape the five canonical XML special characters. Ampersand MUST
 * be replaced first; otherwise other replacements introduce ampersands
 * that get doubly-escaped. Same invariant as `escapeHtml`.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test tests/feeds.test.ts -t escapeXml`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/feeds.ts tests/feeds.test.ts
git commit -m "feat(feeds): add escapeXml helper for the 5 canonical XML chars"
```

---

## Task 2: buildFrontmatter — YAML for the .md frontmatter

**Files:**
- Create: `src/rendering/frontmatter.ts`
- Create: `tests/frontmatter.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { buildFrontmatter } from '../src/rendering/frontmatter.js'

describe('buildFrontmatter', () => {
  it('emits a delimited YAML block with quoted string values', () => {
    const out = buildFrontmatter({ title: 'Hello', slug: 'hello' })
    expect(out).toBe('---\ntitle: "Hello"\nslug: "hello"\n---')
  })

  it('omits null and undefined values entirely', () => {
    const out = buildFrontmatter({
      title: 'A',
      slug: 'a',
      author: undefined,
      updated: null,
    })
    expect(out).not.toContain('author')
    expect(out).not.toContain('updated')
  })

  it('omits empty arrays', () => {
    const out = buildFrontmatter({ title: 'A', slug: 'a', tags: [] })
    expect(out).not.toContain('tags')
  })

  it('emits non-empty arrays as flow-style lists', () => {
    const out = buildFrontmatter({ title: 'A', slug: 'a', tags: ['ai', 'agents'] })
    expect(out).toContain('tags: ["ai", "agents"]')
  })

  it('escapes backslashes and double quotes inside string values', () => {
    const out = buildFrontmatter({ title: 'a "quoted" \\ slash', slug: 's' })
    expect(out).toContain('title: "a \\"quoted\\" \\\\ slash"')
  })

  it('preserves ISO 8601 date strings verbatim', () => {
    const out = buildFrontmatter({ title: 'A', slug: 'a', date: '2026-05-01T12:34:56Z' })
    expect(out).toContain('date: "2026-05-01T12:34:56Z"')
  })

  it('handles all 8 documented keys in canonical order', () => {
    const out = buildFrontmatter({
      title: 'T',
      slug: 's',
      date: '2026-05-01T00:00:00Z',
      updated: '2026-05-02T00:00:00Z',
      author: 'A',
      description: 'D',
      canonical: 'https://example.com/s/',
      tags: ['x'],
    })
    const lines = out.split('\n')
    expect(lines[0]).toBe('---')
    expect(lines[1]).toBe('title: "T"')
    expect(lines[2]).toBe('slug: "s"')
    expect(lines[3]).toBe('date: "2026-05-01T00:00:00Z"')
    expect(lines[4]).toBe('updated: "2026-05-02T00:00:00Z"')
    expect(lines[5]).toBe('author: "A"')
    expect(lines[6]).toBe('description: "D"')
    expect(lines[7]).toBe('canonical: "https://example.com/s/"')
    expect(lines[8]).toBe('tags: ["x"]')
    expect(lines[9]).toBe('---')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test tests/frontmatter.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
/**
 * Build a YAML frontmatter block (between `---` delimiters) for a
 * post's .md source file. Schema is fixed: title, slug, date, updated,
 * author, description, canonical, tags. Null/undefined/empty-array
 * values are omitted (not emitted as `key: null`).
 *
 * String values are double-quoted and escape `\` → `\\` and `"` → `\"`.
 * Tags emit as flow-style lists.
 */
export interface FrontmatterFields {
  title: string
  slug: string
  date?: string | null
  updated?: string | null
  author?: string | null
  description?: string | null
  canonical?: string | null
  tags?: readonly string[]
}

const KEYS = ['title', 'slug', 'date', 'updated', 'author', 'description', 'canonical'] as const

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function buildFrontmatter(fields: FrontmatterFields): string {
  const lines: string[] = ['---']
  for (const key of KEYS) {
    const v = fields[key]
    if (v === undefined || v === null) continue
    lines.push(`${key}: ${quote(v)}`)
  }
  if (fields.tags && fields.tags.length > 0) {
    const items = fields.tags.map(quote).join(', ')
    lines.push(`tags: [${items}]`)
  }
  lines.push('---')
  return lines.join('\n')
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test tests/frontmatter.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/frontmatter.ts tests/frontmatter.test.ts
git commit -m "feat(rendering): add buildFrontmatter for .md source files"
```

---

## Task 3: buildLlmsTxt — per-blog manifest

**Files:**
- Modify: `src/rendering/feeds.ts`
- Modify: `tests/feeds.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/feeds.test.ts`:

```ts
import { buildLlmsTxt } from '../src/rendering/feeds.js'

const blog = { id: 'b1', name: 'My Blog', theme: 'minimal', createdAt: '2026-01-01T00:00:00Z' }

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
    expect(out).toContain('> An agent-first blog. Read the markdown source by appending `.md` to any post URL.')
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
    const evil = { ...post1, title: 'has [bracket] in it', canonicalUrl: 'https://b.slopit.io/has-paren-(in-it)/' }
    const out = buildLlmsTxt({ blog, posts: [evil] })
    // Title: brackets escaped with backslash so MD parsers don't read them as links
    expect(out).toContain('has \\[bracket\\] in it')
    // URL: parens encoded
    expect(out).toContain('https://b.slopit.io/has-paren-%28in-it%29/')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test tests/feeds.test.ts -t buildLlmsTxt`
Expected: FAIL — `buildLlmsTxt` not exported.

- [ ] **Step 3: Implement**

Append to `src/rendering/feeds.ts`:

```ts
import type { Blog } from '../schema/index.js'

export interface LlmsTxtPost {
  title: string
  canonicalUrl: string
  description: string
  publishedAt: string
}

export interface LlmsTxtInput {
  blog: Pick<Blog, 'id' | 'name'>
  posts: readonly LlmsTxtPost[]
}

const LLMS_INTRO =
  '> An agent-first blog. Read the markdown source by appending `.md` to any post URL.'

function escapeMdTitle(s: string): string {
  return s.replace(/[[\]]/g, (c) => '\\' + c)
}

function escapeMdUrl(s: string): string {
  return s.replace(/[()]/g, (c) => encodeURIComponent(c))
}

/**
 * Build the per-blog `llms.txt` manifest. Posts are listed in the
 * order the caller provides; sorting (newest-first) is the renderer's
 * responsibility, not this helper's.
 */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const heading = `# ${input.blog.name ?? input.blog.id}`
  const lines: string[] = [heading, '', LLMS_INTRO, '', '## Posts', '']
  for (const p of input.posts) {
    const title = escapeMdTitle(p.title)
    const url = escapeMdUrl(p.canonicalUrl)
    const desc = p.description ? `: ${p.description}` : ''
    lines.push(`- [${title}](${url})${desc}`)
  }
  return lines.join('\n') + '\n'
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test tests/feeds.test.ts -t buildLlmsTxt`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/feeds.ts tests/feeds.test.ts
git commit -m "feat(feeds): add buildLlmsTxt for per-blog agent-readable manifest"
```

---

## Task 4: buildSitemap

**Files:**
- Modify: `src/rendering/feeds.ts`
- Modify: `tests/feeds.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/feeds.test.ts`:

```ts
import { buildSitemap } from '../src/rendering/feeds.js'

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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test tests/feeds.test.ts -t buildSitemap`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/rendering/feeds.ts`:

```ts
export interface SitemapPost {
  canonicalUrl: string
  updatedAt: string
}

export interface SitemapInput {
  blogRoot: string
  posts: readonly SitemapPost[]
  updatedAt: string // most-recent updatedAt across the blog (for the root entry)
}

function urlEntry(loc: string, lastmod: string): string {
  return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${escapeXml(lastmod)}</lastmod>\n    <changefreq>weekly</changefreq>\n  </url>`
}

export function buildSitemap(input: SitemapInput): string {
  const entries = [urlEntry(input.blogRoot, input.updatedAt)]
  for (const p of input.posts) {
    entries.push(urlEntry(p.canonicalUrl, p.updatedAt))
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test tests/feeds.test.ts -t buildSitemap`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/feeds.ts tests/feeds.test.ts
git commit -m "feat(feeds): add buildSitemap for per-blog sitemap.xml"
```

---

## Task 5: buildRssFeed

**Files:**
- Modify: `src/rendering/feeds.ts`
- Modify: `tests/feeds.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/feeds.test.ts`:

```ts
import { buildRssFeed } from '../src/rendering/feeds.js'

describe('buildRssFeed', () => {
  const blog = { id: 'b1', name: 'My Blog', theme: 'minimal', createdAt: '2026-01-01T00:00:00Z' }
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
    expect((out.match(/<!\[CDATA\[/g) ?? []).length).toBe(
      (out.match(/\]\]>/g) ?? []).length,
    )
  })

  it('falls back to blog.name as author when post.author absent', () => {
    const out = buildRssFeed({ blog, blogRoot, feedUrl, posts: [{ ...sample, author: undefined }] })
    expect(out).toContain('<author>My Blog</author>')
  })

  it('omits <description> when empty', () => {
    const out = buildRssFeed({ blog, blogRoot, feedUrl, posts: [{ ...sample, description: '' }] })
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test tests/feeds.test.ts -t buildRssFeed`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `src/rendering/feeds.ts`:

```ts
export interface RssPost {
  title: string
  canonicalUrl: string
  description: string
  publishedAt: string
  author?: string
  bodyHtml: string
}

export interface RssFeedInput {
  blog: Pick<Blog, 'id' | 'name'>
  blogRoot: string
  feedUrl: string
  posts: readonly RssPost[]
}

const STATIC_CHANNEL_DESCRIPTION = 'An agent-first blog hosted on SlopIt.'

function rfc822(iso: string): string {
  return new Date(iso).toUTCString().replace('GMT', 'GMT')
}

function escapeCdata(s: string): string {
  // The ONLY way to break out of a CDATA section is the literal sequence ]]>.
  // Standard fix: split it across two CDATA sections.
  return s.replace(/\]\]>/g, ']]]]><![CDATA[>')
}

function rssItem(p: RssPost, channelTitle: string): string {
  const author = escapeXml(p.author ?? channelTitle)
  const lines = [
    '    <item>',
    `      <title>${escapeXml(p.title)}</title>`,
    `      <link>${escapeXml(p.canonicalUrl)}</link>`,
    `      <guid isPermaLink="true">${escapeXml(p.canonicalUrl)}</guid>`,
    `      <pubDate>${rfc822(p.publishedAt)}</pubDate>`,
    `      <author>${author}</author>`,
  ]
  if (p.description) {
    lines.push(`      <description>${escapeXml(p.description)}</description>`)
  }
  lines.push(`      <content:encoded><![CDATA[${escapeCdata(p.bodyHtml)}]]></content:encoded>`)
  lines.push('    </item>')
  return lines.join('\n')
}

export function buildRssFeed(input: RssFeedInput): string {
  const channelTitle = input.blog.name ?? input.blog.id
  const items = input.posts.map((p) => rssItem(p, channelTitle)).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(channelTitle)}</title>`,
    `    <link>${escapeXml(input.blogRoot)}</link>`,
    `    <description>${escapeXml(STATIC_CHANNEL_DESCRIPTION)}</description>`,
    `    <atom:link href="${escapeXml(input.feedUrl)}" rel="self" type="application/rss+xml" />`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n')
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test tests/feeds.test.ts -t buildRssFeed`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/feeds.ts tests/feeds.test.ts
git commit -m "feat(feeds): add buildRssFeed for per-blog RSS 2.0 output"
```

---

## Task 6: Wire renderer integration — emit/cleanup

**Files:**
- Modify: `src/rendering/generator.ts`
- Modify: `src/posts.ts`
- Modify: `tests/rendering.test.ts`

- [ ] **Step 1: Add the four interface methods + implementation**

In `src/rendering/generator.ts`, extend `MutationRenderer`:

```ts
// (paste inside the existing MutationRenderer interface definition)
renderPostMarkdown(blogId: string, post: Post): void
deletePostMarkdown(blogId: string, slug: string): void
renderManifests(blogId: string): void  // emits llms.txt + feed.xml + sitemap.xml together
```

Inside `createRenderer`:

```ts
import { buildFrontmatter } from './frontmatter.js'
import { buildLlmsTxt, buildRssFeed, buildSitemap } from './feeds.js'
import { extractDescription } from './seo.js' // already in scope from Phase 1
```

Add concrete implementations that:
- Resolve description via `post.seoDescription ?? post.excerpt ?? extractDescription(post.body)` (matches Phase 1 chain).
- Use the same temp-write-then-rename pattern as `renderPost` (verify in `generator.ts` that this helper exists; if not, lift it out of `renderPost` into a private `writeFileAtomic(path, content)` helper as part of this step).
- For `renderManifests`: query published posts via the existing internal helper (look for `listPublishedPostsForBlog` or equivalent in `src/posts.ts`); sort newest-first by `publishedAt`; cap RSS at 20.

- [ ] **Step 2: Wire calls into existing flows**

In `createRenderer.renderPost` (existing function), at the end of the success path, add:

```ts
this.renderPostMarkdown(blogId, post)  // for published only
this.renderManifests(blogId)
```

In `src/posts.ts`:
- `unpublishPost`: after the existing `renderer.unpublishPost`-equivalent cleanup of the HTML, call `renderer.deletePostMarkdown(blogId, slug)` and `renderer.renderManifests(blogId)`.
- `deletePost`: same cleanup.

- [ ] **Step 3: Add lifecycle integration tests**

In `tests/rendering.test.ts`'s `describe('createRenderer — renderPost', ...)`:

```ts
it('writes <slug>.md, llms.txt, feed.xml, sitemap.xml on publish', () => {
  const { blog } = createBlog(store, { name: 'b' })
  const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
  renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 'hello' }))

  expect(existsSync(join(outputDir, blog.id, 'hello.md'))).toBe(true)
  expect(existsSync(join(outputDir, blog.id, 'llms.txt'))).toBe(true)
  expect(existsSync(join(outputDir, blog.id, 'feed.xml'))).toBe(true)
  expect(existsSync(join(outputDir, blog.id, 'sitemap.xml'))).toBe(true)
})

it('removes <slug>.md when post is unpublished', () => {
  // ...createPost(published), assert .md exists, then updatePost({status:'draft'})
  // assert .md removed and feed.xml regenerated without the post
})

it('removes <slug>.md when post is deleted', () => {
  // similar shape, deletePost
})
```

(Adapt to the actual test fixture pattern in the file. Existing render tests in this `describe` block already cover the setup.)

- [ ] **Step 4: Run the full check**

Run: `pnpm check`
Expected: PASS — typecheck, lint, format, all tests including new lifecycle assertions.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/generator.ts src/posts.ts tests/rendering.test.ts
git commit -m "feat(rendering): emit .md/llms.txt/feed.xml/sitemap.xml on post lifecycle"
```

---

## Task 7: Update SKILL.md

**Files:**
- Modify: `src/skill.ts`
- Modify: `tests/skill.test.ts`

- [ ] **Step 1: Add the agent-endpoints section**

In `src/skill.ts`, find the existing endpoint documentation and add:

```ts
// (snippet to inject — exact placement matches existing convention)
const AGENT_ENDPOINTS_DOC = `
## Agent-readable endpoints

Every blog hosted on this SlopIt instance exposes four read-only files for agent consumption:

- \`<blog-root>/llms.txt\` — manifest of all published posts (newest first)
- \`<blog-root>/<slug>.md\` — raw markdown source for any published post
- \`<blog-root>/feed.xml\` — RSS 2.0 feed of the 20 most recent posts
- \`<blog-root>/sitemap.xml\` — sitemap.xml of all published posts

These are static files served by the reverse proxy. No authentication required. They regenerate automatically when posts are published, updated, unpublished, or deleted.
`
```

- [ ] **Step 2: Update drift tests**

In `tests/skill.test.ts`, add assertions that the SKILL output contains the strings:
- `agent-readable endpoints`
- `llms.txt`
- `<slug>.md`
- `feed.xml`
- `sitemap.xml`

- [ ] **Step 3: Run check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/skill.ts tests/skill.test.ts
git commit -m "docs(skill): document the four agent-readable endpoints"
```

---

## Task 8: Self-hosted Caddyfile

**Files:**
- Modify: `examples/self-hosted/Caddyfile`

- [ ] **Step 1: Add Content-Type rules**

In the static-file `file_server` block (or the equivalent route handler), add:

```caddy
@markdown path *.md
header @markdown Content-Type "text/markdown; charset=utf-8"

@llmstxt path /llms.txt
header @llmstxt Content-Type "text/markdown; charset=utf-8"

@feed path /feed.xml
header @feed Content-Type "application/rss+xml; charset=utf-8"

@sitemap path /sitemap.xml
header @sitemap Content-Type "application/xml; charset=utf-8"
```

- [ ] **Step 2: Verify Docker Compose still publishes a post**

Run: `cd examples/self-hosted && docker compose up -d && curl http://localhost:8080/llms.txt`
Expected: 200 OK with `Content-Type: text/markdown; charset=utf-8`.

(If Docker isn't available locally, leave this as a manual smoke check note in the PR description.)

- [ ] **Step 3: Commit**

```bash
git add examples/self-hosted/Caddyfile
git commit -m "feat(self-hosted): set Content-Type for .md/llms.txt/feed.xml/sitemap.xml"
```

---

## Task 9: Capture learnings

**Files:**
- Create: `docs/solutions/agent-readable-file-outputs.md`

- [ ] **Step 1: Write the doc**

```md
---
title: Agent-readable file outputs alongside HTML
tags: [rendering, themes, agents, seo]
severity: p3
date: 2026-05-01
applies-to: [core, platform, self-hosted]
---

## Rule

Every published post writes five files: `<slug>/index.html`, `<slug>.md`, plus the per-blog `llms.txt`, `feed.xml`, `sitemap.xml`. All emit at the same lifecycle moments (publish, update, unpublish, delete). All are static; Caddy serves them; Node never reads them.

## Lifecycle table

| Trigger | Files written | Files deleted |
|---|---|---|
| publish | `<slug>/index.html`, `<slug>.md`, `llms.txt`, `feed.xml`, `sitemap.xml` | — |
| update (still published) | same | — |
| unpublish or delete | `llms.txt`, `feed.xml`, `sitemap.xml` (regen w/o post) | `<slug>/index.html`, `<slug>.md` |
| delete blog | — | entire `{outputDir}/{blogId}/` tree |

## Atomicity

All four new file types use the same temp-write-then-rename pattern as `<slug>/index.html`. Caddy can race the renderer; rename is atomic on POSIX so a partial file never serves.

## CDATA escape inside `<content:encoded>`

The literal sequence `]]>` in a post body breaks out of a CDATA section. Standard fix: replace `]]>` with `]]]]><![CDATA[>` — close one CDATA, embed the `>` in the next. Same idea as `<` for `</script>` in JSON-LD.

## Why hand-rolled XML/YAML

Boring tech wins. Total lines for `feeds.ts` + `frontmatter.ts` is ~150. A YAML lib is ~10× that as a transitive dep. The output schema is fixed; we control every value.

## Example / proof

- Helpers: `src/rendering/feeds.ts`, `src/rendering/frontmatter.ts`
- Wiring: `src/rendering/generator.ts` (`renderPostMarkdown`, `renderManifests`)
- Unit tests: `tests/feeds.test.ts`, `tests/frontmatter.test.ts`
- Integration: `tests/rendering.test.ts`
```

- [ ] **Step 2: Commit**

```bash
git add docs/solutions/agent-readable-file-outputs.md
git commit -m "docs: capture lifecycle table and CDATA-escape pattern for Phase 2"
```

---

## Task 10: Final verification + PR

- [ ] **Step 1: Run full check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 2: Manual validator passes (before merge)**

- W3C Feed Validator on `feed.xml` from a test blog.
- Google sitemap-format check on `sitemap.xml`.
- `cat blog/some-post.md` and verify YAML frontmatter parses with any standard YAML parser.

- [ ] **Step 3: Push and PR**

```bash
git push -u origin plan/agent-readable-blogs-phase-2
gh pr create --base dev --title "feat: agent-readable file outputs (Phase 2)"
```

PR body links to this plan and the spec. Notes that Phase 1's `<link rel="alternate">` placeholders now resolve. Flags the platform-side `Caddyfile` follow-up needed.

---

## Self-review checklist

- [ ] Spec coverage: every decision in `2026-05-01-blog-post-seo-phase-2-design.md` (19 rows) maps to a task.
- [ ] No placeholder text in any Step.
- [ ] Type names consistent (`LlmsTxtInput`, `RssFeedInput`, `SitemapInput`, `FrontmatterFields`).
- [ ] All file paths exact.
- [ ] Each test step contains real test code, not a description.
