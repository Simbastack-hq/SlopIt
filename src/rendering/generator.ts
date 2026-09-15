import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { getBlogInternal } from '../blogs.js'
import type { Store } from '../db/store.js'
import { listBlogLanguages, listPublishedPostsForBlog } from '../posts.js'
import type { Blog, Post } from '../schema/index.js'
import { buildLlmsTxt, buildRssFeed, buildSitemap } from './feeds.js'
import { buildFrontmatter } from './frontmatter.js'
import { renderMarkdown } from './markdown.js'
import {
  buildJsonLd,
  buildSeoMeta,
  normalizeBaseUrl,
  resolveDescription,
  resolveLanguage,
  textDirection,
} from './seo.js'
import { escapeHtml, loadTheme, render, type ThemeAssets } from './templates.js'
import { languageLabel, stringsFor } from './strings.js'

export interface RendererConfig {
  store: Store
  outputDir: string
  baseUrl: string
  /**
   * Optional post-processor that receives fully-rendered HTML and
   * returns transformed HTML before it's written to disk. Called for
   * every HTML write: `renderPost` (one post page), `renderBlogPosts`
   * (every post page), and `renderBlog` (every home page). NOT called
   * for non-HTML outputs (.md, llms.txt, feed.xml, sitemap.xml).
   *
   * `blogId` is passed so the caller can look up per-blog config like
   * `blog.analytics` without re-resolving it. Identity is the default.
   *
   * Platform uses this to inject analytics `<script>` tags into <head>
   * (Phase 3c). Self-hosted callers pass nothing and get unchanged behavior.
   *
   * Must be repeatable: for the same `(html, blogId)` and the same blog
   * state it reads, it returns the same output. The same page is
   * re-rendered many times over its life (every sibling publish, every
   * blog patch, ops re-render scripts), and each run replaces the file.
   */
  postprocessHtml?: (html: string, blogId: string) => string
}

export interface Renderer {
  readonly baseUrl: string
  renderPost(blogId: string, post: Post): void
  /**
   * Write the blog's home page(s): `index.html` for the root language
   * and `lang/<tag>/index.html` for every other language the blog
   * publishes in (see `listBlogLanguages`). Does not remove homes of
   * languages that no longer have posts — that is `pruneLanguageHomes`,
   * which mutation primitives call last because it is destructive.
   */
  renderBlog(blogId: string): void
  /**
   * Re-write `<slug>/index.html` for every published post in the blog.
   * Post pages embed blog-wide state (the "More from this blog" list of
   * the newest posts, and the hreflang links + language switcher of a
   * translation group), so they are blog-level derived output like the
   * home pages: any change to the published set, or to a post's title,
   * description, language or group, must be followed by this call. HTML
   * only — `.md` and the manifests do not depend on sibling posts.
   */
  renderBlogPosts(blogId: string): void
  /**
   * Remove `lang/<tag>/` for every language that no longer has a
   * published post (and `lang/` itself once empty). ENOENT-tolerant.
   * Destructive, so every mutation primitive calls it LAST, after every
   * render in the sequence has succeeded — a render failure then leaves
   * the old home on disk for the compensated DB state, never a hole.
   * `createPost` needs it too: publishing can change which language is
   * the root (see `listBlogLanguages`), which moves a home from
   * `lang/<tag>/` to `/`.
   */
  pruneLanguageHomes(blogId: string): void
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
   * (Re)emit the per-blog manifest files together — `llms.txt`,
   * `sitemap.xml`, `feed.xml` and one `lang/<tag>/feed.xml` per other
   * language. They share the same per-blog published-posts query so one
   * method is cheaper than several. Atomic per file. Called whenever any
   * post in the blog changes lifecycle (publish, update, unpublish, delete).
   */
  renderManifests(blogId: string): void
}

/**
 * Format an ISO timestamp for human display in `locale` (a canonical
 * BCP-47 tag — the page's language). Returns '' on null/undefined.
 *
 * Pinned to UTC so static output is deterministic regardless of host
 * timezone — '2025-01-01T00:00:00Z' renders as 'January 1, 2025'
 * everywhere, not 'December 31, 2024' on LAX deploys.
 *
 * @internal
 */
