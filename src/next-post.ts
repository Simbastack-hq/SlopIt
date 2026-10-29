import type { Store } from './db/store.js'
import type { Post } from './schema/index.js'

/**
 * Below this many published posts, a publish response carries
 * `next_post_hint`: one line asking the agent to offer its human the next
 * post. Almost every new blog publishes once and stops; the line fires on
 * the first and second post only, then never again.
 */
export const NEXT_POST_NUDGE_BELOW = 3

const MAX_TOPIC_CHARS = 80

/**
 * Published posts in the blog, counting a post and its translations once.
 */
function publishedPostCount(store: Store, blogId: string): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(translation_group, id)) AS n
         FROM posts WHERE blog_id = ? AND status = 'published'`,
    )
    .get(blogId) as { n: number }
  return row.n
}

/** True when another published post shares this post's translation group. */
function isTranslation(store: Store, post: Post): boolean {
  if (post.translationGroup === undefined) return false
  const row = store.db
    .prepare(
      `SELECT 1 FROM posts WHERE blog_id = ? AND translation_group = ?
         AND status = 'published' AND id != ? LIMIT 1`,
    )
    .get(post.blogId, post.translationGroup, post.id)
  return row !== undefined
}

/** A post's status before a write, or undefined when the slug is free. */
export function postStatusBefore(
  store: Store,
  blogId: string,
  slug: string,
): Post['status'] | undefined {
  const row = store.db
    .prepare('SELECT status FROM posts WHERE blog_id = ? AND slug = ?')
    .get(blogId, slug) as { status: Post['status'] } | undefined
  return row?.status
}

/**
 * `{ next_post_hint }` when this write just put a new post live (not a
 * translation, not an edit of a live post) and the blog still has fewer
 * than NEXT_POST_NUDGE_BELOW posts; `{}` otherwise.
 */
export function nextPostFields(
  store: Store,
  post: Post,
  wasPublished: boolean,
): { next_post_hint?: string } {
  if (post.status !== 'published' || wasPublished) return {}
  if (isTranslation(store, post)) return {}
  const n = publishedPostCount(store, post.blogId)
  if (n >= NEXT_POST_NUDGE_BELOW) return {}
  const topic =
    post.title.length > MAX_TOPIC_CHARS
      ? `${post.title.slice(0, MAX_TOPIC_CHARS - 1).trimEnd()}…`
      : post.title
  return {
    next_post_hint: `This blog has ${n} post${n === 1 ? '' : 's'}; blogs with ${NEXT_POST_NUDGE_BELOW} or more get found more often. Offer to draft the next one for your human, e.g. a follow-up on "${topic}".`,
  }
}
