# createBlog + createApiKey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the two foundational primitives of `@slopit/core` — `createBlog` (creates a blog row) and `createApiKey` (mints a plaintext API key for an existing blog) — with narrow error mapping, Zod input validation, and full test coverage.

**Architecture:** Two pure functions in `src/blogs.ts` acting on a `Store` handle. A tiny `SlopItError` class in `src/errors.ts` carries typed string codes. Input validation via Zod in `src/schema/index.ts`. `isBlogNameConflict` is extracted as an exportable predicate so the narrow-match logic can be unit-tested directly. ID generation is a local stdlib helper (no `nanoid` dep).

**Tech Stack:** TypeScript (strict, ESM, NodeNext), `better-sqlite3` (sync), Zod v4, Vitest, Node.js `node:crypto`.

---

## Spec

Authoritative design doc: [`docs/superpowers/specs/2026-04-22-create-blog-design.md`](../specs/2026-04-22-create-blog-design.md) (commit `df089e8`).

## Pre-flight

Before starting:

- Working directory: `/Users/nj/Workspace/SlopIt/code/slopit`.
- Scaffold is already in place. Relevant existing files:
  - `src/db/store.ts` — `createStore`, returns `{ db, close }`. Opens better-sqlite3 with `journal_mode=WAL` and `foreign_keys=ON`, runs migrations.
  - `src/db/migrations/001_core_init.sql` — `blogs`, `posts`, `api_keys`, and `schema_migrations` tables.
  - `src/auth/api-key.ts` — `generateApiKey()` (plaintext `sk_slop_...`), `hashApiKey()` (sha256 hex).
  - `src/schema/index.ts` — already has `BlogSchema`, `PostInputSchema`, `PostSchema`. We'll add `CreateBlogInputSchema` + `CreateBlogInput` type.
  - `src/index.ts` — public barrel (stub exports). Will add blog ops + error exports.
  - `tests/smoke.test.ts` — existing smoke test, leave alone.
- Baseline: `pnpm typecheck` and `pnpm test` pass today. They must keep passing after every task.

## File Structure

| File | New/Modified | Responsibility |
|---|---|---|
| `src/errors.ts` | NEW | `SlopItError` class + `SlopItErrorCode` type |
| `src/blogs.ts` | NEW | `createBlog`, `createApiKey`, `isBlogNameConflict`, local `generateShortId` |
| `src/schema/index.ts` | MODIFY | Append `CreateBlogInputSchema` + `CreateBlogInput` type |
| `src/index.ts` | MODIFY | Add public exports for blog ops + errors |
| `tests/errors.test.ts` | NEW | `SlopItError` unit tests |
| `tests/blogs.test.ts` | NEW | All tests for predicate, schema, `createBlog`, `createApiKey` |

Each file has one responsibility. Tests colocate by module.

## Testing strategy

Each test that touches the DB creates its own `Store` backed by an `mkdtempSync` temp directory. `beforeEach` creates, `afterEach` closes + removes the dir. No shared DB state between tests.

All code is sync (better-sqlite3 is sync). Vitest is already configured to pick up `tests/**/*.test.ts`.

## Deviations from spec (minor)

- The spec's `generateBlogId` is renamed to `generateShortId` and reused for `api_keys.id` too. Matches the spec's "parallel stdlib helper" phrasing and avoids a duplicate function. Still local to `src/blogs.ts`, still not exported.

---

### Task 1: SlopItError class

**Files:**
- Create: `src/errors.ts`
- Create: `tests/errors.test.ts`

- [ ] **Step 1.1: Write failing tests**

Create `tests/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SlopItError } from '../src/errors.js'

describe('SlopItError', () => {
  it('carries code, message, and standard Error properties', () => {
    const e = new SlopItError('BLOG_NAME_CONFLICT', 'oops')
    expect(e.code).toBe('BLOG_NAME_CONFLICT')
    expect(e.message).toBe('oops')
    expect(e.name).toBe('SlopItError')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(SlopItError)
    expect(typeof e.stack).toBe('string')
  })

  it('supports both declared codes', () => {
    const a = new SlopItError('BLOG_NAME_CONFLICT', 'a')
    const b = new SlopItError('BLOG_NOT_FOUND', 'b')
    expect(a.code).toBe('BLOG_NAME_CONFLICT')
    expect(b.code).toBe('BLOG_NOT_FOUND')
  })
})
```

