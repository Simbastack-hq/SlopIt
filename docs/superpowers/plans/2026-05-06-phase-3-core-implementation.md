# Phase 3-core Implementation Plan — `updateBlog` surface + `analytics` field + `postprocessHtml` hook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the entire `updateBlog` surface in core (function + `PATCH /blogs/:id` route + `update_blog` MCP tool) and use it to add a new `analytics` field on `Blog`. Add a `postprocessHtml` hook to `RendererConfig` that platform's analytics-injection wrapper will use in Phase 3c. Pure core change — no platform code.

**Architecture:** Mirrors `updatePost`'s shape exactly: Zod-validated `BlogPatchSchema`, transactional UPDATE with reverse-update compensation, narrow merge of patched fields onto prior row. `analytics_json` is a single nullable TEXT column on `blogs` (Phase 3 design row #8 — single JSON-shaped column, no sibling table). Re-render trigger: when `analytics` changes, re-render every published post in the blog so injected `<script>` tags land on disk. `postprocessHtml` is an optional config field on `RendererConfig`, invoked inside `renderPost` and `renderBlog` between render-to-string and `writeFileAtomic` — identity-default keeps self-hosted compatibility.

**Tech Stack:** TypeScript (strict), Node.js, Vitest, Zod, better-sqlite3 (existing migration system), Hono (existing API), `@modelcontextprotocol/sdk` (existing MCP). No new deps.

