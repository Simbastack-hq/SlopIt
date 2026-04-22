import type { Store } from './db/store.js'
import type { Post } from './schema/index.js'

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
    err instanceof Error
    && (err as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE'
    && err.message.includes('posts.blog_id, posts.slug')
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
