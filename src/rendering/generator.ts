import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getBlogInternal } from '../blogs.js'
import type { Store } from '../db/store.js'
import { listPublishedPostsForBlog } from '../posts.js'
import type { Blog, Post } from '../schema/index.js'
import { renderMarkdown } from './markdown.js'
import { escapeHtml, loadTheme, render } from './templates.js'

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
 * Renderer contract for the mutation primitives (updatePost, deletePost).
 * Extends Renderer with the file-cleanup hook they require to preserve
 * the spec's success invariant (rendered files match post-call state).
 * Shipped `createRenderer` returns MutationRenderer. Consumers who
 * implement a custom Renderer (e.g., object-storage instead of disk)
 * must extend it to MutationRenderer before passing to update/delete.
 */
export interface MutationRenderer extends Renderer {
  /**
   * Remove the post directory for (blogId, slug). ENOENT-tolerant —
   * a missing directory is the desired end state and should not throw.
   * Hard I/O failures (EACCES, EIO) SHOULD throw so callers can apply
   * compensation.
   */
  removePostFiles(blogId: string, slug: string): void
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
        `<article class="post-item">` +
        `<h2><a href="${escapeHtml(p.slug)}/">${escapeHtml(p.title)}</a></h2>` +
        `<time datetime="${escapeHtml(p.publishedAt ?? '')}">${escapeHtml(formatDate(p.publishedAt))}</time>` +
        excerpt +
        `</article>`
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
    `<div class="tags">` + tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join('') + `</div>`
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

export function createRenderer(config: RendererConfig): MutationRenderer {
  const theme = loadTheme('minimal')

  // Normalize baseUrl to always end with `/`. The renderer's baseUrl is
  // also the user-facing blog URL (returned as `blog_url`/`postUrl` and
  // shown in onboarding text + welcome email) — without the slash a
  // browser at `/b/<id>` resolves the relative `style.css` href against
  // the parent `/b/`, breaking CSS. Normalizing here means concat sites
  // are simple (`baseUrl + slug + '/'`) and consumers can pass either
  // form (`https://x.example` or `https://x.example/`) without surprise.
  const baseUrl = config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/'

  const displayName = (blog: Blog): string => blog.name ?? blog.id

  const blogOutputDir = (blogId: string) => join(config.outputDir, blogId)

  return {
    baseUrl,

    renderPost(blogId, post) {
      const blog = getBlogInternal(config.store, blogId)
      const blogDir = blogOutputDir(blogId)

      // ensureCss BEFORE HTML write — see spec's Render sequencing section
      ensureCss(theme.cssPath, blogDir)

      const postDir = join(blogDir, post.slug)
      mkdirSync(postDir, { recursive: true })

      const html = render(theme.post, {
        blogName: displayName(blog),
        postTitle: post.title,
        postPublishedAt: post.publishedAt ?? '',
        postPublishedAtDisplay: formatDate(post.publishedAt),
        themeCssHref: '../style.css',
        blogHomeHref: '..',
        canonicalUrl: baseUrl + post.slug + '/',
        seoMeta: renderSeoMeta(post.seoTitle, post.seoDescription),
        postBody: renderMarkdown(post.body),
        tagList: renderTagList(post.tags),
        poweredBy: renderPoweredBy(),
      })

      writeFileSync(join(postDir, 'index.html'), html, 'utf8')
    },

    renderBlog(blogId) {
      const blog = getBlogInternal(config.store, blogId)
      const blogDir = blogOutputDir(blogId)

      ensureCss(theme.cssPath, blogDir)

      const posts = listPublishedPostsForBlog(config.store, blogId)
      mkdirSync(blogDir, { recursive: true })

      const html = render(theme.index, {
        blogName: displayName(blog),
        themeCssHref: 'style.css',
        postList: renderPostList(posts),
        poweredBy: renderPoweredBy(),
      })

      writeFileSync(join(blogDir, 'index.html'), html, 'utf8')
    },

    removePostFiles(blogId, slug) {
      rmSync(join(config.outputDir, blogId, slug), { recursive: true, force: true })
    },
  }
}
