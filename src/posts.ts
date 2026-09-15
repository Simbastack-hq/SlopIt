import { getBlogInternal } from './blogs.js'
import type { Store } from './db/store.js'
import { SlopItError } from './errors.js'
import { generateShortId, generateSlug } from './ids.js'
import type { MutationRenderer } from './rendering/generator.js'
import { PostInputSchema, type Blog, type Post, type PostInput } from './schema/index.js'
import { PostPatchSchema, type PostPatchInput } from './schema/index.js'

/**
 * Pure predicate: was this error SQLite's UNIQUE constraint failing on
 * posts.blog_id + posts.slug (the compound key)? Used inside createPost's
 * INSERT catch to map the narrow case to SlopItError(POST_SLUG_CONFLICT)
 * while letting other UNIQUE errors (posts.id, api_keys.*) bubble raw.
 *
 * @internal — exported for unit testing; not re-exported from src/index.ts.
 */
export function isPostSlugConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    err.message.includes('posts.blog_id, posts.slug')
  )
}

/**
 * Build an auto-excerpt from markdown body: strip common syntax, collapse
 * whitespace, truncate to 160 chars with a trailing ellipsis on overflow.
 *
 * Not a real markdown parser — good enough for v1 for typical posts. Edge
 * cases (inline HTML, code fences with content) produce noisy excerpts,
 * which is acceptable; callers who care supply an explicit excerpt field.
 *
 * @internal — exported for unit testing; not re-exported from src/index.ts.
 */
