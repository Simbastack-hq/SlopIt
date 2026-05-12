import { generateApiKey, hashApiKey } from './auth/api-key.js'
import type { Store } from './db/store.js'
import { SlopItError } from './errors.js'
import { generateShortId } from './ids.js'
import { listPublishedPostsForBlog } from './posts.js'
import type { MutationRenderer } from './rendering/generator.js'
import {
  BlogAnalyticsSchema,
  BlogPatchSchema,
  CreateBlogInputSchema,
  type Blog,
  type BlogAnalytics,
  type BlogPatchInput,
  type CreateBlogInput,
} from './schema/index.js'

/**
 * Deserialize the `analytics_json` column. NULL → undefined; valid JSON
 * runs through BlogAnalyticsSchema (rejects unknown providers and
 * malformed shapes). A row that fails parse is a corrupted DB write,
 * not user input — fail loud rather than silently returning undefined.
 *
 * @internal
 */
function parseAnalytics(json: string | null): BlogAnalytics | undefined {
  if (json === null) return undefined
  const raw = JSON.parse(json) as unknown
  return BlogAnalyticsSchema.parse(raw)
}

/**
 * Pure predicate so the narrow match logic is testable without running the DB.
 * better-sqlite3 sets err.code for SQLite constraint violations; the column
 * name is only reliably available in err.message.
 *
 * @internal — exported for unit testing only. Not part of the public API;
 * deliberately omitted from `src/index.ts`. Consumers should not rely on it.
 */
export function isBlogNameConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    err.message.includes('blogs.name')
  )
}

export function createBlog(store: Store, input: CreateBlogInput): { blog: Blog } {
  const parsed = CreateBlogInputSchema.parse(input)
  const id = generateShortId()
  const name = parsed.name ?? null
  const theme = parsed.theme
  // Already normalized by the schema's preprocess (trim + lowercase).
  const email = parsed.email ?? null

  const insert = store.db.prepare('INSERT INTO blogs (id, name, theme, email) VALUES (?, ?, ?, ?)')

  try {
    insert.run(id, name, theme, email)
  } catch (e) {
    if (isBlogNameConflict(e)) {
      throw new SlopItError('BLOG_NAME_CONFLICT', `Blog name "${name}" is already taken`)
    }
    throw e
  }

  // Newly-created blog never has analytics or a parent-site URL
  // configured — both columns default to NULL. Skip those round-trip
  // SELECTs and build the Blog shape directly from the in-memory inputs.
  const row = store.db
    .prepare('SELECT id, name, theme, created_at FROM blogs WHERE id = ?')
    .get(id) as {
    id: string
    name: string | null
    theme: 'minimal'
    created_at: string
  }

  const blog: Blog = {
    id: row.id,
    name: row.name,
    theme: row.theme,
    createdAt: row.created_at,
    parentSiteUrl: null,
  }

  return { blog }
}

/**
 * Look up all blogs registered under a given email. Used only by the
 * recovery flow — never exposed via the public REST/MCP read paths
 * because email is intentionally absent from `BlogSchema` (private
 * recovery channel, not blog metadata).
 *
 * Caller is responsible for normalizing `email` to the same form the
 * schema persists (trim + lowercase). Returns [] for no match; never
 * throws.
 */
export function getBlogsByEmail(store: Store, email: string): Blog[] {
  const rows = store.db
    .prepare('SELECT id, name, theme, created_at, parent_site_url FROM blogs WHERE email = ?')
    .all(email) as Array<{
    id: string
    name: string | null
    theme: 'minimal'
    created_at: string
    parent_site_url: string | null
  }>

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    theme: row.theme,
    createdAt: row.created_at,
    parentSiteUrl: row.parent_site_url,
  }))
}

export function createApiKey(store: Store, blogId: string): { apiKey: string } {
  const apiKey = generateApiKey()
  const keyHash = hashApiKey(apiKey)
  const id = generateShortId()

  // The FK on api_keys.blog_id already blocks orphan rows, but we do an
  // explicit existence check so the caller gets SlopItError(BLOG_NOT_FOUND)
  // instead of a cryptic FOREIGN KEY constraint error.
  const tx = store.db.transaction(() => {
    const found = store.db.prepare('SELECT 1 FROM blogs WHERE id = ?').get(blogId)
    if (!found) {
      throw new SlopItError('BLOG_NOT_FOUND', `Blog "${blogId}" does not exist`)
    }
    store.db
      .prepare('INSERT INTO api_keys (id, blog_id, key_hash) VALUES (?, ?, ?)')
      .run(id, blogId, keyHash)
  })

  tx()

  return { apiKey }
}

/**
 * Public, stable read API. Thin wrapper around getBlogInternal so the
 * internal helper (used by the renderer) stays unexported and consumers
 * have a clear entry point.
 */
export function getBlog(store: Store, blogId: string): Blog {
  return getBlogInternal(store, blogId)
}

/**
 * Look up a blog by name. Returns null on miss — names are user input
 * and a miss is a normal 404, unlike getBlog where a miss usually means
 * caller bug. CreateBlogInputSchema enforces lowercase DNS-safe names,
 * so an exact match is sufficient.
 */
export function getBlogByName(store: Store, name: string): Blog | null {
  const row = store.db
    .prepare(
      'SELECT id, name, theme, created_at, analytics_json, parent_site_url FROM blogs WHERE name = ?',
    )
    .get(name) as
    | {
        id: string
        name: string
        theme: 'minimal'
        created_at: string
        analytics_json: string | null
        parent_site_url: string | null
      }
    | undefined

  if (row === undefined) return null

  return {
    id: row.id,
    name: row.name,
    theme: row.theme,
    createdAt: row.created_at,
    analytics: parseAnalytics(row.analytics_json),
    parentSiteUrl: row.parent_site_url,
  }
}

