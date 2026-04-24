# REST Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `@slopit/core` REST router on top of the `createPost` primitives — signup, read, publish, update, delete for posts; auth middleware; idempotency middleware; onboarding-block + SKILL.md generators; `_links` HATEOAS; `text/markdown` alternate body; `rendererFor(blog)` callback for per-blog URLs.

**Architecture:** New primitives (`updatePost`, `deletePost`, `getPost`, `listPosts`, `getBlog`, `verifyApiKey`) land in existing modules. REST infrastructure lives under `src/api/` as focused single-responsibility files (auth, idempotency, errors, links, markdown-body) wired by `createApiRouter`. Two pure generators (`generateOnboardingBlock`, `generateSkillFile`) produce agent-facing text. A new `idempotency_keys` SQLite table (migration `002`) supports the best-effort replay flow. Every handler threads the resolved `c.var.blog` through `config.rendererFor(blog)` so per-blog URLs compose with a shared router.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Hono ^4.12, better-sqlite3 ^12.9, Zod v4.3 (with `z.toJSONSchema`), `@modelcontextprotocol/sdk` (stub only this feature), Vitest ^3.0, Node.js ≥22, `node:crypto` for hashing.

---

## Spec

Authoritative design doc: [`docs/superpowers/specs/2026-04-23-rest-routes-mcp-design.md`](../specs/2026-04-23-rest-routes-mcp-design.md) v2.2 (decision #22).

> **Post-implementation correction — `/signup` idempotency withdrawn.** Review on the merged code surfaced a replay leak: with no caller identity pre-auth, two callers sharing an `Idempotency-Key` on `/signup` would both receive the first caller's `api_key`. The fix (decision #22 in the spec) skips storage and replay whenever `c.var.apiKeyHash` is empty. The inline code snippets below were written against the pre-fix contract — they still mention `/signup` in the idempotency `Applies to` list, the schema comment `-- '' for /signup (pre-auth)`, and the auth-middleware doc comment's "signup-bootstrap case". When reading those snippets as implementation guidance, treat the spec's decision #22 as authoritative; the shipped `src/api/idempotency.ts`, `src/db/migrations/002_idempotency.sql`, and `src/api/auth.ts` reflect the corrected contract.

## Pre-flight

Before starting:

- Working directory: `/Users/nj/Workspace/SlopIt/code/slopit`.
- Branch: `feat/rest-routes-mcp` (already created off `dev @ 8886a84`).
- Baseline: `pnpm typecheck` is clean; `pnpm test` shows **176 passed (176)**. Both must stay green after every task.
- Do NOT touch `src/mcp/server.ts` or its exports in `src/index.ts` — the throwing stub is preserved for this feature per decision #19 / v2.1 revision. MCP lands in `feat/mcp-tools`.
- Commands to know:
  - `pnpm test` — runs the full suite
  - `pnpm test tests/auth.test.ts` — runs one file (vitest passes positional args through)
  - `pnpm typecheck` — strict type check, no emit
  - Build verification is not required after each task; typecheck + tests cover it

## File Structure

| File | Purpose |
|---|---|
| `src/errors.ts` | MODIFY — add 4 new error codes to the union |
| `src/schema/index.ts` | MODIFY — export `PostPatchSchema` (partial + omit slug) |
| `src/db/migrations/002_idempotency.sql` | NEW — `idempotency_keys` table |
| `src/posts.ts` | MODIFY — `updatePost`, `deletePost`, `getPost`, `listPosts` |
| `src/blogs.ts` | MODIFY — public `getBlog` wrapper |
| `src/auth/api-key.ts` | MODIFY — `verifyApiKey(store, key)` |
| `src/onboarding.ts` | NEW — `generateOnboardingBlock` + `OnboardingInputs` type |
| `src/skill.ts` | NEW — `generateSkillFile` |
| `src/api/links.ts` | NEW — `buildLinks(blog, config)` |
| `src/api/errors.ts` | NEW — error→HTTP envelope middleware |
| `src/api/auth.ts` | NEW — API-key auth middleware |
| `src/api/idempotency.ts` | NEW — Idempotency-Key middleware |
| `src/api/markdown-body.ts` | NEW — `text/markdown` body + query-param parser |
| `src/api/routes.ts` | NEW — all REST route handlers |
| `src/api/index.ts` | MODIFY — `createApiRouter` factory (today: only `/health`) |
| `src/index.ts` | MODIFY — public barrel additions (MCP stub exports preserved) |

Tests colocate by module: one file per primitive group, one file per middleware, one file per route group under `tests/api/`.

## Testing strategy

- Every DB-touching test uses `mkdtempSync` for an isolated Store, closed + removed in `afterEach`. No shared state.
- REST tests use Hono's `app.request()` — no real server, no ports.
- Integration tests (cross-blog rendererFor leakage) use two distinct `tmpdir`s + two real `createRenderer` calls.
- New modules target ≥95% line + branch coverage. Verify via `pnpm test:coverage` at the end.
- When a task introduces a new file, write the test FIRST, run it to see the expected failure, THEN implement.

## Deviations from spec (minor)

1. **New `MutationRenderer` interface extends `Renderer`** (Task 5.4). The spec's Files table didn't list `src/rendering/generator.ts` as modified, but `updatePost` (pub→draft) and `deletePost` both need to delete post files. Solution: `Renderer` stays as-is (3 methods — unchanged public contract for `createPost`); a new `MutationRenderer extends Renderer` adds a **required** `removePostFiles(blogId, slug): void`. `updatePost` and `deletePost` take `MutationRenderer`; `ApiRouterConfig.rendererFor` returns `MutationRenderer`; shipped `createRenderer` returns `MutationRenderer`. This is type-safe (no compile without the method) AND backwards-compatible (existing `Renderer` consumers are untouched). Earlier rounds tried "required on Renderer" (breaking) and "optional on Renderer" (silent skip) — both rejected in review; `MutationRenderer` is the resolution.
2. **Task 3 adds a small `tests/idempotency-schema.test.ts`** (not called out in the spec's test list). It verifies the migration landed correctly before Task 13 depends on it.
3. **Task 2 uses `.strict()` on `PostPatchSchema`** to reject `slug` (and any other unknown keys) — the spec says "slug is immutable", `.strict()` is the cleanest Zod mechanism to enforce that at parse time.

## Plan-level precision beyond the spec

- **updatePost published→draft ordering** is `renderBlog` → `removePostFiles`. The spec states the invariant ("compensation must leave no durable change") but doesn't prescribe the sequence. This ordering is the only one that preserves the invariant: if `renderBlog` fails mid-transition, DB compensation rolls status back to 'published' and the post files still exist → consistent pre-call state. If file cleanup fails after a successful `renderBlog`, the orphan file is explicitly allowed by spec decision #20.

---

### Task 1: Add new error codes

**Files:**
- Modify: `src/errors.ts`
- Test: `tests/errors.test.ts` (existing — extend)

- [ ] **Step 1.1: Extend the errors test with the new codes**

Open `tests/errors.test.ts` and append this test inside the existing `describe('SlopItError', ...)` block (before its closing brace):

```ts
  it.each([
    'BLOG_NAME_CONFLICT',
    'BLOG_NOT_FOUND',
    'POST_SLUG_CONFLICT',
    'POST_NOT_FOUND',
    'UNAUTHORIZED',
    'IDEMPOTENCY_KEY_CONFLICT',
    'NOT_IMPLEMENTED',
  ] as const)('accepts code %s', (code) => {
    const e = new SlopItError(code, 'x')
    expect(e.code).toBe(code)
  })
```

- [ ] **Step 1.2: Run and see the typecheck fail**

```bash
pnpm typecheck
```

Expected: 4 errors naming `POST_NOT_FOUND`, `UNAUTHORIZED`, `IDEMPOTENCY_KEY_CONFLICT`, `NOT_IMPLEMENTED` as not assignable to `SlopItErrorCode`.

- [ ] **Step 1.3: Add the codes to the union**

In `src/errors.ts`, replace the `SlopItErrorCode` type with:

```ts
export type SlopItErrorCode =
  | 'BLOG_NAME_CONFLICT'
  | 'BLOG_NOT_FOUND'
  | 'POST_SLUG_CONFLICT'
  | 'POST_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'NOT_IMPLEMENTED'
```

- [ ] **Step 1.4: Verify**

```bash
pnpm typecheck && pnpm test tests/errors.test.ts
```

Expected: typecheck clean; test file passes.

- [ ] **Step 1.5: Commit**

```bash
git add src/errors.ts tests/errors.test.ts
git commit -m "Add 4 new SlopItErrorCode values for REST feature"
```

---

### Task 2: PostPatchSchema

**Files:**
- Modify: `src/schema/index.ts`
- Test: `tests/schema.test.ts` (NEW)

- [ ] **Step 2.1: Write failing tests**

Create `tests/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PostPatchSchema, type PostPatchInput } from '../src/schema/index.js'

describe('PostPatchSchema', () => {
  it('accepts an empty object (no-op patch)', () => {
    expect(() => PostPatchSchema.parse({})).not.toThrow()
  })

  it('accepts patching title only', () => {
    const parsed = PostPatchSchema.parse({ title: 'New title' })
    expect(parsed.title).toBe('New title')
  })

  it('accepts patching status and body', () => {
    const parsed = PostPatchSchema.parse({ status: 'draft', body: 'new body' })
    expect(parsed.status).toBe('draft')
    expect(parsed.body).toBe('new body')
  })

  it('rejects slug in the patch', () => {
    // Zod `.omit({ slug: true })` strips the field; passing it is a strict-mode failure
    // via superRefine-style check. We expect either strip or reject; spec mandates reject.
    const result = PostPatchSchema.safeParse({ slug: 'renamed' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid status values', () => {
    const result = PostPatchSchema.safeParse({ status: 'scheduled' })
    expect(result.success).toBe(false)
  })

  it('trims title whitespace', () => {
    const parsed = PostPatchSchema.parse({ title: '  hello  ' })
    expect(parsed.title).toBe('hello')
  })

  it('PostPatchInput type is compatible', () => {
    const patch: PostPatchInput = { title: 'x' }
    expect(patch.title).toBe('x')
  })
})
```

- [ ] **Step 2.2: Run and see it fail**

```bash
pnpm test tests/schema.test.ts
```

Expected: fails importing `PostPatchSchema` — not exported.

- [ ] **Step 2.3: Add the schema**

In `src/schema/index.ts`, find the existing `export const PostInputSchema = PostInputBaseSchema.superRefine(...)` block. After its closing line (`export type PostInput = z.input<typeof PostInputSchema>`), append:

```ts
// Patch schema for updatePost — all PostInput fields become optional,
// slug is explicitly rejected (use delete+recreate for URL changes; see
// spec decision #2). No superRefine needed: an empty patch is valid.
export const PostPatchSchema = PostInputBaseSchema
  .omit({ slug: true })
  .partial()
  .strict()
export type PostPatchInput = z.input<typeof PostPatchSchema>
```

Note: `.strict()` makes unknown keys (including `slug`) cause a parse failure, which is what the spec requires.

- [ ] **Step 2.4: Verify**

```bash
pnpm typecheck && pnpm test tests/schema.test.ts
```

Expected: typecheck clean; all 7 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add src/schema/index.ts tests/schema.test.ts
git commit -m "Add PostPatchSchema for updatePost — partial fields, slug rejected"
```

---

### Task 3: Migration 002 — idempotency_keys table

**Files:**
- Create: `src/db/migrations/002_idempotency.sql`
- Test: `tests/idempotency-schema.test.ts` (NEW)

- [ ] **Step 3.1: Write a failing schema-presence test**

Create `tests/idempotency-schema.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'

describe('idempotency_keys table', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-idem-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('exists with expected columns', () => {
    const cols = store.db
      .prepare("PRAGMA table_info('idempotency_keys')")
      .all() as { name: string; type: string; notnull: number }[]
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(byName.key).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.api_key_hash).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.method).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.path).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.request_hash).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.response_status).toMatchObject({ type: 'INTEGER', notnull: 1 })
    expect(byName.response_body).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.created_at).toMatchObject({ type: 'TEXT', notnull: 1 })
  })

  it('enforces composite primary key (key, api_key_hash, method, path)', () => {
    const insert = store.db.prepare(
      `INSERT INTO idempotency_keys (key, api_key_hash, method, path, request_hash, response_status, response_body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('k1', '', 'POST', '/signup', 'h1', 200, '{}')
    // Same PK → UNIQUE violation
    expect(() => insert.run('k1', '', 'POST', '/signup', 'h2', 200, '{}')).toThrow(
      /UNIQUE constraint failed/,
    )
    // Different path → OK
    expect(() => insert.run('k1', '', 'POST', '/other', 'h1', 200, '{}')).not.toThrow()
  })
})
```

- [ ] **Step 3.2: Run and see it fail**

```bash
pnpm test tests/idempotency-schema.test.ts
```

Expected: `PRAGMA table_info('idempotency_keys')` returns an empty array — `byName.key` is undefined.

- [ ] **Step 3.3: Create the migration**

Create `src/db/migrations/002_idempotency.sql`:

```sql
-- Idempotency-Key replay records. Core migrations 001-099; this is 002.
-- Weakened guarantee per spec decision #20: rows are inserted AFTER the
-- handler commits, so a crash between commit and insert leaves a retry
-- window. Failure modes are documented; crash-safe variant is deferred.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL,                             -- '' for /signup (pre-auth)
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,                             -- exact path (with :id/:slug substituted)
  request_hash    TEXT NOT NULL,                             -- sha256 over method+path+content-type+sorted-qs+body
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,                             -- serialized JSON response
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (key, api_key_hash, method, path)
);
```

- [ ] **Step 3.4: Verify (also confirm migration picked up by createStore)**

```bash
pnpm test tests/idempotency-schema.test.ts
```

Expected: both tests pass.

Also sanity-check the 176 existing tests still pass:

```bash
pnpm test
```

Expected: all green.

- [ ] **Step 3.5: Commit**

```bash
git add src/db/migrations/002_idempotency.sql tests/idempotency-schema.test.ts
git commit -m "Migration 002: idempotency_keys table (composite PK)"
```

---

### Task 4: Read primitives — getBlog, getPost, listPosts

**Files:**
- Modify: `src/blogs.ts` (add public `getBlog`)
- Modify: `src/posts.ts` (add `getPost`, `listPosts`)
- Modify: `tests/blogs.test.ts` (extend)
- Modify: `tests/posts.test.ts` (extend)

- [ ] **Step 4.1: Write failing test for getBlog**

In `tests/blogs.test.ts`, append inside the top-level `describe` (or create a new one at the bottom):

```ts
describe('getBlog', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-getblog-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the blog for a known id', () => {
    const { blog } = createBlog(store, { name: 'my-blog' })
    const fetched = getBlog(store, blog.id)
    expect(fetched).toEqual(blog)
  })

  it('throws SlopItError(BLOG_NOT_FOUND) for an unknown id', () => {
    expect(() => getBlog(store, 'missing')).toThrow(
      expect.objectContaining({ code: 'BLOG_NOT_FOUND', details: { blogId: 'missing' } }),
    )
  })
})
```

At the top of `tests/blogs.test.ts`, add `getBlog` to the blogs import and confirm `mkdtempSync`, `rmSync`, `tmpdir`, `join`, `createStore`, `Store` are already imported (they are).

- [ ] **Step 4.2: Run and see it fail**

```bash
pnpm test tests/blogs.test.ts
```

Expected: fails importing `getBlog` — not exported.

- [ ] **Step 4.3: Add getBlog public wrapper**

At the bottom of `src/blogs.ts`, add:

```ts
/**
 * Public, stable read API. Thin wrapper around getBlogInternal so the
 * internal helper (used by the renderer) stays unexported and consumers
 * have a clear entry point.
 */
export function getBlog(store: Store, blogId: string): Blog {
  return getBlogInternal(store, blogId)
}
```

- [ ] **Step 4.4: Run getBlog tests**

```bash
pnpm test tests/blogs.test.ts
```

Expected: all tests pass.

- [ ] **Step 4.5: Write failing tests for getPost**

In `tests/posts.test.ts`, append a new describe block (add `getPost`, `listPosts` to the posts imports first):

```ts
describe('getPost', () => {
  let dir: string
  let store: Store
  let renderer: ReturnType<typeof createRenderer>
  let blogId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-getpost-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.example' })
    blogId = createBlog(store, { name: 'test-blog' }).blog.id
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns a post by blog+slug', () => {
    const { post } = createPost(store, renderer, blogId, { title: 'Hello', body: 'body' })
    const fetched = getPost(store, blogId, post.slug)
    expect(fetched.id).toBe(post.id)
    expect(fetched.title).toBe('Hello')
  })

  it('throws POST_NOT_FOUND for an unknown slug', () => {
    expect(() => getPost(store, blogId, 'missing')).toThrow(
      expect.objectContaining({ code: 'POST_NOT_FOUND', details: { blogId, slug: 'missing' } }),
    )
  })

  it('throws POST_NOT_FOUND when slug exists in another blog only', () => {
    const other = createBlog(store, { name: 'other-blog' }).blog
    createPost(store, renderer, other.id, { title: 'Elsewhere', body: 'b', slug: 'shared' })
    expect(() => getPost(store, blogId, 'shared')).toThrow(
      expect.objectContaining({ code: 'POST_NOT_FOUND' }),
    )
  })
})

describe('listPosts', () => {
  let dir: string
  let store: Store
  let renderer: ReturnType<typeof createRenderer>
  let blogId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-listposts-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.example' })
    blogId = createBlog(store, { name: 'test-blog' }).blog.id
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('default returns published only, newest first', () => {
    createPost(store, renderer, blogId, { title: 'First', body: 'b', slug: 'first', status: 'draft' })
    createPost(store, renderer, blogId, { title: 'Second', body: 'b', slug: 'second' })
    createPost(store, renderer, blogId, { title: 'Third', body: 'b', slug: 'third' })
    const posts = listPosts(store, blogId)
    expect(posts.map((p) => p.slug)).toEqual(['third', 'second'])
  })

  it('status=draft returns drafts only', () => {
    createPost(store, renderer, blogId, { title: 'D1', body: 'b', slug: 'd1', status: 'draft' })
    createPost(store, renderer, blogId, { title: 'P1', body: 'b', slug: 'p1' })
    const posts = listPosts(store, blogId, { status: 'draft' })
    expect(posts.map((p) => p.slug)).toEqual(['d1'])
  })

  it('returns empty array for a blog with no matching posts', () => {
    expect(listPosts(store, blogId)).toEqual([])
    expect(listPosts(store, blogId, { status: 'draft' })).toEqual([])
  })

  it('does not leak other blogs\' posts', () => {
    const other = createBlog(store, { name: 'other' }).blog
    createPost(store, renderer, other.id, { title: 'Other', body: 'b', slug: 'other-post' })
    expect(listPosts(store, blogId)).toEqual([])
  })
})
```

- [ ] **Step 4.6: Run and see failures**

```bash
pnpm test tests/posts.test.ts
```

Expected: import failures — `getPost`, `listPosts` not exported.

- [ ] **Step 4.7: Add getPost and listPosts**

In `src/posts.ts`, after `listPublishedPostsForBlog` (and before `createPost`), add:

```ts
/**
 * Public read: fetch a single post by (blogId, slug). Drafts are
 * included (unlike listPublishedPostsForBlog). Throws POST_NOT_FOUND.
 */
export function getPost(store: Store, blogId: string, slug: string): Post {
  const row = store.db
    .prepare(
      `SELECT id, blog_id, slug, title, body, excerpt, tags, status,
              seo_title, seo_description, author, cover_image,
              published_at, created_at, updated_at
         FROM posts WHERE blog_id = ? AND slug = ?`,
    )
    .get(blogId, slug) as {
      id: string
      blog_id: string
      slug: string
      title: string
      body: string
      excerpt: string | null
      tags: string
      status: 'draft' | 'published'
      seo_title: string | null
      seo_description: string | null
      author: string | null
      cover_image: string | null
      published_at: string | null
      created_at: string
      updated_at: string
    } | undefined

  if (!row) {
    throw new SlopItError(
      'POST_NOT_FOUND',
      `Post "${slug}" does not exist in blog "${blogId}"`,
      { blogId, slug },
    )
  }

  return {
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
  }
}

/**
 * Public read: list posts in a blog, optionally filtered by status.
 * Default (no status filter) returns published only, newest first.
 * status='draft' returns drafts, newest-first by created_at.
 */
export function listPosts(
  store: Store,
  blogId: string,
  opts?: { status?: 'draft' | 'published' },
): Post[] {
  const status = opts?.status ?? 'published'
  const orderBy = status === 'published' ? 'published_at DESC' : 'created_at DESC'

  const rows = store.db
    .prepare(
      `SELECT id, blog_id, slug, title, body, excerpt, tags, status,
              seo_title, seo_description, author, cover_image,
              published_at, created_at, updated_at
         FROM posts
        WHERE blog_id = ? AND status = ?
        ORDER BY ${orderBy}`,
    )
    .all(blogId, status) as {
      id: string; blog_id: string; slug: string; title: string; body: string
      excerpt: string | null; tags: string; status: 'draft' | 'published'
      seo_title: string | null; seo_description: string | null
      author: string | null; cover_image: string | null
      published_at: string | null; created_at: string; updated_at: string
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
```

- [ ] **Step 4.8: Verify**

```bash
pnpm typecheck && pnpm test
```

Expected: clean; all tests (old + new) pass.

- [ ] **Step 4.9: Commit**

```bash
git add src/blogs.ts src/posts.ts tests/blogs.test.ts tests/posts.test.ts
git commit -m "Add public read primitives: getBlog, getPost, listPosts"
```

---

### Task 5: updatePost primitive

**Files:**
- Modify: `src/posts.ts`
- Modify: `tests/posts.test.ts`

- [ ] **Step 5.1: Write failing tests covering the render matrix**

In `tests/posts.test.ts`, add `updatePost` to the posts imports, then append:

```ts
describe('updatePost', () => {
  let dir: string
  let store: Store
  let renderer: ReturnType<typeof createRenderer>
  let outDir: string
  let blogId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-update-'))
    outDir = join(dir, 'out')
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderer = createRenderer({ store, outputDir: outDir, baseUrl: 'https://b.example' })
    blogId = createBlog(store, { name: 'upd-blog' }).blog.id
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('draft→draft: DB changes only, no files written', () => {
    const { post } = createPost(store, renderer, blogId, { title: 'T1', body: 'b', status: 'draft' })
    const postFile = join(outDir, blogId, post.slug, 'index.html')
    expect(existsSync(postFile)).toBe(false)
    const updated = updatePost(store, renderer, blogId, post.slug, { title: 'T2' })
    expect(updated.post.title).toBe('T2')
    expect(updated.postUrl).toBeUndefined()
    expect(existsSync(postFile)).toBe(false)
  })

  it('draft→published: writes post + index, sets published_at', () => {
    const { post } = createPost(store, renderer, blogId, { title: 'Hi', body: 'b', status: 'draft' })
    expect(post.publishedAt).toBeNull()
    const updated = updatePost(store, renderer, blogId, post.slug, { status: 'published' })
    expect(updated.post.status).toBe('published')
    expect(updated.post.publishedAt).not.toBeNull()
    expect(updated.postUrl).toBe('https://b.example/' + post.slug + '/')
    expect(existsSync(join(outDir, blogId, post.slug, 'index.html'))).toBe(true)
    expect(existsSync(join(outDir, blogId, 'index.html'))).toBe(true)
  })

  it('published→published: preserves published_at, updates updated_at', async () => {
    const { post } = createPost(store, renderer, blogId, { title: 'P', body: 'b' })
    const originalPublishedAt = post.publishedAt
    // small wait so updated_at can differ
    await new Promise((r) => setTimeout(r, 10))
    const updated = updatePost(store, renderer, blogId, post.slug, { title: 'P (edited)' })
    expect(updated.post.publishedAt).toBe(originalPublishedAt)
    expect(updated.post.updatedAt).not.toBe(post.updatedAt)
    expect(updated.post.title).toBe('P (edited)')
  })

  it('published→draft: clears published_at, deletes post files, re-renders index', () => {
    const { post } = createPost(store, renderer, blogId, { title: 'P', body: 'b' })
    const postDir = join(outDir, blogId, post.slug)
    const indexFile = join(outDir, blogId, 'index.html')
    expect(existsSync(join(postDir, 'index.html'))).toBe(true)
    const updated = updatePost(store, renderer, blogId, post.slug, { status: 'draft' })
    expect(updated.post.status).toBe('draft')
    expect(updated.post.publishedAt).toBeNull()
    expect(updated.postUrl).toBeUndefined()
    expect(existsSync(postDir)).toBe(false)
    expect(readFileSync(indexFile, 'utf8')).not.toContain(post.slug)
  })

  it('empty patch is a no-op (no render, returns current post)', () => {
    const { post } = createPost(store, renderer, blogId, { title: 'P', body: 'b' })
    const indexBefore = readFileSync(join(outDir, blogId, 'index.html'), 'utf8')
    const updated = updatePost(store, renderer, blogId, post.slug, {})
    expect(updated.post.title).toBe(post.title)
    expect(updated.post.updatedAt).toBe(post.updatedAt)
    const indexAfter = readFileSync(join(outDir, blogId, 'index.html'), 'utf8')
    expect(indexAfter).toBe(indexBefore)
  })

  it('rejects slug in the patch (ZodError)', () => {
    const { post } = createPost(store, renderer, blogId, { title: 'P', body: 'b' })
    expect(() => updatePost(store, renderer, blogId, post.slug, { slug: 'renamed' } as never)).toThrow()
  })

  it('throws POST_NOT_FOUND for unknown slug', () => {
    expect(() => updatePost(store, renderer, blogId, 'ghost', { title: 'x' })).toThrow(
      expect.objectContaining({ code: 'POST_NOT_FOUND' }),
    )
  })

  it('compensates on render failure (reverts UPDATE, bubbles error)', () => {
    const { post } = createPost(store, renderer, blogId, { title: 'Orig', body: 'b' })
    const spy = vi.spyOn(renderer, 'renderPost').mockImplementation(() => {
      throw new Error('synthetic render failure')
    })
    expect(() => updatePost(store, renderer, blogId, post.slug, { title: 'New' })).toThrow(
      'synthetic render failure',
    )
    spy.mockRestore()
    const row = getPost(store, blogId, post.slug)
    expect(row.title).toBe('Orig') // reverted
  })
})
```

- [ ] **Step 5.2: Run and see failures**

```bash
pnpm test tests/posts.test.ts
```

Expected: `updatePost` not exported; all new tests fail.

- [ ] **Step 5.3: Implement updatePost**

In `src/posts.ts`, add this import at the top near other schema imports:

```ts
import { PostPatchSchema, type PostPatchInput } from './schema/index.js'
```

Then add at the bottom of `src/posts.ts`:

```ts
/**
 * Patch-update an existing post. Slug is immutable (enforced at the Zod
 * boundary via PostPatchSchema.strict()). Render side effects follow
 * the matrix in the spec (decision #2, #21):
 *
 *   draft→draft      : DB only
 *   draft→published  : write files + index; set published_at=now
 *   published→published : re-render files + index; keep published_at, bump updated_at
 *   published→draft  : delete files; re-render index; clear published_at
 *
 * Compensation mirrors createPost: on render failure the prior row is
 * restored via a reverse UPDATE and the original render error bubbles.
 * See spec's weakened invariant.
 */
export function updatePost(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  slug: string,
  patch: PostPatchInput,
): { post: Post; postUrl?: string } {
  const parsed = PostPatchSchema.parse(patch)

  // Ensure blog exists (throws BLOG_NOT_FOUND)
  getBlogInternal(store, blogId)

  // Load prior row — throws POST_NOT_FOUND if missing
  const prior = getPost(store, blogId, slug)

  // Empty patch → no-op fast path
  const patchKeys = Object.keys(parsed)
  if (patchKeys.length === 0) {
    return prior.status === 'published'
      ? { post: prior, postUrl: renderer.baseUrl + '/' + prior.slug + '/' }
      : { post: prior }
  }

  // Merge patched fields into prior row
  const merged = {
    title: parsed.title ?? prior.title,
    body: parsed.body ?? prior.body,
    excerpt: 'excerpt' in parsed ? parsed.excerpt : prior.excerpt,
    tags: parsed.tags ?? prior.tags,
    status: parsed.status ?? prior.status,
    seoTitle: 'seoTitle' in parsed ? parsed.seoTitle : prior.seoTitle,
    seoDescription: 'seoDescription' in parsed ? parsed.seoDescription : prior.seoDescription,
    author: 'author' in parsed ? parsed.author : prior.author,
    coverImage: 'coverImage' in parsed ? parsed.coverImage : prior.coverImage,
  }

  // Determine published_at by transition (decision #21 preserves on pub→pub)
  const oldStatus = prior.status
  const newStatus = merged.status
  let publishedAt: string | null
  if (oldStatus === 'draft' && newStatus === 'published') {
    publishedAt = new Date().toISOString()
  } else if (oldStatus === 'published' && newStatus === 'draft') {
    publishedAt = null
  } else {
    publishedAt = prior.publishedAt
  }

  // Apply DB UPDATE (updated_at bumps automatically? No — set explicitly)
  const nowIso = new Date().toISOString()
  const tagsJson = JSON.stringify(merged.tags)
  store.db
    .prepare(
      `UPDATE posts
          SET title = ?, body = ?, excerpt = ?, tags = ?, status = ?,
              seo_title = ?, seo_description = ?, author = ?, cover_image = ?,
              published_at = ?, updated_at = ?
        WHERE blog_id = ? AND slug = ?`,
    )
    .run(
      merged.title,
      merged.body,
      merged.excerpt ?? null,
      tagsJson,
      merged.status,
      merged.seoTitle ?? null,
      merged.seoDescription ?? null,
      merged.author ?? null,
      merged.coverImage ?? null,
      publishedAt,
      nowIso,
      blogId,
      slug,
    )

  // Hydrate the updated row
  const updated = getPost(store, blogId, slug)

  // Render side effects per matrix, with compensation
  const compensate = () => {
    // Reverse UPDATE back to prior state
    store.db
      .prepare(
        `UPDATE posts
            SET title = ?, body = ?, excerpt = ?, tags = ?, status = ?,
                seo_title = ?, seo_description = ?, author = ?, cover_image = ?,
                published_at = ?, updated_at = ?
          WHERE blog_id = ? AND slug = ?`,
      )
      .run(
        prior.title,
        prior.body,
        prior.excerpt ?? null,
        JSON.stringify(prior.tags),
        prior.status,
        prior.seoTitle ?? null,
        prior.seoDescription ?? null,
        prior.author ?? null,
        prior.coverImage ?? null,
        prior.publishedAt,
        prior.updatedAt,
        blogId,
        slug,
      )
  }

  try {
    if (oldStatus === 'draft' && newStatus === 'draft') {
      // no file ops
    } else if (newStatus === 'published') {
      renderer.renderPost(blogId, updated)
      renderer.renderBlog(blogId)
    } else if (oldStatus === 'published' && newStatus === 'draft') {
      // IMPORTANT ordering (P1 fix): renderBlog FIRST. It reads the DB
      // where status is now 'draft', so the post is excluded from the
      // index. Then delete the post files. If renderBlog fails, the
      // catch compensates (DB back to 'published') and files still
      // exist → consistent pre-call state. If file deletion fails after
      // a successful renderBlog, the orphan file is tolerable per spec
      // (it 404s on the direct URL but isn't in the index).
      renderer.renderBlog(blogId)
      renderer.removePostFiles(blogId, slug)
    }
  } catch (renderErr) {
    try { compensate() } catch { /* best-effort; weakened invariant */ }
    throw renderErr
  }

  return newStatus === 'published'
    ? { post: updated, postUrl: renderer.baseUrl + '/' + updated.slug + '/' }
    : { post: updated }
}
```

The `renderer.removePostFiles(blogId, slug)` call is a **required** method on `MutationRenderer` — the narrower type `updatePost` takes (see Step 5.4). TypeScript enforces at compile time that any renderer threaded into a mutation primitive provides file cleanup. No optional chaining. No silent skip.

- [ ] **Step 5.4: Add `MutationRenderer` — a narrower interface for mutation primitives**

`Renderer` stays as-is (three methods: `baseUrl`, `renderPost`, `renderBlog`) — unchanged public contract for `createPost`. `MutationRenderer extends Renderer` adds `removePostFiles` as a **required** method. `createRenderer` returns `MutationRenderer`. `updatePost` and `deletePost` take `MutationRenderer`. This is type-safe (no compile without the method) AND backwards-compatible (Renderer consumers are untouched).

Open `src/rendering/generator.ts`. Near the top, the existing `Renderer` interface stays unchanged:

```ts
export interface Renderer {
  readonly baseUrl: string
  renderPost(blogId: string, post: Post): void
  renderBlog(blogId: string): void
}
```

Add, directly below it:

```ts
/**
 * Renderer contract for the mutation primitives (updatePost, deletePost).
 * Extends Renderer with the file-cleanup hook they require to preserve
 * the spec's success invariant (rendered files match post-call state).
 * Shipped `createRenderer` returns MutationRenderer. Consumers who
 * implement a custom Renderer (e.g., object-storage instead of disk)
 * must extend it to MutationRenderer before passing to update/delete.
 */
export interface MutationRenderer extends Renderer {
  /**
   * Remove the post directory for (blogId, slug). ENOENT-tolerant —
   * a missing directory is the desired end state and should not throw.
   * Hard I/O failures (EACCES, EIO) SHOULD throw so callers can apply
   * compensation.
   */
  removePostFiles(blogId: string, slug: string): void
}
```

Change the `createRenderer` factory's return type. Locate:

```ts
export function createRenderer(config: RendererConfig): Renderer {
```

Change to:

```ts
export function createRenderer(config: RendererConfig): MutationRenderer {
```

Locate the `return { baseUrl, renderPost, renderBlog }` block at the end of the factory and extend it:

```ts
  return {
    baseUrl: config.baseUrl,
    renderPost(blogId, post) { /* existing */ },
    renderBlog(blogId) { /* existing */ },
    removePostFiles(blogId, slug) {
      rmSync(join(config.outputDir, blogId, slug), { recursive: true, force: true })
    },
  }
```

Add `rmSync` to the existing `node:fs` import at the top of the file if not already present. `rmSync` with `{ recursive: true, force: true }` is ENOENT-tolerant by design — a missing directory succeeds silently.

- [ ] **Step 5.5: Update `updatePost` signature to use `MutationRenderer`**

In `src/posts.ts`, update the import near the top that brings in the renderer type:

```ts
import type { Renderer, MutationRenderer } from './rendering/generator.js'
```

Change the `updatePost` function signature in the code written in Step 5.3:

```ts
export function updatePost(
  store: Store,
  renderer: MutationRenderer,     // ← changed from Renderer
  blogId: string,
  slug: string,
  patch: PostPatchInput,
): { post: Post; postUrl?: string }
```

The body is unchanged — the `renderer.removePostFiles(blogId, slug)` call in the pub→draft branch (no optional chaining) is already correct under the stricter type.

Verify: no stray `rmSync`/`join` imports in `src/posts.ts` from the earlier coercion. (Step 5.3 never introduced them in the final form — this is a sanity check.)

- [ ] **Step 5.6: Verify**

```bash
pnpm typecheck && pnpm test tests/posts.test.ts
```

Expected: typecheck clean; all updatePost tests pass along with pre-existing ones.

- [ ] **Step 5.7: Commit**

```bash
git add src/posts.ts src/rendering/generator.ts tests/posts.test.ts
git commit -m "Add updatePost with full render matrix + compensation"
```

---

### Task 6: deletePost primitive

**Files:**
- Modify: `src/posts.ts`
- Modify: `tests/posts.test.ts`

- [ ] **Step 6.1: Write failing tests**

In `tests/posts.test.ts`, add `deletePost` to the posts imports and append:

```ts
describe('deletePost', () => {
  let dir: string
  let store: Store
  let renderer: ReturnType<typeof createRenderer>
  let outDir: string
  let blogId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-delete-'))
    outDir = join(dir, 'out')
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderer = createRenderer({ store, outputDir: outDir, baseUrl: 'https://b.example' })
    blogId = createBlog(store, { name: 'del-blog' }).blog.id
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes published post row + files; index omits it; returns {deleted:true}', () => {
    const { post } = createPost(store, renderer, blogId, { title: 'Gone', body: 'b' })
    const postDir = join(outDir, blogId, post.slug)
    const indexFile = join(outDir, blogId, 'index.html')
    expect(existsSync(postDir)).toBe(true)

    const result = deletePost(store, renderer, blogId, post.slug)
    expect(result).toEqual({ deleted: true })

    expect(() => getPost(store, blogId, post.slug)).toThrow(/POST_NOT_FOUND/)
    expect(existsSync(postDir)).toBe(false)
    expect(readFileSync(indexFile, 'utf8')).not.toContain(post.slug)
  })

  it('deletes draft post: row gone, no files to clean up', () => {
    const { post } = createPost(store, renderer, blogId, { title: 'Draft', body: 'b', status: 'draft' })
    const result = deletePost(store, renderer, blogId, post.slug)
    expect(result).toEqual({ deleted: true })
    expect(() => getPost(store, blogId, post.slug)).toThrow(/POST_NOT_FOUND/)
  })

  it('throws POST_NOT_FOUND for unknown slug', () => {
    expect(() => deletePost(store, renderer, blogId, 'ghost')).toThrow(
      expect.objectContaining({ code: 'POST_NOT_FOUND' }),
    )
  })

  it('throws BLOG_NOT_FOUND for unknown blog', () => {
    expect(() => deletePost(store, renderer, 'nope', 'x')).toThrow(
      expect.objectContaining({ code: 'BLOG_NOT_FOUND' }),
    )
  })

  it('on render failure: row still deleted, original error bubbles', () => {
    const { post } = createPost(store, renderer, blogId, { title: 'T', body: 'b' })
    const spy = vi.spyOn(renderer, 'renderBlog').mockImplementation(() => {
      throw new Error('synthetic renderBlog failure')
    })
    expect(() => deletePost(store, renderer, blogId, post.slug)).toThrow('synthetic renderBlog failure')
    spy.mockRestore()
    // Weakened invariant: row is gone; stale index possible but re-render clears it
    expect(() => getPost(store, blogId, post.slug)).toThrow(/POST_NOT_FOUND/)
  })
})
```

- [ ] **Step 6.2: Run and see failures**

```bash
pnpm test tests/posts.test.ts
```

Expected: `deletePost` not exported.

- [ ] **Step 6.3: Implement deletePost**

Append to `src/posts.ts`:

```ts
/**
 * Hard-delete a post (spec decision #3). DB-first, then render side
 * effects. Weakened invariant: on render failure the row is gone and
 * the blog index may be momentarily stale until the next successful
 * publish/delete re-renders it. File cleanup is ENOENT-tolerant.
 */
export function deletePost(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  slug: string,
): { deleted: true } {
  getBlogInternal(store, blogId)     // throws BLOG_NOT_FOUND
  const prior = getPost(store, blogId, slug)  // throws POST_NOT_FOUND

  // DB transaction: DELETE the row
  const tx = store.db.transaction(() => {
    store.db.prepare('DELETE FROM posts WHERE blog_id = ? AND slug = ?').run(blogId, slug)
  })
  tx()

  // After commit: re-render index (if post was published) + remove files.
  // `MutationRenderer` requires removePostFiles at the type level — no
  // optional chaining, no silent skip. Shipped createRenderer implements
  // it; custom renderers that reach this primitive must provide it too.
  if (prior.status === 'published') {
    renderer.renderBlog(blogId)
  }
  renderer.removePostFiles(blogId, slug)

  return { deleted: true }
}
```

- [ ] **Step 6.4: Verify**

```bash
pnpm typecheck && pnpm test tests/posts.test.ts
```

Expected: clean; all deletePost tests pass.

- [ ] **Step 6.5: Commit**

```bash
git add src/posts.ts tests/posts.test.ts
git commit -m "Add deletePost — hard delete with index re-render"
```

---

### Task 7: verifyApiKey helper

**Files:**
- Modify: `src/auth/api-key.ts`
- Create: `tests/auth.test.ts`

- [ ] **Step 7.1: Write failing tests**

Create `tests/auth.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog, createApiKey } from '../src/blogs.js'
import { verifyApiKey } from '../src/auth/api-key.js'

describe('verifyApiKey', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-verifykey-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the blog for a valid key', () => {
    const { blog } = createBlog(store, { name: 'authblog' })
    const { apiKey } = createApiKey(store, blog.id)
    const result = verifyApiKey(store, apiKey)
    expect(result?.id).toBe(blog.id)
    expect(result?.name).toBe('authblog')
  })

  it('returns null for an unknown key', () => {
    expect(verifyApiKey(store, 'sk_slop_doesnotexist')).toBeNull()
  })

  it('returns null for a malformed key', () => {
    expect(verifyApiKey(store, 'not-a-key')).toBeNull()
    expect(verifyApiKey(store, '')).toBeNull()
  })

  it('returns null for a key hash that exists but is for a deleted blog', () => {
    // FK ON DELETE CASCADE handles the row removal; this test just guards
    // against a regression where verifyApiKey returns a dangling blog.
    const { blog } = createBlog(store, { name: 'tmpblog' })
    const { apiKey } = createApiKey(store, blog.id)
    store.db.prepare('DELETE FROM blogs WHERE id = ?').run(blog.id)
    expect(verifyApiKey(store, apiKey)).toBeNull()
  })
})
```

- [ ] **Step 7.2: Run and see it fail**

```bash
pnpm test tests/auth.test.ts
```

Expected: fails — `verifyApiKey` not exported.

- [ ] **Step 7.3: Implement verifyApiKey**

At the bottom of `src/auth/api-key.ts`, add (and add the necessary imports):

```ts
import type { Store } from '../db/store.js'
import { getBlogInternal } from '../blogs.js'
import type { Blog } from '../schema/index.js'
import { SlopItError } from '../errors.js'

/**
 * Hash the provided key, look it up in api_keys, and return the
 * associated Blog. Returns null for any failure mode (unknown key,
 * malformed key, deleted blog). Never throws on an invalid key — the
 * middleware layer maps null to 401.
 */
export function verifyApiKey(store: Store, key: string): Blog | null {
  if (!isApiKey(key)) return null
  const hash = hashApiKey(key)
  const row = store.db
    .prepare('SELECT blog_id FROM api_keys WHERE key_hash = ?')
    .get(hash) as { blog_id: string } | undefined
  if (!row) return null
  try {
    return getBlogInternal(store, row.blog_id)
  } catch (e) {
    if (e instanceof SlopItError && e.code === 'BLOG_NOT_FOUND') return null
    throw e
  }
}
```

- [ ] **Step 7.4: Verify**

```bash
pnpm typecheck && pnpm test tests/auth.test.ts
```

Expected: clean; all four tests pass.

- [ ] **Step 7.5: Commit**

```bash
git add src/auth/api-key.ts tests/auth.test.ts
git commit -m "Add verifyApiKey: hash → api_keys → blog, null on any miss"
```

---

### Task 8: Onboarding block generator

**Files:**
- Create: `src/onboarding.ts`
- Create: `tests/onboarding.test.ts`

- [ ] **Step 8.1: Write failing structural tests**

Create `tests/onboarding.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { generateOnboardingBlock } from '../src/onboarding.js'
import type { Blog } from '../src/schema/index.js'

const blog: Blog = {
  id: 'blog_xyz',
  name: 'ai-thoughts',
  theme: 'minimal',
  createdAt: '2026-04-23T00:00:00Z',
}

describe('generateOnboardingBlock', () => {
  it('opens with an imperative and names the feature', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'sk_slop_test',
      blogUrl: 'https://ai-thoughts.slopit.io',
      baseUrl: 'https://api.slopit.io',
      schemaUrl: 'https://api.slopit.io/schema',
    })
    const firstLine = text.split('\n')[0]
    expect(firstLine).toMatch(/SlopIt blog/i)
    expect(firstLine).toMatch(/Publish.*first post.*verify/i)
  })

  it('includes blog URL, api key, and blog id on labeled lines', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'sk_slop_abc',
      blogUrl: 'https://ai-thoughts.slopit.io',
      baseUrl: 'https://api.slopit.io',
      schemaUrl: 'https://api.slopit.io/schema',
    })
    expect(text).toMatch(/Your blog:\s+https:\/\/ai-thoughts\.slopit\.io/)
    expect(text).toMatch(/API key:\s+sk_slop_abc/)
    expect(text).toMatch(/Blog id:\s+blog_xyz/)
  })

  it('always includes the HTTP curl/request block', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'sk_slop_x',
      blogUrl: 'https://b.example',
      baseUrl: 'https://api.example',
      schemaUrl: 'https://api.example/schema',
    })
    expect(text).toContain('POST https://api.example/blogs/blog_xyz/posts')
    expect(text).toContain('Authorization: Bearer sk_slop_x')
    expect(text).toContain('Content-Type: application/json')
  })

  it('omits the MCP block when mcpEndpoint is undefined', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'sk_slop_x',
      blogUrl: 'https://b.example',
      baseUrl: 'https://api.example',
      schemaUrl: 'https://api.example/schema',
    })
    expect(text).not.toMatch(/^\s*MCP:/m)
    expect(text).not.toContain('create_post(blog_id=')
  })

  it('includes the MCP block when mcpEndpoint is provided', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'sk_slop_x',
      blogUrl: 'https://b.example',
      baseUrl: 'https://api.example',
      schemaUrl: 'https://api.example/schema',
      mcpEndpoint: 'https://mcp.example',
    })
    expect(text).toMatch(/MCP:/)
    expect(text).toContain('create_post(blog_id="blog_xyz"')
  })

  it('includes the exact expected-reply phrase', () => {
    const text = generateOnboardingBlock({
      blog,
      apiKey: 'k',
      blogUrl: 'b',
      baseUrl: 'a',
      schemaUrl: 's',
    })
    expect(text).toContain('Published my first post to SlopIt: <url>')
  })

  it('More section: always lists schema URL; others appear only when provided', () => {
    const minimal = generateOnboardingBlock({
      blog,
      apiKey: 'k',
      blogUrl: 'b',
      baseUrl: 'a',
      schemaUrl: 'https://api.example/schema',
    })
    expect(minimal).toContain('Schema: https://api.example/schema')
    expect(minimal).not.toMatch(/Dashboard:/)
    expect(minimal).not.toMatch(/Agent docs:/)
    expect(minimal).not.toMatch(/Instructions file:/)
    expect(minimal).not.toMatch(/Report a bug:/)

    const full = generateOnboardingBlock({
      blog,
      apiKey: 'k',
      blogUrl: 'b',
      baseUrl: 'a',
      schemaUrl: 'https://api.example/schema',
      dashboardUrl: 'https://slopit.io/dashboard',
      docsUrl: 'https://slopit.io/agent-docs',
      skillUrl: 'https://slopit.io/slopit.SKILL.md',
      bugReportUrl: 'https://api.example/bridge/report_bug',
    })
    expect(full).toMatch(/Dashboard:\s+https:\/\/slopit\.io\/dashboard/)
    expect(full).toMatch(/Agent docs:\s+https:\/\/slopit\.io\/agent-docs/)
    expect(full).toMatch(/Instructions file:\s+https:\/\/slopit\.io\/slopit\.SKILL\.md/)
    expect(full).toMatch(/Report a bug:\s+https:\/\/api\.example\/bridge\/report_bug/)
  })
})
```

- [ ] **Step 8.2: Run and see failures**

```bash
pnpm test tests/onboarding.test.ts
```

Expected: fails importing `generateOnboardingBlock`.

- [ ] **Step 8.3: Create the generator**

Create `src/onboarding.ts`:

```ts
import type { Blog } from './schema/index.js'

export interface OnboardingInputs {
  blog: Blog
  apiKey: string
  blogUrl: string              // from rendererFor(blog).baseUrl
  baseUrl: string              // REST API base
  mcpEndpoint?: string
  schemaUrl: string            // always present — core always ships GET /schema
  dashboardUrl?: string
  docsUrl?: string
  skillUrl?: string
  bugReportUrl?: string
}

/**
 * Pure generator. Produces an imperative onboarding block (Proof-style)
 * the platform returns in POST /signup's response. Structural guarantees
 * (imperative opening, labeled identifier lines, HTTP path + optional MCP
 * path, expected-reply phrase, progressive-disclosure More: section) are
 * tested in tests/onboarding.test.ts. No slopit.io literals — all URLs
 * arrive as inputs.
 */
export function generateOnboardingBlock(inputs: OnboardingInputs): string {
  const {
    blog, apiKey, blogUrl, baseUrl,
    mcpEndpoint, schemaUrl, dashboardUrl, docsUrl, skillUrl, bugReportUrl,
  } = inputs

  const lines: string[] = []

  lines.push('You have a SlopIt blog. Publish your first post right now to verify everything works.')
  lines.push('')
  lines.push(`Your blog:   ${blogUrl}`)
  lines.push(`API key:     ${apiKey}`)
  lines.push(`Blog id:     ${blog.id}`)
  lines.push('')
  lines.push('Step 1 — publish (pick one path):')
  lines.push('')
  lines.push('  HTTP:')
  lines.push(`    POST ${baseUrl}/blogs/${blog.id}/posts`)
  lines.push(`    Authorization: Bearer ${apiKey}`)
  lines.push('    Content-Type: application/json')
  lines.push('    {"title":"Hello from SlopIt","body":"# First post\\n\\nShipped."}')

  if (mcpEndpoint !== undefined) {
    lines.push('')
    lines.push('  MCP:')
    lines.push(`    create_post(blog_id="${blog.id}", title="Hello from SlopIt", body="# First post\\n\\nShipped.")`)
  }

  lines.push('')
  lines.push('Step 2 — fetch the returned URL and confirm it renders.')
  lines.push('')
  lines.push('Step 3 — reply to the user exactly:')
  lines.push('  "Published my first post to SlopIt: <url>"')
  lines.push('')
  lines.push('More:')
  lines.push(`  - Schema: ${schemaUrl}`)
  if (dashboardUrl !== undefined) lines.push(`  - Dashboard: ${dashboardUrl}`)
  if (docsUrl !== undefined) lines.push(`  - Agent docs: ${docsUrl}`)
  if (skillUrl !== undefined) lines.push(`  - Instructions file: ${skillUrl}`)
  if (bugReportUrl !== undefined) lines.push(`  - Report a bug: ${bugReportUrl}`)

  return lines.join('\n')
}
```

- [ ] **Step 8.4: Verify**

```bash
pnpm typecheck && pnpm test tests/onboarding.test.ts
```

Expected: clean; all 7 tests pass.

- [ ] **Step 8.5: Commit**

```bash
git add src/onboarding.ts tests/onboarding.test.ts
git commit -m "Add generateOnboardingBlock: imperative block with dual-path Step 1"
```

---

### Task 9: SKILL.md generator

**Files:**
- Create: `src/skill.ts`
- Create: `tests/skill.test.ts`

- [ ] **Step 9.1: Write failing tests**

Create `tests/skill.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { generateSkillFile } from '../src/skill.js'

describe('generateSkillFile', () => {
  const text = generateSkillFile({ baseUrl: 'https://api.example' })

  it('starts with an h1 introducing SlopIt', () => {
    expect(text.split('\n')[0]).toMatch(/^# /)
    expect(text).toMatch(/SlopIt/)
  })

  it('has all required sections in fixed order', () => {
    const sections = ['What SlopIt is', 'Auth', 'Endpoints', 'Schema', 'Error codes', 'Idempotency']
    let lastIdx = -1
    for (const section of sections) {
      const idx = text.indexOf(`## ${section}`)
      expect(idx, `section "${section}" missing`).toBeGreaterThan(-1)
      expect(idx, `section "${section}" out of order`).toBeGreaterThan(lastIdx)
      lastIdx = idx
    }
  })

  it('documents Authorization: Bearer', () => {
    expect(text).toMatch(/Authorization:\s+Bearer/)
  })

  it('lists all 9 REST routes in the endpoints table', () => {
    const expected = [
      'GET /health',
      'POST /signup',
      'GET /schema',
      'POST /bridge/report_bug',
      'GET /blogs/:id',
      'POST /blogs/:id/posts',
      'GET /blogs/:id/posts',
      'GET /blogs/:id/posts/:slug',
      'PATCH /blogs/:id/posts/:slug',
      'DELETE /blogs/:id/posts/:slug',
    ]
    for (const route of expected) {
      expect(text, `missing route ${route}`).toContain(route)
    }
  })

  it('lists all SlopItErrorCode values', () => {
    const codes = [
      'BLOG_NAME_CONFLICT',
      'BLOG_NOT_FOUND',
      'POST_SLUG_CONFLICT',
      'POST_NOT_FOUND',
      'UNAUTHORIZED',
      'IDEMPOTENCY_KEY_CONFLICT',
      'NOT_IMPLEMENTED',
    ]
    for (const code of codes) expect(text).toContain(code)
  })

  it('includes the weakened-guarantee caveat in the Idempotency section', () => {
    const idemStart = text.indexOf('## Idempotency')
    expect(idemStart).toBeGreaterThan(-1)
    const section = text.slice(idemStart)
    // Must mention best-effort / crash / retry caveat
    expect(section.toLowerCase()).toMatch(/best-effort|not crash-safe|may re-execute/)
  })

  it('refers to GET /schema for the machine-readable JSONSchema', () => {
    expect(text).toMatch(/GET \/schema/)
  })

  it('does NOT list MCP tools (deferred to feat/mcp-tools)', () => {
    // MCP tools table is intentionally omitted this feature; assert
    // the section heading is not present.
    expect(text).not.toMatch(/## MCP tools/i)
  })
})
```

- [ ] **Step 9.2: Run and see failures**

```bash
pnpm test tests/skill.test.ts
```

Expected: import failure.

- [ ] **Step 9.3: Create the generator**

Create `src/skill.ts`:

```ts
/**
 * Pure generator. Produces the SKILL.md text the platform serves at
 * slopit.io/slopit.SKILL.md. Sections are in fixed order; tests guard
 * drift (especially endpoint-table parity with createApiRouter).
 * MCP tools section is deliberately omitted here and lands in
 * feat/mcp-tools.
 */