- [ ] **Step 1.2: Run tests, verify failure**

```bash
pnpm test tests/errors.test.ts
```

Expected: FAIL with "Cannot find module '../src/errors.js'" or similar.

- [ ] **Step 1.3: Implement**

Create `src/errors.ts`:

```ts
export type SlopItErrorCode = 'BLOG_NAME_CONFLICT' | 'BLOG_NOT_FOUND'

export class SlopItError extends Error {
  readonly code: SlopItErrorCode

  constructor(code: SlopItErrorCode, message: string) {
    super(message)
    this.name = 'SlopItError'
    this.code = code
  }
}
```

- [ ] **Step 1.4: Run tests + typecheck, verify pass**

```bash
pnpm test tests/errors.test.ts
pnpm typecheck
pnpm test
```

Expected: all green. Existing smoke tests still passing. 2 new `SlopItError` tests passing.

- [ ] **Step 1.5: Commit**

```bash
git add src/errors.ts tests/errors.test.ts
git commit -m "Add SlopItError with typed error codes

BLOG_NAME_CONFLICT + BLOG_NOT_FOUND. Core's single public error class;
consumers switch on .code to map to HTTP status at the transport
boundary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: isBlogNameConflict predicate

**Files:**
- Create: `src/blogs.ts` (initial — will be extended in later tasks)
- Create: `tests/blogs.test.ts` (initial — will be extended in later tasks)

- [ ] **Step 2.1: Write failing tests**

Create `tests/blogs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isBlogNameConflict } from '../src/blogs.js'

function sqliteUniqueError(constraint: string): Error {
  const e = new Error(`UNIQUE constraint failed: ${constraint}`) as NodeJS.ErrnoException
  e.code = 'SQLITE_CONSTRAINT_UNIQUE'
  return e
}

