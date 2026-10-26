import { z } from 'zod'
import { getBlogInternal } from './blogs.js'
import type { Store } from './db/store.js'
import { SlopItError } from './errors.js'
import { listPublishedPostsForBlog } from './posts.js'
import {
  checkFactValue,
  FACT_NAME,
  factLines,
  factNames,
  type FactLine,
  type FactRecord,
} from './rendering/facts.js'
import type { MutationRenderer } from './rendering/generator.js'
import type { Blog } from './schema/index.js'

// Live facts: the blog's named current claims and the writes that change
// them (docs/specs/2026-10-21-live-facts.md, docs/solutions/live-facts.md).
// The syntax (tokens, substitution, validation) is rendering/facts.ts.
//
// Recovery model: a fact change and a `fact_renders_pending` row for its
// blog commit in one transaction; the same request then re-renders the
// blog's fact-using pages and deletes the row. If that render fails (or
// the process dies), the row stays and the next facts call, the next post
// write, or the host's drainPendingFactRenders at boot finishes it.

/** Most facts one blog may keep. */
export const FACT_LIMIT = 100
/** Most published fact-using posts one fact change re-renders. */
export const FACT_FANOUT_LIMIT = 200

export interface Fact {
  name: string
  value: string
  note: string | null
  source_url: string | null
  /** When the publisher says they last checked the value (ISO 8601). */
  confirmed_at: string
  /** When the value last changed (ISO 8601). */
  updated_at: string
}

export interface FactUse {
  slug: string
  status: 'draft' | 'published'
}

export interface FactWithUses extends Fact {
  /** Every post whose body uses the fact, drafts included. */
  used_by: FactUse[]
}

export interface AffectedPost {
  slug: string
  title: string
  status: 'draft' | 'published'
  /** Live URL; published posts only. */
  url?: string
  /** Each source line that uses the fact, before and after the change. */
  lines: FactLine[]
}

export interface SetFactResult {
  fact: FactWithUses
  /** True when the value is new or different. */
  changed: boolean
  dry_run: boolean
  affected_posts: AffectedPost[]
  /** Published fact-using posts re-rendered by this call (0 on a dry run). */
  rerendered: number
}

/** Body of `PUT /blogs/:id/facts/:name` (MCP `set_fact` adds routing keys). */
export const SetFactInputSchema = z
  .object({
    value: z
      .string()
      .describe(
        'The current value, as plain text: 1–120 characters, one line, none of [ ] < > * _ ~ ` | \\ { }. Put units and qualifiers inside it when they change together, e.g. "500 MB" or "v2.4.1". On a blog in more than one language, keep words out of it ("500 MB", not "500 MB per user"): it shows the same in every language.',
      ),
    note: z
      .string()
      .max(200)
      .nullable()
      .describe(
        'Private note on where the value comes from, up to 200 characters. Not shown on pages. null clears it; omitted keeps it.',
      )
      .optional(),
    source_url: z
      .url({ protocol: /^https$/ })
      .max(500)
      .nullable()
      .describe(
        'https URL the value was checked against. Not shown on pages. null clears it; omitted keeps it.',
      )
      .optional(),
    confirmed_at: z
      .string()
      .describe(
        'When you actually checked the value: an ISO 8601 date ("2026-10-21") or date-time with a time zone ("2026-10-21T09:30:00Z"). Not in the future, not before 2000. Defaults to now, so only omit it when you checked just now.',
      )
      .optional(),
    expected_value: z
      .string()
      .nullable()
      .describe(
        'Compare-and-set: the value you believe is current (null: you believe the fact does not exist yet). If it differs, nothing changes and the call fails with FACT_CONFLICT carrying the current value.',
      )
      .optional(),
    dry_run: z
      .boolean()
      .describe(
        'true writes nothing and returns every post and line the change would affect. Without it the change goes live on every post that uses the fact immediately.',
      )
      .optional(),
  })
  .strict()
export type SetFactInput = z.input<typeof SetFactInputSchema>

const COLUMNS = 'name, value, note, source_url, confirmed_at, updated_at'

function readFacts(store: Store, blogId: string): Fact[] {
  return store.db
    .prepare(`SELECT ${COLUMNS} FROM facts WHERE blog_id = ? ORDER BY name`)
    .all(blogId) as Fact[]
}