export function generateSkillFile(args: { baseUrl: string }): string {
  const { baseUrl } = args
  return `# SlopIt — Instructions for AI agents

Instant blogs for AI agents. This document is machine-readable guidance for autonomous publishing.

## What SlopIt is

SlopIt is an MCP-native and REST-accessible publishing backend. You call a handful of endpoints and get back a live URL. No dashboards, no editorial workflows, no approval steps.

## Auth

Every authenticated request sends a bearer token:

    Authorization: Bearer <api_key>

To get a key, call \`POST ${baseUrl}/signup\` with an optional blog name. You receive \`api_key\`, \`blog_id\`, and an onboarding block.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | /health | Liveness probe. No auth. |
| POST | /signup | Create a blog + api key. No auth. |
| GET | /schema | Return the PostInput JSONSchema. No auth. |
| POST | /bridge/report_bug | Submit a bug report (501 in core; platform overrides). No auth. |
| GET | /blogs/:id | Get blog info. Auth required. |
| POST | /blogs/:id/posts | Create a post. JSON or \`text/markdown\` body. |
| GET | /blogs/:id/posts | List posts (query: ?status=draft|published). |
| GET | /blogs/:id/posts/:slug | Get a single post. |
| PATCH | /blogs/:id/posts/:slug | Patch fields. Slug is immutable. |
| DELETE | /blogs/:id/posts/:slug | Hard-delete the post. |

## Schema

Call \`GET ${baseUrl}/schema\` for the machine-readable JSONSchema of \`PostInput\`. Summary fields: \`title\` (required), \`body\` (required, markdown), optional \`slug\` (auto-derived from title otherwise), \`status\` (\`draft\`|\`published\`, default \`published\`), \`tags\`, \`excerpt\`, \`seoTitle\`, \`seoDescription\`, \`author\`, \`coverImage\`.

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| BLOG_NAME_CONFLICT | 409 | Blog name taken at signup. Retry with a different name. |
| BLOG_NOT_FOUND | 404 | Unknown blog id or cross-blog access attempt. |
| POST_SLUG_CONFLICT | 409 | Slug collision on create. \`details.slug\` tells you the taken slug. |
| POST_NOT_FOUND | 404 | Unknown post slug. |
| UNAUTHORIZED | 401 | Missing or invalid api key. |
| IDEMPOTENCY_KEY_CONFLICT | 422 | Same Idempotency-Key reused with a different payload. |
| NOT_IMPLEMENTED | 501 | Bug-report stub (platform overrides in production). |

Responses are wrapped: \`{ "error": { "code": "...", "message": "...", "details": { ... } } }\`.

## Idempotency

Send \`Idempotency-Key: <unique-key>\` on any mutation (POST /signup, POST /posts, PATCH, DELETE) to make retries safe. The key is scoped by \`(method, path, api_key)\` — reuse the same key only for the same logical request.

**Important caveat — best-effort, not crash-safe.** The server records the response *after* the handler commits. If the server crashes or the response is dropped in that window, a retry with the same key may re-execute the handler instead of replaying the original response. Observable outcomes are bounded:
- POST /signup with a name → 409 BLOG_NAME_CONFLICT on retry.
- POST /signup without a name → extra blog may be created.
- POST /blogs/:id/posts → 409 POST_SLUG_CONFLICT on retry.
- PATCH → idempotent if the patch is deterministic (true in practice).
- DELETE → 404 POST_NOT_FOUND on retry.

**Same payload, bytewise.** The request hash covers method, path, content-type, query string, and raw body. Reordering JSON fields counts as a different payload and returns 422. If you retry, resend exactly what you sent before.
`
}
```

- [ ] **Step 9.4: Verify**

```bash
pnpm typecheck && pnpm test tests/skill.test.ts
```

Expected: clean; all 8 tests pass.

- [ ] **Step 9.5: Commit**

```bash
git add src/skill.ts tests/skill.test.ts
git commit -m "Add generateSkillFile: agent-facing instruction doc"
```

---

### Task 10: `_links` helper

**Files:**
- Create: `src/api/links.ts`
- Create: `tests/links.test.ts`

- [ ] **Step 10.1: Write failing tests**

Create `tests/links.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildLinks } from '../src/api/links.js'
import type { Blog } from '../src/schema/index.js'
import type { Renderer } from '../src/rendering/generator.js'