export function formatDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * URL path segment of a language's home directory: the lowercase
 * canonical tag (`pt-BR` → `pt-br`). URL paths are case-sensitive on
 * disk and lowercase is the convention; `hreflang` values keep the
 * canonical case.
 *
 * @internal
 */
export function languageSegment(tag: string): string {
  return tag.toLowerCase()
}

/**
 * Absolute URL of a language's home page: the blog root for the root
 * language, `<root>lang/<tag>/` for every other. The one place that
 * spells this out — canonicals, hreflang, feeds, the sitemap and the
 * switcher all go through it.
 *
 * @internal
 */
export function homeUrl(root: string, lang: string, rootLang: string): string {
  return lang === rootLang ? root : root + 'lang/' + languageSegment(lang) + '/'
}

/**
 * Static fragment injected into `{{{postList}}}` when a blog has no
 * published posts yet. A dead-empty index (masthead + footer and
 * nothing in between) reads as broken; this gives the blank page a
 * voice — a typed "waiting for the first post" line with a blinking
 * caret, plus a nudge for the owner. Deliberately contains zero
 * user-derived fields, so the raw injection stays safe without
 * escaping. Styles live in each theme's style.css under `.empty-state`.
 */
const EMPTY_STATE_HTML =
  '<section class="empty-state">' +
  '<p class="empty-type-line" aria-hidden="true"><span class="empty-type">waiting for the first post</span></p>' +
  '<h2>Nothing here yet.</h2>' +
  '<p class="empty-sub">The blog is ready. The slop is not.</p>' +
  '<p class="empty-owner"><strong>Your blog?</strong> Your AI has the key. Ask it to publish. The first post takes about a minute.</p>' +
  '</section>'

/**
 * Build the home-page post list fragment. Every user-derived field is
 * HTML-escaped at the boundary here so the `{{{postList}}}` raw injection
 * stays safe. `hrefPrefix` is `''` on the root home and `'../../'` on a
 * `lang/<tag>/` home, so post links resolve from either depth.
 *
 * @internal
 */