function readFact(store: Store, blogId: string, name: string): Fact | undefined {
  return store.db
    .prepare(`SELECT ${COLUMNS} FROM facts WHERE blog_id = ? AND name = ?`)
    .get(blogId, name) as Fact | undefined
}

/**
 * The blog's facts as rendering needs them, keyed by name.
 *
 * @internal
 */
export function loadBlogFacts(store: Store, blogId: string): Map<string, FactRecord> {
  return new Map(
    readFacts(store, blogId).map((f) => [
      f.name,
      { value: f.value, confirmedAt: f.confirmed_at, updatedAt: f.updated_at },
    ]),
  )
}

/**
 * Names of the blog's facts, for checking a post write.
 *
 * @internal
 */
export function blogFactNames(store: Store, blogId: string): Set<string> {
  const rows = store.db.prepare('SELECT name FROM facts WHERE blog_id = ?').all(blogId) as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

interface PostUses {
  slug: string
  title: string
  status: 'draft' | 'published'
  body: string
  names: Set<string>
}

/**
 * Every post of the blog, drafts included, with the facts its body uses.
 * Found by scanning bodies (the one scanner) rather than kept in a table:
 * a blog has at most a few hundred posts, and a derived list can't drift.
 */
function postUses(store: Store, blogId: string): PostUses[] {
  const rows = store.db
    .prepare('SELECT slug, title, status, body FROM posts WHERE blog_id = ? ORDER BY rowid')
    .all(blogId) as Omit<PostUses, 'names'>[]
  return rows.map((r) => ({ ...r, names: new Set(factNames(r.body)) }))
}

function usedBy(uses: readonly PostUses[], name: string): FactUse[] {
  return uses.filter((u) => u.names.has(name)).map((u) => ({ slug: u.slug, status: u.status }))
}

function isPending(store: Store, blogId: string): boolean {
  return (
    store.db.prepare('SELECT 1 FROM fact_renders_pending WHERE blog_id = ?').get(blogId) !==
    undefined
  )
}

/**
 * Re-render everything that shows a fact: every post page (fact-using
 * pages, and the "More from this blog" blurbs on the others that quote
 * them), the home pages (excerpts), the `.md` twin of each fact-using
 * post, and the manifests (feeds, sitemap, llms.txt). Nothing to do when
 * no published post uses a fact.
 *
 * Ordering: each render reads the facts and writes its files with no
 * await in between, and Node runs one request at a time between awaits,
 * so a render can't interleave with another request's: an older value
 * can never land on disk after a newer one. Keep this path synchronous.
 */
function renderFactPages(store: Store, renderer: MutationRenderer, blogId: string): number {
  const factPosts = listPublishedPostsForBlog(store, blogId).filter(
    (p) => factNames(p.body).length > 0,
  )
  if (factPosts.length === 0) return 0
  renderer.renderBlogPosts(blogId)
  renderer.renderBlog(blogId)
  for (const post of factPosts) renderer.renderPostMarkdown(blogId, post)
  renderer.renderManifests(blogId)
  return factPosts.length
}

/**
 * Finish the blog's pending fact render, if it has one, and clear it.
 * Returns how many fact-using published posts were re-rendered (0 when
 * nothing was pending). A failed render stays pending and surfaces as
 * FACT_RENDER_PENDING; the original error goes to the console.
 *
 * @internal Called first by every facts call and every post write.
 */
export function drainFactRender(store: Store, renderer: MutationRenderer, blogId: string): number {
  if (!isPending(store, blogId)) return 0
  let rerendered: number
  try {
    rerendered = renderFactPages(store, renderer, blogId)
  } catch (e) {
    console.error(`[slopit] re-rendering blog ${blogId} after a fact change failed:`, e)
    throw new SlopItError(
      'FACT_RENDER_PENDING',
      "The fact change is saved, but re-rendering the blog's pages failed, so some still show the previous value. Retry the same call (or any facts call) to finish it",
      { blog_id: blogId },
    )
  }
  store.db.prepare('DELETE FROM fact_renders_pending WHERE blog_id = ?').run(blogId)
  return rerendered
}

/** For reads: try the pending render, and report (not throw) if it is still pending. */
function drainForRead(store: Store, renderer: MutationRenderer, blogId: string): void {
  try {
    drainFactRender(store, renderer, blogId)
  } catch (e) {
    // Logged by drainFactRender; the read returns render_pending: true.
    if (!(e instanceof SlopItError && e.code === 'FACT_RENDER_PENDING')) throw e
  }
}

/**
 * Finish every blog's pending fact render, e.g. once at boot after a
 * crash. `rendererFor` is the same per-blog renderer factory the API and
 * MCP server use. One blog failing doesn't stop the rest; failures are
 * logged and listed, and stay pending for the next call to retry.
 */
export function drainPendingFactRenders(
  store: Store,
  rendererFor: (blog: Blog) => MutationRenderer,
): { drained: string[]; failed: string[] } {
  const ids = store.db
    .prepare('SELECT blog_id FROM fact_renders_pending ORDER BY since')
    .all()
    .map((r) => (r as { blog_id: string }).blog_id)
  const drained: string[] = []
  const failed: string[] = []
  for (const id of ids) {
    try {
      drainFactRender(store, rendererFor(getBlogInternal(store, id)), id)
      drained.push(id)
    } catch (e) {
      if (!(e instanceof SlopItError && e.code === 'FACT_RENDER_PENDING')) {
        console.error(`[slopit] pending fact render for blog ${id} failed:`, e)
      }
      failed.push(id)
    }
  }
  return { drained, failed }
}

/** All of the blog's facts, each with the posts that use it. */
export function listFacts(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
): { facts: FactWithUses[]; render_pending: boolean } {
  getBlogInternal(store, blogId)
  drainForRead(store, renderer, blogId)
  const uses = postUses(store, blogId)
  return {
    facts: readFacts(store, blogId).map((f) => ({ ...f, used_by: usedBy(uses, f.name) })),
    render_pending: isPending(store, blogId),
  }
}

function notFound(name: string): SlopItError {
  return new SlopItError(
    'FACT_NOT_FOUND',
    `The blog has no fact "${name}". list_facts (GET /blogs/:id/facts) shows the ones it has`,
    { name },
  )
}

/** One fact with the posts that use it, and whether pages are behind. Throws FACT_NOT_FOUND. */
export function getFact(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  name: string,
): { fact: FactWithUses; render_pending: boolean } {
  getBlogInternal(store, blogId)
  drainForRead(store, renderer, blogId)
  const fact = readFact(store, blogId, name)
  if (fact === undefined) throw notFound(name)
  return {
    fact: { ...fact, used_by: usedBy(postUses(store, blogId), name) },
    render_pending: isPending(store, blogId),
  }
}

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/
const SKEW_MS = 5 * 60_000

function parseConfirmedAt(raw: string | undefined, now: number): string {
  if (raw === undefined) return new Date(now).toISOString()
  const ms = ISO_DATE.test(raw) ? Date.parse(raw) : NaN
  const fail = (why: string) =>
    new SlopItError('FACT_CONFIRMED_AT_INVALID', `confirmed_at ${why}`, { confirmed_at: raw })
  if (Number.isNaN(ms)) {
    throw fail(
      'must be an ISO 8601 date ("2026-10-21") or date-time with a time zone ("2026-10-21T09:30:00Z")',
    )
  }
  if (ms > now + SKEW_MS) throw fail('is in the future: send when you actually checked the value')
  if (ms < Date.UTC(2000, 0, 1)) throw fail('is before 2000')
  return new Date(ms).toISOString()
}

/**
 * Create or change a fact. A new value moves `updated_at` (and with it the
 * modified time of every post that uses the fact); the same value only
 * moves `confirmed_at`. Either way every page that shows facts is
 * re-rendered in this call, so re-sending a value also repairs a render
 * that failed earlier. `dry_run` writes nothing at all.
 */
export function setFact(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  name: string,
  input: SetFactInput,
): SetFactResult {
  getBlogInternal(store, blogId)
  if (!FACT_NAME.test(name)) {
    throw new SlopItError(
      'FACT_NAME_INVALID',
      `"${name}" is not a fact name: use a lowercase letter, then up to 39 lowercase letters, digits or underscores, e.g. "pro_price"`,
      { name },
    )
  }
  const parsed = SetFactInputSchema.parse(input)
  const value = checkFactValue(parsed.value)
  const now = Date.now()
  const confirmedAt = parseConfirmedAt(parsed.confirmed_at, now)
  const prior = readFact(store, blogId, name)

  if (prior === undefined) {
    const { n } = store.db
      .prepare('SELECT COUNT(*) AS n FROM facts WHERE blog_id = ?')
      .get(blogId) as { n: number }
    if (n >= FACT_LIMIT) {
      throw new SlopItError(
        'FACT_LIMIT',
        `A blog can keep at most ${FACT_LIMIT} facts. Delete one that no post uses first`,
        { limit: FACT_LIMIT },
      )
    }
  }

  const uses = postUses(store, blogId)
  const fanout = uses.filter((u) => u.status === 'published' && u.names.size > 0).length
  if (fanout > FACT_FANOUT_LIMIT) {
    throw new SlopItError(
      'FACT_FANOUT',
      `${fanout} published posts use facts; a fact change re-renders all of them and the limit is ${FACT_FANOUT_LIMIT}. Nothing changed`,
      { posts: fanout, limit: FACT_FANOUT_LIMIT },
    )
  }

  // A real write first finishes a render an earlier change left pending,
  // so retrying a compare-and-set whose render failed repairs the pages
  // even though its expected_value is now stale. The caps above still
  // reject before anything is written; a dry run never drains.
  if (parsed.dry_run !== true) drainFactRender(store, renderer, blogId)

  if (parsed.expected_value !== undefined) {
    const current = prior?.value ?? null
    const expected = parsed.expected_value === null ? null : parsed.expected_value.trim()
    if (expected !== current) {
      throw new SlopItError(
        'FACT_CONFLICT',
        `"${name}" is ${current === null ? 'not set' : `"${current}"`}, not what expected_value says. Nothing changed: look at the current value and decide again`,
        { name, current_value: current },
      )
    }
  }

  const changed = prior === undefined || prior.value !== value
  const nowIso = new Date(now).toISOString()
  const fact: Fact = {
    name,
    value,
    note: parsed.note !== undefined ? parsed.note : (prior?.note ?? null),
    source_url: parsed.source_url !== undefined ? parsed.source_url : (prior?.source_url ?? null),
    confirmed_at: confirmedAt,
    updated_at: prior !== undefined && !changed ? prior.updated_at : nowIso,
  }

  const current = new Map(readFacts(store, blogId).map((f) => [f.name, f.value]))
  const next = new Map(current).set(name, value)
  const affected: AffectedPost[] = uses
    .filter((u) => u.names.has(name))
    .map((u) => ({
      slug: u.slug,
      title: u.title,
      status: u.status,
      ...(u.status === 'published' ? { url: renderer.baseUrl + u.slug + '/' } : {}),
      lines: factLines(u.body, name, current, next),
    }))
  const result = (rerendered: number, dryRun: boolean): SetFactResult => ({
    fact: { ...fact, used_by: affected.map((a) => ({ slug: a.slug, status: a.status })) },
    changed,
    dry_run: dryRun,
    affected_posts: affected,
    rerendered,
  })
  if (parsed.dry_run === true) return result(0, true)

  store.db.transaction(() => {
    store.db
      .prepare(
        `INSERT INTO facts (blog_id, name, value, note, source_url, confirmed_at, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (blog_id, name) DO UPDATE SET
           value = excluded.value, note = excluded.note, source_url = excluded.source_url,
           confirmed_at = excluded.confirmed_at, updated_at = excluded.updated_at`,
      )
      .run(blogId, name, value, fact.note, fact.source_url, confirmedAt, fact.updated_at, nowIso)
    // `since` keeps the time the blog first became pending.
    store.db
      .prepare(
        'INSERT INTO fact_renders_pending (blog_id, since) VALUES (?, ?) ON CONFLICT (blog_id) DO NOTHING',
      )
      .run(blogId, nowIso)
  })()

  return result(drainFactRender(store, renderer, blogId), false)
}

/**
 * Delete a fact no post uses. A fact any post's body uses (drafts too) is
 * FACT_IN_USE, naming the posts: change them first.
 */
export function deleteFact(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  name: string,
): { deleted: true } {
  getBlogInternal(store, blogId)
  drainFactRender(store, renderer, blogId)
  if (readFact(store, blogId, name) === undefined) throw notFound(name)
  const posts = usedBy(postUses(store, blogId), name).map((u) => u.slug)
  if (posts.length > 0) {
    throw new SlopItError(
      'FACT_IN_USE',
      `{{fact:${name}}} is used by ${posts.join(', ')}. Edit those posts to stop using it (write the figure as plain text), then delete the fact`,
      { name, posts },
    )
  }
  store.db.prepare('DELETE FROM facts WHERE blog_id = ? AND name = ?').run(blogId, name)
  return { deleted: true }
}
