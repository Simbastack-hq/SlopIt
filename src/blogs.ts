import { generateApiKey, hashApiKey } from './auth/api-key.js'
import { isoTimestamp } from './time.js'
import type { Store } from './db/store.js'
import { SlopItError } from './errors.js'
import { generateShortId } from './ids.js'
import {
  attemptAll,
  listPublishedPostsForBlog,
  rederiveBlogOutput,
  rethrowWithRecovery,
} from './posts.js'
import { accentReadability } from './rendering/brand.js'
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
 * Consumer policy consulted when a blog patch sets a brand field
 * (`accentColor`, `logoUrl`, `faviconUrl`) to a new value. Same shape as
 * `TranslationPolicy`: the consumer decides, core turns a rejection into
 * `BRANDING_DISABLED` with `reason` as the message. Clearing a field is
 * never consulted, so a blog the host stops allowing can still go back
 * to the theme's defaults.
 */
export type BrandPolicy = (blog: Blog) => { ok: true } | { ok: false; reason: string }

export interface BlogWriteOptions {
  brandPolicy?: BrandPolicy
}

// Every column a Blog is read from, in one place for the three readers.
const BLOG_COLUMNS =
  'id, name, title, theme, created_at, analytics_json, parent_site_url, language, accent_color, logo_url, favicon_url'

interface BlogRow {
  id: string
  name: string | null
  title: string | null
  theme: 'minimal'
  created_at: string
  analytics_json: string | null
  parent_site_url: string | null
  language: string
  accent_color: string | null
  logo_url: string | null
  favicon_url: string | null
}