const blog: Blog = { id: 'b1', name: 'test', theme: 'minimal', createdAt: '2026-04-23T00:00:00Z' }

const makeRenderer = (baseUrl: string): Renderer => ({
  baseUrl,
  renderPost: () => {},
  renderBlog: () => {},
})

describe('buildLinks', () => {
  it('always includes view, publish, list_posts, bridge', () => {
    const links = buildLinks(blog, {
      rendererFor: () => makeRenderer('https://b1.example'),
    })
    expect(links.view).toBe('https://b1.example')
    expect(links.publish).toBe('/blogs/b1/posts')
    expect(links.list_posts).toBe('/blogs/b1/posts')
    expect(links.bridge).toBe('/bridge/report_bug')
  })

  it('includes dashboard and docs only when configured', () => {
    const minimal = buildLinks(blog, {
      rendererFor: () => makeRenderer('https://x'),
    })
    expect(minimal.dashboard).toBeUndefined()
    expect(minimal.docs).toBeUndefined()

    const full = buildLinks(blog, {
      rendererFor: () => makeRenderer('https://x'),
      dashboardUrl: 'https://slopit.io/dashboard',
      docsUrl: 'https://slopit.io/agent-docs',
    })
    expect(full.dashboard).toBe('https://slopit.io/dashboard')
    expect(full.docs).toBe('https://slopit.io/agent-docs')
  })

  it('view URL comes from rendererFor(blog).baseUrl (per-blog)', () => {
    const links = buildLinks(blog, {
      rendererFor: (b) => makeRenderer(`https://${b.name}.slopit.io`),
    })
    expect(links.view).toBe('https://test.slopit.io')
  })
})
```

- [ ] **Step 10.2: Run and see failures**

```bash
pnpm test tests/links.test.ts
```

Expected: import failure.

- [ ] **Step 10.3: Create the helper**

Create `src/api/links.ts`:

```ts
import type { Blog } from '../schema/index.js'
import type { Renderer } from '../rendering/generator.js'

