import { getBlogInternal } from './blogs.js'
import type { Store } from './db/store.js'
import { SlopItError } from './errors.js'
import { generateShortId, generateSlug } from './ids.js'
import type { Renderer } from './rendering/generator.js'
import { PostInputSchema, type Post, type PostInput } from './schema/index.js'

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