function rowToBlog(row: BlogRow): Blog {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    theme: row.theme,
    createdAt: isoTimestamp(row.created_at),
    analytics: parseAnalytics(row.analytics_json),
    parentSiteUrl: row.parent_site_url,
    language: row.language,
    accentColor: row.accent_color,
    logoUrl: row.logo_url,
    faviconUrl: row.favicon_url,
  }
}

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
  const language = parsed.language
  const title = parsed.title ?? null
  const parentSiteUrl = parsed.parentSiteUrl ?? null

  const insert = store.db.prepare(
    'INSERT INTO blogs (id, name, title, theme, email, language, parent_site_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )

  try {
    insert.run(id, name, title, theme, email, language, parentSiteUrl)
  } catch (e) {
    if (isBlogNameConflict(e)) {
      throw new SlopItError('BLOG_NAME_CONFLICT', `Blog name "${name}" is already taken`)
    }
    throw e
  }

  // A newly-created blog never has analytics configured (NULL), and its
  // parent-site URL is whatever signup passed. Build the Blog shape from
  // the in-memory inputs instead of selecting those columns back.
  const row = store.db
    .prepare('SELECT id, name, title, theme, created_at, language FROM blogs WHERE id = ?')
    .get(id) as {
    id: string
    name: string | null
    title: string | null
    theme: 'minimal'
    created_at: string
    language: string
  }

  const blog: Blog = {
    id: row.id,
    name: row.name,
    title: row.title,
    theme: row.theme,
    createdAt: isoTimestamp(row.created_at),
    parentSiteUrl,
    language: row.language,
    // Signup never sets a brand; it is a blog patch.
    accentColor: null,
    logoUrl: null,
    faviconUrl: null,
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
    .prepare(`SELECT ${BLOG_COLUMNS} FROM blogs WHERE email = ?`)
    .all(email) as BlogRow[]
  return rows.map(rowToBlog)
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
  const row = store.db.prepare(`SELECT ${BLOG_COLUMNS} FROM blogs WHERE name = ?`).get(name) as
    | BlogRow
    | undefined
  return row === undefined ? null : rowToBlog(row)
}

/**
 * Patch fields on a blog row. v1 surface allows mutation of `title`,
 * `analytics`, `parentSiteUrl`, `language` and the brand (`accentColor`,
 * `logoUrl`, `faviconUrl`). Theme/name/id remain immutable through this
 * function.
 *
 * Side effects:
 *  - When any patched field changes (set, cleared, or modified), every
 *    published post page is re-rendered via `renderer.renderBlogPosts`
 *    so any postprocessHtml hook (Phase 3c's injection wrapper) sees
 *    the new value. `renderer.renderBlog` is also called once; both
 *    rewrite the blog's style.css and favicon.svg, which carry the brand.
 *  - Empty patch, patches with explicit `undefined` values, and
 *    patches that leave every field functionally unchanged are no-ops:
 *    no DB write, no re-render.
 *
 * Refusals, before any write: a brand field set to a new value when
 * `opts.brandPolicy` refuses (BRANDING_DISABLED), then an `accentColor`
 * too light to read on the page (BAD_REQUEST, with a darker suggestion
 * in `details.suggestion`).
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
  opts?: BlogWriteOptions,
): Blog {
  const parsed = BlogPatchSchema.parse(patch)

  // Throws BLOG_NOT_FOUND with details.blogId
  const prior = getBlogInternal(store, blogId)

  // Empty patch → no-op fast path
  if (Object.keys(parsed).length === 0) return prior

  // Each patchable field has four input states:
  //   patch has no key for the field       → leave column untouched
  //   patch field === undefined (explicit) → treat as omitted, leave column untouched
  //   patch field === null                 → clear column to NULL
  //   patch field has a concrete value     → set column
  //
  // The explicit-undefined case matters because Zod's `.optional()` preserves
  // `{ field: undefined }` in the parsed output (the key is present, value
  // is undefined). Treat it as "no change" — same effective semantics as
  // omitting the key.
  const next = <T>(value: T | null | undefined, current: T | null): T | null =>
    value === undefined ? current : value

  const priorAnalyticsJson = prior.analytics === undefined ? null : JSON.stringify(prior.analytics)
  const before: BlogColumns = {
    title: prior.title,
    analyticsJson: priorAnalyticsJson,
    parentSiteUrl: prior.parentSiteUrl,
    language: prior.language,
    accentColor: prior.accentColor,
    logoUrl: prior.logoUrl,
    faviconUrl: prior.faviconUrl,
  }
  const after: BlogColumns = {
    title: next(parsed.title, prior.title),
    analyticsJson:
      parsed.analytics === undefined
        ? priorAnalyticsJson
        : parsed.analytics === null
          ? null
          : JSON.stringify(parsed.analytics),
    parentSiteUrl: next(parsed.parentSiteUrl, prior.parentSiteUrl),
    // Not nullable: a blog always has a language.
    language: parsed.language ?? prior.language,
    accentColor: next(parsed.accentColor, prior.accentColor),
    logoUrl: next(parsed.logoUrl, prior.logoUrl),
    faviconUrl: next(parsed.faviconUrl, prior.faviconUrl),
  }

  const changed = (Object.keys(after) as (keyof BlogColumns)[]).filter(
    (k) => after[k] !== before[k],
  )
  if (changed.length === 0) return prior

  // Setting a new brand value is what a host may restrict; clearing one
  // never is.
  const brandSet = (['accentColor', 'logoUrl', 'faviconUrl'] as const).some(
    (k) => changed.includes(k) && after[k] !== null,
  )
  if (brandSet && opts?.brandPolicy !== undefined) {
    const verdict = opts.brandPolicy(prior)
    if (!verdict.ok) throw new SlopItError('BRANDING_DISABLED', verdict.reason)
  }
  if (changed.includes('accentColor') && after.accentColor !== null) {
    const verdict = accentReadability(after.accentColor)
    if (!verdict.ok) {
      throw new SlopItError('BAD_REQUEST', verdict.message, {
        accentColor: after.accentColor,
        suggestion: verdict.suggestion,
      })
    }
  }

  // One UPDATE over every column; unchanged ones are rewritten with
  // their prior value. Compensation mirrors it exactly.
  const write = (c: BlogColumns) =>
    store.db
      .prepare(
        'UPDATE blogs SET title = ?, analytics_json = ?, parent_site_url = ?, language = ?, accent_color = ?, logo_url = ?, favicon_url = ? WHERE id = ?',
      )
      .run(
        c.title,
        c.analyticsJson,
        c.parentSiteUrl,
        c.language,
        c.accentColor,
        c.logoUrl,
        c.faviconUrl,
        blogId,
      )

  write(after)

  // Hydrate the updated row
  const updated = getBlogInternal(store, blogId)

  const languageChanged = changed.includes('language')
  const titleChanged = changed.includes('title')

  // Re-render side effects. The renderer reads every one of these fields
  // on every call, so rendered output on disk is stale until we re-run
  // it. Analytics, the parent link and the brand affect HTML (and the
  // brand the blog's style.css and favicon.svg) only. The title is the
  // masthead and <title> of every page and also heads feed.xml and
  // llms.txt. Language also lands in every post's `.md` frontmatter and
  // in feed.xml.
  try {
    renderer.renderBlogPosts(blogId)
    renderer.renderBlog(blogId)
    if (languageChanged) {
      for (const post of listPublishedPostsForBlog(store, blogId)) {
        renderer.renderPostMarkdown(blogId, post)
      }
    }
    if (languageChanged || titleChanged) renderer.renderManifests(blogId)
    // A default-language change can move a language from `/lang/<tag>/`
    // to `/` (its old home is now stale). Destructive, so last.
    renderer.pruneLanguageHomes(blogId)
  } catch (renderErr) {
    const failures: unknown[] = []
    try {
      write(before)
    } catch (e) {
      failures.push(e)
    }
    // Re-derive public output from the rows as they stand (same contract
    // as updatePost): .md files carry the effective language, so a failed
    // language change rewrites them too. Every step runs even if another
    // fails, and an incomplete recovery is reported with the original.
    if (languageChanged) {
      failures.push(
        ...attemptAll(
          listPublishedPostsForBlog(store, blogId).map(
            (post) => () => renderer.renderPostMarkdown(blogId, post),
          ),
        ),
      )
    }
    failures.push(...rederiveBlogOutput(renderer, blogId))
    rethrowWithRecovery(renderErr, failures)
  }

  return updated
}

// The patchable columns of a blog row, as updateBlog writes them.
interface BlogColumns {
  title: string | null
  analyticsJson: string | null
  parentSiteUrl: string | null
  language: string
  accentColor: string | null
  logoUrl: string | null
  faviconUrl: string | null
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
  const row = store.db.prepare(`SELECT ${BLOG_COLUMNS} FROM blogs WHERE id = ?`).get(blogId) as
    | BlogRow
    | undefined
  if (row === undefined) {
    throw new SlopItError('BLOG_NOT_FOUND', `Blog "${blogId}" does not exist`, { blogId })
  }
  return rowToBlog(row)
}