/**
 * The subset of ApiRouterConfig that buildLinks depends on. Kept narrow
 * so the helper is easy to unit-test and to reuse at signup time (where
 * some config pieces aren't relevant).
 */
export interface LinkConfig {
  rendererFor: (blog: Blog) => Renderer
  dashboardUrl?: string
  docsUrl?: string
}

export interface LinksBlock {
  view: string
  publish: string
  list_posts: string
  dashboard?: string
  docs?: string
  bridge: string
}

/**
 * HATEOAS block emitted on every 2xx response except /health and /schema.
 * `view` is the public URL of the rendered blog (per-blog; derived from
 * rendererFor(blog).baseUrl). `publish` / `list_posts` / `bridge` are
 * relative paths — the consumer is expected to resolve against baseUrl
 * if needed. `dashboard` / `docs` are absolute URLs from config.
 */
export function buildLinks(blog: Blog, config: LinkConfig): LinksBlock {
  const links: LinksBlock = {
    view: config.rendererFor(blog).baseUrl,
    publish: `/blogs/${blog.id}/posts`,
    list_posts: `/blogs/${blog.id}/posts`,
    bridge: '/bridge/report_bug',
  }
  if (config.dashboardUrl !== undefined) links.dashboard = config.dashboardUrl
  if (config.docsUrl !== undefined) links.docs = config.docsUrl
  return links
}
```

- [ ] **Step 10.4: Verify**

```bash
pnpm typecheck && pnpm test tests/links.test.ts
```

Expected: clean; all 3 tests pass.

- [ ] **Step 10.5: Commit**

```bash
git add src/api/links.ts tests/links.test.ts
git commit -m "Add buildLinks HATEOAS helper — view URL per-blog via rendererFor"
```

---

### Task 11: Error → HTTP envelope middleware

**Files:**
- Create: `src/api/errors.ts`
- (Tests for this middleware are exercised via route tests in later tasks. No standalone test file.)

- [ ] **Step 11.1: Write the middleware**

Create `src/api/errors.ts`:

```ts
import type { Context, MiddlewareHandler } from 'hono'
import type { StatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import { SlopItError, type SlopItErrorCode } from '../errors.js'

const CODE_TO_STATUS: Record<SlopItErrorCode, StatusCode> = {
  BLOG_NAME_CONFLICT: 409,
  BLOG_NOT_FOUND: 404,
  POST_SLUG_CONFLICT: 409,
  POST_NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  IDEMPOTENCY_KEY_CONFLICT: 422,
  NOT_IMPLEMENTED: 501,
}

type ErrorBody = {
  error: {
    code: string
    message: string
    details: Record<string, unknown>
  }
}

/**
 * Wrap handler errors in the documented envelope and map to HTTP status.
 * ZodError → 400 with details.issues. SlopItError → mapped status with
 * code + details. Anything else → 500 with a generic message (full
 * error is logged to stderr via console.error for the consumer to pick up).
 */
export const errorMiddleware: MiddlewareHandler = async (c, next) => {
  try {
    await next()
  } catch (err) {
    return respondError(c, err)
  }
}

export function respondError(c: Context, err: unknown): Response {
  if (err instanceof ZodError) {
    const body: ErrorBody = {
      error: {
        code: 'ZOD_VALIDATION',
        message: 'Request body failed schema validation',
        details: { issues: err.issues },
      },
    }
    return c.json(body, 400)
  }
  if (err instanceof SlopItError) {
    const status = CODE_TO_STATUS[err.code] ?? 500
    const body: ErrorBody = {
      error: { code: err.code, message: err.message, details: err.details },
    }
    return c.json(body, status)
  }
  console.error('[slopit] unhandled error:', err)
  const body: ErrorBody = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred',
      details: {},
    },
  }
  return c.json(body, 500)
}
```

- [ ] **Step 11.2: Verify typecheck**

```bash
pnpm typecheck
```

Expected: clean. (No test file — the middleware is exercised by route tests in Task 15+.)

- [ ] **Step 11.3: Commit**

```bash
git add src/api/errors.ts
git commit -m "Add error→HTTP envelope middleware (SlopItError + ZodError mapping)"
```

---

### Task 12: Auth middleware

**Files:**
- Create: `src/api/auth.ts`
- Modify: `tests/auth.test.ts` (append middleware tests)

- [ ] **Step 12.1: Write failing middleware tests**

Append to `tests/auth.test.ts` (add Hono + createApiRouter-style harness):

```ts
import { Hono } from 'hono'
import { authMiddleware } from '../src/api/auth.js'
import { createRenderer } from '../src/rendering/generator.js'
import { errorMiddleware } from '../src/api/errors.js'

