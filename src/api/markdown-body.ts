import { SlopItError } from '../errors.js'
import type { PostInput } from '../schema/index.js'

/**
 * Parse a text/markdown request body + query-string metadata into a
 * PostInput shape suitable for createPost. This does NOT call Zod;
 * the caller runs PostInputSchema.parse(result) so validation errors
 * surface through the same path as JSON bodies.
 *
 * Only the Tier-1 fields are supported on this path (title, status,
 * slug, tags). Other PostInput fields (excerpt, seoTitle, etc.) are
 * unsupported — agents who need them use JSON.
 */
export function parseMarkdownBody(input: { body: string; query: URLSearchParams }): PostInput {
  const title = input.query.get('title')
  if (title === null || title.length === 0) {
    throw new SlopItError(
      'BAD_REQUEST',
      'text/markdown body requires a ?title=<string> query parameter',
      { missing: 'title' },
    )
  }
  if (input.body.length === 0) {
    throw new SlopItError('BAD_REQUEST', 'text/markdown body must not be empty', {})
  }

  const result: Partial<PostInput> = {
    title,
    body: input.body,
  }

  const status = input.query.get('status')
  if (status !== null) result.status = status as PostInput['status']

  const slug = input.query.get('slug')
  if (slug !== null) result.slug = slug

  const tagsParam = input.query.get('tags')
  if (tagsParam !== null) {
    result.tags = tagsParam
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  }

  return result as PostInput
}
