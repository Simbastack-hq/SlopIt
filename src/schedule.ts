import { getBlogInternal } from './blogs.js'
import type { Store } from './db/store.js'
import { updatePost, type PostWriteOptions } from './posts.js'
import type { MutationRenderer } from './rendering/generator.js'
import type { Blog } from './schema/index.js'

export interface DuePublishResult {
  published: { blogId: string; slug: string }[]
  failed: { blogId: string; slug: string; error: string }[]
}

/**
 * Publish every scheduled draft whose `publishAt` has passed. Hosts call
 * this on a timer (the hosted platform: once a minute). Each post goes
 * through updatePost's normal draft→published path, so rendering,
 * compensation and the host's renderer wrappers (search pings) behave
 * exactly as for a hand publish; that path also clears the schedule.
 *
 * A post that fails to publish (a render error, a fact deleted since) has
 * its schedule cleared and stays a draft, so it isn't retried every
 * minute forever; the error is logged and returned for the host to report.
 */
export function publishDuePosts(
  store: Store,
  rendererFor: (blog: Blog) => MutationRenderer,
  opts?: PostWriteOptions & { now?: Date },
): DuePublishResult {
  const now = (opts?.now ?? new Date()).toISOString()
  const due = store.db
    .prepare(
      `SELECT blog_id, slug FROM posts
        WHERE status = 'draft' AND publish_at IS NOT NULL AND publish_at <= ?
        ORDER BY publish_at, rowid`,
    )
    .all(now) as { blog_id: string; slug: string }[]
  const result: DuePublishResult = { published: [], failed: [] }
  for (const { blog_id: blogId, slug } of due) {
    try {
      const blog = getBlogInternal(store, blogId)
      updatePost(store, rendererFor(blog), blogId, slug, { status: 'published' }, opts)
      result.published.push({ blogId, slug })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`[slopit] scheduled publish failed for ${blogId}/${slug}:`, e)
      store.db
        .prepare('UPDATE posts SET publish_at = NULL WHERE blog_id = ? AND slug = ?')
        .run(blogId, slug)
      result.failed.push({ blogId, slug, error })
    }
  }
  return result
}