describe('isBlogNameConflict', () => {
  it('is true for UNIQUE errors on blogs.name', () => {
    expect(isBlogNameConflict(sqliteUniqueError('blogs.name'))).toBe(true)
  })

  it('is false for UNIQUE errors on other columns', () => {
    expect(isBlogNameConflict(sqliteUniqueError('blogs.id'))).toBe(false)
    expect(isBlogNameConflict(sqliteUniqueError('api_keys.id'))).toBe(false)
    expect(isBlogNameConflict(sqliteUniqueError('api_keys.key_hash'))).toBe(false)
  })

  it('is false for non-UNIQUE DB errors, plain Errors, and non-errors', () => {
    const fkErr = new Error('FOREIGN KEY constraint failed') as NodeJS.ErrnoException
    fkErr.code = 'SQLITE_CONSTRAINT_FOREIGNKEY'
    expect(isBlogNameConflict(fkErr)).toBe(false)

    // Missing code field — bare message match is not enough
    expect(isBlogNameConflict(new Error('UNIQUE constraint failed: blogs.name'))).toBe(false)

    expect(isBlogNameConflict(null)).toBe(false)
    expect(isBlogNameConflict(undefined)).toBe(false)
    expect(isBlogNameConflict('not an error')).toBe(false)
    expect(isBlogNameConflict({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'blogs.name' })).toBe(false)
  })
})
```

- [ ] **Step 2.2: Run tests, verify failure**

```bash
pnpm test tests/blogs.test.ts
```

Expected: FAIL with module-not-found for `../src/blogs.js`.

- [ ] **Step 2.3: Implement**

Create `src/blogs.ts`:

```ts
// Pure predicate so the narrow match logic is testable without running the DB.
// better-sqlite3 sets err.code for SQLite constraint violations; the column
// name is only reliably available in err.message.
export function isBlogNameConflict(err: unknown): boolean {
  return (
    err instanceof Error
    && (err as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE'
    && err.message.includes('blogs.name')
  )
}
```

- [ ] **Step 2.4: Run tests + typecheck, verify pass**

```bash
pnpm test tests/blogs.test.ts
pnpm typecheck
pnpm test
```

Expected: all green. 3 new predicate tests passing.

- [ ] **Step 2.5: Commit**

```bash
git add src/blogs.ts tests/blogs.test.ts
git commit -m "Add isBlogNameConflict pure predicate

Narrow match for SQLite UNIQUE errors on blogs.name specifically.
Extracted so the match logic is tested directly against synthetic
errors without mocking the DB.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: CreateBlogInputSchema

**Files:**
- Modify: `src/schema/index.ts` (append only)
- Modify: `tests/blogs.test.ts` (append only)

- [ ] **Step 3.1: Write failing tests**

Append to `tests/blogs.test.ts`:

```ts
import { CreateBlogInputSchema } from '../src/schema/index.js'

describe('CreateBlogInputSchema', () => {
  it('accepts empty input; name undefined, theme defaults to minimal', () => {
    const parsed = CreateBlogInputSchema.parse({})
    expect(parsed.name).toBeUndefined()
    expect(parsed.theme).toBe('minimal')
  })

  it('accepts valid DNS-safe names', () => {
    for (const name of ['ai', 'ai-thoughts', 'hot-takes-2026', 'abc', 'a2b', 'a'.repeat(63)]) {
      expect(() => CreateBlogInputSchema.parse({ name })).not.toThrow()
    }
  })

  it('accepts all three valid themes', () => {
    for (const theme of ['minimal', 'classic', 'zine'] as const) {
      expect(CreateBlogInputSchema.parse({ theme }).theme).toBe(theme)
    }
  })

  it('rejects invalid theme', () => {
    expect(() => CreateBlogInputSchema.parse({ theme: 'fancy' })).toThrow()
  })

  it.each([
    ['too short (1 char)', 'a'],
    ['leading hyphen', '-abc'],
    ['trailing hyphen', 'abc-'],
    ['uppercase', 'AiThoughts'],
    ['underscore', 'ai_thoughts'],
    ['space', 'ai thoughts'],
    ['too long (64 chars)', 'a'.repeat(64)],
    ['empty string', ''],
    ['only hyphens', '---'],
  ])('rejects name: %s', (_, name) => {
    expect(() => CreateBlogInputSchema.parse({ name })).toThrow()
  })
})
```

- [ ] **Step 3.2: Run tests, verify failure**

```bash
pnpm test tests/blogs.test.ts
```

Expected: FAIL — import of `CreateBlogInputSchema` not found.

- [ ] **Step 3.3: Implement**

Append to `src/schema/index.ts`:

```ts
// Input for createBlog. `name` is DNS-subdomain-safe when provided:
// lowercase alphanumerics + hyphens, no leading/trailing hyphen, 2–63 chars.
// Same constraints whether the blog ends up on a subdomain or not, for
// consistency and so unnamed blogs can claim a subdomain later.
export const CreateBlogInputSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .optional(),
  theme: z.enum(['minimal', 'classic', 'zine']).default('minimal'),
})
export type CreateBlogInput = z.input<typeof CreateBlogInputSchema>
```

- [ ] **Step 3.4: Run tests + typecheck, verify pass**

```bash
pnpm test tests/blogs.test.ts
pnpm typecheck
pnpm test
```

Expected: all green.

- [ ] **Step 3.5: Commit**

```bash
git add src/schema/index.ts tests/blogs.test.ts
git commit -m "Add CreateBlogInputSchema

DNS-safe name (2-63 chars, lowercase alphanumerics + hyphens, no
leading/trailing hyphen). Theme defaults to 'minimal'. .min(2) matches
the regex's structural minimum.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: createBlog

**Files:**
- Modify: `src/blogs.ts` (full rewrite — adds imports, helper, and function while keeping existing `isBlogNameConflict`)
- Modify: `tests/blogs.test.ts` (append)

- [ ] **Step 4.1: Write failing tests**

Append to `tests/blogs.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
import { SlopItError } from '../src/errors.js'

describe('createBlog', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates an unnamed blog; id matches the 32-char alphabet, 8 chars long', () => {
    const { blog } = createBlog(store, {})
    expect(blog.id).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{8}$/)
    expect(blog.name).toBeNull()
    expect(blog.theme).toBe('minimal')
    expect(typeof blog.createdAt).toBe('string')
  })

  it('creates a named blog and persists the name', () => {
    const { blog } = createBlog(store, { name: 'ai-thoughts' })
    expect(blog.name).toBe('ai-thoughts')

    const row = store.db
      .prepare('SELECT id, name, theme FROM blogs WHERE id = ?')
      .get(blog.id) as { id: string; name: string; theme: string }
    expect(row.id).toBe(blog.id)
    expect(row.name).toBe('ai-thoughts')
    expect(row.theme).toBe('minimal')
  })

  it('creates a blog with an explicit theme', () => {
    const { blog } = createBlog(store, { theme: 'zine' })
    expect(blog.theme).toBe('zine')
  })

  it('generates a different id on each call', () => {
    const a = createBlog(store, {})
    const b = createBlog(store, {})
    expect(a.blog.id).not.toBe(b.blog.id)
  })

  it('throws SlopItError(BLOG_NAME_CONFLICT) when the name is reused', () => {
    createBlog(store, { name: 'taken' })
    let caught: unknown
    try {
      createBlog(store, { name: 'taken' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('BLOG_NAME_CONFLICT')
    expect((caught as SlopItError).message).toContain('taken')
  })

  it('rejects invalid input via Zod (bad name, too short)', () => {
    expect(() => createBlog(store, { name: 'BadName' })).toThrow()
    expect(() => createBlog(store, { name: 'a' })).toThrow()
  })
})
```

- [ ] **Step 4.2: Run tests, verify failure**

```bash
pnpm test tests/blogs.test.ts
```

Expected: FAIL — `createBlog` not exported.

- [ ] **Step 4.3: Implement**

Replace the full contents of `src/blogs.ts` with:

```ts
import { randomBytes } from 'node:crypto'
import type { Store } from './db/store.js'
import { SlopItError } from './errors.js'
import {
  CreateBlogInputSchema,
  type Blog,
  type CreateBlogInput,
} from './schema/index.js'

// 32 URL-safe characters (no I/l/o/0/1). Power of 2 → modulo is unbiased.
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

function generateShortId(): string {
  const bytes = randomBytes(8)
  return Array.from(bytes, (b) => ID_ALPHABET[b % 32]).join('')
}

// Pure predicate so the narrow match logic is testable without running the DB.
// better-sqlite3 sets err.code for SQLite constraint violations; the column
// name is only reliably available in err.message.
export function isBlogNameConflict(err: unknown): boolean {
  return (
    err instanceof Error
    && (err as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE'
    && err.message.includes('blogs.name')
  )
}

export function createBlog(
  store: Store,
  input: CreateBlogInput,
): { blog: Blog } {
  const parsed = CreateBlogInputSchema.parse(input)
  const id = generateShortId()
  const name = parsed.name ?? null
  const theme = parsed.theme

  const insert = store.db.prepare(
    'INSERT INTO blogs (id, name, theme) VALUES (?, ?, ?)',
  )

  try {
    insert.run(id, name, theme)
  } catch (e) {
    if (isBlogNameConflict(e)) {
      throw new SlopItError(
        'BLOG_NAME_CONFLICT',
        `Blog name "${name}" is already taken`,
      )
    }
    throw e
  }

  const row = store.db
    .prepare('SELECT id, name, theme, created_at FROM blogs WHERE id = ?')
    .get(id) as {
      id: string
      name: string | null
      theme: 'minimal' | 'classic' | 'zine'
      created_at: string
    }

  const blog: Blog = {
    id: row.id,
    name: row.name,
    theme: row.theme,
    createdAt: row.created_at,
  }

  return { blog }
}
```

- [ ] **Step 4.4: Run tests + typecheck, verify pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. 6 new `createBlog` tests passing, all earlier tests still green.

- [ ] **Step 4.5: Write end-to-end narrow-match safety-net test**

Unit-testing `isBlogNameConflict` in isolation (Task 2) does not guarantee `createBlog` *uses* it. A future edit could inline `err.code === 'SQLITE_CONSTRAINT_UNIQUE'` into `createBlog`'s catch and every test still passes — including the unit tests on the predicate — because no test forces a non-`blogs.name` UNIQUE violation through `createBlog` itself. This step adds that test.

It lives in a separate file so its `vi.mock('node:crypto', ...)` is scoped and doesn't affect the other blog tests' randomness.

Create `tests/blogs.id-collision.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Force randomBytes to return all zeros so generateShortId always
// produces the same id ("aaaaaaaa"). Mock is scoped to this file.
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return {
    ...actual,
    randomBytes: (size: number) => Buffer.alloc(size),
  }
})