**Spec:** [docs/specs/2026-05-01-analytics-three-layers-design.md](https://github.com/Simbastack-hq/slopit-platform/blob/main/docs/specs/2026-05-01-analytics-three-layers-design.md) — Phase 3-core scope table. Read the "Renderer integration" section before Task 4; it explains why the hook shape is what it is.

**Branch:** `feat/blog-analytics-update-surface` (from `dev`).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/db/migrations/006_blog_analytics.sql` | Create | `ALTER TABLE blogs ADD COLUMN analytics_json TEXT`. |
| `src/schema/index.ts` | Modify | Add `BlogAnalyticsSchema` (Umami/Plausible/GA), extend `BlogSchema` with optional `analytics`, add `BlogPatchSchema`. |
| `src/blogs.ts` | Modify | `getBlog`/`getBlogInternal` deserialize `analytics_json`. New `updateBlog(store, renderer, blogId, patch): Blog`. Re-render trigger on `analytics` change. |
| `src/rendering/generator.ts` | Modify | Add `postprocessHtml?: (html, blogId) => string` to `RendererConfig`. Invoke in `renderPost` and `renderBlog` before `writeFileAtomic`. |
| `src/api/routes.ts` | Modify | `PATCH /blogs/:id` route — auth + body parse + call `updateBlog`. |
| `src/mcp/tools.ts` | Modify | `update_blog` MCP tool — same shape. |
| `src/skill.ts` | Modify | Document `PATCH /blogs/:id`, `update_blog` tool, and `Blog.analytics` field. |
| `tests/blogs.test.ts` | Modify | Round-trip tests for `updateBlog`: schema validation, analytics field set/clear, re-render trigger fires. |
| `tests/api/blogs.test.ts` | Modify (or Create) | `PATCH /blogs/:id` happy path + auth failure mode. |
| `tests/mcp/blogs.test.ts` | Modify (or Create) | `update_blog` MCP tool. |
| `tests/rendering.test.ts` | Modify | Tests for `postprocessHtml`: hook is invoked with right args; absent hook = identity; hook output lands on disk. |
| `tests/skill.test.ts` | Modify | Drift assertions for the new endpoint + tool + analytics field. |
| `docs/solutions/blog-analytics-and-postprocess-hook.md` | Create | Capture: why a single JSONB column, why a render-time hook vs read-time middleware, the re-render-on-analytics-change pattern. |

---

## Task 0: Database migration

**Files:**
- Create: `src/db/migrations/006_blog_analytics.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 006_blog_analytics.sql
-- Phase 3c — adds a single nullable JSON column on blogs for per-blog
-- analytics configuration. NULL = no third-party analytics. Object =
-- { umami?: {...}, plausible?: {...}, googleAnalytics?: {...} }, validated
-- by BlogAnalyticsSchema at the boundary. Single column instead of a
-- sibling table (Phase 3 design row #8) — schema is small enough that
-- migration churn outweighs normalization benefit.

ALTER TABLE blogs ADD COLUMN analytics_json TEXT;
```

- [ ] **Step 2: Verify migration runs**

Run: `pnpm test tests/db/store.test.ts` (or equivalent migration-runner test if present).
Expected: PASS. The migration runner picks up `006_blog_analytics.sql` and applies it idempotently.

Cross-check: open a fresh test DB, run all migrations, then `PRAGMA table_info(blogs)` shows `analytics_json` with type `TEXT` and `notnull=0`.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/006_blog_analytics.sql
git commit -m "feat(db): add analytics_json column to blogs (Phase 3 migration)"
```

---

## Task 1: BlogAnalyticsSchema + extended Blog/BlogPatch schemas

**Files:**
- Modify: `src/schema/index.ts`
- Modify: `tests/schema.test.ts` (or extend an existing block)

- [ ] **Step 1: Write the failing tests**

Append to the schema test file:

```ts
import { BlogAnalyticsSchema, BlogPatchSchema, BlogSchema } from '../src/schema/index.js'

describe('BlogAnalyticsSchema', () => {
  it('accepts a Umami-only config', () => {
    const parsed = BlogAnalyticsSchema.parse({
      umami: { scriptUrl: 'https://analytics.example.com/script.js', siteId: 'abc-123' },
    })
    expect(parsed?.umami?.siteId).toBe('abc-123')
  })

  it('accepts a Plausible-only config', () => {
    const parsed = BlogAnalyticsSchema.parse({
      plausible: { scriptUrl: 'https://plausible.io/js/script.js', domain: 'example.com' },
    })
    expect(parsed?.plausible?.domain).toBe('example.com')
  })

  it('accepts a Google Analytics config with G- prefix measurement id', () => {
    const parsed = BlogAnalyticsSchema.parse({ googleAnalytics: { measurementId: 'G-ABC123XYZ' } })
    expect(parsed?.googleAnalytics?.measurementId).toBe('G-ABC123XYZ')
  })

  it('accepts multiple providers in one config', () => {
    const parsed = BlogAnalyticsSchema.parse({
      umami: { scriptUrl: 'https://u.example/s.js', siteId: 'u' },
      plausible: { scriptUrl: 'https://p.example/s.js', domain: 'p.example' },
    })
    expect(parsed?.umami?.siteId).toBe('u')
    expect(parsed?.plausible?.domain).toBe('p.example')
  })

  it('rejects unknown provider keys (strict)', () => {
    expect(() =>
      BlogAnalyticsSchema.parse({ fathom: { scriptUrl: 'x', siteId: 'y' } }),
    ).toThrow()
  })

  it('rejects malformed measurement id', () => {
    expect(() =>
      BlogAnalyticsSchema.parse({ googleAnalytics: { measurementId: 'UA-123' } }),
    ).toThrow()
  })

  it('rejects non-https script URLs (must validate as URL)', () => {
    expect(() =>
      BlogAnalyticsSchema.parse({ umami: { scriptUrl: 'not-a-url', siteId: 'x' } }),
    ).toThrow()
  })

  it('accepts undefined (no analytics configured)', () => {
    expect(BlogAnalyticsSchema.parse(undefined)).toBeUndefined()
  })
})

describe('BlogSchema with analytics', () => {
  it('parses a blog with analytics set', () => {
    const blog = BlogSchema.parse({
      id: 'b1',
      name: 'x',
      theme: 'minimal',
      createdAt: '2026-05-06T00:00:00Z',
      analytics: { umami: { scriptUrl: 'https://u/s.js', siteId: 's' } },
    })
    expect(blog.analytics?.umami).toBeDefined()
  })

  it('parses a blog without analytics (backwards-compat)', () => {
    const blog = BlogSchema.parse({
      id: 'b1',
      name: 'x',
      theme: 'minimal',
      createdAt: '2026-05-06T00:00:00Z',
    })
    expect(blog.analytics).toBeUndefined()
  })
})

describe('BlogPatchSchema', () => {
  it('accepts an analytics patch', () => {
    const parsed = BlogPatchSchema.parse({
      analytics: { plausible: { scriptUrl: 'https://p/s.js', domain: 'd' } },
    })
    expect(parsed.analytics?.plausible?.domain).toBe('d')
  })

  it('accepts an explicit null to clear analytics', () => {
    const parsed = BlogPatchSchema.parse({ analytics: null })
    expect(parsed.analytics).toBeNull()
  })

  it('accepts an empty patch (no-op)', () => {
    const parsed = BlogPatchSchema.parse({})
    expect(Object.keys(parsed)).toHaveLength(0)
  })

  it('rejects unknown patch fields (strict)', () => {
    expect(() => BlogPatchSchema.parse({ theme: 'minimal', extra: 1 })).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test tests/schema.test.ts`
Expected: FAIL — `BlogAnalyticsSchema` and `BlogPatchSchema` not exported.

- [ ] **Step 3: Implement**

In `src/schema/index.ts`, add the analytics schema and patch schema, and extend `BlogSchema`:

```ts
// Phase 3c — bring-your-own analytics. Each provider is its own
// optional sub-object so a single blog can configure multiple (e.g.
// Umami for live ops + GA for marketing reporting). NULL on the blog
// row means "no analytics configured".
export const BlogAnalyticsSchema = z
  .object({
    umami: z
      .object({
        scriptUrl: z.url(),
        siteId: z.string().min(1).max(100),
      })
      .strict()
      .optional(),
    plausible: z
      .object({
        scriptUrl: z.url(),
        domain: z.string().min(1).max(253),
      })
      .strict()
      .optional(),
    googleAnalytics: z
      .object({
        measurementId: z.string().regex(/^G-[A-Z0-9]+$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional()

export type BlogAnalytics = z.infer<typeof BlogAnalyticsSchema>

// Extend the existing BlogSchema. analytics is optional and nullable —
// null in the DB serializes to undefined on read; explicit null in a
// PATCH body clears the column.
export const BlogSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  theme: z.enum(['minimal']),
  createdAt: z.string(),
  analytics: BlogAnalyticsSchema, // optional
})
export type Blog = z.infer<typeof BlogSchema>

// Patch schema for updateBlog. Only the fields that v1 allows mutation
// on: analytics. Theme is immutable in v1 (no theme switcher UI), name
// changes go through a separate flow (TBD), id is permanent. Strict
// rejects unknown keys at the boundary.
//
// `analytics: null` is the documented way to clear analytics; the
// PATCH body distinguishes "omit analytics from patch" (no-op) vs
// "set analytics to null" (clear column) via Object.keys(parsed) in
// updateBlog, same pattern as PostPatchSchema.
export const BlogPatchSchema = z
  .object({
    analytics: BlogAnalyticsSchema.unwrap().nullable().optional(),
  })
  .strict()
export type BlogPatchInput = z.input<typeof BlogPatchSchema>
```

Note: the existing `BlogSchema` definition is replaced, not appended. Other callers (`createBlog`, `getBlog`, etc.) work unchanged because `analytics` is optional.

- [ ] **Step 4: Verify pass**

Run: `pnpm test tests/schema.test.ts`
Expected: PASS — all new tests; existing schema tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/schema/index.ts tests/schema.test.ts
git commit -m "feat(schema): add BlogAnalyticsSchema and BlogPatchSchema"
```

---

## Task 2: `getBlog` deserializes `analytics_json`

**Files:**
- Modify: `src/blogs.ts`
- Modify: `tests/blogs.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/blogs.test.ts`:

```ts
import { BlogAnalyticsSchema } from '../src/schema/index.js'

describe('getBlog with analytics_json', () => {
  it('returns analytics: undefined when column is NULL', () => {
    const { blog } = createBlog(store, { name: 'noan' })
    const fetched = getBlog(store, blog.id)
    expect(fetched.analytics).toBeUndefined()
  })

  it('returns the parsed analytics object when column is set', () => {
    const { blog } = createBlog(store, { name: 'wian' })
    // Direct insert to simulate post-migration state
    store.db
      .prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?')
      .run(
        JSON.stringify({ umami: { scriptUrl: 'https://u/s.js', siteId: 's-1' } }),
        blog.id,
      )
    const fetched = getBlog(store, blog.id)
    expect(fetched.analytics?.umami?.siteId).toBe('s-1')
  })

  it('throws on corrupted analytics_json (fail loud)', () => {
    const { blog } = createBlog(store, { name: 'bad' })
    store.db
      .prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?')
      .run('{not valid json', blog.id)
    expect(() => getBlog(store, blog.id)).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test tests/blogs.test.ts -t "with analytics_json"`
Expected: FAIL — current `getBlog` doesn't select or parse `analytics_json`.

- [ ] **Step 3: Implement**

In `src/blogs.ts`, update both query sites (`getBlogByName` and `getBlogInternal`) and add a small parser helper at the top of the file:

```ts
import { BlogAnalyticsSchema, type BlogAnalytics } from './schema/index.js'

// Deserialize the analytics_json column. NULL → undefined; valid JSON
// runs through BlogAnalyticsSchema (rejects unknown providers and
// malformed shapes). A row that fails parse is a corrupted DB write,
// not user input — fail loud rather than silently returning undefined.
function parseAnalytics(json: string | null): BlogAnalytics | undefined {
  if (json === null) return undefined
  const raw = JSON.parse(json) as unknown
  return BlogAnalyticsSchema.parse(raw)
}
```

Update both query helpers to SELECT `analytics_json` and return `analytics`:

```ts
// getBlogByName
const row = store.db
  .prepare('SELECT id, name, theme, created_at, analytics_json FROM blogs WHERE name = ?')
  .get(name) as
  | {
      id: string
      name: string
      theme: 'minimal'
      created_at: string
      analytics_json: string | null
    }
  | undefined

if (row === undefined) return null

return {
  id: row.id,
  name: row.name,
  theme: row.theme,
  createdAt: row.created_at,
  analytics: parseAnalytics(row.analytics_json),
}
```

Same for `getBlogInternal`: add `analytics_json` to the SELECT list and the destructured type, then include `analytics: parseAnalytics(row.analytics_json)` in the return.

`getBlog` calls `getBlogInternal` and inherits the change for free.

- [ ] **Step 4: Verify pass**

Run: `pnpm test tests/blogs.test.ts`
Expected: PASS — three new tests; existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/blogs.ts tests/blogs.test.ts
git commit -m "feat(blogs): deserialize analytics_json on getBlog"
```

---

## Task 3: `postprocessHtml` hook on `RendererConfig`

**Files:**
- Modify: `src/rendering/generator.ts`
- Modify: `tests/rendering.test.ts`

This task lands the hook itself. The wiring into `updateBlog`'s re-render trigger comes in Task 4.

- [ ] **Step 1: Write the failing tests**

Append to `tests/rendering.test.ts` inside the existing `describe('createRenderer — renderPost', ...)` block:

```ts
it('invokes postprocessHtml with the rendered HTML and blog id, writes the return value', () => {
  const { blog } = createBlog(store, { name: 'pp' })
  const calls: Array<{ html: string; blogId: string }> = []
  const renderer = createRenderer({
    store,
    outputDir,
    baseUrl: 'https://b.example.com',
    postprocessHtml: (html, blogId) => {
      calls.push({ html, blogId })
      return html.replace('</head>', '<script>injected</script>\n</head>')
    },
  })
  renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 'pp', title: 'PP' }))

  expect(calls).toHaveLength(1)
  expect(calls[0].blogId).toBe(blog.id)
  expect(calls[0].html).toContain('<title>PP — pp</title>')

  const html = readFileSync(join(outputDir, blog.id, 'pp', 'index.html'), 'utf8')
  expect(html).toContain('<script>injected</script>')
  expect(html).toContain('</head>')
})

it('uses identity (no transform) when postprocessHtml is absent', () => {
  const { blog } = createBlog(store, { name: 'noid' })
  const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
  renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 'noid' }))

  const html = readFileSync(join(outputDir, blog.id, 'noid', 'index.html'), 'utf8')
  // No injection happened
  expect(html).not.toContain('<script>injected</script>')
  // Existing render still works end-to-end
  expect(html).toContain('<link rel="canonical"')
})

it('invokes postprocessHtml from renderBlog as well as renderPost', () => {
  const { blog } = createBlog(store, { name: 'ppb' })
  let count = 0
  const renderer = createRenderer({
    store,
    outputDir,
    baseUrl: 'https://b.example.com',
    postprocessHtml: (html) => {
      count++
      return html
    },
  })
  renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 'one' }))
  renderer.renderBlog(blog.id)

  // 1 for the post HTML, 1 for the blog index. (.md / feed.xml /
  // sitemap.xml / llms.txt are NOT HTML and do NOT pass through the
  // hook — explicitly asserted below.)
  expect(count).toBe(2)
})

it('does NOT invoke postprocessHtml for .md / feed.xml / sitemap.xml / llms.txt', () => {
  const { blog } = createBlog(store, { name: 'ppm' })
  const seen: string[] = []
  const renderer = createRenderer({
    store,
    outputDir,
    baseUrl: 'https://b.example.com',
    postprocessHtml: (html) => {
      seen.push(html.slice(0, 30))
      return html
    },
  })
  renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 'mdtest' }))

  // Exactly one call (the per-post HTML). No call for the .md sibling
  // or any of the per-blog manifests.
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatch(/^<!doctype html/i)

  // And the .md / manifests themselves never contain anything that
  // resembles a postprocess transform marker.
  const md = readFileSync(join(outputDir, blog.id, 'mdtest.md'), 'utf8')
  expect(md.startsWith('---')).toBe(true) // frontmatter, not HTML
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test tests/rendering.test.ts -t postprocessHtml`
Expected: FAIL — config field doesn't exist; tests fail at type level (TS) or runtime.

- [ ] **Step 3: Implement**

In `src/rendering/generator.ts`:

1. Extend `RendererConfig`:

```ts
export interface RendererConfig {
  store: Store
  outputDir: string
  baseUrl: string
  /**
   * Optional post-processor that receives fully-rendered HTML and
   * returns transformed HTML before it's written to disk. Called from
   * `renderPost` (per-post HTML) and `renderBlog` (per-blog index HTML).
   * NOT called for non-HTML outputs (.md, llms.txt, feed.xml, sitemap.xml).
   *
   * `blogId` is passed so the caller can look up per-blog config like
   * `blog.analytics` without re-resolving it. Identity is the default.
   *
   * Platform uses this to inject analytics `<script>` tags into <head>
   * (Phase 3c). Self-hosted callers pass nothing and get unchanged behavior.
   */
  postprocessHtml?: (html: string, blogId: string) => string
}
```

2. Inside `createRenderer`, derive a single `apply` helper near the top:

```ts
const applyPostprocess = (html: string, blogId: string): string =>
  config.postprocessHtml ? config.postprocessHtml(html, blogId) : html
```

3. In `renderPost`, replace the existing `writeFileAtomic(join(postDir, 'index.html'), html)` with:

```ts
writeFileAtomic(join(postDir, 'index.html'), applyPostprocess(html, blogId))
```

4. In `renderBlog`, same change:

```ts
writeFileAtomic(join(blogDir, 'index.html'), applyPostprocess(html, blogId))
```

Important: do NOT route `renderPostMarkdown` (`.md`), `renderManifests` (`llms.txt`/`feed.xml`/`sitemap.xml`) through `applyPostprocess`. Those aren't HTML — a `</head>`-replace transform would silently misfire on them. Tests in Step 1 explicitly verify they're untouched.

- [ ] **Step 4: Verify pass**

Run: `pnpm test tests/rendering.test.ts`
Expected: PASS — all four new tests plus every existing test.

- [ ] **Step 5: Commit**

```bash
git add src/rendering/generator.ts tests/rendering.test.ts
git commit -m "feat(rendering): add postprocessHtml hook on RendererConfig"
```

---

## Task 4: `updateBlog` function with re-render trigger

**Files:**
- Modify: `src/blogs.ts`
- Modify: `tests/blogs.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/blogs.test.ts`:

```ts
import { updateBlog } from '../src/blogs.js'

describe('updateBlog', () => {
  // Reuse the existing fixture pattern: store + renderer + a blog with one published post.

  it('sets analytics from null when patch.analytics is provided', () => {
    const { blog } = createBlog(store, { name: 'setan' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })

    const updated = updateBlog(store, renderer, blog.id, {
      analytics: { umami: { scriptUrl: 'https://u/s.js', siteId: 's' } },
    })

    expect(updated.analytics?.umami?.siteId).toBe('s')
    // Round-trip via getBlog confirms persistence
    expect(getBlog(store, blog.id).analytics?.umami?.siteId).toBe('s')
  })

  it('clears analytics when patch.analytics is null', () => {
    const { blog } = createBlog(store, { name: 'clear' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    store.db
      .prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?')
      .run(JSON.stringify({ umami: { scriptUrl: 'https://u/s.js', siteId: 's' } }), blog.id)

    const updated = updateBlog(store, renderer, blog.id, { analytics: null })
    expect(updated.analytics).toBeUndefined()
    expect(getBlog(store, blog.id).analytics).toBeUndefined()
  })

  it('no-op on empty patch returns the prior blog unchanged', () => {
    const { blog } = createBlog(store, { name: 'noop' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })

    const updated = updateBlog(store, renderer, blog.id, {})
    expect(updated.analytics).toBeUndefined()
  })

  it('throws BLOG_NOT_FOUND on unknown blog id', () => {
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    expect(() => updateBlog(store, renderer, 'no-such-blog', { analytics: null })).toThrow()
  })

  it('rejects unknown patch fields via Zod strict()', () => {
    const { blog } = createBlog(store, { name: 'strict' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    // @ts-expect-error — testing runtime rejection of unknown keys
    expect(() => updateBlog(store, renderer, blog.id, { theme: 'minimal' })).toThrow()
  })

  it('re-renders every published post when analytics changes', () => {
    const { blog } = createBlog(store, { name: 'rerend' })
    const calls: Array<{ html: string; blogId: string }> = []
    const renderer = createRenderer({
      store,
      outputDir,
      baseUrl: 'https://b.example.com',
      postprocessHtml: (html, blogId) => {
        calls.push({ html, blogId })
        return html.replace('</head>', '<!-- pp -->\n</head>')
      },
    })

    // Create two published posts (each invokes postprocessHtml once for the
    // post HTML, plus once for the blog index — but renderBlog isn't called
    // by createPost in this codebase; verify expectations against actual
    // implementation, adjust call counts as needed).
    createPost(store, renderer, blog.id, { title: 'A', slug: 'aa', body: 'body' })
    createPost(store, renderer, blog.id, { title: 'B', slug: 'bb', body: 'body' })
    const beforeCount = calls.length

    // Change analytics — trigger a re-render of every published post
    updateBlog(store, renderer, blog.id, {
      analytics: { plausible: { scriptUrl: 'https://p/s.js', domain: 'd' } },
    })

    // After the update, every published post has been re-rendered through
    // the new postprocessHtml. We assert calls.length increased by 2 (one
    // per post).
    expect(calls.length - beforeCount).toBeGreaterThanOrEqual(2)

    // And the rendered files on disk now carry the postprocess marker.
    const aaHtml = readFileSync(join(outputDir, blog.id, 'aa', 'index.html'), 'utf8')
    expect(aaHtml).toContain('<!-- pp -->')
  })

  it('does NOT re-render when the patch leaves analytics unchanged', () => {
    const { blog } = createBlog(store, { name: 'samean' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    createPost(store, renderer, blog.id, { title: 'A', slug: 'aa', body: 'body' })

    // Empty patch — no re-render
    let rendered = 0
    const spy = createRenderer({
      store,
      outputDir,
      baseUrl: 'https://b.example.com',
      postprocessHtml: () => {
        rendered++
        return ''
      },
    })
    // We can't introspect renderPost call count without a spy renderer;
    // simpler: empty patch returns immediately, no I/O. Verify by mtime
    // or by counting calls on the spy. Adapter test — implementer picks
    // whichever fits the existing test scaffolding.
    void spy
    void rendered
    expect(true).toBe(true) // placeholder; concrete assertion in implementation review
  })
})
```

(The last test is a sketch — the implementer adapts it to whatever spy/mock pattern the existing test suite uses. The invariant is: empty patch and same-analytics patch must NOT trigger re-render I/O.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test tests/blogs.test.ts -t updateBlog`
Expected: FAIL — `updateBlog` not exported.

- [ ] **Step 3: Implement**

Add to `src/blogs.ts`. Mirror `updatePost`'s shape closely:

```ts
import type { MutationRenderer } from './rendering/generator.js'
import { BlogPatchSchema, type BlogPatchInput } from './schema/index.js'
import { listPublishedPostsForBlog } from './posts.js'

/**
 * Patch fields on a blog row. v1 surface allows mutation only of
 * `analytics`. Theme/name/id remain immutable through this function.
 *
 * Side effects:
 *  - When `analytics` changes (set, cleared, or modified), every
 *    published post in the blog is re-rendered via `renderer.renderPost`
 *    so any postprocessHtml hook (Phase 3c's injection wrapper) sees
 *    the new value. renderBlog is also called once.
 *  - Empty patch and patches that leave `analytics` unchanged are no-ops:
 *    no DB write, no re-render.
 *
 * Compensation: same shape as updatePost. DB UPDATE runs first; on
 * render failure the prior `analytics_json` is restored via a reverse
 * UPDATE and the render error bubbles to the caller.
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
  const patchKeys = Object.keys(parsed)
  if (patchKeys.length === 0) return prior

  // Detect analytics-change semantics. Three cases:
  //   patch has no `analytics` key       → leave column untouched
  //   patch.analytics === null           → clear column to NULL
  //   patch.analytics is an object       → set column to JSON.stringify(value)
  const patchTouchesAnalytics = 'analytics' in parsed
  const newAnalyticsJson: string | null | undefined = patchTouchesAnalytics
    ? parsed.analytics === null
      ? null
      : JSON.stringify(parsed.analytics)
    : undefined // undefined sentinel means "don't change the column"

  // Same-value short-circuit: serialize prior.analytics and compare. If
  // the patch is functionally a no-op (e.g. setting analytics to the
  // same value it already has), skip the DB write and the re-render.
  if (patchTouchesAnalytics) {
    const priorJson = prior.analytics === undefined ? null : JSON.stringify(prior.analytics)
    if (newAnalyticsJson === priorJson) return prior
  }

  // Apply DB UPDATE for the fields the patch touches. Only `analytics`
  // is supported in v1, so this is straightforward.
  if (patchTouchesAnalytics) {
    store.db
      .prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?')
      .run(newAnalyticsJson === undefined ? null : newAnalyticsJson, blogId)
  }

  // Hydrate the updated row
  const updated = getBlogInternal(store, blogId)

  // Compensation: restore prior column values on render failure.
  const compensate = () => {
    const priorJson = prior.analytics === undefined ? null : JSON.stringify(prior.analytics)
    store.db.prepare('UPDATE blogs SET analytics_json = ? WHERE id = ?').run(priorJson, blogId)
  }

  // Re-render side effects. Currently only analytics changes warrant
  // a re-render (the postprocessHtml hook in Phase 3c reads
  // blog.analytics every time it runs, so existing rendered HTML
  // becomes stale the moment analytics changes).
  if (patchTouchesAnalytics) {
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
  }

  return updated
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm test tests/blogs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/blogs.ts tests/blogs.test.ts
git commit -m "feat(blogs): add updateBlog with analytics field and re-render trigger"
```

---

## Task 5: `PATCH /blogs/:id` REST route

**Files:**
- Modify: `src/api/routes.ts`
- Modify: `tests/api/blogs.test.ts` (create if absent)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, type Store } from '../../src/db/store.js'
import { createBlog, createApiKey } from '../../src/blogs.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createApiRouter } from '../../src/api/index.js'

describe('PATCH /blogs/:id', () => {
  let dir: string
  let store: Store
  let app: ReturnType<typeof createApiRouter>
  let blogId: string
  let apiKey: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-api-blogs-'))
    store = createStore({ dbPath: join(dir, 't.db') })
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const { blog } = createBlog(store, { name: 'apit' })
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('200 — sets analytics on the blog', async () => {
    const res = await app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analytics: { umami: { scriptUrl: 'https://u/s.js', siteId: 's' } },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { blog: { analytics?: { umami?: { siteId: string } } } }
    expect(body.blog.analytics?.umami?.siteId).toBe('s')
  })

  it('200 — clears analytics with explicit null', async () => {
    // First set, then clear
    await app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analytics: { plausible: { scriptUrl: 'https://p/s.js', domain: 'd' } },
      }),
    })
    const res = await app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ analytics: null }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { blog: { analytics?: unknown } }
    expect(body.blog.analytics).toBeUndefined()
  })

  it('401 — no Authorization header', async () => {
    const res = await app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analytics: null }),
    })
    expect(res.status).toBe(401)
  })

  it('403 — wrong blog id for the API key', async () => {
    const { blog: other } = createBlog(store, { name: 'other' })
    const res = await app.request(`/blogs/${other.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ analytics: null }),
    })
    expect(res.status).toBe(403)
  })

  it('400 — unknown field in body', async () => {
    const res = await app.request(`/blogs/${blogId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'minimal' }),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test tests/api/blogs.test.ts`
Expected: FAIL — `PATCH /blogs/:id` not registered.

- [ ] **Step 3: Implement**

In `src/api/routes.ts`, add the route. Place it after the `GET /blogs/:id` handler (around line 122 — find the existing block and insert below):

```ts
import { updateBlog } from '../blogs.js'
import type { BlogPatchInput } from '../schema/index.js'

// (inside createApiRouter, after the GET /blogs/:id handler)
app.patch('/blogs/:id', async (c) => {
  const renderer = config.rendererFor(c.var.blog)
  // updateBlog re-parses via BlogPatchSchema.strict(); cast is honest.
  const raw = (await readJsonBodyOptional(c)) as BlogPatchInput
  const blog = updateBlog(config.store, renderer, c.var.blog.id, raw)
  return c.json({ blog, _links: buildLinks(c.var.blog, config) })
})
```

The existing auth middleware on `/blogs/:id/*` covers this route automatically; verify by inspecting `app.use('/blogs/:id', ...)` order. If a different middleware boundary applies (e.g. auth is scoped to `/blogs/:id/posts` rather than `/blogs/:id`), wire auth into this route explicitly the same way the other authenticated routes do.

- [ ] **Step 4: Verify pass**

Run: `pnpm test tests/api/blogs.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes.ts tests/api/blogs.test.ts
git commit -m "feat(api): add PATCH /blogs/:id for analytics config"
```

---

## Task 6: `update_blog` MCP tool

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `tests/mcp/blogs.test.ts` (create if absent)

- [ ] **Step 1: Implement**

Mirror the existing `update_post` MCP tool registration (around line 77 of `src/mcp/tools.ts`). The tool accepts `{ blog_id, analytics }`, runs through `BlogPatchSchema`, and calls `updateBlog`.

```ts
// (paste alongside the other tool registrations)
server.registerTool(
  'update_blog',
  {
    title: 'Update blog config',
    description: 'Patch a blog. v1 surface allows setting/clearing analytics.',
    inputSchema: {
      type: 'object',
      properties: {
        blog_id: { type: 'string' },
        analytics: {
          oneOf: [{ type: 'null' }, BlogAnalyticsJsonSchema],
        },
      },
      required: ['blog_id'],
      additionalProperties: false,
    },
  },
  wrapTool('update_blog', async (args, { store, renderer }) => {
    const patch = BlogPatchSchema.parse({
      ...(args.analytics !== undefined ? { analytics: args.analytics } : {}),
    })
    const blog = updateBlog(store, renderer, args.blog_id, patch)
    return { structuredContent: { blog } }
  }),
)
```

`BlogAnalyticsJsonSchema` is `zodToJsonSchema(BlogAnalyticsSchema.unwrap())` if a converter is already in use, or hand-built if not. Match whatever convention the existing tools follow.

- [ ] **Step 2: Tests**

Mirror the shape of `tests/mcp/posts.test.ts` (or whichever file covers the existing post tools): one happy-path test for setting analytics, one for clearing, one for invalid args.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/blogs.test.ts
git commit -m "feat(mcp): add update_blog tool"
```

---

## Task 7: SKILL.md documentation + drift tests

**Files:**
- Modify: `src/skill.ts`
- Modify: `tests/skill.test.ts`

- [ ] **Step 1: Update SKILL.md content**

In `src/skill.ts`:

1. Add `PATCH ${baseUrl}/blogs/:id` to the Endpoints table after `GET /blogs/:id`.
2. Add `update_blog` to the MCP tools table.
3. Document the `analytics` field on `Blog`: brief paragraph in the Schema section about what providers are supported (Umami, Plausible, GA), how to set/clear via `PATCH`, and that it's opt-in (off by default).

- [ ] **Step 2: Update drift tests**

In `tests/skill.test.ts`:

```ts
it('lists PATCH /blogs/:id in the endpoints table', () => {
  expect(text).toContain('PATCH https://api.example/blogs/:id')
})

it('lists update_blog in the MCP tools table', () => {
  expect(text).toContain('update_blog')
})

it('documents the analytics field on Blog', () => {
  expect(text).toMatch(/analytics/i)
  expect(text).toMatch(/Umami|Plausible|Google Analytics/i)
})
```

The existing `SKILL.md endpoint parity with createApiRouter` test should pick up the new route automatically once it's mounted.

- [ ] **Step 3: Commit**

```bash
git add src/skill.ts tests/skill.test.ts
git commit -m "docs(skill): document PATCH /blogs/:id and update_blog tool"
```

---

## Task 8: Self-hosted Docker Compose smoke (CLAUDE.md non-negotiable)

CLAUDE.md mandates every core change must keep `docker compose up` working in `examples/self-hosted/`. The Phase 3-core changes are backwards-compatible:
- `analytics` is optional on `Blog`; existing creates omit it.
- `postprocessHtml` is optional on `RendererConfig`; self-hosted callers pass nothing.
- `PATCH /blogs/:id` adds a new route, doesn't change any existing one.
- `update_blog` adds a new MCP tool, doesn't change any existing one.

- [ ] **Step 1: Run the smoke check**

If Docker is available locally: `cd examples/self-hosted && docker compose up -d && curl -X POST http://localhost:8080/signup …`. Verify a post still publishes end-to-end.

If Docker isn't available: note the manual smoke in the PR description and rely on the existing core test suite (which exercises the full create/get/list/patch/delete cycle without Docker).

---

## Task 9: Capture learnings

**Files:**
- Create: `docs/solutions/blog-analytics-and-postprocess-hook.md`

```md
---
title: Blog analytics field and the render-postprocess hook
tags: [rendering, schema, analytics, open-core]
severity: p3
date: 2026-05-06
applies-to: [core, platform]
---

## Rule

Per-blog analytics config lives in a single nullable JSON column (`blogs.analytics_json`), validated by `BlogAnalyticsSchema` (Umami / Plausible / GA discriminated providers). Mutation goes through `updateBlog(store, renderer, blogId, patch)` which mirrors `updatePost`'s shape: Zod-validated patch, transactional UPDATE with reverse-update compensation, re-render trigger when the analytics column changes.

## Why one JSON column, not a sibling table

The schema is tiny (3 providers × ~2 fields each) and the access pattern is one-row-at-a-time (the renderer reads it during postprocessHtml). A sibling table would force JOIN-or-second-query overhead per render with zero schema-evolution benefit — adding a future provider is one Zod entry, no migration. Phase 3 design decision row #8.

## Why a render-time hook, not a serve-time middleware

SlopIt's architecture invariant: "Caddy serves static files; Node only runs at write time." A serve-time middleware would put Node on every HTML pageview's hot path. A build-time hook adds ~200 bytes per page to disk (negligible) and runs only at publish/update. Phase 3 design decision row #10.

## The hook contract

`postprocessHtml?: (html: string, blogId: string) => string` on `RendererConfig`. Called from `renderPost` (per-post HTML) and `renderBlog` (per-blog index HTML). NOT called for `.md`, `llms.txt`, `feed.xml`, `sitemap.xml` — those aren't HTML and shouldn't be touched by a `</head>`-replace transform. Identity default; self-hosted callers pass nothing and get unchanged behavior.

## Re-render on analytics change

When `updateBlog` writes a new `analytics_json` value, it iterates `listPublishedPostsForBlog` and calls `renderer.renderPost` for each one, then `renderer.renderBlog` once. Without this trigger, the rendered HTML on disk would still carry the old (or absent) analytics tags until the next user-initiated publish. The same-value short-circuit avoids unnecessary re-renders when the patch is functionally a no-op.

## Example / proof

- Schema: `src/schema/index.ts` (`BlogAnalyticsSchema`, `BlogPatchSchema`)
- Function: `src/blogs.ts` (`updateBlog`)
- Hook: `src/rendering/generator.ts` (`RendererConfig.postprocessHtml`)
- REST: `src/api/routes.ts` (`PATCH /blogs/:id`)
- MCP: `src/mcp/tools.ts` (`update_blog`)
- Tests: `tests/blogs.test.ts`, `tests/rendering.test.ts`, `tests/api/blogs.test.ts`, `tests/mcp/blogs.test.ts`
```

- [ ] **Step 2: Commit**

```bash
git add docs/solutions/blog-analytics-and-postprocess-hook.md
git commit -m "docs: capture analytics column + postprocessHtml hook patterns"
```

---

## Task 10: Final verification + PR

- [ ] **Step 1: Run full check**

Run: `pnpm check`
Expected: PASS — typecheck, lint, format, all tests.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin feat/blog-analytics-update-surface
gh pr create --base dev --title "feat: updateBlog surface + analytics field + postprocessHtml hook (Phase 3-core)"
```

PR body should:
1. Link to this plan, the Phase 3 spec (merged in slopit-platform), and the Phase 3 trio overall.
2. Note: backwards-compatible. Existing blogs return `analytics: undefined`. Self-hosted users pass no hook; behavior unchanged.
3. Flag that this PR is a dependency for Phase 3c (platform-side analytics-injection wrapper) which goes into `slopit-platform`.

---

## Self-review checklist

- [ ] Spec coverage: every Phase 3-core row in the design's files table (`src/db/migrations/...`, schema, blogs.ts, generator.ts, api/routes.ts, mcp/tools.ts, skill.ts) has at least one task.
- [ ] No "TBD" / "implement later" placeholders.
- [ ] Type names consistent (`BlogAnalytics`, `BlogPatchInput`, `RendererConfig.postprocessHtml`).
- [ ] Each test in the plan is concrete code, not a description.
- [ ] All file paths are exact (`src/blogs.ts`, `src/rendering/generator.ts`, etc., verified against `dev` HEAD after Phase 2 merge).
- [ ] No breaking change: `BlogSchema.analytics` is optional, `RendererConfig.postprocessHtml` is optional, new REST + MCP surfaces don't replace existing ones.