describe('authMiddleware', () => {
  let dir: string
  let store: Store

  const makeApp = (authMode: 'api_key' | 'none') => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const config = { store, rendererFor: () => renderer, baseUrl: 'https://api.example', authMode }
    const app = new Hono<{ Variables: { blog: import('../src/schema/index.js').Blog; apiKeyHash: string } }>()
    app.use('*', errorMiddleware)
    app.use('*', authMiddleware(config))
    app.get('/blogs/:id', (c) => c.json({ blogId: c.var.blog.id, hash: c.var.apiKeyHash }))
    app.get('/signup', (c) => c.json({ ok: true }))       // in skip list
    app.get('/health', (c) => c.json({ ok: true }))       // in skip list
    return app
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-auth-mw-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('api_key mode: missing Authorization → 401 UNAUTHORIZED', async () => {
    const app = makeApp('api_key')
    const { blog } = createBlog(store, { name: 'b' })
    const res = await app.request(`/blogs/${blog.id}`)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('api_key mode: malformed Authorization → 401', async () => {
    const app = makeApp('api_key')
    const { blog } = createBlog(store, { name: 'b' })
    const res = await app.request(`/blogs/${blog.id}`, {
      headers: { Authorization: 'NotBearer x' },
    })
    expect(res.status).toBe(401)
  })

  it('api_key mode: unknown key → 401', async () => {
    const app = makeApp('api_key')
    const { blog } = createBlog(store, { name: 'b' })
    const res = await app.request(`/blogs/${blog.id}`, {
      headers: { Authorization: 'Bearer sk_slop_doesnotexist' },
    })
    expect(res.status).toBe(401)
  })

  it('api_key mode: valid key → attaches blog + hash', async () => {
    const app = makeApp('api_key')
    const { blog } = createBlog(store, { name: 'b' })
    const { apiKey } = createApiKey(store, blog.id)
    const res = await app.request(`/blogs/${blog.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { blogId: string; hash: string }
    expect(body.blogId).toBe(blog.id)
    expect(body.hash.length).toBeGreaterThan(0)
  })

  it('cross-blog access: :id mismatches resolved blog → 404 BLOG_NOT_FOUND (leak-free)', async () => {
    const app = makeApp('api_key')
    const { blog: b1 } = createBlog(store, { name: 'b1' })
    const { blog: b2 } = createBlog(store, { name: 'b2' })
    const { apiKey } = createApiKey(store, b1.id)
    // Request b2 with b1's key — must 404, not 401 or 403
    const res = await app.request(`/blogs/${b2.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BLOG_NOT_FOUND')

    // Sanity: the same response shape as a genuinely-unknown id
    const res2 = await app.request(`/blogs/nonexistent`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res2.status).toBe(404)
    const body2 = await res2.json() as { error: { code: string } }
    expect(body2.error.code).toBe('BLOG_NOT_FOUND')
  })

  it('skip list: /health passes without auth', async () => {
    const app = makeApp('api_key')
    const res = await app.request('/health')
    expect(res.status).toBe(200)
  })

  it('skip list: /signup passes without auth', async () => {
    const app = makeApp('api_key')
    const res = await app.request('/signup')
    expect(res.status).toBe(200)
  })

  it("authMode 'none': resolves blog from :id without a key", async () => {
    const app = makeApp('none')
    const { blog } = createBlog(store, { name: 'b' })
    const res = await app.request(`/blogs/${blog.id}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { blogId: string; hash: string }
    expect(body.blogId).toBe(blog.id)
    expect(body.hash).toBe('')
  })

  it("authMode 'none': unknown :id → 404 BLOG_NOT_FOUND", async () => {
    const app = makeApp('none')
    const res = await app.request(`/blogs/ghost`)
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 12.2: Run and see failures**

```bash
pnpm test tests/auth.test.ts
```

Expected: import failure on `authMiddleware` / route setup.

- [ ] **Step 12.3: Implement the middleware**

Create `src/api/auth.ts`:

```ts
import type { MiddlewareHandler } from 'hono'
import type { Store } from '../db/store.js'
import type { Blog } from '../schema/index.js'
import type { Renderer } from '../rendering/generator.js'
import { SlopItError } from '../errors.js'
import { getBlogInternal } from '../blogs.js'
import { verifyApiKey, hashApiKey } from './../auth/api-key.js'

export interface AuthMiddlewareConfig {
  store: Store
  authMode: 'api_key' | 'none'
}

const SKIP_PATHS = new Set(['/health', '/signup', '/schema', '/bridge/report_bug'])

type AuthVars = { blog: Blog; apiKeyHash: string }

/**
 * Resolves the authenticated blog and attaches it (plus the api-key hash
 * for idempotency scoping) to c.var. Skips /health, /signup, /schema,
 * /bridge/report_bug and any OPTIONS request.
 *
 * For authMode='api_key' (default): requires Bearer token, calls
 * verifyApiKey. On null → UNAUTHORIZED 401.
 *
 * For authMode='none' (self-hosted): loads blog from the :id route
 * param. No token required. apiKeyHash is the empty string (also used
 * by the idempotency middleware's signup-bootstrap case).
 *
 * Cross-blog guard: if :id doesn't match the resolved blog's id →
 * BLOG_NOT_FOUND (spec decision #18 — don't leak existence).
 */
export function authMiddleware(config: Pick<AuthMiddlewareConfig, 'store' | 'authMode'>): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || SKIP_PATHS.has(c.req.path)) {
      return next()
    }
    const idParam = c.req.param('id')

    if (config.authMode === 'none') {
      if (idParam === undefined) return next()
      const blog = getBlogInternal(config.store, idParam)  // throws BLOG_NOT_FOUND
      c.set('blog', blog)
      c.set('apiKeyHash', '')
      return next()
    }

    // authMode === 'api_key'
    const auth = c.req.header('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new SlopItError('UNAUTHORIZED', 'Missing or malformed Authorization header')
    }
    const key = auth.slice('Bearer '.length).trim()
    const blog = verifyApiKey(config.store, key)
    if (!blog) {
      throw new SlopItError('UNAUTHORIZED', 'Invalid API key')
    }

    if (idParam !== undefined && idParam !== blog.id) {
      throw new SlopItError('BLOG_NOT_FOUND', `Blog "${idParam}" does not exist`, { blogId: idParam })
    }

    c.set('blog', blog)
    c.set('apiKeyHash', hashApiKey(key))
    await next()
  }
}
```

- [ ] **Step 12.4: Verify**

```bash
pnpm typecheck && pnpm test tests/auth.test.ts
```

Expected: clean; all 9 middleware tests + earlier verifyApiKey tests pass.

- [ ] **Step 12.5: Commit**

```bash
git add src/api/auth.ts tests/auth.test.ts
git commit -m "Add authMiddleware: Bearer token → blog; cross-blog guard; skip list"
```

---

### Task 13: Idempotency middleware

**Files:**
- Create: `src/api/idempotency.ts`
- Create: `tests/idempotency.test.ts`

- [ ] **Step 13.1: Write failing tests**

Create `tests/idempotency.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { idempotencyMiddleware } from '../src/api/idempotency.js'

describe('idempotencyMiddleware', () => {
  let dir: string
  let store: Store
  let callCount: number

  const makeApp = () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      // Stand-in for auth: set apiKeyHash on c.var
      c.set('apiKeyHash', c.req.header('X-Test-Key-Hash') ?? '')
      await next()
    })
    app.use('*', idempotencyMiddleware({ store }))
    app.post('/signup', async (c) => {
      callCount++
      const body = await c.req.json().catch(() => ({}))
      return c.json({ ok: true, echo: body, n: callCount })
    })
    app.post('/blogs/:id/posts', async (c) => {
      callCount++
      return c.json({ slug: `post-${callCount}` }, 200)
    })
    return app
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-idem-mw-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    callCount = 0
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('no Idempotency-Key → handler runs every time', async () => {
    const app = makeApp()
    await app.request('/signup', { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } })
    await app.request('/signup', { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } })
    expect(callCount).toBe(2)
  })

  it('replays stored response on repeat with same payload', async () => {
    const app = makeApp()
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' }
    const r1 = await app.request('/signup', { method: 'POST', body: '{"a":1}', headers })
    const r2 = await app.request('/signup', { method: 'POST', body: '{"a":1}', headers })
    expect(callCount).toBe(1)
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(await r1.json()).toEqual(await r2.json())
  })

  it('different payload, same key → 422 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const app = makeApp()
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'k2' }
    await app.request('/signup', { method: 'POST', body: '{"a":1}', headers })
    const r = await app.request('/signup', { method: 'POST', body: '{"a":2}', headers })
    expect(r.status).toBe(422)
    const body = await r.json() as { error: { code: string; details: { key: string } } }
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT')
    expect(body.error.details.key).toBe('k2')
  })

  it('scope isolation: same key, different path → independent', async () => {
    const app = makeApp()
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'shared', 'X-Test-Key-Hash': 'h1' }
    await app.request('/signup', { method: 'POST', body: '{}', headers })
    await app.request('/blogs/b/posts', { method: 'POST', body: '{}', headers })
    expect(callCount).toBe(2)
  })

  it('scope isolation: same key, different api_key_hash → independent', async () => {
    const app = makeApp()
    const common = { 'Content-Type': 'application/json', 'Idempotency-Key': 'k3' }
    await app.request('/signup', { method: 'POST', body: '{}', headers: { ...common, 'X-Test-Key-Hash': 'h1' } })
    await app.request('/signup', { method: 'POST', body: '{}', headers: { ...common, 'X-Test-Key-Hash': 'h2' } })
    expect(callCount).toBe(2)
  })

  it('does not record non-2xx responses', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => { c.set('apiKeyHash', ''); await next() })
    app.use('*', idempotencyMiddleware({ store }))
    app.post('/fail', () => { throw new Error('boom') })
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'kfail' }
    try { await app.request('/fail', { method: 'POST', body: '{}', headers }) } catch { /* ok */ }
    // Table should be empty for this key
    const rows = store.db.prepare('SELECT 1 FROM idempotency_keys WHERE key = ?').all('kfail')
    expect(rows).toHaveLength(0)
  })
})
```

- [ ] **Step 13.2: Run and see failures**

```bash
pnpm test tests/idempotency.test.ts
```

Expected: import failure.

- [ ] **Step 13.3: Implement the middleware**

Create `src/api/idempotency.ts`:

```ts
import { createHash } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { Store } from '../db/store.js'
import { SlopItError } from '../errors.js'