export function autoExcerpt(body: string): string {
  const stripped = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*#+ /gm, '')
    .replace(/^[ \t]*> /gm, '')
    .replace(/^[ \t]*[-*+] /gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (stripped.length <= 160) return stripped
  return stripped.slice(0, 160).trimEnd() + '…'
}

/**
 * Consumer policy consulted when a write links a post into a translation
 * group (`translationOf` with a slug). Same shape as the signup
 * `nameValidator`: the consumer decides, core turns a rejection into a
 * structured `TRANSLATIONS_DISABLED` error with `reason` as the message.
 * Core does not know why a consumer might refuse (the hosted platform
 * gates this by plan); it only knows a consumer may.
 */
export type TranslationPolicy = (blog: Blog) => { ok: true } | { ok: false; reason: string }

export interface PostWriteOptions {
  translationPolicy?: TranslationPolicy
}

/**
 * `lang` is the directory of the per-language home pages
 * (`/lang/<tag>/index.html`, `/lang/<tag>/feed.xml`). A post with that
 * slug would share the directory, so the slug is refused for new posts.
 * One reserved word keeps post slugs and language homes in disjoint
 * namespaces without reserving every language code as a slug.
 */
const RESERVED_SLUGS = new Set(['lang'])

const POST_COLUMNS = `id, blog_id, slug, title, body, excerpt, tags, status,
              seo_title, seo_description, author, cover_image, language,
              translation_group, published_at, created_at, updated_at`

interface PostRow {
  id: string
  blog_id: string
  slug: string
  title: string
  body: string
  excerpt: string | null
  tags: string
  status: 'draft' | 'published'
  seo_title: string | null
  seo_description: string | null
  author: string | null
  cover_image: string | null
  language: string | null
  translation_group: string | null
  published_at: string | null
  created_at: string
  updated_at: string
}

function rowToPost(row: PostRow): Post {
  return {
    id: row.id,
    blogId: row.blog_id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    excerpt: row.excerpt ?? undefined,
    tags: JSON.parse(row.tags) as string[],
    status: row.status,
    seoTitle: row.seo_title ?? undefined,
    seoDescription: row.seo_description ?? undefined,
    author: row.author ?? undefined,
    coverImage: row.cover_image ?? undefined,
    language: row.language ?? undefined,
    translationGroup: row.translation_group ?? undefined,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Returns published posts for a blog, newest-first by published_at.
 * Drafts excluded. Used by the renderer to build the blog index.
 *
 * @internal
 */
export function listPublishedPostsForBlog(store: Store, blogId: string): Post[] {
  const rows = store.db
    .prepare(
      `SELECT ${POST_COLUMNS}
         FROM posts
        WHERE blog_id = ? AND status = 'published'
        ORDER BY published_at DESC, rowid DESC`,
    )
    .all(blogId) as PostRow[]
  return rows.map(rowToPost)
}

/**
 * Languages a blog publishes in, root language first, the rest
 * alphabetical. The root language is the blog's default when at least
 * one published post is in it; otherwise the language with the most
 * published posts (tie: alphabetical), so `/` is always the most useful
 * page rather than an empty state on a blog whose stored default has
 * drifted from what it actually publishes. A blog with no published
 * posts reports `[blog.language]`. Never empty.
 *
 * The renderer builds one home page and feed per entry; the hosted
 * platform uses the same list to pick a visitor's home page.
 */
export function listBlogLanguages(store: Store, blogId: string): string[] {
  const blog = getBlogInternal(store, blogId)
  const rows = store.db
    .prepare(
      `SELECT COALESCE(p.language, b.language) AS lang, COUNT(*) AS n
         FROM posts p JOIN blogs b ON b.id = p.blog_id
        WHERE p.blog_id = ? AND p.status = 'published'
        GROUP BY lang`,
    )
    .all(blogId) as { lang: string; n: number }[]
  if (rows.length === 0) return [blog.language]

  const byTag = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const root = rows.some((r) => r.lang === blog.language)
    ? blog.language
    : rows.slice().sort((a, b) => b.n - a.n || byTag(a.lang, b.lang))[0].lang
  const others = rows
    .map((r) => r.lang)
    .filter((l) => l !== root)
    .sort(byTag)
  return [root, ...others]
}

/**
 * Public read: fetch a single post by (blogId, slug). Drafts are
 * included (unlike listPublishedPostsForBlog). Throws POST_NOT_FOUND.
 */
export function getPost(store: Store, blogId: string, slug: string): Post {
  const row = store.db
    .prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE blog_id = ? AND slug = ?`)
    .get(blogId, slug) as PostRow | undefined

  if (!row) {
    throw new SlopItError('POST_NOT_FOUND', `Post "${slug}" does not exist in blog "${blogId}"`, {
      blogId,
      slug,
    })
  }
  return rowToPost(row)
}

/**
 * Public read: list posts in a blog, optionally filtered by status.
 * Default (no status filter) returns published only, newest first.
 * status='draft' returns drafts, newest-first by created_at.
 */
export function listPosts(
  store: Store,
  blogId: string,
  opts?: { status?: 'draft' | 'published' },
): Post[] {
  const status = opts?.status ?? 'published'
  const orderBy = status === 'published' ? 'published_at DESC' : 'created_at DESC'

  const rows = store.db
    .prepare(
      `SELECT ${POST_COLUMNS}
         FROM posts
        WHERE blog_id = ? AND status = ?
        ORDER BY ${orderBy}`,
    )
    .all(blogId, status) as PostRow[]
  return rows.map(rowToPost)
}

// -----------------------------------------------------------------------------
// Translation groups
// -----------------------------------------------------------------------------

/**
 * Where a write leaves a post's group membership. `adopt` names the
 * target post to bring into the group when it had none yet, with the
 * `language` it stored before (NULL = inherited) so compensation can
 * put it back.
 */
interface TranslationLink {
  group: string | null
  adopt: { id: string; language: string | null } | null
}

const NO_LINK: TranslationLink = { group: null, adopt: null }

/**
 * Resolve `translationOf` (a slug in the same blog) into the group the
 * writing post joins. Consults the consumer's policy first; then the
 * target must exist in *this* blog (getPost is blog-scoped, so a slug
 * from another tenant is simply not found); a post cannot translate
 * itself.
 */
function resolveTranslationOf(
  store: Store,
  blog: Blog,
  translationOf: string,
  selfId: string | null,
  policy: TranslationPolicy | undefined,
): TranslationLink {
  if (policy !== undefined) {
    const verdict = policy(blog)
    if (!verdict.ok) {
      throw new SlopItError('TRANSLATIONS_DISABLED', verdict.reason, { translationOf })
    }
  }
  const target = getPost(store, blog.id, translationOf)
  if (selfId !== null && target.id === selfId) {
    throw new SlopItError('BAD_REQUEST', 'A post cannot be a translation of itself', {
      translationOf,
    })
  }
  return {
    group: target.translationGroup ?? generateShortId(),
    adopt:
      target.translationGroup === undefined
        ? { id: target.id, language: target.language ?? null }
        : null,
  }
}

/**
 * Bring the target post into `group`, freezing its language at its
 * current effective value so group membership never depends on the blog
 * default (which can change). Runs inside the caller's transaction.
 */
function adoptIntoGroup(store: Store, blog: Blog, link: TranslationLink): void {
  if (link.adopt === null) return
  store.db
    .prepare(
      'UPDATE posts SET translation_group = ?, language = COALESCE(language, ?) WHERE id = ?',
    )
    .run(link.group, blog.language, link.adopt.id)
}

/** Reverse of adoptIntoGroup, for compensation after a failed render. */
function unadopt(store: Store, link: TranslationLink): void {
  if (link.adopt === null) return
  store.db
    .prepare('UPDATE posts SET translation_group = NULL, language = ? WHERE id = ?')
    .run(link.adopt.language, link.adopt.id)
}

/**
 * One post per language per group. Preflight inside the write
 * transaction (after the adopt write, so the target's now-explicit
 * language is visible) to name the existing member in the error; the
 * partial unique index in migration 010 is the backstop.
 */
function assertLanguageFree(
  store: Store,
  blogId: string,
  group: string,
  language: string,
  selfId: string,
): void {
  const taken = store.db
    .prepare(
      'SELECT slug FROM posts WHERE blog_id = ? AND translation_group = ? AND language = ? AND id != ?',
    )
    .get(blogId, group, language, selfId) as { slug: string } | undefined
  if (taken) {
    throw new SlopItError(
      'TRANSLATION_CONFLICT',
      `This translation group already has a post in "${language}": "${taken.slug}"`,
      { language, slug: taken.slug },
    )
  }
}

/**
 * Re-derive every blog-level page from the rows as they stand now: home
 * pages, manifests and feeds, every post page, then prune stale language
 * homes. Used after a compensated write failure so public output matches
 * the restored rows — a failed publish must not leave a readable page, a
 * feed entry or a language home behind (Codex audit 2026-09-16, #1).
 *
 * @internal
 */
export function rederiveBlogOutput(renderer: MutationRenderer, blogId: string): void {
  renderer.renderBlog(blogId)
  renderer.renderManifests(blogId)
  renderer.renderBlogPosts(blogId)
  renderer.pruneLanguageHomes(blogId)
}

/**
 * Create a post. For published posts, also renders the post page + blog
 * index + CSS to disk, and returns a postUrl. For drafts, writes the DB
 * row only and returns { post } without postUrl.
 *
 * See docs/superpowers/specs/2026-04-22-create-post-design.md for the full
 * contract. If rendering fails, createPost compensates: the row (and an
 * adopted translation target) is restored, the new post's files are
 * removed, and every blog-level page is re-derived from the restored rows.
 * Compensation is best-effort: if the DELETE or the re-render also fails
 * (DB corruption, I/O failure), operator cleanup is needed.
 *
 * `translationOf` links the new post into the target's translation group
 * (docs/superpowers/specs/2026-09-15-translations-design.md): the target
 * is adopted into a fresh group if it had none, both rows end up with an
 * explicit `language`, and compensation restores the target too.
 */
export function createPost(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  input: PostInput,
  opts?: PostWriteOptions,
): { post: Post; postUrl?: string } {
  const parsed = PostInputSchema.parse(input)

  // Step 2: blog exists (throws BLOG_NOT_FOUND with details.blogId)
  const blog = getBlogInternal(store, blogId)

  // Step 3: resolve slug (superRefine already rejected empty auto-slug)
  const slug = parsed.slug ?? generateSlug(parsed.title)
  if (RESERVED_SLUGS.has(slug)) {
    throw new SlopItError(
      'POST_SLUG_RESERVED',
      `Slug "${slug}" is reserved for the per-language home pages; choose another slug`,
      { slug },
    )
  }

  // Step 4: derived fields. A group member always stores its language.
  const link =
    parsed.translationOf !== undefined
      ? resolveTranslationOf(store, blog, parsed.translationOf, null, opts?.translationPolicy)
      : NO_LINK
  const language =
    link.group !== null ? (parsed.language ?? blog.language) : (parsed.language ?? null)
  const id = generateShortId()
  const excerpt = parsed.excerpt ?? autoExcerpt(parsed.body)
  const now = new Date().toISOString()
  const publishedAt = parsed.status === 'published' ? now : null
  const tagsJson = JSON.stringify(parsed.tags)

  // Step 5: transactional INSERT with preflight + narrow-match. The target
  // adoption and the language-uniqueness preflight ride in the same
  // transaction, so a conflict rolls the adoption back with it.
  const tx = store.db.transaction(() => {
    const exists = store.db
      .prepare('SELECT 1 FROM posts WHERE blog_id = ? AND slug = ?')
      .get(blogId, slug)
    if (exists) {
      throw new SlopItError('POST_SLUG_CONFLICT', `Slug "${slug}" is already taken in this blog`, {
        slug,
      })
    }
    adoptIntoGroup(store, blog, link)
    if (link.group !== null) assertLanguageFree(store, blogId, link.group, language!, id)
    try {
      store.db
        .prepare(
          `INSERT INTO posts (
             id, blog_id, slug, title, body, excerpt, tags, status,
             seo_title, seo_description, author, cover_image, language,
             translation_group, published_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          blogId,
          slug,
          parsed.title,
          parsed.body,
          excerpt,
          tagsJson,
          parsed.status,
          parsed.seoTitle ?? null,
          parsed.seoDescription ?? null,
          parsed.author ?? null,
          parsed.coverImage ?? null,
          language,
          link.group,
          publishedAt,
        )
    } catch (e) {
      if (isPostSlugConflict(e)) {
        throw new SlopItError(
          'POST_SLUG_CONFLICT',
          `Slug "${slug}" is already taken in this blog`,
          { slug },
        )
      }
      throw e
    }
  })
  tx()

  // Hydrate the row we just wrote
  const post = rowToPost(
    store.db.prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`).get(id) as PostRow,
  )

  // Render (published only) with compensation on failure. renderBlogPosts
  // refreshes every sibling page's "More from this blog" block and, for
  // translations, the hreflang links and language switcher.
  if (parsed.status === 'published') {
    try {
      renderer.renderPost(blogId, post)
      renderer.renderBlog(blogId)
      renderer.renderBlogPosts(blogId)
      // A publish can make another language the root (listBlogLanguages),
      // moving its home from lang/<tag>/ to /. Destructive, so last.
      renderer.pruneLanguageHomes(blogId)
    } catch (renderErr) {
      try {
        store.db.transaction(() => {
          store.db.prepare('DELETE FROM posts WHERE id = ?').run(id)
          unadopt(store, link)
        })()
        // Public output must not outlive the row: drop what renderPost
        // wrote for this post, then rebuild the pages that embedded it
        // (homes, feeds, sibling hreflang) from the restored rows.
        renderer.removePostFiles(blogId, slug)
        renderer.deletePostMarkdown(blogId, slug)
        rederiveBlogOutput(renderer, blogId)
      } catch {
        /* best-effort; see the function doc */
      }
      throw renderErr
    }
    return { post, postUrl: renderer.baseUrl + post.slug + '/' }
  }

  return { post }
}

/**
 * Patch-update an existing post. Slug is immutable (enforced at the Zod
 * boundary via PostPatchSchema.strict()). Render side effects follow
 * the matrix in the spec (decision #2, #21):
 *
 *   draft→draft      : DB only
 *   draft→published  : write files + index; set published_at=now
 *   published→published : re-render files + index; keep published_at, bump updated_at
 *   published→draft  : delete files; re-render index; clear published_at
 *
 * `translationOf`: a slug joins that post's group (adopting it into a
 * fresh group if needed), `null` leaves the current group, omitted keeps
 * membership. A group member always stores an explicit language, so
 * `language: null` on a member stores the blog default rather than NULL.
 *
 * Compensation mirrors createPost: on render failure the prior row (and
 * an adopted target) is restored via reverse UPDATEs and the original
 * render error bubbles. See spec's weakened invariant.
 */
export function updatePost(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  slug: string,
  patch: PostPatchInput,
  opts?: PostWriteOptions,
): { post: Post; postUrl?: string } {
  const parsed = PostPatchSchema.parse(patch)

  // Ensure blog exists (throws BLOG_NOT_FOUND)
  const blog = getBlogInternal(store, blogId)

  // Load prior row — throws POST_NOT_FOUND if missing
  const prior = getPost(store, blogId, slug)

  // Empty patch → no-op fast path
  const patchKeys = Object.keys(parsed)
  if (patchKeys.length === 0) {
    return prior.status === 'published'
      ? { post: prior, postUrl: renderer.baseUrl + prior.slug + '/' }
      : { post: prior }
  }

  // Group membership after this patch (see the function doc).
  const membership = parsed.translationOf
  let link: TranslationLink
  if (typeof membership === 'string') {
    link = resolveTranslationOf(store, blog, membership, prior.id, opts?.translationPolicy)
  } else if (membership === null) {
    link = NO_LINK
  } else {
    link = { group: prior.translationGroup ?? null, adopt: null }
  }

  // Language after this patch. Outside a group the existing rule holds
  // (`null` clears the override, omitted keeps the prior value). Inside a
  // group the value is always explicit: `null`/absent resolve to the
  // blog default.
  const languageTouched = 'language' in parsed
  const language: string | null =
    link.group !== null
      ? languageTouched
        ? (parsed.language ?? blog.language)
        : (prior.language ?? blog.language)
      : languageTouched
        ? (parsed.language ?? null)
        : (prior.language ?? null)

  // Merge patched fields into prior row
  const merged = {
    title: parsed.title ?? prior.title,
    body: parsed.body ?? prior.body,
    excerpt: 'excerpt' in parsed ? parsed.excerpt : prior.excerpt,
    tags: parsed.tags ?? prior.tags,
    status: parsed.status ?? prior.status,
    seoTitle: 'seoTitle' in parsed ? parsed.seoTitle : prior.seoTitle,
    seoDescription: 'seoDescription' in parsed ? parsed.seoDescription : prior.seoDescription,
    author: 'author' in parsed ? parsed.author : prior.author,
    coverImage: 'coverImage' in parsed ? parsed.coverImage : prior.coverImage,
  }

  // Determine published_at by transition (decision #21 preserves on pub→pub)
  const oldStatus = prior.status
  const newStatus = merged.status
  let publishedAt: string | null
  if (oldStatus === 'draft' && newStatus === 'published') {
    publishedAt = new Date().toISOString()
  } else if (oldStatus === 'published' && newStatus === 'draft') {
    publishedAt = null
  } else {
    publishedAt = prior.publishedAt
  }

  const writeSelf = store.db.prepare(
    `UPDATE posts
        SET title = ?, body = ?, excerpt = ?, tags = ?, status = ?,
            seo_title = ?, seo_description = ?, author = ?, cover_image = ?,
            language = ?, translation_group = ?, published_at = ?, updated_at = ?
      WHERE blog_id = ? AND slug = ?`,
  )

  // One transaction over both rows: adopt the target (if any), check the
  // group has no other post in this language, then write this post.
  const nowIso = new Date().toISOString()
  store.db.transaction(() => {
    adoptIntoGroup(store, blog, link)
    if (link.group !== null) assertLanguageFree(store, blogId, link.group, language!, prior.id)
    writeSelf.run(
      merged.title,
      merged.body,
      merged.excerpt ?? null,
      JSON.stringify(merged.tags),
      merged.status,
      merged.seoTitle ?? null,
      merged.seoDescription ?? null,
      merged.author ?? null,
      merged.coverImage ?? null,
      language,
      link.group,
      publishedAt,
      nowIso,
      blogId,
      slug,
    )
  })()

  // Hydrate the updated row
  const updated = getPost(store, blogId, slug)

  // Render side effects per matrix, with compensation
  const compensate = () => {
    store.db.transaction(() => {
      writeSelf.run(
        prior.title,
        prior.body,
        prior.excerpt ?? null,
        JSON.stringify(prior.tags),
        prior.status,
        prior.seoTitle ?? null,
        prior.seoDescription ?? null,
        prior.author ?? null,
        prior.coverImage ?? null,
        prior.language ?? null,
        prior.translationGroup ?? null,
        prior.publishedAt,
        prior.updatedAt,
        blogId,
        slug,
      )
      unadopt(store, link)
    })()
  }

  try {
    if (oldStatus === 'draft' && newStatus === 'draft') {
      // no file ops
    } else if (newStatus === 'published') {
      // renderPost emits per-post HTML + .md + per-blog manifests (Phase 2),
      // renderBlog refreshes the human-facing home pages, renderBlogPosts
      // the sibling pages (title/description/translations may have
      // changed). A language change can empty a language, so the stale
      // home is pruned last, after every write succeeded.
      renderer.renderPost(blogId, updated)
      renderer.renderBlog(blogId)
      renderer.renderBlogPosts(blogId)
      renderer.pruneLanguageHomes(blogId)
    } else if (oldStatus === 'published' && newStatus === 'draft') {
      // Published → draft. Ordering matters (reviewer P2 from Phase 2 review):
      //   1. renderBlog + renderManifests + renderBlogPosts run FIRST against
      //      the now-draft DB so the post is excluded from index, manifests
      //      and sibling "More from" lists. If any throws, the catch
      //      compensates DB back to 'published' and the per-post files are
      //      still on disk → consistent pre-call state.
      //   2. removePostFiles, deletePostMarkdown and pruneLanguageHomes run
      //      LAST. They're destructive; we cannot recover them from the
      //      catch, so we only reach them after the safe re-render side
      //      has succeeded.
      renderer.renderBlog(blogId)
      renderer.renderManifests(blogId)
      renderer.renderBlogPosts(blogId)
      renderer.removePostFiles(blogId, slug)
      renderer.deletePostMarkdown(blogId, slug)
      renderer.pruneLanguageHomes(blogId)
    }
  } catch (renderErr) {
    try {
      compensate()
      // Put public output back in step with the restored rows: a post that
      // was published gets its prior page, .md and manifests back; one
      // that was a draft loses whatever the failed publish wrote. Then the
      // blog-level pages are re-derived.
      if (prior.status === 'published') {
        renderer.renderPost(blogId, prior)
      } else {
        renderer.removePostFiles(blogId, slug)
        renderer.deletePostMarkdown(blogId, slug)
      }
      rederiveBlogOutput(renderer, blogId)
    } catch {
      /* best-effort; a second failure needs operator cleanup */
    }
    throw renderErr
  }

  return newStatus === 'published'
    ? { post: updated, postUrl: renderer.baseUrl + updated.slug + '/' }
    : { post: updated }
}

/**
 * Hard-delete a post (spec decision #3). DB-first, then render side
 * effects. Weakened invariant: on render failure the row is gone and
 * the blog index may be momentarily stale until the next successful
 * publish/delete re-renders it. File cleanup is ENOENT-tolerant.
 */
export function deletePost(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  slug: string,
): { deleted: true } {
  getBlogInternal(store, blogId) // throws BLOG_NOT_FOUND
  const prior = getPost(store, blogId, slug) // throws POST_NOT_FOUND

  // DB transaction: DELETE the row
  const tx = store.db.transaction(() => {
    store.db.prepare('DELETE FROM posts WHERE blog_id = ? AND slug = ?').run(blogId, slug)
  })
  tx()

  // After commit: re-render index (if post was published) + remove files.
  // `MutationRenderer` requires removePostFiles at the type level — no
  // optional chaining, no silent skip. Shipped createRenderer implements
  // it; custom renderers that reach this primitive must provide it too.
  // Same manifests-before-destructive-cleanup ordering as the updatePost
  // published→draft branch. Index refresh + manifest regen first; per-post
  // file removal and the language-home prune last.
  if (prior.status === 'published') {
    renderer.renderBlog(blogId)
    renderer.renderManifests(blogId)
    renderer.renderBlogPosts(blogId)
    renderer.deletePostMarkdown(blogId, slug)
  }
  renderer.removePostFiles(blogId, slug)
  renderer.pruneLanguageHomes(blogId)

  return { deleted: true }
}