export function renderPostList(posts: Post[], locale: string, hrefPrefix = ''): string {
  if (posts.length === 0) return EMPTY_STATE_HTML
  return posts
    .map((p) => {
      const excerpt = p.excerpt ? `<p>${escapeHtml(p.excerpt)}</p>` : ''
      return (
        `<article class="post-item">` +
        `<h2><a href="${escapeHtml(hrefPrefix + p.slug)}/">${escapeHtml(p.title)}</a></h2>` +
        `<time datetime="${escapeHtml(p.publishedAt ?? '')}">${escapeHtml(formatDate(p.publishedAt, locale))}</time>` +
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
 * Build the "More from this blog" fragment for a post page: the three
 * newest published posts in the same language, excluding the post being
 * rendered. Returns '' when there is nothing else to link to, so a
 * one-post blog (or a one-post language) renders no heading.
 *
 * `published` is the newest-first published list the caller has already
 * filtered to the post's language. Every user-derived field is
 * HTML-escaped here so the `{{{moreFrom}}}` raw injection stays safe.
 *
 * Markup deliberately avoids `<article>` and the `post-item` class. Those
 * are the two markers a consumer's `postprocessHtml` hook can rely on to
 * tell a post page (exactly one `</article>`, no `post-item` article)
 * from a home page, and this block must not blur them.
 *
 * @internal
 */
export function renderMoreFrom(self: Post, published: Post[], heading: string): string {
  const others = published.filter((p) => p.id !== self.id).slice(0, 3)
  if (others.length === 0) return ''
  const items = others
    .map((p) => {
      const description = resolveDescription(p)
      const blurb = description ? `<p>${escapeHtml(description)}</p>` : ''
      return `<li><a href="../${escapeHtml(p.slug)}/">${escapeHtml(p.title)}</a>${blurb}</li>`
    })
    .join('')
  return (
    `<nav class="more-from" aria-labelledby="more-from-heading">` +
    `<h2 id="more-from-heading">${escapeHtml(heading)}</h2>` +
    `<ul>${items}</ul>` +
    `</nav>`
  )
}

export interface AlternateEntry {
  /** Canonical BCP-47 tag of this variant. */
  language: string
  /** Absolute URL of this variant. */
  url: string
}

/**
 * `<link rel="alternate" hreflang>` lines for a page that exists in
 * several languages (a translation group's posts, or the home pages).
 * Includes the page itself, as hreflang requires; `x-default` points at
 * the `rootLang` variant when the set has one. Returns '' for fewer than
 * two entries, so a page with no translations emits nothing.
 *
 * @internal
 */
export function renderAlternates(entries: readonly AlternateEntry[], rootLang: string): string {
  if (entries.length < 2) return ''
  const lines = entries.map(
    (e) =>
      `<link rel="alternate" hreflang="${escapeHtml(e.language)}" href="${escapeHtml(e.url)}">`,
  )
  const root = entries.find((e) => e.language === rootLang)
  if (root) {
    lines.push(`<link rel="alternate" hreflang="x-default" href="${escapeHtml(root.url)}">`)
  }
  return lines.join('\n')
}

export interface LanguageNavEntry {
  /** Canonical BCP-47 tag. */
  language: string
  /** href of this language's page, relative to the page being rendered. */
  href: string
}

/**
 * The language switcher: one item per language, each named in its own
 * language (`Deutsch · English · Français`), the current one a plain
 * `<span aria-current="page">`. `dir="auto"` isolates an Arabic or
 * Hebrew name inside an LTR row and vice versa. Returns '' for fewer
 * than two entries. Every label, attribute and href is escaped here so
 * the `{{{…}}}` raw injection stays safe.
 *
 * @internal
 */
export function renderLanguageNav(
  entries: readonly LanguageNavEntry[],
  current: string,
  label: string,
): string {
  if (entries.length < 2) return ''
  const items = entries
    .map((e) => {
      const name = escapeHtml(languageLabel(e.language))
      const lang = escapeHtml(e.language)
      return e.language === current
        ? `<span aria-current="page" lang="${lang}" dir="auto">${name}</span>`
        : `<a lang="${lang}" hreflang="${lang}" dir="auto" href="${escapeHtml(e.href)}">${name}</a>`
    })
    .join('')
  return `<nav class="translations" aria-label="${escapeHtml(label)}">${items}</nav>`
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
 * Build the optional "back to parent site" link. Empty string when
 * `parentSiteUrl` is null/undefined — the templates inline the result
 * via `{{{parentSiteLink}}}` inside the masthead row, so absent config
 * renders no markup at all. The visible label is a fixed "Main site →"
 * rather than the parent hostname: most blogs sit under the same brand
 * as their parent (blog.acme.com → acme.com), so echoing the hostname
 * would duplicate the blog's masthead name beside it. A generic label
 * reads cleanly in that common case and is no less clear when parent
 * and blog are unrelated. The href is escaped because it lands inside
 * an HTML attribute.
 *
 * @internal
 */
/**
 * True only for absolute http/https URLs. Parses with the WHATWG `URL`
 * constructor and checks the normalized protocol — the same basis as the
 * `httpUrl` schema, so a value that passes the write boundary is never
 * silently dropped here for a spelling the schema would have accepted.
 */
function isHttpUrl(s: string): boolean {
  let protocol: string
  try {
    protocol = new URL(s).protocol
  } catch {
    return false
  }
  return protocol === 'http:' || protocol === 'https:'
}

export function renderParentSiteLink(
  parentSiteUrl: string | null | undefined,
  label: string,
  dir: 'ltr' | 'rtl',
): string {
  if (!parentSiteUrl) return ''
  // Defense in depth: the schema (`httpUrl`) rejects non-http(s) schemes
  // at the write boundary, but a row written before that constraint — or
  // a corrupt write — must not render as a live `javascript:` link. Drop
  // anything that isn't http(s) rather than emit an XSS anchor.
  if (!isHttpUrl(parentSiteUrl)) return ''
  // The arrow points "outward" in the page's reading direction.
  const arrow = dir === 'rtl' ? '&larr;' : '&rarr;'
  return `<a class="parent-site" href="${escapeHtml(parentSiteUrl)}">${escapeHtml(label)} ${arrow}</a>`
}

/**
 * Write `content` to `path` atomically: write to `${path}.tmp` first,
 * then rename. POSIX rename is atomic, so a concurrent reader (Caddy)
 * never sees a partially-written file.
 *
 * Used by all renderer write paths: per-post `<slug>/index.html` and
 * `<slug>.md`, plus per-blog `index.html`, `llms.txt`, `feed.xml`,
 * `sitemap.xml` and the `lang/<tag>/` copies of the first and third.
 *
 * Caller is responsible for `mkdirSync(dirname(path), { recursive: true })`
 * if the parent directory doesn't exist (matches the existing pattern in
 * `ensureThemeAssets` and `renderPost`).
 *
 * @internal
 */
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

/**
 * Copy the theme's per-blog static assets (style.css, favicon.svg) into
 * a blog's output directory. Always overwrites (not copy-if-missing) so
 * blogs pick up theme changes on the next publish after a package
 * upgrade. Creates the blog dir if it doesn't exist yet.
 *
 * @internal
 */
export function ensureThemeAssets(theme: ThemeAssets, blogOutputDir: string): void {
  mkdirSync(blogOutputDir, { recursive: true })
  copyFileSync(theme.cssPath, join(blogOutputDir, 'style.css'))
  copyFileSync(theme.faviconPath, join(blogOutputDir, 'favicon.svg'))
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

  // On-disk directory of a language's home page: the blog dir for the
  // root language, `lang/<tag>/` for every other.
  const homeDir = (blogDir: string, lang: string, rootLang: string): string =>
    lang === rootLang ? blogDir : join(blogDir, 'lang', languageSegment(lang))

  // Emit the `<slug>.md` source file for a published post: YAML frontmatter
  // (8 fixed keys, blanks omitted) + the author's raw markdown body.
  function renderPostMarkdown(blogId: string, post: Post): void {
    const blog = getBlogInternal(config.store, blogId)
    const blogDir = blogOutputDir(blogId)
    mkdirSync(blogDir, { recursive: true })
    const canonical = canonicalFor(post.slug)
    const sameDay = post.publishedAt && post.updatedAt === post.publishedAt ? null : post.updatedAt
    const frontmatter = buildFrontmatter({
      title: post.title,
      slug: post.slug,
      language: resolveLanguage(post, blog),
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

  // Emit the per-blog manifest files together. They all read the same
  // published-posts list, so one method is cheaper than several.
  function renderManifests(blogId: string): void {
    const blog = getBlogInternal(config.store, blogId)
    const blogDir = blogOutputDir(blogId)
    mkdirSync(blogDir, { recursive: true })

    // Newest-first by publishedAt — same order users see on the home page.
    const all = listPublishedPostsForBlog(config.store, blogId)
      .slice()
      .sort((a, b) => {
        const ap = a.publishedAt ?? a.createdAt
        const bp = b.publishedAt ?? b.createdAt
        return bp.localeCompare(ap)
      })

    const root = blogRootUrl()
    const languages = listBlogLanguages(config.store, blogId)
    const rootLang = languages[0]
    const latestUpdatedAt = (posts: Post[]): string =>
      posts.length > 0
        ? posts.map((p) => p.updatedAt).sort((a, b) => b.localeCompare(a))[0]
        : blog.createdAt

    // llms.txt — every published post, all languages
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

    // One feed per language: `feed.xml` for the root language,
    // `lang/<tag>/feed.xml` for the others. Filter first, then cap at the
    // 20 most recent, so a small language is never crowded out.
    for (const lang of languages) {
      const dir = homeDir(blogDir, lang, rootLang)
      mkdirSync(dir, { recursive: true })
      const home = homeUrl(root, lang, rootLang)
      const rssPosts = all
        .filter((p) => resolveLanguage(p, blog) === lang)
        .slice(0, 20)
        .map((p) => ({
          title: p.title,
          canonicalUrl: canonicalFor(p.slug),
          description: resolveDescription(p),
          publishedAt: p.publishedAt ?? p.createdAt,
          author: p.author,
          bodyHtml: renderMarkdown(p.body),
        }))
      const feedXml = buildRssFeed({
        blog: { id: blog.id, name: blog.name, language: lang },
        blogRoot: home,
        feedUrl: home + 'feed.xml',
        posts: rssPosts,
      })
      writeFileAtomic(join(dir, 'feed.xml'), feedXml)
    }

    // sitemap.xml — the root, every other language's home, every
    // published post; no cap.
    const sitemapXml = buildSitemap({
      blogRoot: root,
      homes: languages.slice(1).map((lang) => ({
        url: homeUrl(root, lang, rootLang),
        updatedAt: latestUpdatedAt(all.filter((p) => resolveLanguage(p, blog) === lang)),
      })),
      posts: all.map((p) => ({ canonicalUrl: canonicalFor(p.slug), updatedAt: p.updatedAt })),
      updatedAt: latestUpdatedAt(all),
    })
    writeFileAtomic(join(blogDir, 'sitemap.xml'), sitemapXml)
  }

  // Single template render path for a post page, shared by renderPost
  // (one post) and renderBlogPosts (every published post). `published`
  // is the blog's newest-first published list; it feeds the "More from
  // this blog" block and the translation group. `languages` is the
  // blog's language list (root first). Caller has already run
  // ensureThemeAssets.
  function writePostHtml(
    blog: Blog,
    blogDir: string,
    post: Post,
    published: Post[],
    languages: string[],
  ): void {
    const postDir = join(blogDir, post.slug)
    mkdirSync(postDir, { recursive: true })

    const canonicalUrl = canonicalFor(post.slug)
    const rootLang = languages[0]

    // The page is in the post's effective language: its own override,
    // else the blog default. Dates, chrome strings, and direction follow.
    const lang = resolveLanguage(post, blog)
    const dir = textDirection(lang)
    const strings = stringsFor(lang)

    // Published members of this post's translation group (self included),
    // in the blog's language order. Drafts have no URL and are not here.
    const members =
      post.translationGroup === undefined
        ? [post]
        : published
            .filter((p) => p.translationGroup === post.translationGroup)
            .sort(
              (a, b) =>
                languages.indexOf(resolveLanguage(a, blog)) -
                languages.indexOf(resolveLanguage(b, blog)),
            )
    const alternates = members.map((p) => ({
      language: resolveLanguage(p, blog),
      url: canonicalFor(p.slug),
    }))
    const sameLanguage = published.filter((p) => resolveLanguage(p, blog) === lang)

    // Home link: `..` on a monolingual blog, as ever. On a multilingual
    // blog a post links to its own language's home; a root-language post
    // carries `?lang=` so a consumer negotiating language on `/` treats
    // the click as an explicit choice rather than an entry to redirect.
    const blogHomeHref =
      languages.length === 1
        ? '..'
        : lang === rootLang
          ? `../?lang=${lang}`
          : `../lang/${languageSegment(lang)}/`

    const html = render(theme.post, {
      lang,
      dir,
      blogName: displayName(blog),
      postTitle: post.title,
      postPublishedAt: post.publishedAt ?? '',
      postPublishedAtDisplay: formatDate(post.publishedAt, lang),
      themeCssHref: '../style.css',
      blogHomeHref,
      canonicalUrl,
      alternates: renderAlternates(alternates, rootLang),
      seoMeta: buildSeoMeta({
        post,
        blog,
        canonicalUrl,
        alternateLanguages:
          members.length > 1 ? alternates.map((a) => a.language).filter((l) => l !== lang) : [],
      }),
      jsonLd: buildJsonLd({ post, blog, canonicalUrl }),
      coverImage: renderCoverImage(post.coverImage, post.title),
      translations: renderLanguageNav(
        members.map((p) => ({
          language: resolveLanguage(p, blog),
          href: `../${p.slug}/`,
        })),
        lang,
        strings.otherLanguages,
      ),
      postBody: renderMarkdown(post.body),
      tagList: renderTagList(post.tags),
      moreFrom: renderMoreFrom(post, sameLanguage, strings.moreFrom),
      poweredBy: renderPoweredBy(),
      parentSiteLink: renderParentSiteLink(blog.parentSiteUrl, strings.mainSite, dir),
    })

    writeFileAtomic(join(postDir, 'index.html'), applyPostprocess(html, blog.id))
  }

  return {
    baseUrl,

    renderPost(blogId, post) {
      const blog = getBlogInternal(config.store, blogId)
      const blogDir = blogOutputDir(blogId)

      // ensureThemeAssets BEFORE HTML write — see spec's Render sequencing section
      ensureThemeAssets(theme, blogDir)

      writePostHtml(
        blog,
        blogDir,
        post,
        listPublishedPostsForBlog(config.store, blogId),
        listBlogLanguages(config.store, blogId),
      )

      // Phase 2 — emit the .md sibling and refresh the per-blog manifests
      // whenever a published post is rendered. Drafts skip both (no
      // canonical URL, would break feed.xml).
      if (post.status === 'published') {
        renderPostMarkdown(blogId, post)
        renderManifests(blogId)
      }
    },

    renderBlogPosts(blogId) {
      const blog = getBlogInternal(config.store, blogId)
      const blogDir = blogOutputDir(blogId)

      ensureThemeAssets(theme, blogDir)

      const published = listPublishedPostsForBlog(config.store, blogId)
      const languages = listBlogLanguages(config.store, blogId)
      for (const post of published) {
        writePostHtml(blog, blogDir, post, published, languages)
      }
    },

    renderBlog(blogId) {
      const blog = getBlogInternal(config.store, blogId)
      const blogDir = blogOutputDir(blogId)

      ensureThemeAssets(theme, blogDir)

      const posts = listPublishedPostsForBlog(config.store, blogId)
      const languages = listBlogLanguages(config.store, blogId)
      const rootLang = languages[0]
      const root = blogRootUrl()
      mkdirSync(blogDir, { recursive: true })

      // The slug `lang` is refused for new posts (POST_SLUG_RESERVED); a
      // post written before that rule would share `lang/` with the home
      // pages. Refuse to write over it rather than corrupt either.
      if (languages.length > 1 && existsSync(join(blogDir, 'lang.md'))) {
        throw new Error(
          `Blog ${blogId}: a post with slug "lang" occupies the per-language home directory; rename that post before publishing in more than one language`,
        )
      }

      const homes = languages.map((l) => ({ language: l, url: homeUrl(root, l, rootLang) }))

      // One home page per language, each in that language: its posts,
      // its chrome strings, its `lang`/`dir`, its dates.
      for (const lang of languages) {
        const dir = homeDir(blogDir, lang, rootLang)
        mkdirSync(dir, { recursive: true })
        const prefix = lang === rootLang ? '' : '../../'
        const dirAttr = textDirection(lang)
        const strings = stringsFor(lang)

        const html = render(theme.index, {
          lang,
          dir: dirAttr,
          blogName: displayName(blog),
          themeCssHref: prefix + 'style.css',
          faviconHref: prefix + 'favicon.svg',
          canonicalUrl: homeUrl(root, lang, rootLang),
          alternates: renderAlternates(homes, rootLang),
          languageNav: renderLanguageNav(
            languages.map((l) => ({
              language: l,
              // The root home's link carries `?lang=` (see writePostHtml).
              href: prefix + (l === rootLang ? `?lang=${l}` : `lang/${languageSegment(l)}/`),
            })),
            lang,
            strings.otherLanguages,
          ),
          postList: renderPostList(
            posts.filter((p) => resolveLanguage(p, blog) === lang),
            lang,
            prefix,
          ),
          poweredBy: renderPoweredBy(),
          parentSiteLink: renderParentSiteLink(blog.parentSiteUrl, strings.mainSite, dirAttr),
        })

        writeFileAtomic(join(dir, 'index.html'), applyPostprocess(html, blogId))
      }
    },

    pruneLanguageHomes(blogId) {
      const langDir = join(config.outputDir, blogId, 'lang')
      if (!existsSync(langDir)) return
      // `lang/` holds only what renderBlog and renderManifests wrote, so
      // anything not in the current non-root language set is stale.
      const keep = new Set(listBlogLanguages(config.store, blogId).slice(1).map(languageSegment))
      // Directories only: a post written before the slug `lang` was
      // reserved owns `lang/index.html` (a file), and that is not ours to
      // remove. `lang/` itself goes only when nothing at all is left.
      for (const entry of readdirSync(langDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !keep.has(entry.name)) {
          rmSync(join(langDir, entry.name), { recursive: true, force: true })
        }
      }
      if (readdirSync(langDir).length === 0) rmSync(langDir, { recursive: true, force: true })
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