const APPLIES_TO = new Set<string>(['POST', 'PATCH', 'DELETE'])

export interface IdempotencyMiddlewareConfig {
  store: Store
}

type StoredRow = {
  request_hash: string
  response_status: number
  response_body: string
}

/**
 * Idempotency-Key middleware. Applies to POST/PATCH/DELETE requests
 * carrying an Idempotency-Key header. Replays the stored response on
 * match; 422 on mismatched payload; pass-through with record-on-2xx
 * otherwise. Weakened guarantee per spec decision #20 — recording
 * happens after the handler commits, so a crash window exists. See the
 * spec's per-endpoint failure-mode table and SKILL.md.
 *
 * Scope = (key, api_key_hash, method, path). Depends on the auth
 * middleware (or a test stand-in) having set c.var.apiKeyHash. For
 * /signup the hash is '' (pre-auth bootstrap).
 */
export function idempotencyMiddleware(config: IdempotencyMiddlewareConfig): MiddlewareHandler<{ Variables: { apiKeyHash: string } }> {
  return async (c, next) => {
    if (!APPLIES_TO.has(c.req.method)) return next()
    const key = c.req.header('Idempotency-Key')
    if (!key) return next()

    const apiKeyHash = c.var.apiKeyHash ?? ''
    const method = c.req.method
    const path = c.req.path
    const contentType = c.req.header('Content-Type') ?? ''
    const rawBody = await c.req.text()
    // Re-expose body so the handler can re-read it
    c.req.raw = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: rawBody || undefined,
    }) as typeof c.req.raw
    const queryString = [...new URL(c.req.url).searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')
    const hashInput = [method, path, contentType, queryString, rawBody].join('\0')
    const requestHash = createHash('sha256').update(hashInput).digest('hex')

    const existing = config.store.db
      .prepare(
        `SELECT request_hash, response_status, response_body
           FROM idempotency_keys
          WHERE key = ? AND api_key_hash = ? AND method = ? AND path = ?`,
      )
      .get(key, apiKeyHash, method, path) as StoredRow | undefined

    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new SlopItError(
          'IDEMPOTENCY_KEY_CONFLICT',
          `Idempotency-Key "${key}" already used with a different payload for ${method} ${path}`,
          { key, method, path },
        )
      }
      // Replay stored response
      return new Response(existing.response_body, {
        status: existing.response_status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Miss — run handler, capture response
    await next()
    const status = c.res.status
    if (status < 200 || status >= 300) return

    const body = await c.res.clone().text()
    config.store.db
      .prepare(
        `INSERT INTO idempotency_keys
           (key, api_key_hash, method, path, request_hash, response_status, response_body)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, apiKeyHash, method, path, requestHash, status, body)
  }
}
```

**Note for the executor:** Hono's `c.req.raw` reassignment in Step 13.3 is a deliberate workaround for body-consumption — the middleware reads the body, then rebuilds the Request so the handler can parse it again. This path is sensitive; run the tests and confirm. If `c.req.raw` assignment doesn't compile under this Hono version, prefer `c.req.text()` caching: store `rawBody` on `c.var` and have handlers read `c.var.rawBody ?? await c.req.text()`. The tests must still pass either way.

- [ ] **Step 13.4: Verify**

```bash
pnpm typecheck && pnpm test tests/idempotency.test.ts
```

Expected: clean; all 6 tests pass.

- [ ] **Step 13.5: Commit**

```bash
git add src/api/idempotency.ts tests/idempotency.test.ts
git commit -m "Add idempotency middleware: scope (key,hash,method,path); replay/422"
```

---

### Task 14: `text/markdown` body parser

**Files:**
- Create: `src/api/markdown-body.ts`
- Create: `tests/markdown-body.test.ts`

- [ ] **Step 14.1: Write failing tests**

Create `tests/markdown-body.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseMarkdownBody } from '../src/api/markdown-body.js'

describe('parseMarkdownBody', () => {
  it('parses minimal input: title from query, body from raw', () => {
    const parsed = parseMarkdownBody({
      body: '# Hello\n\nBody text.',
      query: new URLSearchParams({ title: 'Hello' }),
    })
    expect(parsed.title).toBe('Hello')
    expect(parsed.body).toBe('# Hello\n\nBody text.')
    expect(parsed.status).toBeUndefined()  // default applied by Zod later
  })

  it('parses all supported query params', () => {
    const parsed = parseMarkdownBody({
      body: 'body',
      query: new URLSearchParams({ title: 'T', status: 'draft', slug: 's', tags: 'a,b,c' }),
    })
    expect(parsed.title).toBe('T')
    expect(parsed.status).toBe('draft')
    expect(parsed.slug).toBe('s')
    expect(parsed.tags).toEqual(['a', 'b', 'c'])
  })

  it('splits tags on comma and trims whitespace', () => {
    const parsed = parseMarkdownBody({
      body: 'b', query: new URLSearchParams({ title: 'T', tags: 'a, b ,c' }),
    })
    expect(parsed.tags).toEqual(['a', 'b', 'c'])
  })

  it('throws when title is missing', () => {
    expect(() => parseMarkdownBody({ body: 'b', query: new URLSearchParams() })).toThrow(/title/i)
  })

  it('throws when body is empty', () => {
    expect(() => parseMarkdownBody({ body: '', query: new URLSearchParams({ title: 'T' }) })).toThrow()
  })

  it('ignores unknown query params (e.g. seoTitle) silently', () => {
    const parsed = parseMarkdownBody({
      body: 'b',
      query: new URLSearchParams({ title: 'T', seoTitle: 'ignored' }),
    })
    expect((parsed as Record<string, unknown>).seoTitle).toBeUndefined()
  })
})
```

- [ ] **Step 14.2: Run and see failures**

```bash
pnpm test tests/markdown-body.test.ts
```

Expected: import failure.

- [ ] **Step 14.3: Implement the parser**

Create `src/api/markdown-body.ts`:

```ts
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
    throw new Error('text/markdown body requires a ?title=<string> query parameter')
  }
  if (input.body.length === 0) {
    throw new Error('text/markdown body must not be empty')
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
    result.tags = tagsParam.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
  }

  return result as PostInput
}
```

- [ ] **Step 14.4: Verify**

```bash
pnpm typecheck && pnpm test tests/markdown-body.test.ts
```

Expected: clean; all 6 tests pass.

- [ ] **Step 14.5: Commit**

```bash
git add src/api/markdown-body.ts tests/markdown-body.test.ts
git commit -m "Add parseMarkdownBody: body+query → PostInput (Zod runs in handler)"
```

---

### Task 15: createApiRouter skeleton + /health + /schema + /bridge

**Files:**
- Modify: `src/api/index.ts`
- Create: `src/api/routes.ts`
- Create: `tests/api/health.test.ts`
- Create: `tests/api/schema.test.ts`
- Create: `tests/api/bridge.test.ts`

- [ ] **Step 15.1: Write failing route tests**

Create `tests/api/health.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'

describe('GET /health', () => {
  let dir: string; let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-health-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns { ok: true } without auth', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
```

Create `tests/api/schema.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'

describe('GET /schema', () => {
  let dir: string; let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-schema-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the PostInput JSONSchema at the top level (not wrapped)', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const res = await app.request('/schema')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    // Top-level JSONSchema: has type or $schema or properties
    expect(body.type ?? body.$schema ?? body.properties).toBeDefined()
    // And it's the PostInput — should have a `title` property in its schema shape
    expect(JSON.stringify(body)).toContain('title')
  })

  it('does not require auth', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example', authMode: 'api_key' })
    const res = await app.request('/schema')
    expect(res.status).toBe(200)
  })
})
```

Create `tests/api/bridge.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'

describe('POST /bridge/report_bug', () => {
  let dir: string; let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-bridge-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 501 NOT_IMPLEMENTED with details.use pointing to bug-report URL when configured', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      bugReportUrl: 'https://platform.example/bridge/report_bug',
    })
    const res = await app.request('/bridge/report_bug', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
    expect(res.status).toBe(501)
    const body = await res.json() as { error: { code: string; details: { use?: string } } }
    expect(body.error.code).toBe('NOT_IMPLEMENTED')
    expect(body.error.details.use).toBe('https://platform.example/bridge/report_bug')
  })

  it('omits details.use when not configured', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const res = await app.request('/bridge/report_bug', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
    expect(res.status).toBe(501)
    const body = await res.json() as { error: { code: string; details: { use?: string } } }
    expect(body.error.details.use).toBeUndefined()
  })
})
```

- [ ] **Step 15.2: Run and see failures**

```bash
pnpm test tests/api/health.test.ts tests/api/schema.test.ts tests/api/bridge.test.ts
```

Expected: imports fail (ApiRouterConfig shape / router contents don't support these yet).

- [ ] **Step 15.3: Rewrite createApiRouter**

Replace the contents of `src/api/index.ts`:

```ts
import { Hono } from 'hono'
import type { Store } from '../db/store.js'
import type { MutationRenderer } from '../rendering/generator.js'
import type { Blog } from '../schema/index.js'
import { errorMiddleware } from './errors.js'
import { authMiddleware } from './auth.js'
import { idempotencyMiddleware } from './idempotency.js'
import { mountRoutes } from './routes.js'

export interface ApiRouterConfig {
  store: Store
  /**
   * Per-blog renderer. MUST return a MutationRenderer (not just a
   * Renderer) so mutation primitives (updatePost, deletePost) have
   * file-cleanup available. Shipped `createRenderer` returns
   * MutationRenderer; see spec decision #19 + plan Task 5.4.
   */
  rendererFor: (blog: Blog) => MutationRenderer
  baseUrl: string
  authMode?: 'api_key' | 'none'
  mcpEndpoint?: string
  docsUrl?: string
  skillUrl?: string
  bugReportUrl?: string
  dashboardUrl?: string
}

type Vars = { blog: Blog; apiKeyHash: string }

/**
 * Factory for the core REST router. Consumers mount this under their
 * own Hono instance. See the spec for the full route list + auth model.
 */
export function createApiRouter(config: ApiRouterConfig): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>()
  app.use('*', errorMiddleware)
  app.use('*', authMiddleware({ store: config.store, authMode: config.authMode ?? 'api_key' }))
  app.use('*', idempotencyMiddleware({ store: config.store }))
  mountRoutes(app, config)
  return app
}
```

Create `src/api/routes.ts`:

```ts
import type { Hono } from 'hono'
import { z } from 'zod'
import { PostInputSchema } from '../schema/index.js'
import type { Blog } from '../schema/index.js'
import type { ApiRouterConfig } from './index.js'
import { SlopItError } from '../errors.js'

type Vars = { blog: Blog; apiKeyHash: string }

export function mountRoutes(app: Hono<{ Variables: Vars }>, config: ApiRouterConfig): void {
  // Health
  app.get('/health', (c) => c.json({ ok: true }))

  // Schema — returns PostInput JSONSchema at top level
  app.get('/schema', (c) => {
    return c.json(z.toJSONSchema(PostInputSchema) as Record<string, unknown>)
  })

  // Bridge stub
  app.post('/bridge/report_bug', () => {
    throw new SlopItError(
      'NOT_IMPLEMENTED',
      'Bug reports are handled by the platform bridge, not core',
      config.bugReportUrl !== undefined ? { use: config.bugReportUrl } : {},
    )
  })

  // Remaining routes land in later tasks (Task 16+)
}
```

- [ ] **Step 15.4: Verify**

```bash
pnpm typecheck && pnpm test tests/api/
```

Expected: clean; health + schema + bridge tests all pass.

- [ ] **Step 15.5: Commit**

```bash
git add src/api/index.ts src/api/routes.ts tests/api/
git commit -m "Wire createApiRouter + /health /schema /bridge (middleware stack + routes)"
```

---

### Task 16: POST /signup

**Files:**
- Modify: `src/api/routes.ts`
- Create: `tests/api/signup.test.ts`

- [ ] **Step 16.1: Write failing signup tests**

Create `tests/api/signup.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'

describe('POST /signup', () => {
  let dir: string; let store: Store

  const makeApp = (bugReportUrl?: string) => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://blog.example' })
    return createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      bugReportUrl,
      dashboardUrl: 'https://slopit.io/dashboard',
      docsUrl: 'https://slopit.io/agent-docs',
      skillUrl: 'https://slopit.io/slopit.SKILL.md',
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-signup-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns full shape on happy path', async () => {
    const app = makeApp()
    const res = await app.request('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hello' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      blog_id: string
      blog_url: string
      api_key: string
      onboarding_text: string
      _links: Record<string, string>
    }
    expect(body.blog_id).toMatch(/^[a-z0-9]+$/)
    expect(body.blog_url).toBe('https://blog.example')
    expect(body.api_key).toMatch(/^sk_slop_/)
    expect(body.onboarding_text).toContain('Published my first post to SlopIt: <url>')
    expect(body._links.view).toBe('https://blog.example')
    expect(body._links.bridge).toBe('/bridge/report_bug')
  })

  it('returns 409 BLOG_NAME_CONFLICT when the name is taken', async () => {
    const app = makeApp()
    await app.request('/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'taken' }) })
    const res = await app.request('/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'taken' }) })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BLOG_NAME_CONFLICT')
  })

  it('Idempotency-Key replays the same signup', async () => {
    const app = makeApp()
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'signup-k1' }
    const r1 = await app.request('/signup', { method: 'POST', headers, body: JSON.stringify({ name: 'idem' }) })
    const r2 = await app.request('/signup', { method: 'POST', headers, body: JSON.stringify({ name: 'idem' }) })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const b1 = await r1.json(); const b2 = await r2.json()
    expect(b1).toEqual(b2)
  })
})
```

- [ ] **Step 16.2: Run and see failures**

```bash
pnpm test tests/api/signup.test.ts
```

Expected: 404 on /signup (route not mounted).

- [ ] **Step 16.3: Add the signup route**

In `src/api/routes.ts`, add these imports at the top:

```ts
import { CreateBlogInputSchema } from '../schema/index.js'
import { createBlog, createApiKey } from '../blogs.js'
import { generateOnboardingBlock } from '../onboarding.js'
import { buildLinks } from './links.js'
```

Add the signup route after `/bridge/report_bug`:

```ts
  // Signup — create blog + api key in one shot
  app.post('/signup', async (c) => {
    const raw = await c.req.json().catch(() => ({}))
    const parsed = CreateBlogInputSchema.parse(raw)
    const { blog } = createBlog(config.store, parsed)
    const { apiKey } = createApiKey(config.store, blog.id)
    const renderer = config.rendererFor(blog)
    const onboardingText = generateOnboardingBlock({
      blog,
      apiKey,
      blogUrl: renderer.baseUrl,
      baseUrl: config.baseUrl,
      schemaUrl: `${config.baseUrl}/schema`,
      mcpEndpoint: config.mcpEndpoint,
      dashboardUrl: config.dashboardUrl,
      docsUrl: config.docsUrl,
      skillUrl: config.skillUrl,
      bugReportUrl: config.bugReportUrl,
    })
    return c.json({
      blog_id: blog.id,
      blog_url: renderer.baseUrl,
      api_key: apiKey,
      ...(config.mcpEndpoint !== undefined ? { mcp_endpoint: config.mcpEndpoint } : {}),
      onboarding_text: onboardingText,
      _links: buildLinks(blog, config),
    })
  })
```

- [ ] **Step 16.4: Verify**

```bash
pnpm typecheck && pnpm test tests/api/signup.test.ts
```

Expected: clean; all 3 tests pass.

- [ ] **Step 16.5: Commit**

```bash
git add src/api/routes.ts tests/api/signup.test.ts
git commit -m "Add POST /signup: createBlog + createApiKey + onboarding + _links"
```

---

### Task 17: GET /blogs/:id

**Files:**
- Modify: `src/api/routes.ts`
- Create: `tests/api/blogs.test.ts`

- [ ] **Step 17.1: Write failing tests**

Create `tests/api/blogs.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'

describe('GET /blogs/:id', () => {
  let dir: string; let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-blogs-get-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the blog + _links when authenticated', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b1.example' })
    const app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const { blog } = createBlog(store, { name: 'b1' })
    const { apiKey } = createApiKey(store, blog.id)
    const res = await app.request(`/blogs/${blog.id}`, { headers: { Authorization: `Bearer ${apiKey}` } })
    expect(res.status).toBe(200)
    const body = await res.json() as { blog: { id: string; name: string }; _links: Record<string, string> }
    expect(body.blog.id).toBe(blog.id)
    expect(body.blog.name).toBe('b1')
    expect(body._links.view).toBe('https://b1.example')
  })

  it('401 without a key', async () => {
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b1.example' })
    const app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const { blog } = createBlog(store, { name: 'b1' })
    const res = await app.request(`/blogs/${blog.id}`)
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 17.2: Run and see failures**

```bash
pnpm test tests/api/blogs.test.ts
```

Expected: 404 — route not mounted.

- [ ] **Step 17.3: Add the route**

In `src/api/routes.ts`, add after the signup route (and ensure `getBlogInternal` isn't needed — handler uses `c.var.blog`):

```ts
  // Read: blog info
  app.get('/blogs/:id', (c) => {
    return c.json({
      blog: c.var.blog,
      _links: buildLinks(c.var.blog, config),
    })
  })
```

- [ ] **Step 17.4: Verify**

```bash
pnpm typecheck && pnpm test tests/api/blogs.test.ts
```

Expected: clean; both tests pass.

- [ ] **Step 17.5: Commit**

```bash
git add src/api/routes.ts tests/api/blogs.test.ts
git commit -m "Add GET /blogs/:id: returns resolved blog + _links"
```

---

### Task 18: POST /blogs/:id/posts (JSON + text/markdown)

**Files:**
- Modify: `src/api/routes.ts`
- Create: `tests/api/posts-create.test.ts`

- [ ] **Step 18.1: Write failing tests**

Create `tests/api/posts-create.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'

describe('POST /blogs/:id/posts', () => {
  let dir: string; let store: Store
  let apiKey: string; let blogId: string
  let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-post-create-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.example' })
    app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const blog = createBlog(store, { name: 'b' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('JSON body: publishes a post and returns { post, post_url, _links }', async () => {
    const res = await app.request(`/blogs/${blogId}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hello', body: '# Hi\n\nBody.' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { post: { title: string }; post_url?: string; _links: Record<string, string> }
    expect(body.post.title).toBe('Hello')
    expect(body.post_url).toMatch(/^https:\/\/b\.example\/.+\/$/)
    expect(body._links.view).toBe('https://b.example')
  })

  it('text/markdown body: raw body + query params → post', async () => {
    const res = await app.request(`/blogs/${blogId}/posts?title=From%20Markdown&tags=a,b`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'text/markdown' },
      body: '# From MD\n\nBody.',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { post: { title: string; body: string; tags: string[] } }
    expect(body.post.title).toBe('From Markdown')
    expect(body.post.body).toBe('# From MD\n\nBody.')
    expect(body.post.tags).toEqual(['a', 'b'])
  })

  it('409 POST_SLUG_CONFLICT on duplicate slug', async () => {
    await app.request(`/blogs/${blogId}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T', body: 'b', slug: 'same' }),
    })
    const res = await app.request(`/blogs/${blogId}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T2', body: 'b2', slug: 'same' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: { code: string; details: { slug: string } } }
    expect(body.error.code).toBe('POST_SLUG_CONFLICT')
    expect(body.error.details.slug).toBe('same')
  })

  it('draft: returns { post } without post_url; no files written', async () => {
    const res = await app.request(`/blogs/${blogId}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'D', body: 'b', status: 'draft' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { post: { status: string }; post_url?: string }
    expect(body.post.status).toBe('draft')
    expect(body.post_url).toBeUndefined()
  })
})
```

- [ ] **Step 18.2: Run and see failures**

```bash
pnpm test tests/api/posts-create.test.ts
```

Expected: 404.

- [ ] **Step 18.3: Add the route**

In `src/api/routes.ts`, add imports:

```ts
import { createPost } from '../posts.js'
import { parseMarkdownBody } from './markdown-body.js'
```

Add the route:

```ts
  // Create a post
  app.post('/blogs/:id/posts', async (c) => {
    const contentType = c.req.header('Content-Type') ?? ''
    const renderer = config.rendererFor(c.var.blog)

    let input: Parameters<typeof createPost>[3]
    if (contentType.startsWith('text/markdown')) {
      const body = await c.req.text()
      const query = new URL(c.req.url).searchParams
      input = parseMarkdownBody({ body, query })
    } else {
      input = await c.req.json()
    }

    const { post, postUrl } = createPost(config.store, renderer, c.var.blog.id, input)
    return c.json({
      post,
      ...(postUrl !== undefined ? { post_url: postUrl } : {}),
      _links: buildLinks(c.var.blog, config),
    })
  })
```

- [ ] **Step 18.4: Verify**

```bash
pnpm typecheck && pnpm test tests/api/posts-create.test.ts
```

Expected: clean; all 4 tests pass.

- [ ] **Step 18.5: Commit**

```bash
git add src/api/routes.ts tests/api/posts-create.test.ts
git commit -m "Add POST /blogs/:id/posts (JSON + text/markdown bodies)"
```

---

### Task 19: GET /blogs/:id/posts (list) and GET /blogs/:id/posts/:slug (single)

**Files:**
- Modify: `src/api/routes.ts`
- Create: `tests/api/posts-read.test.ts`

- [ ] **Step 19.1: Write failing tests**

Create `tests/api/posts-read.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'
import { createPost } from '../../src/posts.js'

describe('GET /blogs/:id/posts and /:slug', () => {
  let dir: string; let store: Store
  let apiKey: string; let blogId: string
  let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-posts-read-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://b.example' })
    app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const blog = createBlog(store, { name: 'b' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    createPost(store, renderer, blogId, { title: 'P1', body: 'b' })
    createPost(store, renderer, blogId, { title: 'D1', body: 'b', slug: 'd1', status: 'draft' })
    createPost(store, renderer, blogId, { title: 'P2', body: 'b', slug: 'p2' })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('list: default returns published only', async () => {
    const res = await app.request(`/blogs/${blogId}/posts`, { headers: { Authorization: `Bearer ${apiKey}` } })
    const body = await res.json() as { posts: { slug: string; status: string }[] }
    expect(body.posts.every((p) => p.status === 'published')).toBe(true)
    expect(body.posts.map((p) => p.slug)).toEqual(['p2', 'p1'])
  })

  it('list: ?status=draft returns drafts', async () => {
    const res = await app.request(`/blogs/${blogId}/posts?status=draft`, { headers: { Authorization: `Bearer ${apiKey}` } })
    const body = await res.json() as { posts: { slug: string }[] }
    expect(body.posts.map((p) => p.slug)).toEqual(['d1'])
  })

  it('list: invalid ?status → 400', async () => {
    const res = await app.request(`/blogs/${blogId}/posts?status=scheduled`, { headers: { Authorization: `Bearer ${apiKey}` } })
    expect(res.status).toBe(400)
  })

  it('single: returns the post + _links', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/p2`, { headers: { Authorization: `Bearer ${apiKey}` } })
    expect(res.status).toBe(200)
    const body = await res.json() as { post: { slug: string }; _links: Record<string, string> }
    expect(body.post.slug).toBe('p2')
    expect(body._links.publish).toBe(`/blogs/${blogId}/posts`)
  })

  it('single: POST_NOT_FOUND for unknown slug', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/ghost`, { headers: { Authorization: `Bearer ${apiKey}` } })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('POST_NOT_FOUND')
  })
})
```

- [ ] **Step 19.2: Run and see failures**

```bash
pnpm test tests/api/posts-read.test.ts
```

Expected: 404 on list and single.

- [ ] **Step 19.3: Add the routes**

In `src/api/routes.ts`, add imports:

```ts
import { getPost, listPosts } from '../posts.js'
```

Add a small Zod validator for the `?status` query param (reuse existing shape). Define at the top of `routes.ts` after imports:

```ts
const StatusQuerySchema = z.enum(['draft', 'published']).optional()
```

Add the routes:

```ts
  // List posts
  app.get('/blogs/:id/posts', (c) => {
    const status = StatusQuerySchema.parse(c.req.query('status'))
    const posts = listPosts(config.store, c.var.blog.id, status !== undefined ? { status } : undefined)
    return c.json({ posts, _links: buildLinks(c.var.blog, config) })
  })

  // Single post
  app.get('/blogs/:id/posts/:slug', (c) => {
    const post = getPost(config.store, c.var.blog.id, c.req.param('slug'))
    return c.json({ post, _links: buildLinks(c.var.blog, config) })
  })
```

- [ ] **Step 19.4: Verify**

```bash
pnpm typecheck && pnpm test tests/api/posts-read.test.ts
```

Expected: clean; all 5 tests pass.

- [ ] **Step 19.5: Commit**

```bash
git add src/api/routes.ts tests/api/posts-read.test.ts
git commit -m "Add GET /blogs/:id/posts list + single with status filter"
```

---

### Task 20: PATCH /blogs/:id/posts/:slug

**Files:**
- Modify: `src/api/routes.ts`
- Create: `tests/api/posts-update.test.ts`

- [ ] **Step 20.1: Write failing tests**

Create `tests/api/posts-update.test.ts`:

```ts
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'
import { createPost } from '../../src/posts.js'

describe('PATCH /blogs/:id/posts/:slug', () => {
  let dir: string; let store: Store
  let apiKey: string; let blogId: string; let slug: string
  let outDir: string; let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-post-update-'))
    outDir = join(dir, 'out')
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({ store, outputDir: outDir, baseUrl: 'https://b.example' })
    app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const blog = createBlog(store, { name: 'b' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    const post = createPost(store, renderer, blogId, { title: 'Orig', body: 'b' }).post
    slug = post.slug
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('patches title; returns updated post + post_url + _links', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/${slug}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Edited' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { post: { title: string }; post_url?: string; _links: Record<string, string> }
    expect(body.post.title).toBe('Edited')
    expect(body.post_url).toMatch(/^https:\/\/b\.example\/.+\/$/)
  })

  it('published → draft: removes post files', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/${slug}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'draft' }),
    })
    expect(res.status).toBe(200)
    expect(existsSync(join(outDir, blogId, slug))).toBe(false)
  })

  it('rejects slug in the patch with 400', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/${slug}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'renamed' }),
    })
    expect(res.status).toBe(400)
  })

  it('404 POST_NOT_FOUND for unknown slug', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/ghost`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 20.2: Run and see failures**

```bash
pnpm test tests/api/posts-update.test.ts
```

Expected: 404.

- [ ] **Step 20.3: Add the route**

In `src/api/routes.ts`, add `updatePost` to the posts import:

```ts
import { createPost, getPost, listPosts, updatePost } from '../posts.js'
```

Add the route:

```ts
  // Patch post
  app.patch('/blogs/:id/posts/:slug', async (c) => {
    const renderer = config.rendererFor(c.var.blog)
    const raw = await c.req.json().catch(() => ({}))
    const { post, postUrl } = updatePost(config.store, renderer, c.var.blog.id, c.req.param('slug'), raw)
    return c.json({
      post,
      ...(postUrl !== undefined ? { post_url: postUrl } : {}),
      _links: buildLinks(c.var.blog, config),
    })
  })
```

Note: `updatePost` internally parses via `PostPatchSchema.parse` (which has `.strict()`), so the 400 on unknown `slug` key comes through the ZodError path in `errorMiddleware`.

- [ ] **Step 20.4: Verify**

```bash
pnpm typecheck && pnpm test tests/api/posts-update.test.ts
```

Expected: clean; all 4 tests pass.

- [ ] **Step 20.5: Commit**

```bash
git add src/api/routes.ts tests/api/posts-update.test.ts
git commit -m "Add PATCH /blogs/:id/posts/:slug"
```

---

### Task 21: DELETE /blogs/:id/posts/:slug

**Files:**
- Modify: `src/api/routes.ts`
- Create: `tests/api/posts-delete.test.ts`

- [ ] **Step 21.1: Write failing tests**

Create `tests/api/posts-delete.test.ts`:

```ts
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'
import { createPost } from '../../src/posts.js'

describe('DELETE /blogs/:id/posts/:slug', () => {
  let dir: string; let store: Store
  let apiKey: string; let blogId: string; let slug: string
  let outDir: string; let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-post-delete-'))
    outDir = join(dir, 'out')
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({ store, outputDir: outDir, baseUrl: 'https://b.example' })
    app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })
    const blog = createBlog(store, { name: 'b' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    const post = createPost(store, renderer, blogId, { title: 'T', body: 'b' }).post
    slug = post.slug
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes the post + files and returns { deleted: true, _links }', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/${slug}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { deleted: boolean; _links: Record<string, string> }
    expect(body.deleted).toBe(true)
    expect(body._links.view).toBe('https://b.example')
    expect(existsSync(join(outDir, blogId, slug))).toBe(false)
  })

  it('404 POST_NOT_FOUND for unknown slug', async () => {
    const res = await app.request(`/blogs/${blogId}/posts/ghost`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(404)
  })

  it('Idempotency-Key replays', async () => {
    const headers = { Authorization: `Bearer ${apiKey}`, 'Idempotency-Key': 'del-k1' }
    const r1 = await app.request(`/blogs/${blogId}/posts/${slug}`, { method: 'DELETE', headers })
    const r2 = await app.request(`/blogs/${blogId}/posts/${slug}`, { method: 'DELETE', headers })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(await r1.json()).toEqual(await r2.json())
  })
})
```

- [ ] **Step 21.2: Run and see failures**

```bash
pnpm test tests/api/posts-delete.test.ts
```

Expected: 404.

- [ ] **Step 21.3: Add the route**

In `src/api/routes.ts`, add `deletePost` to the posts import:

```ts
import { createPost, deletePost, getPost, listPosts, updatePost } from '../posts.js'
```

Add the route:

```ts
  // Delete post
  app.delete('/blogs/:id/posts/:slug', (c) => {
    const renderer = config.rendererFor(c.var.blog)
    const result = deletePost(config.store, renderer, c.var.blog.id, c.req.param('slug'))
    return c.json({ ...result, _links: buildLinks(c.var.blog, config) })
  })
