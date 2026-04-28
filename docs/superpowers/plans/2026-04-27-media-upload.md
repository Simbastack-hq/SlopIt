# Media Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add image upload to SlopIt so an agent can publish a blog post with photos in one conversation. Two-step flow: REST/MCP upload returns a public URL; agent references that URL in the post markdown body and/or `coverImage`.

**Architecture:** New `src/media.ts` primitive shared by REST and MCP, mirroring how `src/posts.ts` is shared today. Bytes live on disk under `<blog-output>/_media/<id>.<ext>`, served by the same static handler as rendered HTML. DB-first ordering with compensation, matching `posts.ts`. Per-blog quota enforced in-transaction. Default unlimited in core; platform overrides via factory config.

**Tech Stack:** TypeScript (strict), Node.js, Hono (REST), `@modelcontextprotocol/sdk` (MCP), `better-sqlite3`, Zod, Vitest.

**Spec:** [docs/superpowers/specs/2026-04-27-media-upload-design.md](../specs/2026-04-27-media-upload-design.md). Read the spec before starting — every "why" question is answered there.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/db/migrations/005_media.sql` | Create | `media` table + index |
| `src/errors.ts` | Modify | Add 4 new `SlopItErrorCode` values |
| `src/envelope.ts` | Modify | Add 4 new entries to `CODE_TO_STATUS` |
| `src/rendering/generator.ts` | Modify | Extend `MutationRenderer` with `mediaDir(blogId)`; implement |
| `src/media.ts` | Create | Pure primitive: `uploadMedia`, `listMedia`, `getMedia`, `deleteMedia` |
| `src/api/idempotency.ts` | Modify | Replace `text()` with `arrayBuffer()`; hash bytes |
| `src/api/index.ts` | Modify | Add `mediaMaxBytes` / `mediaMaxTotalBytesPerBlog` to `ApiRouterConfig` |
| `src/api/routes.ts` | Modify | Mount 4 media endpoints |
| `src/api/links.ts` | Modify | Add `upload_media`, `list_media` to `LinksBlock` |
| `src/mcp/server.ts` | Modify | Add same fields to `McpServerConfig` |
| `src/mcp/tools.ts` | Modify | Register `upload_media`, `list_media`, `delete_media` |
| `src/skill.ts` | Modify | Document new endpoints, tools, error codes, "Posts with images" section |
| `src/index.ts` | Modify | Re-export anything new that platform/self-hosters need |
| `tests/media.test.ts` | Create | Unit tests for the primitive |
| `tests/api/media.test.ts` | Create | REST endpoint tests |
| `tests/mcp/media.test.ts` | Create | MCP tool tests |
| `tests/idempotency-binary.test.ts` | Create | Regression test for binary-safe idempotency |
| `tests/links.test.ts` | Modify | Add new `_links` fields |
| `tests/skill.test.ts` | Modify | Drift tests for new content |
| `PRODUCT_BRIEF.md` | Modify | Remove "No image hosting" v1 non-goal line |

---

## Task 1: DB migration — `media` table

**Files:**
- Create: `src/db/migrations/005_media.sql`

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/005_media.sql`:

```sql
CREATE TABLE media (
  id           TEXT PRIMARY KEY,
  blog_id      TEXT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_media_blog ON media(blog_id);
```

- [ ] **Step 2: Verify the migration applies cleanly**

Run: `pnpm test tests/smoke.test.ts -- --run`
Expected: PASS. The store auto-runs migrations on init; smoke test covers store creation. If it fails with "table media already exists" or syntax errors, fix the SQL.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/005_media.sql
git commit -m "feat(db): add media table migration"
```

---

## Task 2: Add new error codes

**Files:**
- Modify: `src/errors.ts:1-9`
- Modify: `src/envelope.ts:11-20`
- Test: `tests/errors.test.ts` (existing — extend if it covers code → status mapping; otherwise inline assertions in later tasks cover it)

- [ ] **Step 1: Extend `SlopItErrorCode` union**

Edit `src/errors.ts`. Note: `BAD_REQUEST` is added too — today it's only produced by `mapErrorToEnvelope(SyntaxError)` and is NOT a first-class union member. The new media boundary-parse cases (no `file` field, multiple `file` fields, empty base64, etc.) need to throw `new SlopItError('BAD_REQUEST', …)`, so it must be in the union.

```ts
export type SlopItErrorCode =
  | 'BAD_REQUEST'
  | 'BLOG_NAME_CONFLICT'
  | 'BLOG_NAME_RESERVED'
  | 'BLOG_NOT_FOUND'
  | 'POST_SLUG_CONFLICT'
  | 'POST_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'NOT_IMPLEMENTED'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_TYPE_UNSUPPORTED'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_QUOTA_EXCEEDED'
```

- [ ] **Step 2: Run type-check to confirm `CODE_TO_STATUS` is now incomplete**

Run: `pnpm typecheck`
Expected: FAIL with errors about `CODE_TO_STATUS` missing keys for `BAD_REQUEST` and the four new MEDIA_* codes (the `Record<SlopItErrorCode, number>` type forces it).

- [ ] **Step 3: Add status mappings**

Edit `src/envelope.ts`, replace the `CODE_TO_STATUS` constant:

```ts
const CODE_TO_STATUS: Record<SlopItErrorCode, number> = {
  BAD_REQUEST: 400,
  BLOG_NAME_CONFLICT: 409,
  BLOG_NAME_RESERVED: 400,
  BLOG_NOT_FOUND: 404,
  POST_SLUG_CONFLICT: 409,
  POST_NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  IDEMPOTENCY_KEY_CONFLICT: 422,
  NOT_IMPLEMENTED: 501,
  MEDIA_NOT_FOUND: 404,
  MEDIA_TYPE_UNSUPPORTED: 400,
  MEDIA_TOO_LARGE: 413,
  MEDIA_QUOTA_EXCEEDED: 413,
}
```

The existing `mapErrorToEnvelope` `SyntaxError` branch (which hand-rolls a `BAD_REQUEST` envelope) keeps working unchanged — it still emits the same envelope without going through `CODE_TO_STATUS`. The new entry only matters when `BAD_REQUEST` is thrown explicitly via `new SlopItError('BAD_REQUEST', ...)`.

- [ ] **Step 4: Run type-check, expect PASS**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts src/envelope.ts
git commit -m "feat(errors): add MEDIA_* error codes"
```

---

## Task 3: Extend `MutationRenderer` with `mediaDir(blogId)`

**Files:**
- Modify: `src/rendering/generator.ts:30-38` (interface) and `:142-211` (implementation)
- Test: `tests/rendering.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/rendering.test.ts` (alongside existing renderer tests):

```ts
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
// ... existing imports for createRenderer + test helpers ...

describe('MutationRenderer.mediaDir', () => {
  it('returns <outputDir>/<blogId>/_media without creating the directory', () => {
    const { renderer, outputDir } = makeRenderer() // existing helper, or build inline
    const got = renderer.mediaDir('blog_abc123')
    expect(got).toBe(join(outputDir, 'blog_abc123', '_media'))
  })
})
```

