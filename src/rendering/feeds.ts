import type { Blog } from '../schema/index.js'
import { blogDisplayName } from './seo.js'

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

// -----------------------------------------------------------------------------
// llms.txt — per-blog manifest
// -----------------------------------------------------------------------------

export interface LlmsTxtPost {
  title: string
  canonicalUrl: string
  description: string
  publishedAt: string
}

export interface LlmsTxtInput {
  blog: Pick<Blog, 'id' | 'name' | 'title'>
  posts: readonly LlmsTxtPost[]
}

const LLMS_INTRO =
  '> An agent-first blog. Read the markdown source by appending `.md` to any post URL.'

function escapeMdTitle(s: string): string {
  return s.replace(/[[\]]/g, (c) => '\\' + c)
}

function escapeMdUrl(s: string): string {
  // encodeURIComponent leaves parens unencoded (they're reserved-but-allowed
  // in URLs), so percent-encode them manually — Markdown link parsers break
  // when they see literal `(` or `)` inside the `(url)` portion.
  return s.replace(/\(/g, '%28').replace(/\)/g, '%29')
}

/**
 * Build the per-blog `llms.txt` manifest. Posts are listed in the
 * order the caller provides; sorting (newest-first) is the renderer's
 * responsibility, not this helper's.
 */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const heading = `# ${blogDisplayName(input.blog)}`
  const lines: string[] = [heading, '', LLMS_INTRO, '', '## Posts', '']
  for (const p of input.posts) {
    const title = escapeMdTitle(p.title)
    const url = escapeMdUrl(p.canonicalUrl)
    const desc = p.description ? `: ${p.description}` : ''
    lines.push(`- [${title}](${url})${desc}`)
  }
  return lines.join('\n') + '\n'
}

// -----------------------------------------------------------------------------
// sitemap.xml
// -----------------------------------------------------------------------------

export interface SitemapPost {
  canonicalUrl: string
  updatedAt: string
}

/** A non-root language home page (`/lang/<tag>/`). */
export interface SitemapHome {
  url: string
  updatedAt: string // most-recent updatedAt among that language's posts
}

export interface SitemapInput {
  blogRoot: string
  /** Language home pages other than the root. Empty on a monolingual blog. */
  homes: readonly SitemapHome[]
  posts: readonly SitemapPost[]
  updatedAt: string // most-recent updatedAt across the blog (for the root entry)
}

function urlEntry(loc: string, lastmod: string): string {
  return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${escapeXml(lastmod)}</lastmod>\n    <changefreq>weekly</changefreq>\n  </url>`
}

export function buildSitemap(input: SitemapInput): string {
  const entries = [urlEntry(input.blogRoot, input.updatedAt)]
  for (const h of input.homes) {
    entries.push(urlEntry(h.url, h.updatedAt))
  }
  for (const p of input.posts) {
    entries.push(urlEntry(p.canonicalUrl, p.updatedAt))
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`
}

// -----------------------------------------------------------------------------
// robots.txt
// -----------------------------------------------------------------------------

// `User-agent: *` already allows these; naming them makes the welcome
// explicit. Tokens as each vendor documents them (checked 2026-10-10):
// developers.openai.com/api/docs/bots, Anthropic's "Does Anthropic crawl
// data from the web" help article, docs.perplexity.ai/guides/bots, Google's
// common-crawlers page (Google-Extended), support.apple.com/en-us/119829.
const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Google-Extended',
  'Applebot-Extended',
]

// First line of every robots.txt the renderer writes. The renderer only
// rewrites a robots.txt that is missing or starts with this line, so an
// operator's own file (or one with this line deleted) is never replaced.
export const ROBOTS_TXT_HEADER =
  '# Written by SlopIt on every publish. Delete this line to keep your own edits.'

export function buildRobotsTxt(input: { sitemapUrl: string }): string {
  const groups = ['*', ...AI_CRAWLERS].map((ua) => `User-agent: ${ua}\nAllow: /\n`)
  return `${ROBOTS_TXT_HEADER}\n${groups.join('\n')}\nSitemap: ${input.sitemapUrl}\n`
}

// -----------------------------------------------------------------------------
// feed.xml — RSS 2.0 with content:encoded
// -----------------------------------------------------------------------------

export interface RssPost {
  title: string
  canonicalUrl: string
  description: string
  publishedAt: string
  author?: string
  bodyHtml: string
}

export interface RssFeedInput {
  blog: Pick<Blog, 'id' | 'name' | 'title' | 'language'>
  blogRoot: string
  feedUrl: string
  posts: readonly RssPost[]
}

const STATIC_CHANNEL_DESCRIPTION = 'An agent-first blog hosted on SlopIt.'

function rfc822(iso: string): string {
  return new Date(iso).toUTCString()
}

function escapeCdata(s: string): string {
  // The ONLY way to break out of a CDATA section is the literal sequence ]]>.
  // Standard fix: split it across two CDATA sections.
  return s.replace(/\]\]>/g, ']]]]><![CDATA[>')
}

function rssItem(p: RssPost, channelTitle: string): string {
  // RSS 2.0 `<author>` is specifically an email-address field per
  // https://www.rssboard.org/rss-specification — emitting a display name
  // there produces a non-compliant feed (W3C feed validator flags it).
  // For display-name authorship we use `<dc:creator>` (Dublin Core),
  // which is widely supported and is the standard RSS-extension pattern
  // for human names. Fall back to the channel title when the post has
  // no explicit author.
  const creator = escapeXml(p.author ?? channelTitle)
  const lines = [
    '    <item>',
    `      <title>${escapeXml(p.title)}</title>`,
    `      <link>${escapeXml(p.canonicalUrl)}</link>`,
    `      <guid isPermaLink="true">${escapeXml(p.canonicalUrl)}</guid>`,
    `      <pubDate>${rfc822(p.publishedAt)}</pubDate>`,
    `      <dc:creator>${creator}</dc:creator>`,
  ]
  if (p.description) {
    lines.push(`      <description>${escapeXml(p.description)}</description>`)
  }
  lines.push(`      <content:encoded><![CDATA[${escapeCdata(p.bodyHtml)}]]></content:encoded>`)
  lines.push('    </item>')
  return lines.join('\n')
}

export function buildRssFeed(input: RssFeedInput): string {
  const channelTitle = blogDisplayName(input.blog)
  const items = input.posts.map((p) => rssItem(p, channelTitle)).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <channel>',
    `    <title>${escapeXml(channelTitle)}</title>`,
    `    <link>${escapeXml(input.blogRoot)}</link>`,
    `    <description>${escapeXml(STATIC_CHANNEL_DESCRIPTION)}</description>`,
    `    <language>${escapeXml(input.blog.language)}</language>`,
    `    <atom:link href="${escapeXml(input.feedUrl)}" rel="self" type="application/rss+xml" />`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n')
}