```

- [ ] **Step 21.4: Verify**

```bash
pnpm typecheck && pnpm test tests/api/posts-delete.test.ts
```

Expected: clean; all 3 tests pass.

- [ ] **Step 21.5: Commit**

```bash
git add src/api/routes.ts tests/api/posts-delete.test.ts
git commit -m "Add DELETE /blogs/:id/posts/:slug"
```

---

### Task 22: Expose public API

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 22.1: Update the barrel**

Replace the contents of `src/index.ts`:

```ts
// Public surface of @slopit/core. Keep this file small and deliberate —
// every export here is a promise to consumers. See ARCHITECTURE.md.

export { createStore } from './db/store.js'
export type { Store, StoreConfig } from './db/store.js'

export * from './schema/index.js'

// Blog primitives
export { createBlog, createApiKey, getBlog } from './blogs.js'

// Post primitives
export { createPost, updatePost, deletePost, getPost, listPosts } from './posts.js'

// Auth
export { verifyApiKey } from './auth/api-key.js'

// Errors
export { SlopItError } from './errors.js'
export type { SlopItErrorCode } from './errors.js'

// Rendering
export { createRenderer } from './rendering/generator.js'
export type { Renderer, MutationRenderer, RendererConfig } from './rendering/generator.js'

// REST router factory
export { createApiRouter } from './api/index.js'
export type { ApiRouterConfig } from './api/index.js'