// Import AFTER the mock so blogs.ts binds to the mocked randomBytes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
import { SlopItError } from '../src/errors.js'

describe('createBlog — narrow error mapping through the function', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lets a non-name UNIQUE error (blogs.id collision) bubble raw; does NOT mislabel as BLOG_NAME_CONFLICT', () => {
    // First call succeeds.
    const first = createBlog(store, {})

    // Second call generates the same id (mock) → blogs.id UNIQUE.
    let caught: unknown
    try {
      createBlog(store, {})
    } catch (e) {
      caught = e
    }

    expect(first.blog.id).toMatch(/^[a]{8}$/) // sanity: mock took effect
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(SlopItError)
    expect((caught as Error).message).toContain('blogs.id')
    // SQLite raises SQLITE_CONSTRAINT_PRIMARYKEY for PK violations
    // (not SQLITE_CONSTRAINT_UNIQUE); our narrow predicate matches UNIQUE
    // only, so it correctly returns false for this case.
    expect((caught as NodeJS.ErrnoException).code).toBe('SQLITE_CONSTRAINT_PRIMARYKEY')
  })
})
```

- [ ] **Step 4.6: Run new test + full suite, verify pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. The new test should pass on first run because the implementation from Step 4.3 already calls `isBlogNameConflict`, which returns `false` for `blogs.id` errors. If this test *fails*, `createBlog` is catching too widely and must be fixed before proceeding.

- [ ] **Step 4.7: Commit**

```bash
git add src/blogs.ts tests/blogs.test.ts tests/blogs.id-collision.test.ts
git commit -m "Add createBlog with narrow error mapping + regression guard