If `makeRenderer()` doesn't exist yet, build inline using `createRenderer({ store: testStore, outputDir: '/tmp/test-' + Date.now(), baseUrl: 'http://x/' })`.

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm test tests/rendering.test.ts -- --run`
Expected: FAIL — `renderer.mediaDir is not a function` or compile error.

- [ ] **Step 3: Extend the interface**

Edit `src/rendering/generator.ts`, replace the `MutationRenderer` interface block:

```ts
export interface MutationRenderer extends Renderer {
  /**
   * Remove the post directory for (blogId, slug). ENOENT-tolerant —
   * a missing directory is the desired end state and should not throw.
   * Hard I/O failures (EACCES, EIO) SHOULD throw so callers can apply
   * compensation.
   */
  removePostFiles(blogId: string, slug: string): void
  /**
   * Absolute path to the blog's media directory
   * (`<outputDir>/<blogId>/_media`). Pure path computation — does not
   * create the directory. Callers `mkdirSync(dir, { recursive: true })`
   * on first write.
   */
  mediaDir(blogId: string): string
}
```

- [ ] **Step 4: Implement on the shipped renderer**

Edit `src/rendering/generator.ts`, in `createRenderer` add the method to the returned object (alongside `removePostFiles`):

```ts
    removePostFiles(blogId, slug) {
      rmSync(join(config.outputDir, blogId, slug), { recursive: true, force: true })
    },
    mediaDir(blogId) {
      return join(config.outputDir, blogId, '_media')
    },
```

- [ ] **Step 5: Run, expect PASS**

Run: `pnpm test tests/rendering.test.ts -- --run`
Expected: PASS.

- [ ] **Step 6: Run typecheck for any test-double consumers**

Run: `pnpm typecheck`
Expected: PASS. If any test file declares its own fake `MutationRenderer` (search for `removePostFiles:` in `tests/`), update those doubles to add `mediaDir: () => '/tmp/fake-media'` or similar so the type still satisfies.

- [ ] **Step 7: Commit**

```bash
git add src/rendering/generator.ts tests/rendering.test.ts
# include any test-double fixes from step 6:
# git add tests/<files>
git commit -m "feat(renderer): add mediaDir(blogId) to MutationRenderer"
```

---

## Task 4: `src/media.ts` — uploadMedia (validation + atomicity + quota)

**Files:**
- Create: `src/media.ts`
- Test: `tests/media.test.ts`

- [ ] **Step 1: Write the failing test for the happy path**

Create `tests/media.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../src/db/store.js'
import { createRenderer } from '../src/rendering/generator.js'
import { uploadMedia } from '../src/media.js'
import type { Blog } from '../src/schema/index.js'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function makeFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'slopit-media-'))
  const store = createStore({ dbPath: join(dir, 'test.db') })
  store.db
    .prepare(
      "INSERT INTO blogs (id, name, theme, created_at) VALUES (?, ?, 'minimal', datetime('now'))",
    )
    .run('blog_test', 'test')
  const blog: Blog = { id: 'blog_test', name: 'test', theme: 'minimal', createdAt: '' } as Blog
  const renderer = createRenderer({
    store,
    outputDir: join(dir, 'out'),
    baseUrl: 'https://test.example/',
  })
  return { store, renderer, blog, dir }
}

