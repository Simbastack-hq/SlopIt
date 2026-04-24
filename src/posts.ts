import { getBlogInternal } from './blogs.js'
import type { Store } from './db/store.js'
import { SlopItError } from './errors.js'
import { generateShortId, generateSlug } from './ids.js'
import type { Renderer, MutationRenderer } from './rendering/generator.js'
import { PostInputSchema, type Post, type PostInput } from './schema/index.js'
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
 * Returns published posts for a blog, newest-first by published_at.
 * Drafts excluded. Used by the renderer to build the blog index.
 *
 * @internal
 */
export function listPublishedPostsForBlog(store: Store, blogId: string): Post[] {
  const rows = store.db
    .prepare(
      `SELECT id, blog_id, slug, title, body, excerpt, tags, status,
              seo_title, seo_description, author, cover_image,
              published_at, created_at, updated_at
         FROM posts
        WHERE blog_id = ? AND status = 'published'
        ORDER BY published_at DESC`,
    )
    .all(blogId) as {
    id: string
    blog_id: string
    slug: string
    title: string
    body: string
    excerpt: string | null
    tags: string
    status: 'published'
    seo_title: string | null
    seo_description: string | null
    author: string | null
    cover_image: string | null
    published_at: string | null
    created_at: string
    updated_at: string
  }[]

  return rows.map((row) => ({
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
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

/**
 * Public read: fetch a single post by (blogId, slug). Drafts are
 * included (unlike listPublishedPostsForBlog). Throws POST_NOT_FOUND.
 */
export function getPost(store: Store, blogId: string, slug: string): Post {
  const row = store.db
    .prepare(
      `SELECT id, blog_id, slug, title, body, excerpt, tags, status,
              seo_title, seo_description, author, cover_image,
              published_at, created_at, updated_at
         FROM posts WHERE blog_id = ? AND slug = ?`,
    )
    .get(blogId, slug) as
    | {
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
        published_at: string | null
        created_at: string
        updated_at: string
      }
    | undefined

  if (!row) {
    throw new SlopItError('POST_NOT_FOUND', `Post "${slug}" does not exist in blog "${blogId}"`, {
      blogId,
      slug,
    })
  }

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
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
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
      `SELECT id, blog_id, slug, title, body, excerpt, tags, status,
              seo_title, seo_description, author, cover_image,
              published_at, created_at, updated_at
         FROM posts
        WHERE blog_id = ? AND status = ?
        ORDER BY ${orderBy}`,
    )
    .all(blogId, status) as {
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
    published_at: string | null
    created_at: string
    updated_at: string
  }[]

  return rows.map((row) => ({
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
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

/**
 * Create a post. For published posts, also renders the post page + blog
 * index + CSS to disk, and returns a postUrl. For drafts, writes the DB
 * row only and returns { post } without postUrl.
 *
 * See docs/superpowers/specs/2026-04-22-create-post-design.md for the full
 * contract, including the weakened atomicity invariant: if render fails,
 * createPost attempts compensation via DELETE FROM posts. If the DELETE
 * also fails (extraordinarily rare — usually indicates DB corruption or
 * I/O failure), the row persists and operator cleanup is needed.
 */
export function createPost(
  store: Store,
  renderer: Renderer,
  blogId: string,
  input: PostInput,
): { post: Post; postUrl?: string } {
  const parsed = PostInputSchema.parse(input)

  // Step 2: blog exists (throws BLOG_NOT_FOUND with details.blogId)
  getBlogInternal(store, blogId)

  // Step 3: resolve slug (superRefine already rejected empty auto-slug)
  const slug = parsed.slug ?? generateSlug(parsed.title)

  // Step 4: derived fields
  const id = generateShortId()
  const excerpt = parsed.excerpt ?? autoExcerpt(parsed.body)
  const now = new Date().toISOString()
  const publishedAt = parsed.status === 'published' ? now : null
  const tagsJson = JSON.stringify(parsed.tags)

  // Step 5: transactional INSERT with preflight + narrow-match
  const tx = store.db.transaction(() => {
    const exists = store.db
      .prepare('SELECT 1 FROM posts WHERE blog_id = ? AND slug = ?')
      .get(blogId, slug)
    if (exists) {
      throw new SlopItError('POST_SLUG_CONFLICT', `Slug "${slug}" is already taken in this blog`, {
        slug,
      })
    }
    try {
      store.db
        .prepare(
          `INSERT INTO posts (
             id, blog_id, slug, title, body, excerpt, tags, status,
             seo_title, seo_description, author, cover_image, published_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const row = store.db
    .prepare(
      `SELECT id, blog_id, slug, title, body, excerpt, tags, status,
              seo_title, seo_description, author, cover_image,
              published_at, created_at, updated_at
         FROM posts WHERE id = ?`,
    )
    .get(id) as {
    id: string
    blog_id: string
    slug: string
    title: string
    body: string
    // createPost always writes a non-null excerpt (explicit or auto).
    excerpt: string
    tags: string
    status: 'draft' | 'published'
    seo_title: string | null
    seo_description: string | null
    author: string | null
    cover_image: string | null
    published_at: string | null
    created_at: string
    updated_at: string
  }

  const post: Post = {
    id: row.id,
    blogId: row.blog_id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    excerpt: row.excerpt,
    tags: JSON.parse(row.tags) as string[],
    status: row.status,
    seoTitle: row.seo_title ?? undefined,
    seoDescription: row.seo_description ?? undefined,
    author: row.author ?? undefined,
    coverImage: row.cover_image ?? undefined,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }

  // Render (published only) with compensation on failure
  if (parsed.status === 'published') {
    try {
      renderer.renderPost(blogId, post)
      renderer.renderBlog(blogId)
    } catch (renderErr) {
      try {
        store.db.prepare('DELETE FROM posts WHERE id = ?').run(id)
      } catch {
        /* best-effort; see spec decision #6 */
      }
      throw renderErr
    }
    return { post, postUrl: renderer.baseUrl + '/' + post.slug + '/' }
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
 * Compensation mirrors createPost: on render failure the prior row is
 * restored via a reverse UPDATE and the original render error bubbles.
 * See spec's weakened invariant.
 */
export function updatePost(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  slug: string,
  patch: PostPatchInput,
): { post: Post; postUrl?: string } {
  const parsed = PostPatchSchema.parse(patch)

  // Ensure blog exists (throws BLOG_NOT_FOUND)
  getBlogInternal(store, blogId)

  // Load prior row — throws POST_NOT_FOUND if missing
  const prior = getPost(store, blogId, slug)

  // Empty patch → no-op fast path
  const patchKeys = Object.keys(parsed)
  if (patchKeys.length === 0) {
    return prior.status === 'published'
      ? { post: prior, postUrl: renderer.baseUrl + '/' + prior.slug + '/' }
      : { post: prior }
  }

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

  // Apply DB UPDATE (updated_at bumps automatically? No — set explicitly)
  const nowIso = new Date().toISOString()
  const tagsJson = JSON.stringify(merged.tags)
  store.db
    .prepare(
      `UPDATE posts
          SET title = ?, body = ?, excerpt = ?, tags = ?, status = ?,
              seo_title = ?, seo_description = ?, author = ?, cover_image = ?,
              published_at = ?, updated_at = ?
        WHERE blog_id = ? AND slug = ?`,
    )
    .run(
      merged.title,
      merged.body,
      merged.excerpt ?? null,
      tagsJson,
      merged.status,
      merged.seoTitle ?? null,
      merged.seoDescription ?? null,
      merged.author ?? null,
      merged.coverImage ?? null,
      publishedAt,
      nowIso,
      blogId,
      slug,
    )

  // Hydrate the updated row
  const updated = getPost(store, blogId, slug)

  // Render side effects per matrix, with compensation
  const compensate = () => {
    // Reverse UPDATE back to prior state
    store.db
      .prepare(
        `UPDATE posts
            SET title = ?, body = ?, excerpt = ?, tags = ?, status = ?,
                seo_title = ?, seo_description = ?, author = ?, cover_image = ?,
                published_at = ?, updated_at = ?
          WHERE blog_id = ? AND slug = ?`,
      )
      .run(
        prior.title,
        prior.body,
        prior.excerpt ?? null,
        JSON.stringify(prior.tags),
        prior.status,
        prior.seoTitle ?? null,
        prior.seoDescription ?? null,
        prior.author ?? null,
        prior.coverImage ?? null,
        prior.publishedAt,
        prior.updatedAt,
        blogId,
        slug,
      )
  }

  try {
    if (oldStatus === 'draft' && newStatus === 'draft') {
      // no file ops
    } else if (newStatus === 'published') {
      renderer.renderPost(blogId, updated)
      renderer.renderBlog(blogId)
    } else if (oldStatus === 'published' && newStatus === 'draft') {
      // IMPORTANT ordering (P1 fix): renderBlog FIRST. It reads the DB
      // where status is now 'draft', so the post is excluded from the
      // index. Then delete the post files. If renderBlog fails, the
      // catch compensates (DB back to 'published') and files still
      // exist → consistent pre-call state. If file deletion fails after
      // a successful renderBlog, the orphan file is tolerable per spec
      // (it 404s on the direct URL but isn't in the index).
      renderer.renderBlog(blogId)
      renderer.removePostFiles(blogId, slug)
    }
  } catch (renderErr) {
    try {
      compensate()
    } catch {
      /* best-effort; weakened invariant */
    }
    throw renderErr
  }

  return newStatus === 'published'
    ? { post: updated, postUrl: renderer.baseUrl + '/' + updated.slug + '/' }
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
  if (prior.status === 'published') {
    renderer.renderBlog(blogId)
  }
  renderer.removePostFiles(blogId, slug)

  return { deleted: true }
}
