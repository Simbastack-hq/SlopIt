import type { Blog, Post } from './schema/index.js'

/**
 * Host hook for draft previews: given a draft, return a private URL where
 * the human can see it rendered, or `undefined` when there is none. Core
 * serves no previews itself; a host that wants them signs and serves the
 * URL (platform: an unguessable link on the blog's own host, noindex).
 * Only called for drafts; a published post has `post_url` instead.
 */
export type PreviewUrlFor = (blog: Blog, post: Post) => string | undefined

/** `{ preview_url }` for a draft when the host has previews, else `{}`. */
export function previewFields(
  previewUrlFor: PreviewUrlFor | undefined,
  blog: Blog,
  post: Post,
): { preview_url?: string } {
  if (post.status !== 'draft' || previewUrlFor === undefined) return {}
  const url = previewUrlFor(blog, post)
  return url === undefined ? {} : { preview_url: url }
}