// Generators (pure; platform serves, core produces)
export { generateOnboardingBlock } from './onboarding.js'
export type { OnboardingInputs } from './onboarding.js'
export { generateSkillFile } from './skill.js'

// MCP stub — kept exported per v2.1 spec P2 fix. feat/mcp-tools replaces
// the stub body with the real implementation.
export { createMcpServer } from './mcp/server.js'
export type { McpServerConfig } from './mcp/server.js'
```

- [ ] **Step 22.2: Verify all public exports resolve**

```bash
pnpm typecheck && pnpm test
```

Expected: all existing tests still pass, no new failures.

- [ ] **Step 22.3: Commit**

```bash
git add src/index.ts
git commit -m "Expand public barrel: new primitives, router factory, generators"
```

---

### Task 23: Cross-blog `rendererFor` leakage integration test

**Files:**
- Create: `tests/api/multi-blog-renderer.test.ts`

This is the test that verifies decision #19's core promise: a shared router serving two distinct blogs never cross-contaminates URLs in response bodies or rendered files.

- [ ] **Step 23.1: Write the test**

Create `tests/api/multi-blog-renderer.test.ts`:

```ts
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiRouter } from '../../src/api/index.js'
import { createRenderer, type MutationRenderer } from '../../src/rendering/generator.js'
import { createBlog, createApiKey } from '../../src/blogs.js'
import type { Blog } from '../../src/schema/index.js'

describe('rendererFor(blog): no cross-blog URL leakage', () => {
  let dir: string; let store: Store
  let renderers: Map<string, MutationRenderer>
  let app: ReturnType<typeof createApiRouter>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-multi-blog-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    renderers = new Map()
    app = createApiRouter({
      store,
      baseUrl: 'https://api.example',
      rendererFor: (blog: Blog) => {
        const cached = renderers.get(blog.id)
        if (cached) return cached
        // NOTE: createRenderer nests output under {outputDir}/{blogId}/
        // internally — pass the shared parent here, not a per-blog subdir.
        // Per-blog differentiation is baseUrl, not outputDir.
        const outDir = join(dir, 'out')
        const url = blog.name === 'alpha' ? 'https://alpha.example' : 'https://beta.example'
        const r = createRenderer({ store, outputDir: outDir, baseUrl: url })
        renderers.set(blog.id, r)
        return r
      },
    })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('two blogs, two distinct renderers: post_url, _links.view, and rendered canonical URLs all stay correct per blog', async () => {
    const alpha = createBlog(store, { name: 'alpha' }).blog
    const beta = createBlog(store, { name: 'beta' }).blog
    const keyA = createApiKey(store, alpha.id).apiKey
    const keyB = createApiKey(store, beta.id).apiKey

    // Publish a post to each blog
    const resA = await app.request(`/blogs/${alpha.id}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alpha post', body: 'hello alpha' }),
    })
    const bodyA = await resA.json() as { post: { slug: string }; post_url: string; _links: Record<string, string> }
    expect(bodyA.post_url).toMatch(/^https:\/\/alpha\.example\//)
    expect(bodyA._links.view).toBe('https://alpha.example')

    const resB = await app.request(`/blogs/${beta.id}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Beta post', body: 'hello beta' }),
    })
    const bodyB = await resB.json() as { post: { slug: string }; post_url: string; _links: Record<string, string> }
    expect(bodyB.post_url).toMatch(/^https:\/\/beta\.example\//)
    expect(bodyB._links.view).toBe('https://beta.example')

    // Confirm rendered files: each blog's post HTML references only its own canonical URL
    const alphaPostHtml = readFileSync(join(dir, 'out', alpha.id, bodyA.post.slug, 'index.html'), 'utf8')
    expect(alphaPostHtml).toContain('https://alpha.example/')
    expect(alphaPostHtml).not.toContain('https://beta.example')

    const betaPostHtml = readFileSync(join(dir, 'out', beta.id, bodyB.post.slug, 'index.html'), 'utf8')
    expect(betaPostHtml).toContain('https://beta.example/')
    expect(betaPostHtml).not.toContain('https://alpha.example')

    // Read-side: GET /blogs/:id returns the right view URL
    const getA = await app.request(`/blogs/${alpha.id}`, { headers: { Authorization: `Bearer ${keyA}` } })
    const getABody = await getA.json() as { _links: Record<string, string> }
    expect(getABody._links.view).toBe('https://alpha.example')

    const getB = await app.request(`/blogs/${beta.id}`, { headers: { Authorization: `Bearer ${keyB}` } })
    const getBBody = await getB.json() as { _links: Record<string, string> }
    expect(getBBody._links.view).toBe('https://beta.example')
  })

  it('cross-blog access: alpha key used for beta id → 404 (no URL leaks either way)', async () => {
    const alpha = createBlog(store, { name: 'alpha' }).blog
    const beta = createBlog(store, { name: 'beta' }).blog
    const keyA = createApiKey(store, alpha.id).apiKey

    const res = await app.request(`/blogs/${beta.id}`, { headers: { Authorization: `Bearer ${keyA}` } })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string; details: Record<string, unknown> } }
    expect(body.error.code).toBe('BLOG_NOT_FOUND')
    // Response must not contain either blog's public URL
    const raw = await res.clone().text()
    expect(raw).not.toContain('alpha.example')
    expect(raw).not.toContain('beta.example')
  })
})
```

- [ ] **Step 23.2: Run**

```bash
pnpm test tests/api/multi-blog-renderer.test.ts
```

Expected: both tests pass. If they don't, it reveals an rendererFor plumbing bug that must be fixed in the relevant earlier task — do NOT paper over the failure here.

- [ ] **Step 23.3: Commit**

```bash
git add tests/api/multi-blog-renderer.test.ts
git commit -m "Integration test: rendererFor(blog) — no cross-blog URL leakage"
```

---

### Task 24: SKILL.md endpoint-parity test + final verification

**Files:**
- Modify: `tests/skill.test.ts`

- [ ] **Step 24.1: Add parity test**

Append to `tests/skill.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/db/store.js'
import { createRenderer } from '../src/rendering/generator.js'
import { createApiRouter } from '../src/api/index.js'

describe('SKILL.md endpoint parity with createApiRouter', () => {
  it('every route mounted by createApiRouter appears in the SKILL.md endpoints table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slopit-skill-parity-'))
    const store = createStore({ dbPath: join(dir, 'p.db') })
    const renderer = createRenderer({ store, outputDir: join(dir, 'out'), baseUrl: 'https://x' })
    const app = createApiRouter({ store, rendererFor: () => renderer, baseUrl: 'https://api.example' })

    // Extract Hono's routes list. Each has method + path.
    const routes = app.routes
      .filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path}`)

    const skill = generateSkillFile({ baseUrl: 'https://api.example' })
    for (const route of new Set(routes)) {
      expect(skill, `SKILL.md missing route ${route}`).toContain(route)
    }

    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 24.2: Run the parity test**

```bash
pnpm test tests/skill.test.ts
```

Expected: all tests pass, including the new parity test. If it fails naming a specific route not in SKILL.md, update the SKILL.md endpoint table in `src/skill.ts` to include it — drift is a bug.

- [ ] **Step 24.3: Full-suite verification**

```bash
pnpm typecheck
pnpm test
pnpm test:coverage
```

Expected:
- `pnpm typecheck`: no errors
- `pnpm test`: all tests pass (previous 176 + new test files; should land in the 280–320 range total)
- `pnpm test:coverage`: new modules (`src/api/*`, `src/onboarding.ts`, `src/skill.ts`, new code in `src/posts.ts`, `src/blogs.ts`, `src/auth/api-key.ts`) at ≥95% line + branch coverage

If coverage dips below 95% on any new module, add the missing tests before proceeding.

- [ ] **Step 24.4: Commit parity test**

```bash
git add tests/skill.test.ts
git commit -m "Add SKILL.md endpoint-parity test against createApiRouter routes"
```

- [ ] **Step 24.5: Final sanity — run the happy-path from the spec**

One last manual smoke: open a Node REPL (or write a throwaway `scripts/smoke.ts` — don't commit it) and run:

```ts
import { createStore, createRenderer, createApiRouter } from '@slopit/core'
// (using src paths directly via ts-node or similar, not the built package)
```

Actually the easier check is to confirm the signup happy-path test in `tests/api/signup.test.ts` exercises the full `content → live URL` loop, which it does. No separate smoke needed.

---

## Done

After Task 24 completes:

- All 24 tasks committed on `feat/rest-routes-mcp`.
- `pnpm typecheck` clean.
- `pnpm test` green, total count ≈ 280–320 tests.
- `pnpm test:coverage` shows ≥95% on new modules.
- `src/index.ts` exports the full public surface per spec decision #16 + #17.
- MCP stub at `src/mcp/server.ts` untouched.

Next steps (not in this plan):

1. PR `feat/rest-routes-mcp` → `dev`. PR body summarizes what landed + links the spec + lists the 24 commits.
2. Dev review round.
3. Merge when green.
4. `feat/mcp-tools` opens against `dev` — replaces `createMcpServer` stub body, adds `tests/mcp/*`, updates SKILL.md generator with the MCP tools section.