generateShortId (local) produces 8-char URL-safe ids on a 32-char
alphabet. Narrow error mapping: only UNIQUE on blogs.name becomes
SlopItError(BLOG_NAME_CONFLICT); other UNIQUE errors (the astronomically
unlikely blogs.id collision) bubble unwrapped. Zod validates input at
the entry point; consumers handle ZodError.

Includes an end-to-end test that mocks node:crypto to force a blogs.id
collision through createBlog and asserts the raw SQLite error bubbles
instead of being mislabeled — catches any future edit that widens the
catch clause.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: createApiKey

**Files:**
- Modify: `src/blogs.ts` (append imports + function)
- Modify: `tests/blogs.test.ts` (append)

- [ ] **Step 5.1: Write failing tests**

Append to `tests/blogs.test.ts`:

```ts
import { createApiKey } from '../src/blogs.js'
import { hashApiKey } from '../src/auth/api-key.js'

describe('createApiKey', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a sk_slop_-prefixed plaintext key for an existing blog', () => {
    const { blog } = createBlog(store, {})
    const { apiKey } = createApiKey(store, blog.id)
    expect(apiKey).toMatch(/^sk_slop_/)
  })

  it('stores the sha256 hash only; plaintext is never persisted', () => {
    const { blog } = createBlog(store, {})
    const { apiKey } = createApiKey(store, blog.id)

    const hash = hashApiKey(apiKey)
    const row = store.db
      .prepare('SELECT key_hash FROM api_keys WHERE blog_id = ?')
      .get(blog.id) as { key_hash: string }
    expect(row.key_hash).toBe(hash)

    // No row where key_hash == plaintext (defense check)
    const plaintextRows = store.db
      .prepare('SELECT 1 FROM api_keys WHERE key_hash = ?')
      .all(apiKey)
    expect(plaintextRows).toHaveLength(0)
  })

  it('allows multiple keys per blog (each call mints a new one)', () => {
    const { blog } = createBlog(store, {})
    const a = createApiKey(store, blog.id).apiKey
    const b = createApiKey(store, blog.id).apiKey
    expect(a).not.toBe(b)

    const count = store.db
      .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE blog_id = ?')
      .get(blog.id) as { n: number }
    expect(count.n).toBe(2)
  })

  it('throws SlopItError(BLOG_NOT_FOUND) for an unknown blog id', () => {
    let caught: unknown
    try {
      createApiKey(store, 'nonexistent')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('BLOG_NOT_FOUND')
  })

  it('leaves no api_keys row behind when the blog does not exist', () => {
    try { createApiKey(store, 'nonexistent') } catch { /* expected */ }
    const count = store.db
      .prepare('SELECT COUNT(*) AS n FROM api_keys')
      .get() as { n: number }
    expect(count.n).toBe(0)
  })
})
```

