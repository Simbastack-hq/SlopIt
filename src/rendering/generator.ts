import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getBlogInternal } from '../blogs.js'
import type { Store } from '../db/store.js'
import { listPublishedPostsForBlog } from '../posts.js'
import type { Blog, Post } from '../schema/index.js'
import { buildLlmsTxt, buildRssFeed, buildSitemap } from './feeds.js'
import { buildFrontmatter } from './frontmatter.js'
import { renderMarkdown } from './markdown.js'
import { buildJsonLd, buildSeoMeta, normalizeBaseUrl, resolveDescription } from './seo.js'
import { escapeHtml, loadTheme, render } from './templates.js'

export interface RendererConfig {
  store: Store
  outputDir: string
  baseUrl: string
  /**
   * Optional post-processor that receives fully-rendered HTML and
   * returns transformed HTML before it's written to disk. Called from
   * `renderPost` (per-post HTML) and `renderBlog` (per-blog index HTML).
   * NOT called for non-HTML outputs (.md, llms.txt, feed.xml, sitemap.xml).
   *
   * `blogId` is passed so the caller can look up per-blog config like
   * `blog.analytics` without re-resolving it. Identity is the default.
   *
   * Platform uses this to inject analytics `<script>` tags into <head>
   * (Phase 3c). Self-hosted callers pass nothing and get unchanged behavior.
   */
  postprocessHtml?: (html: string, blogId: string) => string
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
  /**
   * Absolute path to the blog's media directory
   * (`<outputDir>/<blogId>/_media`). Pure path computation — does not
   * create the directory. Callers `mkdirSync(dir, { recursive: true })`
   * on first write.
   */
  mediaDir(blogId: string): string
  /**
   * Write the per-post `<slug>.md` source file (YAML frontmatter + raw
   * body) alongside the existing `<slug>/index.html`. Atomic via
   * `writeFileAtomic`. Called from `renderPost` for published posts.
   */
  renderPostMarkdown(blogId: string, post: Post): void
  /**
   * Remove the per-post `<slug>.md` source file. ENOENT-tolerant.
   * Called from the published→draft branch of `updatePost` and from
   * `deletePost`.
   */
  deletePostMarkdown(blogId: string, slug: string): void
  /**
   * (Re)emit the three per-blog manifest files together — `llms.txt`,
   * `feed.xml`, `sitemap.xml`. They share the same per-blog published-
   * posts query so one method is cheaper than three separate ones.
   * Atomic per file. Called whenever any post in the blog changes
   * lifecycle (publish, update, unpublish, delete).
   */
  renderManifests(blogId: string): void
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
 * Build the cover-image fragment. Empty string when no coverImage.
 * URL is escaped because it lands inside an HTML attribute.
 *
 * @internal
 */
export function renderCoverImage(coverImage: string | undefined, alt: string): string {
  if (!coverImage) return ''
  return `<img class="cover" src="${escapeHtml(coverImage)}" alt="${escapeHtml(alt)}">`
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
 * Write `content` to `path` atomically: write to `${path}.tmp` first,
 * then rename. POSIX rename is atomic, so a concurrent reader (Caddy)
 * never sees a partially-written file.
 *
 * Used by all renderer write paths: per-post `<slug>/index.html` and
 * `<slug>.md`, plus per-blog `index.html`, `llms.txt`, `feed.xml`,
 * `sitemap.xml`.
 *
 * Caller is responsible for `mkdirSync(dirname(path), { recursive: true })`
 * if the parent directory doesn't exist (matches the existing pattern in
 * `ensureCss` and `renderPost`).
 *
 * @internal
 */
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
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

  const displayName = (blog: Blog): string => blog.name ?? blog.id

  const blogOutputDir = (blogId: string) => join(config.outputDir, blogId)

  // Identity-default postprocess hook. Platform passes a real transform
  // (analytics injection); self-hosted callers don't, and pay nothing.
  const applyPostprocess = (html: string, blogId: string): string =>
    config.postprocessHtml ? config.postprocessHtml(html, blogId) : html

  // Single source of truth for a post's canonical URL. normalizeBaseUrl
  // strips a trailing slash so concatenation is unambiguous regardless of
  // whether the caller (platform vs self-hosted) passes `https://x.com`
  // or `https://x.com/`.
  const canonicalFor = (slug: string): string => normalizeBaseUrl(config.baseUrl) + '/' + slug + '/'

  const blogRootUrl = (): string => normalizeBaseUrl(config.baseUrl) + '/'

  // Emit the `<slug>.md` source file for a published post: YAML frontmatter
  // (8 fixed keys, blanks omitted) + the author's raw markdown body.
  function renderPostMarkdown(blogId: string, post: Post): void {
    const blogDir = blogOutputDir(blogId)
    mkdirSync(blogDir, { recursive: true })
    const canonical = canonicalFor(post.slug)
    const sameDay = post.publishedAt && post.updatedAt === post.publishedAt ? null : post.updatedAt
    const frontmatter = buildFrontmatter({
      title: post.title,
      slug: post.slug,
      date: post.publishedAt ?? null,
      updated: sameDay,
      author: post.author ?? null,
      description: resolveDescription(post) || null,
      canonical,
      tags: post.tags,
    })
    const content = `${frontmatter}\n\n${post.body}\n`
    writeFileAtomic(join(blogDir, `${post.slug}.md`), content)
  }