describe('uploadMedia', () => {
  it('writes a row, writes the file, and returns an absolute URL', () => {
    const { store, renderer, blog } = makeFixtures()
    const result = uploadMedia(
      store,
      renderer,
      { maxBytes: 5_000_000, maxTotalBytesPerBlog: null },
      blog,
      { filename: 'photo.png', contentType: 'image/png', bytes: new Uint8Array(PNG_BYTES) },
    )

    expect(result.id).toMatch(/^[a-z0-9]+$/i)
    expect(result.contentType).toBe('image/png')
    expect(result.bytes).toBe(PNG_BYTES.length)
    expect(result.url).toBe('https://test.example/_media/' + result.id + '.png')

    const row = store.db.prepare('SELECT * FROM media WHERE id = ?').get(result.id) as {
      blog_id: string
      filename: string
    }
    expect(row.blog_id).toBe('blog_test')
    expect(row.filename).toBe('photo.png')

    const filePath = join(renderer.mediaDir('blog_test'), result.id + '.png')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath).equals(PNG_BYTES)).toBe(true)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm test tests/media.test.ts -- --run`
Expected: FAIL — `Cannot find module '../src/media.js'` or similar.

- [ ] **Step 3: Create the primitive**

Create `src/media.ts`:

```ts
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from './db/store.js'
import { SlopItError } from './errors.js'
import { generateShortId } from './ids.js'
import type { MutationRenderer } from './rendering/generator.js'
import type { Blog } from './schema/index.js'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
type AllowedType = (typeof ALLOWED_TYPES)[number]

const EXT_BY_TYPE: Record<AllowedType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export interface MediaRow {
  id: string
  blogId: string
  filename: string
  contentType: AllowedType
  bytes: number
  createdAt: string
}

export interface MediaWithUrl extends MediaRow {
  url: string
}

export interface MediaLimits {
  maxBytes: number
  maxTotalBytesPerBlog: number | null
}

export interface UploadInput {
  filename: string
  contentType: string
  bytes: Uint8Array
}

function isAllowed(ct: string): ct is AllowedType {
  return (ALLOWED_TYPES as readonly string[]).includes(ct)
}

function urlFor(renderer: MutationRenderer, row: MediaRow): string {
  return renderer.baseUrl + '_media/' + row.id + '.' + EXT_BY_TYPE[row.contentType]
}

export function uploadMedia(
  store: Store,
  renderer: MutationRenderer,
  limits: MediaLimits,
  blog: Blog,
  input: UploadInput,
): MediaWithUrl {
  if (!isAllowed(input.contentType)) {
    throw new SlopItError(
      'MEDIA_TYPE_UNSUPPORTED',
      `Unsupported content_type "${input.contentType}". Allowed: ${ALLOWED_TYPES.join(', ')}.`,
      { content_type: input.contentType, allowed: [...ALLOWED_TYPES] },
    )
  }
  if (input.bytes.length === 0) {
    throw new SlopItError('MEDIA_TOO_LARGE', 'File is empty', { bytes: 0 })
  }
  if (input.bytes.length > limits.maxBytes) {
    throw new SlopItError(
      'MEDIA_TOO_LARGE',
      `File exceeds per-file cap of ${limits.maxBytes} bytes`,
      { max_bytes: limits.maxBytes, bytes: input.bytes.length },
    )
  }

  const id = generateShortId()
  const contentType = input.contentType
  const ext = EXT_BY_TYPE[contentType]
  const now = new Date().toISOString()

  // DB-first transaction (matches posts.ts). Quota check inside.
  const tx = store.db.transaction(() => {
    if (limits.maxTotalBytesPerBlog !== null) {
      const usedRow = store.db
        .prepare('SELECT IFNULL(SUM(bytes), 0) AS used FROM media WHERE blog_id = ?')
        .get(blog.id) as { used: number }
      if (usedRow.used + input.bytes.length > limits.maxTotalBytesPerBlog) {
        throw new SlopItError(
          'MEDIA_QUOTA_EXCEEDED',
          'Blog media quota exhausted',
          { used_bytes: usedRow.used, quota_bytes: limits.maxTotalBytesPerBlog },
        )
      }
    }
    store.db
      .prepare(
        `INSERT INTO media (id, blog_id, filename, content_type, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, blog.id, input.filename, contentType, input.bytes.length, now)
  })
  tx()

  // File write with compensation on failure (matches posts.ts pattern).
  const dir = renderer.mediaDir(blog.id)
  const finalPath = join(dir, id + '.' + ext)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(finalPath, input.bytes)
  } catch (writeErr) {
    try {
      store.db.prepare('DELETE FROM media WHERE id = ?').run(id)
    } catch {
      /* best-effort */
    }
    try {
      unlinkSync(finalPath)
    } catch {
      /* best-effort */
    }
    throw writeErr
  }

  const row: MediaRow = {
    id,
    blogId: blog.id,
    filename: input.filename,
    contentType,
    bytes: input.bytes.length,
    createdAt: now,
  }
  return { ...row, url: urlFor(renderer, row) }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test tests/media.test.ts -- --run`
Expected: PASS.

- [ ] **Step 5: Add unsupported-type test**

Append to `tests/media.test.ts`:

```ts
  it('rejects an unsupported content_type with MEDIA_TYPE_UNSUPPORTED', () => {
    const { store, renderer, blog } = makeFixtures()
    expect(() =>
      uploadMedia(
        store,
        renderer,
        { maxBytes: 5_000_000, maxTotalBytesPerBlog: null },
        blog,
        { filename: 'doc.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) },
      ),
    ).toThrow(/MEDIA_TYPE_UNSUPPORTED|Unsupported content_type/)
  })
```

- [ ] **Step 6: Run, expect PASS**

Run: `pnpm test tests/media.test.ts -- --run`
Expected: PASS.

- [ ] **Step 7: Add too-large test**

Append:

```ts
  it('rejects bytes over maxBytes with MEDIA_TOO_LARGE', () => {
    const { store, renderer, blog } = makeFixtures()
    expect(() =>
      uploadMedia(
        store,
        renderer,
        { maxBytes: 4, maxTotalBytesPerBlog: null },
        blog,
        { filename: 'big.png', contentType: 'image/png', bytes: new Uint8Array(PNG_BYTES) },
      ),
    ).toThrow(/MEDIA_TOO_LARGE|exceeds per-file cap/)
  })
```

- [ ] **Step 8: Run, expect PASS**

Run: `pnpm test tests/media.test.ts -- --run`

- [ ] **Step 9: Add quota-exceeded test**

Append:

```ts
  it('rejects upload past per-blog quota with MEDIA_QUOTA_EXCEEDED', () => {
    const { store, renderer, blog } = makeFixtures()
    const limits = { maxBytes: 5_000_000, maxTotalBytesPerBlog: 16 }
    uploadMedia(store, renderer, limits, blog, {
      filename: 'a.png',
      contentType: 'image/png',
      bytes: new Uint8Array(PNG_BYTES),
    })
    expect(() =>
      uploadMedia(store, renderer, limits, blog, {
        filename: 'b.png',
        contentType: 'image/png',
        bytes: new Uint8Array(PNG_BYTES),
      }),
    ).toThrow(/MEDIA_QUOTA_EXCEEDED/)
  })
```

- [ ] **Step 10: Run, expect PASS**

Run: `pnpm test tests/media.test.ts -- --run`

- [ ] **Step 11: Add atomicity test (post-INSERT failure → DB row rolled back)**

Append. **Why a stub renderer instead of `vi.spyOn(fs, 'writeFileSync')`:** `src/media.ts` imports `writeFileSync` as a named binding. In ESM, named bindings are live but read-only — `vi.spyOn(fs, 'writeFileSync')` mutates the namespace object after import, which doesn't reach the already-resolved binding inside `media.ts`, so the spy may not fire. Instead, we wrap the real renderer with a thin proxy whose `mediaDir()` returns a path that makes `mkdirSync` fail (a regular file pretending to be a directory parent → `ENOTDIR`). The compensation block triggers the same way regardless of which post-INSERT step throws.

```ts
import { writeFileSync as fsWriteFileSync } from 'node:fs'

  it('rolls back the DB row when post-INSERT file work fails', () => {
    const { store, renderer, blog, dir } = makeFixtures()
    // Plant a regular file where the media dir would live, so mkdirSync
    // hits ENOTDIR on a path component.
    fsWriteFileSync(join(dir, 'out', 'blog_test'), 'i-am-a-file-not-a-dir')

    expect(() =>
      uploadMedia(
        store,
        renderer,
        { maxBytes: 5_000_000, maxTotalBytesPerBlog: null },
        blog,
        { filename: 'a.png', contentType: 'image/png', bytes: new Uint8Array(PNG_BYTES) },
      ),
    ).toThrow(/ENOTDIR|Not a directory|EEXIST/i)

    const count = store.db
      .prepare('SELECT COUNT(*) as c FROM media WHERE blog_id = ?')
      .get('blog_test') as { c: number }
    expect(count.c).toBe(0)
  })
```

If the harness `mkdtempSync` parent makes the planted-file approach awkward (e.g. `out/` doesn't exist yet when the test runs), pre-create the parent: `mkdirSync(join(dir, 'out'), { recursive: true })` before planting the blocker file.

- [ ] **Step 12: Run, expect PASS**

Run: `pnpm test tests/media.test.ts -- --run`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add src/media.ts tests/media.test.ts
git commit -m "feat(media): uploadMedia primitive with validation, quota, atomicity"
```

---

## Task 5: `src/media.ts` — listMedia, getMedia, deleteMedia

**Files:**
- Modify: `src/media.ts`
- Modify: `tests/media.test.ts`

- [ ] **Step 1: Write failing tests for read operations**

Append to `tests/media.test.ts`:

```ts
import { listMedia, getMedia, deleteMedia } from '../src/media.js'

describe('listMedia / getMedia / deleteMedia', () => {
  it('lists media for the blog newest-first', () => {
    const { store, renderer, blog } = makeFixtures()
    const a = uploadMedia(store, renderer, { maxBytes: 5_000_000, maxTotalBytesPerBlog: null }, blog, {
      filename: 'a.png', contentType: 'image/png', bytes: new Uint8Array(PNG_BYTES),
    })
    const b = uploadMedia(store, renderer, { maxBytes: 5_000_000, maxTotalBytesPerBlog: null }, blog, {
      filename: 'b.png', contentType: 'image/png', bytes: new Uint8Array(PNG_BYTES),
    })
    const list = listMedia(store, renderer, blog.id)
    expect(list.map((m) => m.id)).toEqual([b.id, a.id])
    expect(list[0].url).toMatch(/^https:\/\/test\.example\/_media\//)
  })

  it('getMedia returns single row by id; throws MEDIA_NOT_FOUND for unknown id', () => {
    const { store, renderer, blog } = makeFixtures()
    const a = uploadMedia(store, renderer, { maxBytes: 5_000_000, maxTotalBytesPerBlog: null }, blog, {
      filename: 'a.png', contentType: 'image/png', bytes: new Uint8Array(PNG_BYTES),
    })
    expect(getMedia(store, renderer, blog.id, a.id).filename).toBe('a.png')
    expect(() => getMedia(store, renderer, blog.id, 'nope')).toThrow(/MEDIA_NOT_FOUND/)
  })

  it('deleteMedia removes the row and the file; ENOENT-tolerant', () => {
    const { store, renderer, blog } = makeFixtures()
    const a = uploadMedia(store, renderer, { maxBytes: 5_000_000, maxTotalBytesPerBlog: null }, blog, {
      filename: 'a.png', contentType: 'image/png', bytes: new Uint8Array(PNG_BYTES),
    })
    const filePath = join(renderer.mediaDir(blog.id), a.id + '.png')
    // Pre-delete the file: deleteMedia must still succeed
    require('node:fs').unlinkSync(filePath)
    expect(deleteMedia(store, renderer, blog.id, a.id)).toEqual({ deleted: true })
    expect(store.db.prepare('SELECT COUNT(*) c FROM media WHERE id = ?').get(a.id)).toEqual({ c: 0 })
  })

  it('deleteMedia throws MEDIA_NOT_FOUND for unknown id', () => {
    const { store, renderer, blog } = makeFixtures()
    expect(() => deleteMedia(store, renderer, blog.id, 'nope')).toThrow(/MEDIA_NOT_FOUND/)
  })

  it('cross-blog isolation: getMedia/deleteMedia for blog A cannot see blog B media', () => {
    const { store, renderer, blog } = makeFixtures()
    store.db
      .prepare("INSERT INTO blogs (id, name, theme, created_at) VALUES (?, ?, 'minimal', datetime('now'))")
      .run('blog_b', 'b')
    const a = uploadMedia(store, renderer, { maxBytes: 5_000_000, maxTotalBytesPerBlog: null }, blog, {
      filename: 'a.png', contentType: 'image/png', bytes: new Uint8Array(PNG_BYTES),
    })
    expect(() => getMedia(store, renderer, 'blog_b', a.id)).toThrow(/MEDIA_NOT_FOUND/)
    expect(() => deleteMedia(store, renderer, 'blog_b', a.id)).toThrow(/MEDIA_NOT_FOUND/)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm test tests/media.test.ts -- --run`
Expected: FAIL — `listMedia is not exported` or undefined.

- [ ] **Step 3: Implement read operations**

Append to `src/media.ts`:

```ts
function rowToMedia(r: {
  id: string
  blog_id: string
  filename: string
  content_type: string
  bytes: number
  created_at: string
}): MediaRow {
  if (!isAllowed(r.content_type)) {
    // Type narrowing for TS; row content_type is constrained by the DB writer.
    throw new SlopItError(
      'MEDIA_TYPE_UNSUPPORTED',
      `Stored row has invalid content_type "${r.content_type}"`,
      { content_type: r.content_type },
    )
  }
  return {
    id: r.id,
    blogId: r.blog_id,
    filename: r.filename,
    contentType: r.content_type,
    bytes: r.bytes,
    createdAt: r.created_at,
  }
}

export function listMedia(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
): MediaWithUrl[] {
  const rows = store.db
    .prepare(
      `SELECT id, blog_id, filename, content_type, bytes, created_at
         FROM media WHERE blog_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(blogId) as Parameters<typeof rowToMedia>[0][]
  return rows.map((r) => {
    const m = rowToMedia(r)
    return { ...m, url: urlFor(renderer, m) }
  })
}

export function getMedia(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  id: string,
): MediaWithUrl {
  const row = store.db
    .prepare(
      `SELECT id, blog_id, filename, content_type, bytes, created_at
         FROM media WHERE blog_id = ? AND id = ?`,
    )
    .get(blogId, id) as Parameters<typeof rowToMedia>[0] | undefined
  if (!row) {
    throw new SlopItError('MEDIA_NOT_FOUND', `Media "${id}" not found`, { id })
  }
  const m = rowToMedia(row)
  return { ...m, url: urlFor(renderer, m) }
}

export function deleteMedia(
  store: Store,
  renderer: MutationRenderer,
  blogId: string,
  id: string,
): { deleted: true } {
  const m = getMedia(store, renderer, blogId, id) // throws MEDIA_NOT_FOUND
  store.db.prepare('DELETE FROM media WHERE id = ?').run(id)
  const ext = EXT_BY_TYPE[m.contentType]
  const path = join(renderer.mediaDir(blogId), id + '.' + ext)
  try {
    unlinkSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  return { deleted: true }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test tests/media.test.ts -- --run`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Re-export from src/index.ts**

Edit `src/index.ts`, find the existing exports section and add:

```ts
export { uploadMedia, listMedia, getMedia, deleteMedia } from './media.js'
export type { MediaRow, MediaWithUrl, MediaLimits, UploadInput } from './media.js'
```

(If `src/index.ts` only re-exports certain things by design, follow that pattern; the goal is parity with how `posts.ts` is exposed.)

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/media.ts src/index.ts tests/media.test.ts
git commit -m "feat(media): listMedia, getMedia, deleteMedia"
```

---

## Task 6: Idempotency middleware — binary-safe body buffering

**Files:**
- Modify: `src/api/idempotency.ts:24-79`
- Test: `tests/idempotency-binary.test.ts`

**Why first:** the REST upload endpoint mounts under this middleware. If we fix it after wiring the upload route, we'd ship a window where binary upload + idempotency-key silently corrupts bytes.

- [ ] **Step 1: Write the failing regression test**

Create `tests/idempotency-binary.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../src/db/store.js'
import { idempotencyMiddleware } from '../src/api/idempotency.js'

describe('idempotency middleware (binary bodies)', () => {
  it('preserves binary multipart bytes through replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slopit-idem-'))
    const store = createStore({ dbPath: join(dir, 'test.db') })
    const app = new Hono<{ Variables: { apiKeyHash: string } }>()
    app.use('*', async (c, next) => {
      c.set('apiKeyHash', 'fake_key_hash')
      await next()
    })
    app.use('*', idempotencyMiddleware({ store }))
    app.post('/echo', async (c) => {
      const buf = new Uint8Array(await c.req.raw.arrayBuffer())
      return c.json({ first_byte: buf[0], length: buf.length })
    })

    const bin = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const headers = { 'Idempotency-Key': 'k1', 'Content-Type': 'application/octet-stream' }

    const r1 = await app.request('/echo', { method: 'POST', headers, body: bin })
    const j1 = (await r1.json()) as { first_byte: number; length: number }
    expect(j1).toEqual({ first_byte: 0xff, length: 6 })

    const r2 = await app.request('/echo', { method: 'POST', headers, body: bin })
    const j2 = (await r2.json()) as { first_byte: number; length: number }
    expect(j2).toEqual({ first_byte: 0xff, length: 6 })
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm test tests/idempotency-binary.test.ts -- --run`
Expected: FAIL — first request likely returns wrong `length` because `c.req.text()` decodes 0xFF (invalid UTF-8) to a replacement character, then the recreated `Request` body is a corrupted string of different byte length when read back as `arrayBuffer()`.

- [ ] **Step 3: Replace `text()` with `arrayBuffer()` and hash bytes**

Edit `src/api/idempotency.ts`. Replace lines around the body-buffering logic so the middleware reads bytes, not text:

```ts
import { createHash } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { Store } from '../db/store.js'
import { SlopItError } from '../errors.js'
import {
  lookupIdempotencyRecord,
  recordIdempotencyResponse,
  type IdempotencyScope,
} from '../idempotency-store.js'
import { respondError } from './errors.js'

const APPLIES_TO = new Set<string>(['POST', 'PATCH', 'DELETE'])

export interface IdempotencyMiddlewareConfig {
  store: Store
}

export function idempotencyMiddleware(
  config: IdempotencyMiddlewareConfig,
): MiddlewareHandler<{ Variables: { apiKeyHash: string } }> {
  return async (c, next) => {
    if (!APPLIES_TO.has(c.req.method)) return next()
    const key = c.req.header('Idempotency-Key')
    if (!key) return next()

    const apiKeyHash = c.var.apiKeyHash ?? ''
    if (!apiKeyHash) return next()

    const method = c.req.method
    const path = c.req.path
    const contentType = c.req.header('Content-Type') ?? ''

    // Buffer the body as bytes (binary-safe). Re-expose so handlers can re-read.
    const rawBytes = new Uint8Array(await c.req.raw.arrayBuffer())
    c.req.raw = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: rawBytes.byteLength > 0 ? rawBytes : undefined,
    })

    const queryString = [...new URL(c.req.url).searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')

    const hasher = createHash('sha256')
    hasher.update(method)
    hasher.update('\0')
    hasher.update(path)
    hasher.update('\0')
    hasher.update(contentType)
    hasher.update('\0')
    hasher.update(queryString)
    hasher.update('\0')
    hasher.update(rawBytes)
    const requestHash = hasher.digest('hex')

    const scope: IdempotencyScope = { key, apiKeyHash, method, path, requestHash }
    const result = lookupIdempotencyRecord(config.store, scope)

    if (result.status === 'hit-mismatch') {
      return respondError(
        c,
        new SlopItError(
          'IDEMPOTENCY_KEY_CONFLICT',
          `Idempotency-Key "${key}" already used with a different payload for ${method} ${path}`,
          { key, method, path },
        ),
      )
    }
    if (result.status === 'hit-match') {
      return new Response(result.body, {
        status: result.responseStatus,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await next()
    const status = c.res.status
    if (status < 200 || status >= 300) return

    const body = await c.res.clone().text()
    recordIdempotencyResponse(config.store, scope, body, status)
  }
}
```

- [ ] **Step 4: Run binary regression test, expect PASS**

Run: `pnpm test tests/idempotency-binary.test.ts -- --run`
Expected: PASS.

- [ ] **Step 5: Run existing JSON-idempotency tests, expect PASS**

Run: `pnpm test tests/idempotency.test.ts tests/idempotency-store.test.ts tests/idempotency-schema.test.ts tests/api -- --run`
Expected: ALL PASS. The hash now incorporates raw bytes; an identical JSON string still yields a deterministic hash, so existing scenarios are unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/api/idempotency.ts tests/idempotency-binary.test.ts
git commit -m "fix(api): make idempotency middleware binary-safe"
```

---

## Task 7: Extend `ApiRouterConfig` and `McpServerConfig` with media limits

**Files:**
- Modify: `src/api/index.ts`
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Add fields to `ApiRouterConfig`**

Edit `src/api/index.ts`, append to the `ApiRouterConfig` interface:

```ts
  /**
   * Per-file upload cap in bytes. Default 5_000_000 (5 MB).
   */
  mediaMaxBytes?: number
  /**
   * Per-blog total media cap in bytes. `null` = unlimited (default).
   * Platform passes plan-tier values; self-hosted leaves unlimited.
   */
  mediaMaxTotalBytesPerBlog?: number | null
```

- [ ] **Step 2: Add identical fields to `McpServerConfig`**

Edit `src/mcp/server.ts`, append to the `McpServerConfig` interface (with the same JSDoc).

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/api/index.ts src/mcp/server.ts
git commit -m "feat(config): add mediaMaxBytes and mediaMaxTotalBytesPerBlog to factory configs"
```

---

## Task 8: REST upload endpoint — `POST /blogs/:id/media`

**Files:**
- Modify: `src/api/routes.ts`
- Test: `tests/api/media.test.ts`

- [ ] **Step 1: Write the failing test for the happy path**

Create `tests/api/media.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../../src/db/store.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createApiRouter } from '../../src/api/index.js'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function freshApi() {
  const dir = mkdtempSync(join(tmpdir(), 'slopit-api-media-'))
  const store = createStore({ dbPath: join(dir, 'test.db') })
  const renderer = createRenderer({
    store,
    outputDir: join(dir, 'out'),
    baseUrl: 'https://test.example/',
  })
  const app = new Hono()
  app.route(
    '/',
    createApiRouter({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://test.example',
    }),
  )
  // Signup to get an api key
  const signup = await app.request('/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 't' + Date.now() }),
  })
  const sj = (await signup.json()) as { blog_id: string; api_key: string }
  return { app, blogId: sj.blog_id, apiKey: sj.api_key, store, renderer }
}

describe('REST media upload', () => {
  it('POST /blogs/:id/media accepts a multipart upload and returns media + url', async () => {
    const { app, blogId, apiKey } = await freshApi()
    const fd = new FormData()
    fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'photo.png')

    const res = await app.request(`/blogs/${blogId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { media: { id: string; url: string }; _links: unknown }
    expect(body.media.id).toMatch(/^[A-Za-z0-9]+$/)
    expect(body.media.url).toMatch(/^https:\/\/test\.example\/_media\/.+\.png$/)
  })

  it('rejects an upload with no file field as BAD_REQUEST', async () => {
    const { app, blogId, apiKey } = await freshApi()
    const fd = new FormData()
    fd.append('not_file', 'oops')
    const res = await app.request(`/blogs/${blogId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('BAD_REQUEST')
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm test tests/api/media.test.ts -- --run`
Expected: FAIL — `POST /blogs/.../media` returns 404.

- [ ] **Step 3: Mount the upload route**

Edit `src/api/routes.ts`. Add imports at the top:

```ts
import { uploadMedia, listMedia, getMedia, deleteMedia } from '../media.js'
import type { MediaLimits } from '../media.js'
```

In `mountRoutes`, after the existing post DELETE route, add:

```ts
  // Media: upload (multipart)
  app.post('/blogs/:id/media', async (c) => {
    const renderer = config.rendererFor(c.var.blog)
    const limits: MediaLimits = {
      maxBytes: config.mediaMaxBytes ?? 5_000_000,
      maxTotalBytesPerBlog: config.mediaMaxTotalBytesPerBlog ?? null,
    }
    const ct = c.req.header('Content-Type') ?? ''
    if (!ct.startsWith('multipart/form-data')) {
      throw new SlopItError('BAD_REQUEST', 'multipart/form-data required', { content_type: ct })
    }
    const form = await c.req.parseBody({ all: true })
    const fileField = form['file']
    if (fileField === undefined) {
      throw new SlopItError('BAD_REQUEST', "multipart 'file' field required", {})
    }
    if (Array.isArray(fileField)) {
      throw new SlopItError('BAD_REQUEST', 'only one file per request', {})
    }
    if (typeof fileField === 'string') {
      throw new SlopItError('BAD_REQUEST', "'file' must be a binary upload", {})
    }
    const file = fileField as File
    if (file.size === 0) {
      throw new SlopItError('BAD_REQUEST', 'file is empty', {})
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const media = uploadMedia(config.store, renderer, limits, c.var.blog, {
      filename: file.name,
      contentType: file.type,
      bytes,
    })
    return c.json({ media, _links: buildLinks(c.var.blog, config) })
  })
```

(Verify `SlopItError` is already imported at the top of `src/api/routes.ts`; it should be.)

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test tests/api/media.test.ts -- --run`
Expected: PASS for both tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes.ts tests/api/media.test.ts
git commit -m "feat(api): POST /blogs/:id/media upload endpoint"
```

---

## Task 9: REST list/get/delete media endpoints

**Files:**
- Modify: `src/api/routes.ts`
- Modify: `tests/api/media.test.ts`

- [ ] **Step 1: Append failing tests for list/get/delete**

Append to `tests/api/media.test.ts`:

```ts
  it('GET /blogs/:id/media lists uploads', async () => {
    const { app, blogId, apiKey } = await freshApi()
    const fd = new FormData()
    fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'a.png')
    await app.request(`/blogs/${blogId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    })
    const res = await app.request(`/blogs/${blogId}/media`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { media: { id: string }[]; _links: unknown }
    expect(body.media).toHaveLength(1)
  })

  it('GET /blogs/:id/media/:mid returns a single record; DELETE removes it', async () => {
    const { app, blogId, apiKey } = await freshApi()
    const fd = new FormData()
    fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'a.png')
    const upload = await app.request(`/blogs/${blogId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    })
    const { media } = (await upload.json()) as { media: { id: string } }

    const get = await app.request(`/blogs/${blogId}/media/${media.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(get.status).toBe(200)

    const del = await app.request(`/blogs/${blogId}/media/${media.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(del.status).toBe(200)
    expect((await del.json()) as { deleted: true }).toMatchObject({ deleted: true })

    const after = await app.request(`/blogs/${blogId}/media/${media.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(after.status).toBe(404)
  })
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm test tests/api/media.test.ts -- --run`
Expected: FAIL — list/get/delete return 404.

- [ ] **Step 3: Mount the read/delete routes**

Edit `src/api/routes.ts`, append after the upload route:

```ts
  app.get('/blogs/:id/media', (c) => {
    const renderer = config.rendererFor(c.var.blog)
    const media = listMedia(config.store, renderer, c.var.blog.id)
    return c.json({ media, _links: buildLinks(c.var.blog, config) })
  })

  app.get('/blogs/:id/media/:mid', (c) => {
    const renderer = config.rendererFor(c.var.blog)
    const media = getMedia(config.store, renderer, c.var.blog.id, c.req.param('mid'))
    return c.json({ media, _links: buildLinks(c.var.blog, config) })
  })

  app.delete('/blogs/:id/media/:mid', (c) => {
    const renderer = config.rendererFor(c.var.blog)
    const result = deleteMedia(config.store, renderer, c.var.blog.id, c.req.param('mid'))
    return c.json({ ...result, _links: buildLinks(c.var.blog, config) })
  })
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test tests/api/media.test.ts -- --run`
Expected: PASS for all tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes.ts tests/api/media.test.ts
git commit -m "feat(api): list/get/delete media endpoints"
```

---

## Task 10: Update `_links` block to advertise media

**Files:**
- Modify: `src/api/links.ts`
- Modify: `tests/links.test.ts`

- [ ] **Step 1: Add failing test**

Add to `tests/links.test.ts`:

```ts
  it('includes upload_media and list_media paths', () => {
    // … reuse existing buildLinks test setup …
    const links = buildLinks(fakeBlog, fakeConfig)
    expect(links.upload_media).toBe(`/blogs/${fakeBlog.id}/media`)
    expect(links.list_media).toBe(`/blogs/${fakeBlog.id}/media`)
  })
```

(If the existing test doesn't define `fakeBlog`/`fakeConfig`, mirror the pattern from neighboring tests in the same file.)

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm test tests/links.test.ts -- --run`
Expected: FAIL — TypeScript will likely complain about `upload_media` not being on `LinksBlock`.

- [ ] **Step 3: Extend `LinksBlock` and `buildLinks`**

Edit `src/api/links.ts`:

```ts
export interface LinksBlock {
  view: string
  publish: string
  list_posts: string
  upload_media: string
  list_media: string
  dashboard?: string
  docs?: string
  bridge: string
}

export function buildLinks(blog: Blog, config: LinkConfig): LinksBlock {
  const links: LinksBlock = {
    view: config.rendererFor(blog).baseUrl,
    publish: `/blogs/${blog.id}/posts`,
    list_posts: `/blogs/${blog.id}/posts`,
    upload_media: `/blogs/${blog.id}/media`,
    list_media: `/blogs/${blog.id}/media`,
    bridge: '/bridge/report_bug',
  }
  if (config.dashboardUrl !== undefined) links.dashboard = config.dashboardUrl
  if (config.docsUrl !== undefined) links.docs = config.docsUrl
  return links
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test tests/links.test.ts -- --run`

- [ ] **Step 5: Run full API suite to ensure other tests aren't asserting exact `_links` shape**

Run: `pnpm test tests/api -- --run`
Expected: PASS. If any test does `expect(links).toEqual({...})` with the old shape, update it to the new shape.

- [ ] **Step 6: Commit**

```bash
git add src/api/links.ts tests/links.test.ts
# include any test updates from step 5
git commit -m "feat(api): advertise media endpoints in _links"
```

---

## Task 11: MCP tools — `upload_media`, `list_media`, `delete_media`

**Files:**
- Modify: `src/mcp/tools.ts`
- Test: `tests/mcp/media.test.ts`

- [ ] **Step 1: Write failing tests using existing MCP test helpers**

Create `tests/mcp/media.test.ts`. Look at `tests/mcp/posts-create.test.ts` for the exact harness to mirror. Skeleton:

```ts
import { describe, it, expect } from 'vitest'
import { makeTestServer } from './helpers.js'  // see existing helper
// PNG signature bytes
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('mcp media tools', () => {
  it('upload_media accepts base64 + content_type and returns a public URL', async () => {
    const { call, blog } = await makeTestServer() // returns helper that signs up + returns auth context
    const r = await call('upload_media', {
      blog_id: blog.id,
      filename: 'photo.png',
      content_type: 'image/png',
      data_base64: PNG_BYTES.toString('base64'),
    })
    expect(r.media.url).toMatch(/^https?:\/\/.+\/_media\/.+\.png$/)
  })

  it('upload_media rejects malformed base64 with ZOD_VALIDATION', async () => {
    const { call, blog } = await makeTestServer()
    const r = await call('upload_media', {
      blog_id: blog.id,
      filename: 'photo.png',
      content_type: 'image/png',
      data_base64: 'not!!!base64@@@',
    })
    expect(r.error?.code).toMatch(/ZOD_VALIDATION|BAD_REQUEST/)
  })

  it('list_media returns uploaded items', async () => {
    const { call, blog } = await makeTestServer()
    await call('upload_media', {
      blog_id: blog.id,
      filename: 'a.png',
      content_type: 'image/png',
      data_base64: PNG_BYTES.toString('base64'),
    })
    const r = await call('list_media', { blog_id: blog.id })
    expect(r.media).toHaveLength(1)
  })

  it('delete_media removes the item', async () => {
    const { call, blog } = await makeTestServer()
    const u = await call('upload_media', {
      blog_id: blog.id,
      filename: 'a.png',
      content_type: 'image/png',
      data_base64: PNG_BYTES.toString('base64'),
    })
    const d = await call('delete_media', { blog_id: blog.id, media_id: u.media.id })
    expect(d.deleted).toBe(true)
  })
})
```

If the existing `makeTestServer` helper has a different name/shape, follow `tests/mcp/posts-create.test.ts` literally — it's the closest analog.

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm test tests/mcp/media.test.ts -- --run`
Expected: FAIL — tools not registered.

- [ ] **Step 3: Register the three MCP tools**

Edit `src/mcp/tools.ts`. Add imports at the top:

```ts
import { uploadMedia, listMedia, deleteMedia } from '../media.js'
import type { MediaLimits } from '../media.js'
```

Inside `registerTools`, after the existing tools, add:

```ts
  // 9. upload_media — accepts base64 bytes, returns public URL.
  // base64 validated via Zod refine; full size/type/quota check happens
  // inside uploadMedia().
  const Base64Schema = z
    .string()
    .min(1)
    .refine((s) => /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0, {
      message: 'data_base64 must be valid standard base64',
    })

  const UploadMediaInputSchema = z
    .object({
      blog_id: z.string(),
      filename: z.string().min(1).max(255),
      content_type: z.string().min(1),
      data_base64: Base64Schema,
      idempotency_key: z.string().optional(),
    })
    .strict()

  server.registerTool(
    'upload_media',
    {
      description:
        'Upload an image (JPEG/PNG/GIF/WebP, max 5MB) as base64 in `data_base64`. Returns a public URL — use it as ![alt](url) in post markdown or pass as coverImage.',
      inputSchema: UploadMediaInputSchema,
    },
    wrapTool<z.infer<typeof UploadMediaInputSchema>>(
      config,
      'upload_media',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      (args, ctx) => {
        const renderer = config.rendererFor(ctx.blog!)
        const limits: MediaLimits = {
          maxBytes: config.mediaMaxBytes ?? 5_000_000,
          maxTotalBytesPerBlog: config.mediaMaxTotalBytesPerBlog ?? null,
        }
        const bytes = Buffer.from(args.data_base64, 'base64')
        if (bytes.length === 0) {
          throw new SlopItError('BAD_REQUEST', 'data_base64 decoded to zero bytes', {})
        }
        const media = uploadMedia(config.store, renderer, limits, ctx.blog!, {
          filename: args.filename,
          contentType: args.content_type,
          bytes: new Uint8Array(bytes),
        })
        return { media }
      },
    ),
  )

  // 10. list_media
  server.registerTool(
    'list_media',
    {
      description:
        "List uploaded images for the blog. Returns each image's id, public URL, content type, and byte size.",
      inputSchema: z.object({ blog_id: z.string() }).strict(),
    },
    wrapTool<{ blog_id: string }>(
      config,
      'list_media',
      { auth: 'required', crossBlogGuard: true },
      (_args, ctx) => {
        const renderer = config.rendererFor(ctx.blog!)
        return { media: listMedia(config.store, renderer, ctx.blog!.id) }
      },
    ),
  )

  // 11. delete_media
  const DeleteMediaInputSchema = z
    .object({
      blog_id: z.string(),
      media_id: z.string(),
      idempotency_key: z.string().optional(),
    })
    .strict()

  server.registerTool(
    'delete_media',
    {
      description:
        'Permanently delete an uploaded image by id. The URL stops working immediately. Posts that referenced it will show a broken image until edited.',
      inputSchema: DeleteMediaInputSchema,
    },
    wrapTool<z.infer<typeof DeleteMediaInputSchema>>(
      config,
      'delete_media',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      (args, ctx) => {
        const renderer = config.rendererFor(ctx.blog!)
        return deleteMedia(config.store, renderer, ctx.blog!.id, args.media_id)
      },
    ),
  )
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test tests/mcp/media.test.ts -- --run`

- [ ] **Step 5: Run full MCP suite (catch any envelope-parity / tool-description drift)**

Run: `pnpm test tests/mcp -- --run`
Expected: PASS. The `tests/mcp/tool-descriptions.test.ts` may need updating if it asserts an exact tool count — bump the expected count from 8 to 11 there.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/media.test.ts
# include tool-description test fix if needed
git commit -m "feat(mcp): upload_media, list_media, delete_media tools"
```

---

## Task 12: Update `src/skill.ts` agent docs

**Files:**
- Modify: `src/skill.ts`
- Modify: `tests/skill.test.ts` (if it asserts exact content)

- [ ] **Step 1: Update endpoints table**

Edit `src/skill.ts`. Find the endpoints table and add four rows:

```
| POST /blogs/:id/media | Upload an image (multipart, file field). Returns { media, url }. |
| GET /blogs/:id/media | List uploaded images for the blog. |
| GET /blogs/:id/media/:id | Get a single media record. |
| DELETE /blogs/:id/media/:id | Permanently delete an image. |
```

- [ ] **Step 2: Update MCP tools list**

If `src/skill.ts` lists the MCP tool names, add `upload_media`, `list_media`, `delete_media`.

- [ ] **Step 3: Add "Posts with images" section**

Append a new section after the existing post-publish flow:

```
## Posts with images

Two-step flow:

1. Upload each image. Returned \`url\` is absolute — use it as-is.
   POST ${baseUrl}/blogs/<blog_id>/media   (Content-Type: multipart/form-data, single \`file\` field)
   → 200 { media: { id, url, content_type, bytes }, _links }

2. Reference the URL(s) inline in the post body or set as cover image:
   \`\`\`
   ![View from the castle](https://my-blog.slopit.io/_media/abc123.jpg)
   \`\`\`
   Or pass as the \`coverImage\` field on POST /blogs/<id>/posts.

Allowed types: JPEG, PNG, GIF, WebP. Default per-file cap: 5 MB.
```

(Adjust the templating to match the file's existing string-template style — most likely a backtick template with `${baseUrl}` substitution.)

- [ ] **Step 4: Update error codes table**

Add four rows:

```
| MEDIA_NOT_FOUND | 404 | Unknown media id. |
| MEDIA_TYPE_UNSUPPORTED | 400 | content_type not in allowed list (JPEG/PNG/GIF/WebP). |
| MEDIA_TOO_LARGE | 413 | File exceeds the per-file cap. |
| MEDIA_QUOTA_EXCEEDED | 413 | Blog's total media quota exhausted. |
```

- [ ] **Step 5: Run skill drift tests**

Run: `pnpm test tests/skill.test.ts -- --run`
Expected: PASS. If the test asserts exact endpoint-table parity by reading from `createApiRouter`, it should auto-pass once the routes are mounted; if it has hand-written exact-string assertions, update them.

- [ ] **Step 6: Commit**

```bash
git add src/skill.ts tests/skill.test.ts
git commit -m "docs(skill): document media upload endpoints, tools, and errors"
```

---

## Task 13: Remove "no image hosting" from the v1 non-goals

**Files:**
- Modify: `PRODUCT_BRIEF.md`
- Modify: `slopit-platform/PRODUCT_BRIEF.md` (if same file is mirrored there — the spec said both files have this line)

- [ ] **Step 1: Delete the line in slopit/PRODUCT_BRIEF.md**

Edit `PRODUCT_BRIEF.md`:81. Delete:

```
- No image hosting (external URLs only)
```

- [ ] **Step 2: Delete the matching line in slopit-platform/PRODUCT_BRIEF.md**

If it exists there too. Check with: `grep -n "image hosting" ../slopit-platform/PRODUCT_BRIEF.md`.

- [ ] **Step 3: Commit**

```bash
git add PRODUCT_BRIEF.md
# include platform PRODUCT_BRIEF.md if you edited it
git commit -m "docs(brief): image upload is now in v1 scope"
```

(Note: `slopit-platform` is a separate repo; that edit needs its own commit and PR. Flag this to the human reviewer.)

---

## Task 14: Final integration check

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full check pipeline**

Run: `pnpm check`
Expected: PASS — typecheck + lint + format + all tests.

- [ ] **Step 2: Manually exercise the write contract end-to-end**

**Scope of this check:** `@slopit/core` writes static files; serving them at the public URL is the consumer's job (Caddy in production, `cachedStatic` in `slopit-platform`). `examples/self-hosted/mcp-http.ts` is a **write-path** harness — it boots the API + MCP but does **not** serve the rendered output directory. So we verify the write contract here (upload returns the right URL, the file lands at the expected path, posts can embed the URL) and defer browser-render verification to the platform PR / Caddy deploy.

```bash
# Boot the self-hosted write-path harness (port 8080, REST at root, MCP at /mcp).
SLOPIT_BASE_URL=http://localhost:8080 \
SLOPIT_OUT=./tmp-out \
SLOPIT_DB=./tmp-slopit.db \
pnpm dlx tsx examples/self-hosted/mcp-http.ts &

# Wait until the server is listening, then:

# 1. Sign up
SIGNUP=$(curl -sX POST http://localhost:8080/signup -H 'Content-Type: application/json' -d '{}')
echo "$SIGNUP" | jq .
BLOG_ID=$(echo "$SIGNUP" | jq -r .blog_id)
API_KEY=$(echo "$SIGNUP" | jq -r .api_key)

# 2. Upload a real PNG
UPLOAD=$(curl -sX POST http://localhost:8080/blogs/$BLOG_ID/media \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@/path/to/some.png")
echo "$UPLOAD" | jq .
URL=$(echo "$UPLOAD" | jq -r .media.url)
ID=$(echo "$UPLOAD" | jq -r .media.id)

# 3. Verify the file is on disk where the URL implies
test -f "./tmp-out/$BLOG_ID/_media/$ID.png" && echo "OK: file exists" || echo "FAIL: file missing"

# 4. Verify _links advertises the upload endpoint
curl -sH "Authorization: Bearer $API_KEY" http://localhost:8080/blogs/$BLOG_ID | jq ._links
# Expect upload_media and list_media keys present, both = "/blogs/$BLOG_ID/media".

# 5. Create a post embedding the URL; verify rendered HTML contains the <img>
curl -sX POST http://localhost:8080/blogs/$BLOG_ID/posts \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: text/markdown' \
  -d "# Hello\n\n![alt](${URL})\n" | jq .
# Then look at the rendered HTML on disk:
grep -c "<img" ./tmp-out/$BLOG_ID/*/index.html
# Expect: at least 1.

# 6. Verify list + delete
curl -sH "Authorization: Bearer $API_KEY" http://localhost:8080/blogs/$BLOG_ID/media | jq .
curl -sX DELETE -H "Authorization: Bearer $API_KEY" http://localhost:8080/blogs/$BLOG_ID/media/$ID | jq .
test ! -f "./tmp-out/$BLOG_ID/_media/$ID.png" && echo "OK: file gone" || echo "FAIL: file still there"

# Cleanup
rm -rf ./tmp-out ./tmp-slopit.db ./tmp-slopit.db-shm ./tmp-slopit.db-wal
kill %1 2>/dev/null || true
```

If any step fails, debug before moving on. **Browser-render verification belongs in the follow-up `slopit-platform` PR** — that repo mounts the static handler at `/b/:blogId/*` (and per-tenant subdomains), so once both PRs land in dev, the full read path can be exercised against staging. Surface this in the PR description so the human reviewer knows the read-side check is split across the two repos.

- [ ] **Step 3: Open PR to dev**

```bash
git push -u origin feat/media-upload-spec
gh pr create --base dev --title "feat: media upload (v1 launch)" --body "$(cat <<'EOF'
## Summary

- New `src/media.ts` primitive (uploadMedia/listMedia/getMedia/deleteMedia).
- 4 REST endpoints under `/blogs/:id/media`.
- 3 MCP tools (`upload_media`, `list_media`, `delete_media`).
- New `media` table + 4 new error codes.
- `MutationRenderer` gains `mediaDir(blogId)`.
- Idempotency middleware now binary-safe (`text()` → `arrayBuffer()`).
- `PRODUCT_BRIEF.md` v1 non-goals updated.

Spec: `docs/superpowers/specs/2026-04-27-media-upload-design.md`.

## Test plan

- [ ] `pnpm check` passes locally
- [ ] Manual happy path: signup → upload PNG → reference in post body → browser renders both
- [ ] MCP tool descriptions read clearly via an MCP client (Claude Desktop or a dev harness)
EOF
)"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:

| Spec section | Task |
|---|---|
| Architecture | Tasks 4 (uploadMedia), 8 (REST), 11 (MCP) |
| Storage layout / URL form / DB schema | Task 1 (migration), Task 4 (URL computation in primitive) |
| `src/media.ts` primitive | Tasks 4, 5 |
| Renderer extension `mediaDir(blogId)` | Task 3 |
| Atomicity & compensation | Task 4 (steps 1–4, 11–12) |
| Quota check inside transaction | Task 4 (steps 9–10) |
| Validation table | Task 4 (steps 5–10) |
| REST endpoints | Tasks 8, 9 |
| MCP tools | Task 11 |
| Idempotency middleware fix | Task 6 |
| Configuration additions | Task 7 |
| Boundary parse error contract | Task 8 (no-file test), Task 11 (base64 test) |
| `_links` advertisement | Task 10 |
| Error code additions | Task 2 |
| Agent docs | Task 12 |
| YAGNI fence | Honored throughout — no signature sniffing, no `.tmp` rename, no IMMEDIATE locking, no resize. |
| PRODUCT_BRIEF v1 non-goals | Task 13 |

**Type consistency** — `MediaLimits`, `MediaWithUrl`, `UploadInput` are defined in Task 4 and reused unchanged in Tasks 5, 8, 9, 11. `mediaDir` signature matches between Task 3 (interface) and Tasks 4, 5 (consumers).

**Placeholder scan** — no TBD/TODO/"implement later" patterns. All steps include code or exact commands.