- [ ] **Step 5.2: Run tests, verify failure**

```bash
pnpm test tests/blogs.test.ts
```

Expected: FAIL — `createApiKey` not exported.

- [ ] **Step 5.3: Implement**

Append to `src/blogs.ts` (add the new import at top with the other imports; add the function at the bottom):

At the top of the imports block, add:

```ts
import { generateApiKey, hashApiKey } from './auth/api-key.js'
```

At the bottom of the file, add:

```ts
export function createApiKey(
  store: Store,
  blogId: string,
): { apiKey: string } {
  const apiKey = generateApiKey()
  const keyHash = hashApiKey(apiKey)
  const id = generateShortId()

  // The FK on api_keys.blog_id already blocks orphan rows, but we do an
  // explicit existence check so the caller gets SlopItError(BLOG_NOT_FOUND)
  // instead of a cryptic FOREIGN KEY constraint error.
  const tx = store.db.transaction(() => {
    const found = store.db
      .prepare('SELECT 1 FROM blogs WHERE id = ?')
      .get(blogId)
    if (!found) {
      throw new SlopItError(
        'BLOG_NOT_FOUND',
        `Blog "${blogId}" does not exist`,
      )
    }
    store.db
      .prepare('INSERT INTO api_keys (id, blog_id, key_hash) VALUES (?, ?, ?)')
      .run(id, blogId, keyHash)
  })

  tx()

  return { apiKey }
}
```

- [ ] **Step 5.4: Run tests + typecheck, verify pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. 5 new `createApiKey` tests passing.

- [ ] **Step 5.5: Commit**

```bash
git add src/blogs.ts tests/blogs.test.ts
git commit -m "Add createApiKey

Mints a plaintext key for an existing blog; returns it once. Only the
sha256 hash is stored. Explicit existence check inside a transaction
raises SlopItError(BLOG_NOT_FOUND) cleanly instead of bubbling a
cryptic FOREIGN KEY constraint error. Multiple keys per blog are
allowed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Public exports

**Files:**
- Modify: `src/index.ts` (rewrite)
- Modify: `tests/blogs.test.ts` (append export-surface test)

- [ ] **Step 6.1: Write failing test**

Append to `tests/blogs.test.ts`:

```ts
describe('public barrel exports', () => {
  it('exposes createBlog, createApiKey, SlopItError, CreateBlogInputSchema', async () => {
    const mod = await import('../src/index.js')
    expect(typeof mod.createBlog).toBe('function')
    expect(typeof mod.createApiKey).toBe('function')
    expect(typeof mod.SlopItError).toBe('function') // class is callable
    expect(typeof mod.CreateBlogInputSchema).toBe('object') // Zod schema
  })
})
```

- [ ] **Step 6.2: Run test, verify failure**

```bash
pnpm test tests/blogs.test.ts -t "public barrel"
```

Expected: FAIL — `createBlog` / `createApiKey` / `SlopItError` not on the module (schema is re-exported via `export * from './schema/index.js'` so that may already pass; the `createBlog`/`createApiKey`/`SlopItError` assertions must fail).

- [ ] **Step 6.3: Implement**

Replace full contents of `src/index.ts`:

```ts
// Public surface of @slopit/core. Keep this file small and deliberate —
// every export here is a promise to consumers. See ARCHITECTURE.md.

export { createStore } from './db/store.js'
export type { Store, StoreConfig } from './db/store.js'

export * from './schema/index.js'

export { createBlog, createApiKey } from './blogs.js'

export { SlopItError } from './errors.js'
export type { SlopItErrorCode } from './errors.js'

// Factories below are stubs for now; wire them up one at a time.
export { createApiRouter } from './api/index.js'
export type { ApiRouterConfig } from './api/index.js'