  function deletePostMarkdown(blogId: string, slug: string): void {
    // ENOENT-tolerant: missing file is the desired end state.
    rmSync(join(config.outputDir, blogId, `${slug}.md`), { force: true })
  }

  // Emit the three per-blog manifest files together. They all read the same
  // published-posts list, so one method is cheaper than three.
  function renderManifests(blogId: string): void {
    const blog = getBlogInternal(config.store, blogId)
    const blogDir = blogOutputDir(blogId)
    mkdirSync(blogDir, { recursive: true })

    // Newest-first by publishedAt — same order users see in the blog index.
    const all = listPublishedPostsForBlog(config.store, blogId)
      .slice()
      .sort((a, b) => {
        const ap = a.publishedAt ?? a.createdAt
        const bp = b.publishedAt ?? b.createdAt
        return bp.localeCompare(ap)
      })

    const root = blogRootUrl()
    const latestUpdatedAt =
      all.length > 0
        ? all.map((p) => p.updatedAt).sort((a, b) => b.localeCompare(a))[0]
        : blog.createdAt

    // llms.txt
    const llmsTxt = buildLlmsTxt({
      blog,
      posts: all.map((p) => ({
        title: p.title,
        canonicalUrl: canonicalFor(p.slug),
        description: resolveDescription(p),
        publishedAt: p.publishedAt ?? p.createdAt,
      })),
    })
    writeFileAtomic(join(blogDir, 'llms.txt'), llmsTxt)

    // feed.xml — cap RSS at 20 most recent
    const rssPosts = all.slice(0, 20).map((p) => ({
      title: p.title,
      canonicalUrl: canonicalFor(p.slug),
      description: resolveDescription(p),
      publishedAt: p.publishedAt ?? p.createdAt,
      author: p.author,
      bodyHtml: renderMarkdown(p.body),
    }))
    const feedXml = buildRssFeed({
      blog,
      blogRoot: root,
      feedUrl: root + 'feed.xml',
      posts: rssPosts,
    })
    writeFileAtomic(join(blogDir, 'feed.xml'), feedXml)

    // sitemap.xml — every published post, no cap
    const sitemapPosts = all.map((p) => ({
      canonicalUrl: canonicalFor(p.slug),
      updatedAt: p.updatedAt,
    }))
    const sitemapXml = buildSitemap({
      blogRoot: root,
      posts: sitemapPosts,
      updatedAt: latestUpdatedAt,
    })
    writeFileAtomic(join(blogDir, 'sitemap.xml'), sitemapXml)
  }

  return {
    baseUrl: config.baseUrl,

    renderPost(blogId, post) {
      const blog = getBlogInternal(config.store, blogId)
      const blogDir = blogOutputDir(blogId)

      // ensureCss BEFORE HTML write — see spec's Render sequencing section
      ensureCss(theme.cssPath, blogDir)

      const postDir = join(blogDir, post.slug)
      mkdirSync(postDir, { recursive: true })

      const canonicalUrl = canonicalFor(post.slug)

      const html = render(theme.post, {
        blogName: displayName(blog),
        postTitle: post.title,
        postPublishedAt: post.publishedAt ?? '',
        postPublishedAtDisplay: formatDate(post.publishedAt),
        themeCssHref: '../style.css',
        blogHomeHref: '..',
        canonicalUrl,
        seoMeta: buildSeoMeta({ post, blog, canonicalUrl }),
        jsonLd: buildJsonLd({ post, blog, canonicalUrl }),
        coverImage: renderCoverImage(post.coverImage, post.title),
        postBody: renderMarkdown(post.body),
        tagList: renderTagList(post.tags),
        poweredBy: renderPoweredBy(),
      })

      writeFileAtomic(join(postDir, 'index.html'), applyPostprocess(html, blogId))

      // Phase 2 — emit the .md sibling and refresh the per-blog manifests
      // whenever a published post is rendered. Drafts skip both (no
      // canonical URL, would break feed.xml).
      if (post.status === 'published') {
        renderPostMarkdown(blogId, post)
        renderManifests(blogId)
      }
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

      writeFileAtomic(join(blogDir, 'index.html'), applyPostprocess(html, blogId))
    },

    removePostFiles(blogId, slug) {
      rmSync(join(config.outputDir, blogId, slug), { recursive: true, force: true })
    },
    renderPostMarkdown,
    deletePostMarkdown,
    renderManifests,
    mediaDir(blogId) {
      return join(config.outputDir, blogId, '_media')
    },
  }
}
