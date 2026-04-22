import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../db/store.js'
import type { Post } from '../schema/index.js'
import { escapeHtml } from './templates.js'

export interface RendererConfig {
  store: Store
  outputDir: string
  baseUrl: string
}

export interface Renderer {
  readonly baseUrl: string
  renderPost(blogId: string, post: Post): void
  renderBlog(blogId: string): void
}

/**
 * Format an ISO timestamp for human display. Returns '' on null/undefined.
 *
 * Pinned to UTC so static output is deterministic regardless of host
 * timezone — '2025-01-01T00:00:00Z' renders as 'January 1, 2025'
 * everywhere, not 'December 31, 2024' on LAX deploys.
 *
 * @internal
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Build the blog-index post list fragment. Every user-derived field is
 * HTML-escaped at the boundary here so the `{{{postList}}}` raw injection
 * stays safe.
 *
 * @internal
 */
export function renderPostList(posts: Post[]): string {
  if (posts.length === 0) return ''
  return posts
    .map((p) => {
      const excerpt = p.excerpt ? `<p>${escapeHtml(p.excerpt)}</p>` : ''
      return (
        `<article class="post-item">`
        + `<h2><a href="${escapeHtml(p.slug)}/">${escapeHtml(p.title)}</a></h2>`
        + `<time datetime="${escapeHtml(p.publishedAt ?? '')}">${escapeHtml(formatDate(p.publishedAt))}</time>`
        + excerpt
        + `</article>`
      )
    })
    .join('')
}

/**
 * Build the tag-pill fragment. Empty string when no tags.
 *
 * @internal
 */
export function renderTagList(tags: string[]): string {
  if (tags.length === 0) return ''
  return (
    `<div class="tags">`
    + tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join('')
    + `</div>`
  )
}

/**
 * Core's single branding hook. Documented exception to ARCHITECTURE.md
 * rule #5. Platform may strip/replace based on plan.
 *
 * @internal
 */
export function renderPoweredBy(): string {
  return `<a href="https://slopit.io">Powered by SlopIt</a>`
}

/**
 * Build the SEO meta-tag block. Returns '' when both title and
 * description are missing. All user content escaped at the boundary.
 *
 * @internal
 */
export function renderSeoMeta(
  seoTitle: string | undefined,
  seoDescription: string | undefined,
): string {
  if (!seoTitle && !seoDescription) return ''
  const parts: string[] = []
  if (seoDescription) {
    parts.push(`<meta name="description" content="${escapeHtml(seoDescription)}">`)
  }
  if (seoTitle) {
    parts.push(`<meta property="og:title" content="${escapeHtml(seoTitle)}">`)
  }
  if (seoDescription) {
    parts.push(`<meta property="og:description" content="${escapeHtml(seoDescription)}">`)
  }
  return parts.join('')
}

/**
 * Copy the theme's style.css into a blog's output directory. Always
 * overwrites (not copy-if-missing) so blogs pick up style.css changes
 * on the next publish after a package upgrade. Creates the blog dir
 * if it doesn't exist yet.
 *
 * @internal
 */
export function ensureCss(cssSourcePath: string, blogOutputDir: string): void {
  mkdirSync(blogOutputDir, { recursive: true })
  copyFileSync(cssSourcePath, join(blogOutputDir, 'style.css'))
}

/**
 * Placeholder factory — Task 10 replaces this with the real renderer.
 * Leaving it as a throw so any accidental use before Task 10 lands
 * fails loudly.
 */
export function createRenderer(_config: RendererConfig): Renderer {
  return {
    baseUrl: _config.baseUrl,
    renderPost() { throw new Error('createRenderer: not implemented until Task 10') },
    renderBlog() { throw new Error('createRenderer: not implemented until Task 10') },
  }
}