export { createRenderer } from './rendering/generator.js'
export type { Renderer, RendererConfig } from './rendering/generator.js'

export { createMcpServer } from './mcp/server.js'
export type { McpServerConfig } from './mcp/server.js'
```

- [ ] **Step 6.4: Run tests + typecheck, verify pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green.

- [ ] **Step 6.5: Commit**

```bash
git add src/index.ts tests/blogs.test.ts
git commit -m "Export createBlog, createApiKey, SlopItError from public barrel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Final verification

**Files:**
- None (verification and push only).

- [ ] **Step 7.1: Install coverage provider**

Vitest needs `@vitest/coverage-v8` to actually emit coverage. It is not in the scaffold.

```bash
pnpm add -D @vitest/coverage-v8
```

Verify the devDep landed in `package.json` and `pnpm-lock.yaml` updated.

- [ ] **Step 7.2: Full verification pass**

```bash
pnpm typecheck
pnpm test
pnpm exec vitest run --coverage
```

Note: the correct form is `pnpm exec vitest run --coverage`. The earlier-wrong form `pnpm test -- --coverage` silently drops the flag because of how pnpm forwards args.

Expected:
- Typecheck: no errors.
- Tests: all passing (smoke + errors + blogs + blogs.id-collision). At least 23 tests total.
- Coverage: 100% lines and branches on `src/blogs.ts` and `src/errors.ts`. A coverage summary is printed to the terminal; full HTML report in `coverage/`.

If any line in those two files is uncovered, add a test for it. If any test flakes, do not proceed — investigate.

- [ ] **Step 7.3: Commit the coverage provider devDep**

```bash
git add package.json pnpm-lock.yaml
git commit -m "Add @vitest/coverage-v8 devDependency for coverage reports

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7.4: Land the commits upstream**

The plan does not prescribe a branch strategy — branch context is environment-specific. Check `git status` first and follow the repo's active flow:

- **Single-contributor, pre-public repo** (the current state per `CLAUDE.md`): direct push to `main` is acceptable.
  ```bash
  git push origin main
  ```
- **Multi-contributor or public repo**: push a feature branch and open a PR.
  ```bash
  git push -u origin feat/create-blog && gh pr create
  ```

If unsure which mode applies, stop and ask before pushing.

- [ ] **Step 7.5: Done**

Feature complete. Next features (`getBlog`, `createPost`, etc.) get their own spec → plan → implementation cycles.

---

## Self-review

- **Spec coverage:** Every spec section maps to a task. `SlopItError` → T1. `isBlogNameConflict` → T2. `CreateBlogInputSchema` → T3. `createBlog` behavior + narrow error mapping + ID format → T4 (steps 4.1–4.4 for happy-path; steps 4.5–4.6 for the end-to-end narrow-match safety net). `createApiKey` behavior + existence check + multi-key + BLOG_NOT_FOUND → T5. Public surface → T6. Coverage target → T7 (with `@vitest/coverage-v8` installed in Step 7.1 and the correct `pnpm exec vitest run --coverage` command in Step 7.2).
- **Placeholder scan:** No TBD, no "implement later", no "add appropriate X". Every step shows the code or command it wants.
- **Type consistency:** `CreateBlogInput` defined in T3 and used in T4 — match. `SlopItError` defined T1, used T4/T5, exported T6 — match. `Store` imported consistently from `./db/store.js`. `isBlogNameConflict` exported from T2's `src/blogs.ts`, used inside `createBlog` in T4 — match.
- **Deviation noted:** `generateBlogId` renamed to `generateShortId` because the same helper is used by `api_keys.id` in Task 5. Still local to `src/blogs.ts`, still not exported.
- **Branch policy:** Step 7.4 does not hardcode `git push origin main` — it defers to the repo's active branch flow, with both direct-to-main (single-contributor, pre-public) and feature-branch/PR (multi-contributor, public) paths documented.
- **Node/API availability:** `randomBytes` from `node:crypto`, `mkdtempSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`. All stdlib, all available on the scaffold's declared Node ≥22.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-04-22-create-blog-implementation.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task; review between tasks; fast iteration with minimal context bloat in the main session.
2. **Inline Execution** — I execute tasks in this session with checkpoints for your review.

Which approach?
