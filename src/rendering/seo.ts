import type { Blog, Post } from '../schema/index.js'
import { escapeHtml } from './templates.js'

/**
 * Strip markdown formatting, collapse whitespace, truncate on word boundary.
 * Used as the fallback for `<meta name="description">` when an author hasn't
 * set `seoDescription` or `excerpt`. Returns '' for empty / pure-formatting input.
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

/**
 * Resolve a post's description via the documented chain:
 *   post.seoDescription → post.excerpt → extractDescription(post.body)
 * Returns '' if all three resolve to empty. Used by both buildSeoMeta
 * and buildJsonLd in this phase, and re-used by Phase 2's `.md`/RSS/
 * `llms.txt` generators. Single source of truth for description-fallback.
 */
export function resolveDescription(post: Post): string {
  if (post.seoDescription) return post.seoDescription
  if (post.excerpt) return post.excerpt
  return extractDescription(post.body)
}

/**
 * Strip one trailing slash from a base URL so that callers can safely
 * append `'/' + slug + '/'` without producing double slashes.
 *
 * Platform passes named-blog base URLs as `https://${name}.slopit.io/`
 * (with trailing slash); the existing inline concatenation in
 * `generator.ts` would produce `https://${name}.slopit.io//slug/`.
 * This helper normalizes once at the boundary.
 */
export function normalizeBaseUrl(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

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
  // Description follows the documented fallback chain via resolveDescription.
  // Phase 2 reuses the same helper so .md/RSS/llms.txt produce the same
  // description for the same post.
  const description = resolveDescription(post)

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

/**
 * Build the full block of SEO `<meta>` tags for a post. Always emits
 * og:title, og:type, og:url, og:site_name, twitter:card. Conditional
 * emit for description (when derivable), image, author, tags, and
 * article:modified_time.
 *
 * Output is `\n`-joined for readable view-source. All user-controlled
 * values pass through escapeHtml.
 */
export function buildSeoMeta(input: SeoInput): string {
  const { post, blog, canonicalUrl } = input
  const lines: string[] = []

  const title = post.seoTitle ?? post.title
  const description = resolveDescription(post)
  const siteName = blog.name ?? blog.id
  const hasImage = Boolean(post.coverImage)
  const hasModified = Boolean(
    post.updatedAt && post.publishedAt && post.updatedAt !== post.publishedAt,
  )

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
  if (post.coverImage) {
    lines.push(`<meta property="og:image" content="${escapeHtml(post.coverImage)}">`)
    lines.push(`<meta property="og:image:alt" content="${escapeHtml(title)}">`)
  }

  // Article namespace
  if (post.publishedAt) {
    lines.push(`<meta property="article:published_time" content="${escapeHtml(post.publishedAt)}">`)
  }
  if (hasModified && post.updatedAt) {
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
  lines.push(`<meta name="twitter:card" content="${hasImage ? 'summary_large_image' : 'summary'}">`)
  lines.push(`<meta name="twitter:title" content="${escapeHtml(title)}">`)
  if (description) {
    lines.push(`<meta name="twitter:description" content="${escapeHtml(description)}">`)
  }
  if (post.coverImage) {
    lines.push(`<meta name="twitter:image" content="${escapeHtml(post.coverImage)}">`)
  }

  return lines.join('\n')
}