/**
 * Patch fields on a blog row. v1 surface allows mutation of `analytics`
 * and `parentSiteUrl`. Theme/name/id remain immutable through this function.
 *
 * Side effects:
 *  - When any patched field changes (set, cleared, or modified), every
 *    published post in the blog is re-rendered via `renderer.renderPost`
 *    so any postprocessHtml hook (Phase 3c's injection wrapper) sees
 *    the new value. `renderer.renderBlog` is also called once.
 *  - Empty patch, patches with explicit `undefined` values, and
 *    patches that leave every field functionally unchanged are no-ops:
 *    no DB write, no re-render.
 *
 * Compensation: same shape as updatePost. DB UPDATE runs first; on
 * render failure the prior values are restored via a reverse UPDATE
 * and the render error bubbles to the caller. The reverse UPDATE
 * itself is best-effort — same weakened invariant as updatePost.
 */
export function updateBlog(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  patch: BlogPatchInput,
): Blog {
  const parsed = BlogPatchSchema.parse(patch)

  // Throws BLOG_NOT_FOUND with details.blogId
  const prior = getBlogInternal(store, blogId)

  // Empty patch → no-op fast path
  if (Object.keys(parsed).length === 0) return prior

  // Detect per-field change semantics. For each patchable field there are
  // four input states:
  //   patch has no key for the field       → leave column untouched
  //   patch field === undefined (explicit) → treat as omitted, leave column untouched
  //   patch field === null                 → clear column to NULL
  //   patch field has a concrete value     → set column
  //
  // The explicit-undefined case matters because Zod's `.optional()` preserves
  // `{ field: undefined }` in the parsed output (the key is present, value
  // is undefined). Treat it as "no change" — same effective semantics as
  // omitting the key.
  const patchTouchesAnalytics = 'analytics' in parsed && parsed.analytics !== undefined
  const patchTouchesParentSiteUrl = 'parentSiteUrl' in parsed && parsed.parentSiteUrl !== undefined

  const priorAnalyticsJson = prior.analytics === undefined ? null : JSON.stringify(prior.analytics)
  const newAnalyticsJson: string | null = patchTouchesAnalytics
    ? parsed.analytics === null
      ? null
      : JSON.stringify(parsed.analytics)
    : priorAnalyticsJson

  const priorParentSiteUrl = prior.parentSiteUrl
  const newParentSiteUrl: string | null = patchTouchesParentSiteUrl
    ? (parsed.parentSiteUrl ?? null)
    : priorParentSiteUrl

  const analyticsChanged = newAnalyticsJson !== priorAnalyticsJson
  const parentSiteUrlChanged = newParentSiteUrl !== priorParentSiteUrl
  if (!analyticsChanged && !parentSiteUrlChanged) return prior

  // Apply DB UPDATE. Only write columns whose value changed so the SQL
  // stays minimal and tests that observe column writes (idempotency,
  // audit) aren't disturbed for no-op fields.
  if (analyticsChanged && parentSiteUrlChanged) {
    store.db
      .prepare('UPDATE blogs SET analytics_json = ?, parent_site_url = ? WHERE id = ?')
      .run(newAnalyticsJson, newParentSiteUrl, blogId)
  } else if (analyticsChanged) {
    store.db
      .prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?')
      .run(newAnalyticsJson, blogId)
  } else {
    store.db
      .prepare('UPDATE blogs SET parent_site_url = ? WHERE id = ?')
      .run(newParentSiteUrl, blogId)
  }

  // Hydrate the updated row
  const updated = getBlogInternal(store, blogId)

  // Compensation: restore prior column values on render failure.
  const compensate = () => {
    store.db
      .prepare('UPDATE blogs SET analytics_json = ?, parent_site_url = ? WHERE id = ?')
      .run(priorAnalyticsJson, priorParentSiteUrl, blogId)
  }

  // Re-render side effects. The renderer reads blog.analytics and
  // blog.parentSiteUrl on every call (analytics via the postprocessHtml
  // hook, parentSiteUrl via the template), so rendered HTML on disk is
  // stale until we re-run it.
  try {
    const posts = listPublishedPostsForBlog(store, blogId)
    for (const post of posts) {
      renderer.renderPost(blogId, post)
    }
    renderer.renderBlog(blogId)
  } catch (renderErr) {
    try {
      compensate()
    } catch {
      /* best-effort; weakened invariant per updatePost precedent */
    }
    throw renderErr
  }

  return updated
}

/**
 * Fetch a blog by id, throwing SlopItError(BLOG_NOT_FOUND) if missing.
 * Used by the renderer (for display name / theme) and by createPost's
 * existence check. Not in the public barrel — callers must import from
 * './blogs.js' directly.
 *
 * @internal
 */
export function getBlogInternal(store: Store, blogId: string): Blog {
  const row = store.db
    .prepare(
      'SELECT id, name, theme, created_at, analytics_json, parent_site_url FROM blogs WHERE id = ?',
    )
    .get(blogId) as
    | {
        id: string
        name: string | null
        theme: 'minimal'
        created_at: string
        analytics_json: string | null
        parent_site_url: string | null
      }
    | undefined

  if (row === undefined) {
    throw new SlopItError('BLOG_NOT_FOUND', `Blog "${blogId}" does not exist`, { blogId })
  }

  return {
    id: row.id,
    name: row.name,
    theme: row.theme,
    createdAt: row.created_at,
    analytics: parseAnalytics(row.analytics_json),
    parentSiteUrl: row.parent_site_url,
  }
}
