# MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 8 MCP tools (signup, create_post, update_post, delete_post, get_blog, get_post, list_posts, report_bug) on `@slopit/core` with full REST-parity for business errors, per the spec at `docs/superpowers/specs/2026-04-24-mcp-tools-design.md`.

**Architecture:** MCP is a second transport, not a second data model. A small set of transport-agnostic helpers (`mapErrorToEnvelope`, `lookupIdempotencyRecord`, `recordIdempotencyResponse`, `resolveBearer`) is extracted from the existing REST code. A `wrapTool` higher-order function wraps each tool's business handler in the auth → cross-blog guard → idempotency → error-envelope pipeline. The MCP server is built with `@modelcontextprotocol/sdk`'s high-level `McpServer` class and returned unattached (consumer attaches a transport).

**Tech Stack:** TypeScript strict ESM, `@modelcontextprotocol/sdk@^1.29`, Zod v4, vitest, better-sqlite3, existing `src/api/*` + `src/auth/*` + `src/posts.ts` + `src/blogs.ts` primitives.

**Spec reference:** Every task below cites the spec decision it implements. Open the spec alongside this plan.

**Before starting:**
```bash
cd /Users/nj/Workspace/SlopIt/code/slopit/.worktrees/feat-mcp-tools
git status                    # clean, on feat/mcp-tools
pnpm install
pnpm check                    # 308 tests must pass before Task 1
```

If `pnpm check` fails: STOP. The baseline is wrong. Don't proceed.

---

## Work breakdown

- **Phase 0 (Tasks 1–3):** Refactors to prepare shared helpers. REST behavior unchanged.
- **Phase 1 (Tasks 4–6):** MCP scaffolding — `resolveBearer`, `wrapTool`, `createMcpServer` factory.
- **Phase 2 (Tasks 7–12):** The 8 tools, one group of related tools per task.
- **Phase 3 (Tasks 13–14):** Cross-cutting tests (tool-descriptions guard, envelope parity with REST).
- **Phase 4 (Tasks 15–16):** Tier 2 — transport examples + SKILL.md update. Fold in if scope allows.
- **Phase 5 (Task 17):** Final verification + PR wrap-up.

---

## Task 1: Extract `PostInputBaseSchema` + `slugTitleRefinement` to internal submodule

Implements spec Decision #6 + file `src/schema/post-input-base.ts`. Preparatory refactor: the base schema and slug-check refinement currently live inline inside `src/schema/index.ts`. They need to be shared with `src/mcp/tools.ts` without going through the public barrel.

**Files:**
- Create: `src/schema/post-input-base.ts`
- Modify: `src/schema/index.ts` (lines 16–43 — extract `PostInputBaseSchema` const and the `superRefine` callback)

- [x] **Step 1: Create `src/schema/post-input-base.ts`**

```ts
import { z } from 'zod'
import { generateSlug } from '../ids.js'

/**
 * Internal base schema shared across transports. Not re-exported from
 * src/schema/index.ts — consumers who need the shape use PostInputSchema.
 * Exists so REST's PostInputSchema and MCP's create_post tool schema
 * can share both the field shape and the slug/title refinement without
 * duplication.
 */
export const PostInputBaseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .optional(),
  body: z.string().trim().min(1),
  excerpt: z.string().max(300).optional(),
  tags: z.array(z.string()).default([]),
  status: z.enum(['draft', 'published']).default('published'),
  seoTitle: z.string().max(200).optional(),
  seoDescription: z.string().max(300).optional(),
  author: z.string().max(100).optional(),
  coverImage: z.url().optional(),
})

/**
 * Shared superRefine callback. If slug is omitted and the title has no
 * slug-compatible characters, the blog can't auto-derive a URL. Reject
 * at schema time with a clear message.
 */
export const slugTitleRefinement = (
  input: z.infer<typeof PostInputBaseSchema>,
  ctx: z.RefinementCtx,
): void => {
  if (input.slug === undefined && generateSlug(input.title) === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['title'],
      message: 'Title must contain slug-compatible characters, or provide an explicit slug',
    })
  }
}
```

- [x] **Step 2: Rewrite `src/schema/index.ts`**

Replace the inline `PostInputBaseSchema` const + inline `superRefine` callback with imports from the new module. Do NOT re-export them — they must stay out of the barrel because `src/index.ts` does `export * from './schema/index.js'` and re-exporting would leak them publicly. `src/mcp/tools.ts` (Task 8+) imports directly from `./post-input-base.js`, bypassing the barrel.

Final contents of `src/schema/index.ts`:

```ts
import { z } from 'zod'
import { PostInputBaseSchema, slugTitleRefinement } from './post-input-base.js'

// NOT re-exported — stays internal. MCP imports from ./post-input-base.js directly.

// Blog — the top-level container. name is nullable because unnamed /b/:slug
// blogs are allowed (see strategy: "instant" tier, path-based URLs).
export const BlogSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  theme: z.enum(['minimal']),
  createdAt: z.string(),
})
export type Blog = z.infer<typeof BlogSchema>

// PostInput — what the API/MCP caller provides. Kept opinionated.
export const PostInputSchema = PostInputBaseSchema.superRefine(slugTitleRefinement)
export type PostInput = z.input<typeof PostInputSchema>

// Patch schema for updatePost — slug is rejected via .strict(); empty
// patch is a valid no-op. See spec decision #2 + src/posts.ts updatePost.
export const PostPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).optional(),
    excerpt: z.string().max(300).optional(),
    tags: z.array(z.string()).optional(),
    status: z.enum(['draft', 'published']).optional(),
    seoTitle: z.string().max(200).optional(),
    seoDescription: z.string().max(300).optional(),
    author: z.string().max(100).optional(),
    coverImage: z.url().optional(),
  })
  .strict()
export type PostPatchInput = z.input<typeof PostPatchSchema>

// Post — what core stores and returns.
export const PostSchema = PostInputBaseSchema.extend({
  id: z.string(),
  blogId: z.string(),
  slug: z.string(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Post = z.infer<typeof PostSchema>

// Input for createBlog. `name` is DNS-subdomain-safe.
export const CreateBlogInputSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .optional(),
  theme: z.enum(['minimal']).default('minimal'),
})
export type CreateBlogInput = z.input<typeof CreateBlogInputSchema>
```

Copy the block-doc comments from the original file verbatim — the snippet above omits a few for brevity but the file on disk should preserve them.

- [x] **Step 3: Run the full test suite to verify no regression**

Run: `pnpm check`
Expected: all 308 tests still pass.

- [x] **Step 4: Commit**

```bash
git add src/schema/post-input-base.ts src/schema/index.ts
git commit -m "$(cat <<'EOF'
refactor: extract PostInputBaseSchema + slugTitleRefinement to internal module

Preparatory for MCP: both need to be shared between REST's
PostInputSchema and MCP's create_post tool schema without leaking
through the barrel. Lives in src/schema/post-input-base.ts, imported
by src/schema/index.ts for construction. No public-API change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extract `mapErrorToEnvelope` to `src/envelope.ts`

Implements spec "Error envelope — shared helper" section. Lifts the mapping logic out of `src/api/errors.ts` so MCP's `wrapTool` can call it identically.

**Files:**
- Create: `src/envelope.ts`
- Create: `tests/envelope.test.ts`
- Modify: `src/api/errors.ts`

- [x] **Step 1: Write failing tests for `mapErrorToEnvelope`**

Create `tests/envelope.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SlopItError } from '../src/errors.js'
import { mapErrorToEnvelope } from '../src/envelope.js'

describe('mapErrorToEnvelope', () => {
  it('maps ZodError to ZOD_VALIDATION envelope with 400 statusHint', () => {
    const schema = z.object({ n: z.number() })
    let caught: unknown
    try {
      schema.parse({ n: 'oops' })
    } catch (e) {
      caught = e
    }
    const env = mapErrorToEnvelope(caught)
    expect(env.code).toBe('ZOD_VALIDATION')
    expect(env.statusHint).toBe(400)
    expect(env.details).toHaveProperty('issues')
    expect(env.message).toBe('Request body failed schema validation')
  })

  it('maps SyntaxError to BAD_REQUEST envelope with 400 statusHint', () => {
    const env = mapErrorToEnvelope(new SyntaxError('bad json'))
    expect(env.code).toBe('BAD_REQUEST')
    expect(env.statusHint).toBe(400)
    expect(env.message).toBe('Malformed JSON body')
    expect(env.details).toEqual({ message: 'bad json' })
  })

  it('maps SlopItError to its code + mapped statusHint', () => {
    const err = new SlopItError('BLOG_NOT_FOUND', 'not found', { blog_id: 'x' })
    const env = mapErrorToEnvelope(err)
    expect(env.code).toBe('BLOG_NOT_FOUND')
    expect(env.statusHint).toBe(404)
    expect(env.details).toEqual({ blog_id: 'x' })
  })

  it('maps SlopItError with unknown code to 500 statusHint', () => {
    // cast through unknown — this tests the fallback, not public API
    const err = Object.assign(new SlopItError('BLOG_NOT_FOUND', 'x'), { code: 'WEIRD' as never })
    const env = mapErrorToEnvelope(err)
    expect(env.statusHint).toBe(500)
  })

  it('maps unknown throwables to INTERNAL_ERROR + console.error', () => {
    const logs: string[] = []
    const origConsole = console.error
    console.error = (...args: unknown[]) => {
      // Capture ALL args — mapErrorToEnvelope logs `'[slopit] …:'` as
      // arg[0] and the Error as arg[1]; asserting against only arg[0]
      // would miss the actual error text.
      logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    }
    try {
      const env = mapErrorToEnvelope(new Error('boom'))
      expect(env.code).toBe('INTERNAL_ERROR')
      expect(env.statusHint).toBe(500)
      expect(env.message).toBe('An internal error occurred')
      expect(env.details).toEqual({})
      expect(logs.join(' ')).toContain('boom')
      expect(logs.join(' ')).toContain('[slopit]')
    } finally {
      console.error = origConsole
    }
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/envelope.test.ts`
Expected: module not found — `Cannot find module '../src/envelope.js'`.

- [x] **Step 3: Create `src/envelope.ts`**

```ts
import { ZodError } from 'zod'
import { SlopItError, type SlopItErrorCode } from './errors.js'

export interface Envelope {
  code: string
  message: string
  details: Record<string, unknown>
  statusHint: number
}

const CODE_TO_STATUS: Record<SlopItErrorCode, number> = {
  BLOG_NAME_CONFLICT: 409,
  BLOG_NOT_FOUND: 404,
  POST_SLUG_CONFLICT: 409,
  POST_NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  IDEMPOTENCY_KEY_CONFLICT: 422,
  NOT_IMPLEMENTED: 501,
}

/**
 * Map any thrown value to the transport-agnostic envelope. REST wraps
 * this in its JSON response body; MCP wraps it in
 * { isError: true, content, structuredContent }.
 *
 * Side effect: unhandled errors are logged via console.error so the
 * consumer's logger sees them regardless of transport.
 */
export function mapErrorToEnvelope(err: unknown): Envelope {
  if (err instanceof ZodError) {
    return {
      code: 'ZOD_VALIDATION',
      message: 'Request body failed schema validation',
      details: { issues: err.issues },
      statusHint: 400,
    }
  }
  if (err instanceof SyntaxError) {
    return {
      code: 'BAD_REQUEST',
      message: 'Malformed JSON body',
      details: { message: err.message },
      statusHint: 400,
    }
  }
  if (err instanceof SlopItError) {
    const statusHint = CODE_TO_STATUS[err.code] ?? 500
    return {
      code: err.code,
      message: err.message,
      details: err.details,
      statusHint,
    }
  }
  console.error('[slopit] unhandled error:', err)
  return {
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred',
    details: {},
    statusHint: 500,
  }
}
```

- [x] **Step 4: Update `src/api/errors.ts` to delegate to `mapErrorToEnvelope`**

Replace the file contents with:

```ts
import type { Context } from 'hono'
import type { ErrorHandler } from 'hono/types'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { mapErrorToEnvelope } from '../envelope.js'

/**
 * Register via app.onError(errorMiddleware) — Hono's compose intercepts
 * thrown errors before they can propagate through middleware try/catch.
 * Delegates to mapErrorToEnvelope for the mapping (shared with MCP).
 */
export const errorMiddleware: ErrorHandler = (err, c) => {
  return respondError(c, err)
}

export function respondError(c: Context, err: unknown): Response {
  const env = mapErrorToEnvelope(err)
  return c.json(
    { error: { code: env.code, message: env.message, details: env.details } },
    env.statusHint as ContentfulStatusCode,
  )
}
```

- [x] **Step 5: Run the new tests — they should pass**

Run: `pnpm test -- tests/envelope.test.ts`
Expected: 5 passed.

- [x] **Step 6: Run the full test suite — REST tests should still pass unchanged**

Run: `pnpm check`
Expected: 308 + 5 = 313 tests pass; typecheck + lint + prettier green.

- [x] **Step 7: Commit**

```bash
git add src/envelope.ts src/api/errors.ts tests/envelope.test.ts
git commit -m "$(cat <<'EOF'
refactor: extract mapErrorToEnvelope to transport-agnostic helper

Lifts the SlopItError/ZodError/SyntaxError mapping out of
src/api/errors.ts so MCP's wrapTool can call it identically. Keeps
the REST envelope shape exactly as before (respondError still
returns c.json with the same { error: { code, message, details } }
body). Adds direct unit tests for the helper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extract idempotency store to `src/idempotency-store.ts`

Implements spec "Idempotency — shared helper" section. Pulls the SQL + scope-tuple logic out of `src/api/idempotency.ts` so MCP's `wrapTool` and REST's Hono middleware call the same helper.

**Files:**
- Create: `src/idempotency-store.ts`
- Create: `tests/idempotency-store.test.ts`
- Modify: `src/api/idempotency.ts`

- [x] **Step 1: Write failing tests for the store helper**

Create `tests/idempotency-store.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import {
  lookupIdempotencyRecord,
  recordIdempotencyResponse,
  type IdempotencyScope,
} from '../src/idempotency-store.js'

describe('idempotency-store', () => {
  let dir: string
  let store: Store

  const makeScope = (overrides: Partial<IdempotencyScope> = {}): IdempotencyScope => ({
    key: 'k-1',
    apiKeyHash: 'hash-a',
    method: 'POST',
    path: '/blogs/b/posts',
    requestHash: 'req-1',
    ...overrides,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-idem-store-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lookup returns miss on empty table', () => {
    expect(lookupIdempotencyRecord(store, makeScope())).toEqual({ status: 'miss' })
  })

  it('record then lookup returns hit-match', () => {
    recordIdempotencyResponse(store, makeScope(), '{"ok":true}', 200)
    const result = lookupIdempotencyRecord(store, makeScope())
    expect(result).toEqual({ status: 'hit-match', body: '{"ok":true}', responseStatus: 200 })
  })

  it('record then lookup with different requestHash returns hit-mismatch', () => {
    recordIdempotencyResponse(store, makeScope(), '{"ok":true}', 200)
    const result = lookupIdempotencyRecord(store, makeScope({ requestHash: 'req-2' }))
    expect(result).toEqual({ status: 'hit-mismatch' })
  })

  it('scope isolates by method — same key different method is a miss', () => {
    recordIdempotencyResponse(store, makeScope({ method: 'POST' }), '{"ok":true}', 200)
    expect(lookupIdempotencyRecord(store, makeScope({ method: 'MCP' }))).toEqual({ status: 'miss' })
  })

  it('scope isolates by path (REST path vs MCP tool name)', () => {
    recordIdempotencyResponse(store, makeScope({ method: 'MCP', path: 'create_post' }), '{}', 200)
    expect(
      lookupIdempotencyRecord(store, makeScope({ method: 'MCP', path: 'update_post' })),
    ).toEqual({ status: 'miss' })
  })

  it('scope isolates by apiKeyHash — different callers, same key, independent', () => {
    recordIdempotencyResponse(store, makeScope({ apiKeyHash: 'a' }), '{"first":1}', 200)
    const second = lookupIdempotencyRecord(store, makeScope({ apiKeyHash: 'b' }))
    expect(second).toEqual({ status: 'miss' })
  })

  it('recordIdempotencyResponse throws when apiKeyHash is empty (defensive)', () => {
    expect(() =>
      recordIdempotencyResponse(store, makeScope({ apiKeyHash: '' }), '{}', 200),
    ).toThrow(/apiKeyHash must be non-empty/)
  })

  it('lookupIdempotencyRecord throws when apiKeyHash is empty (defensive)', () => {
    expect(() => lookupIdempotencyRecord(store, makeScope({ apiKeyHash: '' }))).toThrow(
      /apiKeyHash must be non-empty/,
    )
  })
})
```

- [x] **Step 2: Run tests to verify failure**

Run: `pnpm test -- tests/idempotency-store.test.ts`
Expected: module not found.

- [x] **Step 3: Create `src/idempotency-store.ts`**

```ts
import type { Store } from './db/store.js'

export interface IdempotencyScope {
  key: string
  apiKeyHash: string
  method: string
  path: string
  requestHash: string
}

export type IdempotencyLookup =
  | { status: 'miss' }
  | { status: 'hit-match'; body: string; responseStatus: number }
  | { status: 'hit-mismatch' }

type StoredRow = {
  request_hash: string
  response_status: number
  response_body: string
}

function assertApiKeyHash(scope: IdempotencyScope): void {
  if (scope.apiKeyHash === '') {
    throw new Error(
      'idempotency-store: apiKeyHash must be non-empty — callers must skip idempotency for unauthenticated requests (REST decision #22, MCP decision #16)',
    )
  }
}

export function lookupIdempotencyRecord(
  store: Store,
  scope: IdempotencyScope,
): IdempotencyLookup {
  assertApiKeyHash(scope)
  const row = store.db
    .prepare(
      `SELECT request_hash, response_status, response_body
         FROM idempotency_keys
        WHERE key = ? AND api_key_hash = ? AND method = ? AND path = ?`,
    )
    .get(scope.key, scope.apiKeyHash, scope.method, scope.path) as StoredRow | undefined

  if (!row) return { status: 'miss' }
  if (row.request_hash !== scope.requestHash) return { status: 'hit-mismatch' }
  return {
    status: 'hit-match',
    body: row.response_body,
    responseStatus: row.response_status,
  }
}

export function recordIdempotencyResponse(
  store: Store,
  scope: IdempotencyScope,
  body: string,
  responseStatus: number,
): void {
  assertApiKeyHash(scope)
  store.db
    .prepare(
      `INSERT INTO idempotency_keys
         (key, api_key_hash, method, path, request_hash, response_status, response_body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scope.key,
      scope.apiKeyHash,
      scope.method,
      scope.path,
      scope.requestHash,
      responseStatus,
      body,
    )
}
```

- [x] **Step 4: Update `src/api/idempotency.ts` to use the new helper**

Replace the file with:

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

/**
 * Idempotency-Key middleware. Applies to POST/PATCH/DELETE requests
 * carrying an Idempotency-Key header from an AUTHENTICATED caller.
 * Delegates scope lookup/record to src/idempotency-store.ts (shared
 * with MCP). Weakened guarantee per spec decision #20.
 */
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
    const rawBody = await c.req.text()
    // Re-expose body so the handler can re-read it
    c.req.raw = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: rawBody || undefined,
    })
    const queryString = [...new URL(c.req.url).searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')
    const hashInput = [method, path, contentType, queryString, rawBody].join('\0')
    const requestHash = createHash('sha256').update(hashInput).digest('hex')

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

- [x] **Step 5: Run the full test suite**

Run: `pnpm check`
Expected: 308 + 5 (Task 2) + 8 (new idempotency-store tests) = 321 tests pass; typecheck + lint + prettier green.

- [x] **Step 6: Commit**

```bash
git add src/idempotency-store.ts src/api/idempotency.ts tests/idempotency-store.test.ts
git commit -m "$(cat <<'EOF'
refactor: extract idempotency store helpers (shared REST + MCP)

lookupIdempotencyRecord + recordIdempotencyResponse now live in
src/idempotency-store.ts. REST's Hono middleware delegates the
SQL/scope-tuple bits; MCP's wrapTool (next) will call the same
helper. Defensive assert on empty apiKeyHash keeps the decision-22
invariant unbreakable from either caller.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `resolveBearer` helper for MCP

Implements spec "Auth resolution" section. Reads the bearer token from `extra.authInfo?.token` (set by transports that carry auth natively — including `InMemoryTransport.send({ authInfo })`) and from `extra.requestInfo?.headers.authorization` case-insensitively (HTTP transports). Returns `null` under `authMode: 'none'`.

**Files:**
- Create: `src/mcp/auth.ts`
- Create: `tests/mcp/auth-helper.test.ts`

- [x] **Step 1: Write failing tests**

Create `tests/mcp/auth-helper.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { resolveBearer } from '../../src/mcp/auth.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

const makeExtra = (overrides: Partial<Extra> = {}): Extra =>
  ({
    signal: new AbortController().signal,
    sendRequest: async () => ({ _meta: undefined }) as never,
    sendNotification: async () => undefined,
    ...overrides,
  }) as Extra

describe('resolveBearer', () => {
  it("returns null under authMode: 'none'", () => {
    expect(resolveBearer(makeExtra(), { authMode: 'none' })).toBeNull()
  })

  it('reads from authInfo.token when present', () => {
    const extra = makeExtra({ authInfo: { token: 'sk_slop_abc', clientId: 'x', scopes: [] } })
    expect(resolveBearer(extra, { authMode: 'api_key' })).toBe('sk_slop_abc')
  })

  it("reads from requestInfo.headers.authorization (lowercase key, 'Bearer ' prefix)", () => {
    const extra = makeExtra({
      requestInfo: { headers: { authorization: 'Bearer sk_slop_lower' } },
    })
    expect(resolveBearer(extra, { authMode: 'api_key' })).toBe('sk_slop_lower')
  })

  it("reads from requestInfo.headers case-insensitively (Authorization, AUTHORIZATION)", () => {
    const extra1 = makeExtra({
      requestInfo: { headers: { Authorization: 'Bearer sk_slop_cap' } },
    })
    expect(resolveBearer(extra1, { authMode: 'api_key' })).toBe('sk_slop_cap')

    const extra2 = makeExtra({
      requestInfo: { headers: { AUTHORIZATION: 'Bearer sk_slop_upper' } },
    })
    expect(resolveBearer(extra2, { authMode: 'api_key' })).toBe('sk_slop_upper')
  })

  it("accepts 'bearer ' prefix case-insensitively", () => {
    const extra = makeExtra({
      requestInfo: { headers: { authorization: 'bearer sk_slop_mixed' } },
    })
    expect(resolveBearer(extra, { authMode: 'api_key' })).toBe('sk_slop_mixed')
  })

  it('returns null when header is missing', () => {
    expect(resolveBearer(makeExtra(), { authMode: 'api_key' })).toBeNull()
  })

  it('returns null when header exists but is not a Bearer', () => {
    const extra = makeExtra({
      requestInfo: { headers: { authorization: 'Basic dXNlcjpwYXNz' } },
    })
    expect(resolveBearer(extra, { authMode: 'api_key' })).toBeNull()
  })

  it('prefers authInfo.token over the header when both are present', () => {
    const extra = makeExtra({
      authInfo: { token: 'sk_slop_from_authinfo', clientId: 'x', scopes: [] },
      requestInfo: { headers: { authorization: 'Bearer sk_slop_from_header' } },
    })
    expect(resolveBearer(extra, { authMode: 'api_key' })).toBe('sk_slop_from_authinfo')
  })
})
```

- [x] **Step 2: Run — fails because module missing**

Run: `pnpm test -- tests/mcp/auth-helper.test.ts`
Expected: module not found.

- [x] **Step 3: Create `src/mcp/auth.ts`**

```ts
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

/**
 * Resolve the raw bearer token from a tool call's RequestHandlerExtra.
 *
 * Under authMode: 'none', always returns null — the wrapTool pipeline
 * resolves blog context from args.blog_id instead.
 *
 * Under authMode: 'api_key', tries two sources in order:
 *   1. extra.authInfo?.token — populated by transports that carry auth
 *      natively (InMemoryTransport.send({ authInfo }), OAuth-aware HTTP).
 *   2. extra.requestInfo?.headers — plain-record header map from HTTP
 *      transports. Lookup is case-insensitive (the SDK's IsomorphicHeaders
 *      is a plain object, not a `Headers` instance). Accepts both
 *      'Bearer ' and 'bearer ' prefixes case-insensitively.
 *
 * Returns null on any miss so the caller can map to UNAUTHORIZED once.
 */
export function resolveBearer(
  extra: Extra,
  config: { authMode?: 'api_key' | 'none' },
): string | null {
  if (config.authMode === 'none') return null

  if (typeof extra.authInfo?.token === 'string' && extra.authInfo.token !== '') {
    return extra.authInfo.token
  }

  const headers = extra.requestInfo?.headers
  if (!headers) return null

  let raw: string | undefined
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') {
      raw = Array.isArray(v) ? v[0] : v
      break
    }
  }
  if (typeof raw !== 'string') return null

  const lower = raw.toLowerCase()
  if (!lower.startsWith('bearer ')) return null
  return raw.slice('bearer '.length).trim() || null
}
```

- [x] **Step 4: Run tests — should pass**

Run: `pnpm test -- tests/mcp/auth-helper.test.ts`
Expected: 8 passed.

- [x] **Step 5: Commit**

```bash
git add src/mcp/auth.ts tests/mcp/auth-helper.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): resolveBearer reads authInfo.token or requestInfo headers

Supports both transport-native auth (authInfo from
InMemoryTransport.send or OAuth middleware) and plain Bearer headers
(HTTP transports). Case-insensitive header lookup because the SDK's
IsomorphicHeaders is a plain record, not a Headers instance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `wrapTool` higher-order function

Implements spec "`wrapTool` pipeline" section. One central place for auth → cross-blog guard → idempotency → error envelope. Every tool registration goes through `wrapTool`.

**Files:**
- Create: `src/mcp/wrap-tool.ts`
- Create: `tests/mcp/wrap-tool.test.ts`

- [x] **Step 1: Write failing tests for `wrapTool`**

Create `tests/mcp/wrap-tool.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createBlog, createApiKey } from '../../src/blogs.js'
import { SlopItError } from '../../src/errors.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { wrapTool } from '../../src/mcp/wrap-tool.js'
import type { McpServerConfig } from '../../src/mcp/server.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

const makeExtra = (overrides: Partial<Extra> = {}): Extra =>
  ({
    signal: new AbortController().signal,
    sendRequest: async () => ({ _meta: undefined }) as never,
    sendNotification: async () => undefined,
    ...overrides,
  }) as Extra

describe('wrapTool', () => {
  let dir: string
  let store: Store
  let config: McpServerConfig
  let apiKey: string
  let blogId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-wrap-tool-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    config = {
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      authMode: 'api_key',
    }
    const blog = createBlog(store, { name: 'b' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const authExtra = () =>
    makeExtra({ authInfo: { token: apiKey, clientId: 'test', scopes: [] } })

  it('public tools run without auth and wrap results in structuredContent', async () => {
    const cb = wrapTool(config, 'noop', { auth: 'public' }, async () => ({ ok: true }))
    const result = await cb({}, makeExtra())
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ ok: true })
    expect(result.content?.[0]).toMatchObject({ type: 'text' })
  })

  it("auth: 'required' + no bearer → UNAUTHORIZED envelope", async () => {
    const cb = wrapTool(config, 'x', { auth: 'required' }, async () => ({ ok: true }))
    const result = await cb({}, makeExtra())
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { code: 'UNAUTHORIZED' },
    })
  })

  it("auth: 'required' + invalid bearer → UNAUTHORIZED envelope", async () => {
    const cb = wrapTool(config, 'x', { auth: 'required' }, async () => ({ ok: true }))
    const result = await cb(
      {},
      makeExtra({ authInfo: { token: 'sk_slop_nope', clientId: 't', scopes: [] } }),
    )
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  })

  it('valid bearer + no args → business handler receives ctx.blog and ctx.apiKeyHash', async () => {
    const cb = wrapTool<{ blog_id?: string }>(config, 'x', { auth: 'required' }, async (_args, ctx) => {
      return { blog_id_from_ctx: ctx.blog!.id, hash_len: ctx.apiKeyHash!.length }
    })
    const res = await cb({}, authExtra())
    expect(res.structuredContent).toEqual({ blog_id_from_ctx: blogId, hash_len: 64 })
  })

  it('cross-blog guard: args.blog_id mismatches → BLOG_NOT_FOUND envelope', async () => {
    const cb = wrapTool<{ blog_id: string }>(
      config,
      'x',
      { auth: 'required', crossBlogGuard: true },
      async (_args) => ({ ok: true }),
    )
    const res = await cb({ blog_id: 'other' }, authExtra())
    expect(res.isError).toBe(true)
    expect(res.structuredContent).toMatchObject({
      error: { code: 'BLOG_NOT_FOUND', details: { blog_id: 'other' } },
    })
  })

  it('business-thrown SlopItError maps via envelope', async () => {
    const cb = wrapTool(config, 'x', { auth: 'required' }, async () => {
      throw new SlopItError('POST_NOT_FOUND', 'nope', { slug: 'x' })
    })
    const res = await cb({}, authExtra())
    expect(res.isError).toBe(true)
    expect(res.structuredContent).toMatchObject({
      error: { code: 'POST_NOT_FOUND', message: 'nope', details: { slug: 'x' } },
    })
    expect((res.content?.[0] as { type: string; text: string }).text).toBe(
      'POST_NOT_FOUND: nope',
    )
  })

  it("authMode: 'none' + crossBlogGuard: resolves blog from args.blog_id, no bearer required", async () => {
    const noneConfig: McpServerConfig = { ...config, authMode: 'none' }
    const cb = wrapTool<{ blog_id: string }>(
      noneConfig,
      'x',
      { auth: 'required', crossBlogGuard: true },
      async (_args, ctx) => ({ id: ctx.blog!.id }),
    )
    const res = await cb({ blog_id: blogId }, makeExtra())
    expect(res.isError).toBeUndefined()
    expect(res.structuredContent).toEqual({ id: blogId })
  })

  it('idempotency: same key + same args replays previous result', async () => {
    let calls = 0
    const cb = wrapTool<{ blog_id: string; idempotency_key?: string; name: string }>(
      config,
      'x',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      async (args) => {
        calls += 1
        return { call: calls, name: args.name }
      },
    )
    const a = await cb(
      { blog_id: blogId, idempotency_key: 'k1', name: 'a' },
      authExtra(),
    )
    const b = await cb(
      { blog_id: blogId, idempotency_key: 'k1', name: 'a' },
      authExtra(),
    )
    expect(calls).toBe(1)
    expect(b.structuredContent).toEqual(a.structuredContent)
  })

  it('idempotency: same key + different args → IDEMPOTENCY_KEY_CONFLICT', async () => {
    const cb = wrapTool<{ blog_id: string; idempotency_key?: string; name: string }>(
      config,
      'x',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      async (args) => ({ name: args.name }),
    )
    await cb({ blog_id: blogId, idempotency_key: 'k2', name: 'a' }, authExtra())
    const res = await cb({ blog_id: blogId, idempotency_key: 'k2', name: 'b' }, authExtra())
    expect(res.isError).toBe(true)
    expect(res.structuredContent).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_CONFLICT', details: { key: 'k2', method: 'MCP', path: 'x' } },
    })
  })

  it('idempotency is skipped when no idempotency_key is passed', async () => {
    let calls = 0
    const cb = wrapTool<{ blog_id: string; idempotency_key?: string }>(
      config,
      'x',
      { auth: 'required', idempotent: true, crossBlogGuard: true },
      async () => {
        calls += 1
        return { call: calls }
      },
    )
    await cb({ blog_id: blogId }, authExtra())
    await cb({ blog_id: blogId }, authExtra())
    expect(calls).toBe(2)
  })
})
```

`wrapTool`'s signature is `wrapTool(config, name, opts, business)` — config first, always explicit, no module-globals. `registerTools` in Tasks 7–12 passes the same `config` that `createMcpServer` received.

- [x] **Step 2: Run tests to verify failure**

Run: `pnpm test -- tests/mcp/wrap-tool.test.ts`
Expected: module not found.

- [x] **Step 3: Create `src/mcp/wrap-tool.ts`**

```ts
import { createHash } from 'node:crypto'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { getBlogInternal } from '../blogs.js'
import { SlopItError } from '../errors.js'
import { mapErrorToEnvelope } from '../envelope.js'
import {
  lookupIdempotencyRecord,
  recordIdempotencyResponse,
  type IdempotencyScope,
} from '../idempotency-store.js'
import type { Blog } from '../schema/index.js'
import { hashApiKey, verifyApiKey } from '../auth/api-key.js'
import { resolveBearer } from './auth.js'
import type { McpServerConfig } from './server.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

export interface WrapToolOpts {
  auth: 'required' | 'public'
  idempotent?: boolean
  crossBlogGuard?: boolean
}

export interface ToolCtx {
  store: McpServerConfig['store']
  config: McpServerConfig
  blog?: Blog
  apiKeyHash?: string
}

export type ToolBusiness<A> = (args: A, ctx: ToolCtx) => unknown | Promise<unknown>

type WrappedToolCallback<A> = (args: A, extra: Extra) => Promise<CallToolResult>

/**
 * Canonicalize args (minus idempotency_key) for MCP idempotency hashing.
 * Recursively sort object keys, compact JSON. Arrays preserve their
 * order — only object keys are sorted.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function canonicalRequestHash(toolName: string, args: Record<string, unknown>): string {
  const { idempotency_key: _ignored, ...rest } = args
  return createHash('sha256')
    .update('MCP\0' + toolName + '\0' + canonicalJson(rest))
    .digest('hex')
}

function successResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as CallToolResult['structuredContent'],
  }
}

function errorResult(err: unknown): CallToolResult {
  const env = mapErrorToEnvelope(err)
  return {
    isError: true,
    content: [{ type: 'text', text: `${env.code}: ${env.message}` }],
    structuredContent: {
      error: { code: env.code, message: env.message, details: env.details },
    },
  }
}

/**
 * Wrap a business handler with the auth → cross-blog → idempotency →
 * error-envelope pipeline. Every MCP tool registration goes through
 * this. Config is explicit (first arg) so multiple McpServer instances
 * in the same process don't collide on a global, and so tests can
 * stand up an isolated server without module state.
 */
export function wrapTool<A extends Record<string, unknown> = Record<string, unknown>>(
  config: McpServerConfig,
  name: string,
  opts: WrapToolOpts,
  business: ToolBusiness<A>,
): WrappedToolCallback<A> {
  return async (args, extra) => {
    try {
      const ctx: ToolCtx = { store: config.store, config }

      // Step 1: Auth
      if (opts.auth === 'required') {
        if (config.authMode === 'none') {
          if (!opts.crossBlogGuard) {
            throw new SlopItError(
              'UNAUTHORIZED',
              "Tool requires authentication but authMode: 'none' cannot resolve blog without crossBlogGuard",
            )
          }
          const blogId = args.blog_id
          if (typeof blogId !== 'string') {
            throw new SlopItError('BLOG_NOT_FOUND', 'Missing or invalid blog_id', {})
          }
          ctx.blog = getBlogInternal(config.store, blogId)
          ctx.apiKeyHash = ''
        } else {
          const bearer = resolveBearer(extra, config)
          if (!bearer) throw new SlopItError('UNAUTHORIZED', 'Missing bearer token')
          const blog = verifyApiKey(config.store, bearer)
          if (!blog) throw new SlopItError('UNAUTHORIZED', 'Invalid API key')
          ctx.blog = blog
          ctx.apiKeyHash = hashApiKey(bearer)
        }
      }

      // Step 2: Cross-blog guard
      if (opts.crossBlogGuard && ctx.blog) {
        const blogId = args.blog_id
        if (typeof blogId === 'string' && blogId !== ctx.blog.id) {
          throw new SlopItError('BLOG_NOT_FOUND', `Blog "${blogId}" does not exist`, {
            blog_id: blogId,
          })
        }
      }

      // Step 3: Idempotency lookup
      const idemKey = typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined
      const idemEnabled = opts.idempotent === true && idemKey !== undefined && !!ctx.apiKeyHash
      let idemScope: IdempotencyScope | undefined
      if (idemEnabled) {
        idemScope = {
          key: idemKey as string,
          apiKeyHash: ctx.apiKeyHash as string,
          method: 'MCP',
          path: name,
          requestHash: canonicalRequestHash(name, args),
        }
        const result = lookupIdempotencyRecord(config.store, idemScope)
        if (result.status === 'hit-match') {
          return successResult(JSON.parse(result.body))
        }
        if (result.status === 'hit-mismatch') {
          throw new SlopItError(
            'IDEMPOTENCY_KEY_CONFLICT',
            `Idempotency-Key "${idemKey as string}" already used with a different payload for MCP tool ${name}`,
            { key: idemKey as string, method: 'MCP', path: name },
          )
        }
      }

      // Step 4: Run business
      const result = await business(args, ctx)

      // Step 5: Record on success
      if (idemEnabled && idemScope) {
        recordIdempotencyResponse(config.store, idemScope, JSON.stringify(result), 200)
      }

      // Step 6: Success envelope
      return successResult(result)
    } catch (err) {
      // Step 7: Error envelope
      return errorResult(err)
    }
  }
}

```

Note: no module-global state. `registerTools(server, config)` has `config` in scope and passes it to every `wrapTool` call. Tests do the same.

- [x] **Step 4: Run the `wrapTool` tests**

Run: `pnpm test -- tests/mcp/wrap-tool.test.ts`
Expected: 10 passed.

Note: `getBlogInternal` throws `BLOG_NOT_FOUND` on miss; the catch at step 7 maps it to the envelope correctly.

- [x] **Step 5: Run the full suite**

Run: `pnpm check`
Expected: typecheck + lint + prettier green. Test count = 321 (Task 3) + 8 (Task 4) + 10 (Task 5) = 339.

- [x] **Step 6: Commit**

```bash
git add src/mcp/wrap-tool.ts tests/mcp/wrap-tool.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): wrapTool HOF for auth + cross-blog + idempotency + envelope

Every tool handler goes through this. Keeps the pipeline plumbing in
one place; each tool registration passes thin business logic. Shared
idempotency-store helper + shared envelope mapping means MCP errors
match REST envelopes for every SlopItError.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `createMcpServer` factory replaces the stub

Implements spec "Public API" + Decision #12. Returns an SDK `McpServer` with no tools registered yet — tools land in Phase 2. Sets the active config so `wrapTool` can read it.

**Files:**
- Modify: `src/mcp/server.ts`
- Create: `tests/mcp/server.test.ts`

- [x] **Step 1: Write failing test for the factory shape**

Create `tests/mcp/server.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createMcpServer } from '../../src/mcp/server.js'

describe('createMcpServer', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-server-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns an unattached McpServer', () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    expect(server).toBeInstanceOf(McpServer)
  })

  it('connects to an InMemoryTransport cleanly', async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    // SDK 1.29 only registers tools/list lazily on first registerTool call;
    // an empty server would fail a listTools() assertion here. tools/list is
    // exercised naturally starting in Task 7 (signup test) and formally
    // asserted in Task 13 (tool-descriptions guard).
    await expect(server.connect(serverT)).resolves.not.toThrow()

    await server.close()
  })
})
```

- [x] **Step 2: Run — fails because stub throws**

Run: `pnpm test -- tests/mcp/server.test.ts`
Expected: `createMcpServer: not implemented` thrown.

- [x] **Step 3: Replace stub with factory**

Replace `src/mcp/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Store } from '../db/store.js'
import type { MutationRenderer } from '../rendering/generator.js'
import type { Blog } from '../schema/index.js'
import { registerTools } from './tools.js'

export interface McpServerConfig {
  store: Store
  rendererFor: (blog: Blog) => MutationRenderer
  baseUrl: string
  authMode?: 'api_key' | 'none'
  mcpEndpoint?: string
  docsUrl?: string
  skillUrl?: string
  bugReportUrl?: string
  dashboardUrl?: string
}

/**
 * Build an SDK McpServer with the 8 SlopIt tools registered. Returns
 * the server unattached — consumer calls `await server.connect(transport)`
 * with whichever transport they want (stdio, Streamable HTTP, etc).
 *
 * Config mirrors ApiRouterConfig field-for-field so platform can share
 * a single config object across both factories.
 */
export function createMcpServer(config: McpServerConfig): McpServer {
  const server = new McpServer({ name: '@slopit/core', version: '0.1.0' })
  registerTools(server, config)
  return server
}
```

- [x] **Step 4: Create a minimal `src/mcp/tools.ts` stub that compiles**

For this task we ship a placeholder so the factory compiles; tools populate in Phase 2.

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpServerConfig } from './server.js'

/**
 * Register all 8 SlopIt MCP tools on the given server.
 * Tools are added in sequence; each is independently testable.
 *
 * Populated across Tasks 7–12.
 */
export function registerTools(_server: McpServer, _config: McpServerConfig): void {
  // intentionally empty — filled in Phase 2
}
```

- [x] **Step 5: Run tests**

Run: `pnpm test -- tests/mcp/server.test.ts`
Expected: 2 passed.

- [x] **Step 6: Run `pnpm check`**

Run: `pnpm check`
Expected: typecheck + lint + prettier green; total test count = 339 + 2 = 341.

- [x] **Step 7: Commit**

```bash
git add src/mcp/server.ts src/mcp/tools.ts tests/mcp/server.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): createMcpServer factory replaces stub (no tools yet)

Returns an unattached McpServer; consumer owns transport wiring.
registerTools is a stub that Phase 2 will populate with the 8 tools.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `signup` tool

Implements spec tool #1. First of the 8 — establishes the test-harness pattern used by subsequent tasks.

**Files:**
- Modify: `src/mcp/tools.ts`
- Create: `tests/mcp/signup.test.ts`

- [x] **Step 1: Write the failing tests**

Create `tests/mcp/signup.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createMcpServer } from '../../src/mcp/server.js'

describe('MCP tool: signup', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: () => Promise<void>

  const boot = async (mcpEndpoint?: string) => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      mcpEndpoint,
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-signup-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('happy path: returns blog_id, blog_url, api_key, onboarding_text', async () => {
    await boot()
    const result = (await client.callTool({
      name: 'signup',
      arguments: { name: 'hello' },
    })) as {
      structuredContent: {
        blog_id: string
        blog_url: string
        api_key: string
        onboarding_text: string
        mcp_endpoint?: string
      }
      isError?: boolean
    }
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent.blog_id).toMatch(/^[a-z0-9]+$/)
    expect(result.structuredContent.blog_url).toBe('https://b.example')
    expect(result.structuredContent.api_key).toMatch(/^sk_slop_/)
    expect(result.structuredContent.onboarding_text).toContain(
      'Published my first post to SlopIt: <url>',
    )
    expect(result.structuredContent).not.toHaveProperty('mcp_endpoint')
  })

  it('includes mcp_endpoint when configured', async () => {
    await boot('https://mcp.example/mcp')
    const result = (await client.callTool({
      name: 'signup',
      arguments: {},
    })) as {
      structuredContent: { mcp_endpoint?: string }
    }
    expect(result.structuredContent.mcp_endpoint).toBe('https://mcp.example/mcp')
  })

  it('BLOG_NAME_CONFLICT envelope on duplicate name', async () => {
    await boot()
    await client.callTool({ name: 'signup', arguments: { name: 'taken' } })
    const result = (await client.callTool({
      name: 'signup',
      arguments: { name: 'taken' },
    })) as {
      isError: boolean
      structuredContent: { error: { code: string } }
    }
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('BLOG_NAME_CONFLICT')
  })

  it('regression guard (decision #22 parity): idempotency_key rejected by SDK schema validation', async () => {
    await boot()
    const result = (await client.callTool({
      name: 'signup',
      arguments: { name: 'idem', idempotency_key: 'nope' },
    })) as {
      isError: boolean
      content: { type: string; text: string }[]
      structuredContent?: unknown
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Input validation error')
    // SDK-shaped error has no structuredContent (decision #15)
    expect(result.structuredContent).toBeUndefined()
  })
})
```

- [x] **Step 2: Run — fails because `signup` tool isn't registered**

Run: `pnpm test -- tests/mcp/signup.test.ts`
Expected: tool not found / or callTool rejects. 4 failures.

- [x] **Step 3: Add `signup` to `src/mcp/tools.ts`**

Replace `src/mcp/tools.ts` with:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createApiKey, createBlog } from '../blogs.js'
import { generateOnboardingBlock } from '../onboarding.js'
import { CreateBlogInputSchema } from '../schema/index.js'
import type { McpServerConfig } from './server.js'
import { wrapTool } from './wrap-tool.js'

export function registerTools(server: McpServer, config: McpServerConfig): void {
  // 1. signup — create a blog + API key in one call.
  // Schema: exactly CreateBlogInputSchema — idempotency_key is deliberately
  // absent so SDK validation rejects it at the schema layer (decision #22
  // parity, decision #15 explains the SDK-shaped error that results).
  server.registerTool(
    'signup',
    {
      description:
        'Create a SlopIt blog and get an API key. Use this once, before anything else. Returns a live URL, the API key, and onboarding text to follow.',
      inputSchema: CreateBlogInputSchema.strict(),
    },
    wrapTool<{ name?: string; theme?: 'minimal' }>(
      config,
      'signup',
      { auth: 'public' },
      (args) => {
        const { blog } = createBlog(config.store, args)
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
        return {
          blog_id: blog.id,
          blog_url: renderer.baseUrl,
          api_key: apiKey,
          ...(config.mcpEndpoint !== undefined ? { mcp_endpoint: config.mcpEndpoint } : {}),
          onboarding_text: onboardingText,
        }
      },
    ),
  )
}
```

- [x] **Step 4: Run the signup tests**

Run: `pnpm test -- tests/mcp/signup.test.ts`
Expected: 4 passed.

- [x] **Step 5: Run `pnpm check`**

Run: `pnpm check`
Expected: 341 + 4 = 345 tests pass; green typecheck/lint/prettier.

- [x] **Step 6: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/signup.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): signup tool — create blog + api_key + onboarding text

First of 8 MCP tools. Mirrors REST /signup response shape (minus
_links). Schema is CreateBlogInputSchema.strict() — any
idempotency_key arg is rejected by SDK validation (spec decision #22
parity via #15).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `create_post` tool

Implements spec tool #2. Reuses `PostInputBaseSchema` + `slugTitleRefinement` from the internal submodule (Task 1). Authenticated + idempotent + cross-blog-guarded.

**Files:**
- Modify: `src/mcp/tools.ts`
- Create: `tests/mcp/posts-create.test.ts`

- [x] **Step 1: Write the failing tests**

Create `tests/mcp/posts-create.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiKey, createBlog } from '../../src/blogs.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { attachAuth, callTool } from './helpers.js'

describe('MCP tool: create_post', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: () => Promise<void>
  let blogId: string
  let apiKey: string
  let otherBlogId: string

  const boot = async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    attachAuth(clientT, apiKey)
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-create-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    const other = createBlog(store, { name: 'other' }).blog
    otherBlogId = other.id
    await boot()
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('happy path: publishes a post and returns post + post_url', async () => {
    const result = await callTool(client, 'create_post', {
      blog_id: blogId,
      title: 'Hello',
      body: '# Hi\n\nBody.',
    })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent.post.slug).toBe('hello')
    expect(result.structuredContent.post_url).toBe('https://b.example/hello/')
  })

  it('missing title → SDK-shaped validation error', async () => {
    const result = await callTool(client, 'create_post', { blog_id: blogId, body: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Input validation error')
    expect(result.structuredContent).toBeUndefined()
  })

  it('cross-blog guard: other blog_id → BLOG_NOT_FOUND envelope', async () => {
    const result = await callTool(client, 'create_post', {
      blog_id: otherBlogId,
      title: 'x',
      body: 'y',
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('BLOG_NOT_FOUND')
  })

  it('idempotency replay: same key + same args → identical response', async () => {
    const first = await callTool(client, 'create_post', {
      blog_id: blogId,
      title: 'Idem',
      body: 'x',
      idempotency_key: 'k-create-1',
    })
    const second = await callTool(client, 'create_post', {
      blog_id: blogId,
      title: 'Idem',
      body: 'x',
      idempotency_key: 'k-create-1',
    })
    expect(first.isError).toBeFalsy()
    expect(second.isError).toBeFalsy()
    expect(second.structuredContent).toEqual(first.structuredContent)
  })

  it('idempotency mismatch: same key + different args → IDEMPOTENCY_KEY_CONFLICT', async () => {
    await callTool(client, 'create_post', {
      blog_id: blogId,
      title: 'A',
      body: 'x',
      idempotency_key: 'k-create-2',
    })
    const result = await callTool(client, 'create_post', {
      blog_id: blogId,
      title: 'B',
      body: 'x',
      idempotency_key: 'k-create-2',
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT')
  })

  it('POST_SLUG_CONFLICT on duplicate explicit slug (no idempotency)', async () => {
    await callTool(client, 'create_post', { blog_id: blogId, title: 'A', slug: 'same', body: 'x' })
    const result = await callTool(client, 'create_post', { blog_id: blogId, title: 'B', slug: 'same', body: 'y' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('POST_SLUG_CONFLICT')
  })
})
```

- [x] **Step 2: Create `tests/mcp/helpers.ts`**

```ts
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Wrap the client-side InMemoryTransport so every outgoing message
 * carries authInfo. SDK exposes send({ authInfo }) natively; that
 * flows into extra.authInfo on the server side, which resolveBearer
 * reads. Test-only; production HTTP transport reads headers.
 */
export function attachAuth(transport: InMemoryTransport, token: string): void {
  const original = transport.send.bind(transport)
  transport.send = (message, options) =>
    original(message, { ...(options ?? {}), authInfo: { token, clientId: 'test', scopes: [] } })
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await client.request(
    { method: 'tools/call', params: { name, arguments: args } },
    CallToolResultSchema,
  )) as CallToolResult
}
```

- [x] **Step 3: Add `create_post` to `src/mcp/tools.ts`**

Append inside `registerTools`:

```ts
// 2. create_post — publish a new post.
const CreatePostInputSchema = z
  .object({ blog_id: z.string() })
  .extend(PostInputBaseSchema.shape)
  .extend({ idempotency_key: z.string().optional() })
  .strict()
  .superRefine(slugTitleRefinement)

server.registerTool(
  'create_post',
  {
    description:
      "Publish a post to the blog. Needs `title` and `body` (markdown). Returns the published post's live URL.",
    inputSchema: CreatePostInputSchema,
  },
  wrapTool<{ blog_id: string; idempotency_key?: string; title: string; body: string; [k: string]: unknown }>(
    config,
    'create_post',
    { auth: 'required', idempotent: true, crossBlogGuard: true },
    (args, ctx) => {
      const renderer = config.rendererFor(ctx.blog!)
      const { blog_id: _b, idempotency_key: _k, ...postInput } = args
      const { post, postUrl } = createPost(config.store, renderer, ctx.blog!.id, postInput)
      return {
        post,
        ...(postUrl !== undefined ? { post_url: postUrl } : {}),
      }
    },
  ),
)
```

Add the required imports at the top of the file:

```ts
import { z } from 'zod'
import { PostInputBaseSchema, slugTitleRefinement } from '../schema/post-input-base.js'
import { createPost } from '../posts.js'
```

- [x] **Step 4: Run create_post tests**

Run: `pnpm test -- tests/mcp/posts-create.test.ts`
Expected: 6 passed.

- [x] **Step 5: Full check + commit**

Run: `pnpm check`
Expected: 345 + 6 = 351 tests pass.

```bash
git add src/mcp/tools.ts tests/mcp/posts-create.test.ts tests/mcp/helpers.ts
git commit -m "$(cat <<'EOF'
feat(mcp): create_post tool with idempotency + cross-blog guard

Reuses PostInputBaseSchema + slugTitleRefinement from the internal
schema submodule — no duplication with REST's PostInputSchema. Shared
test helper for auth-injected tool calls lands here.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `update_post` tool

Implements spec tool #3. Wraps `PostPatchSchema` in a `patch` field. Each row of REST's status-matrix is tested.

**Files:**
- Modify: `src/mcp/tools.ts`
- Create: `tests/mcp/posts-update.test.ts`

- [x] **Step 1: Write the failing tests**

Create `tests/mcp/posts-update.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiKey, createBlog } from '../../src/blogs.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createPost, getPost } from '../../src/posts.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { attachAuth, callTool } from './helpers.js'

describe('MCP tool: update_post', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: () => Promise<void>
  let blogId: string
  let apiKey: string

  const boot = async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    attachAuth(clientT, apiKey)
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    // seed a published post
    createPost(store, renderer, blogId, { title: 'Seed', body: 'Original', slug: 'seed' })
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-update-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    await boot()
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('published → published preserves published_at', async () => {
    const firstPubAt = getPost(store, blogId, 'seed').publishedAt

    const result = await callTool(client, 'update_post', {
      blog_id: blogId,
      slug: 'seed',
      patch: { body: 'Edited' },
    })
    expect(result.isError).toBeFalsy()
    const post = result.structuredContent.post as { publishedAt: string; body: string }
    expect(post.publishedAt).toBe(firstPubAt)
    expect(post.body).toBe('Edited')
  })

  it('slug in patch → SDK-shaped validation error', async () => {
    const result = await callTool(client, 'update_post', {
      blog_id: blogId,
      slug: 'seed',
      patch: { slug: 'new-slug' },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Input validation error')
  })

  it('empty patch → returns current post unchanged', async () => {
    const result = await callTool(client, 'update_post', {
      blog_id: blogId,
      slug: 'seed',
      patch: {},
    })
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent.post as { slug: string }).slug).toBe('seed')
  })

  it('published → draft deletes the post file (DB still has the row)', async () => {
    const result = await callTool(client, 'update_post', {
      blog_id: blogId,
      slug: 'seed',
      patch: { status: 'draft' },
    })
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent.post as { status: string }).status).toBe('draft')
    // no post_url on draft
    expect(result.structuredContent.post_url).toBeUndefined()
  })
})
```

- [x] **Step 2: Run — fails (tool not registered)**

Run: `pnpm test -- tests/mcp/posts-update.test.ts`
Expected: failures on tool-not-found. The test uses `getPost` from the store directly (no `get_post` MCP tool dependency), so Task 11 is not a prerequisite.

- [x] **Step 3: Add `update_post` registration to `src/mcp/tools.ts`**

Append inside `registerTools` (after `create_post`):

```ts
// 3. update_post — patch an existing post.
const UpdatePostInputSchema = z
  .object({
    blog_id: z.string(),
    slug: z.string(),
    patch: PostPatchSchema,
    idempotency_key: z.string().optional(),
  })
  .strict()

server.registerTool(
  'update_post',
  {
    description:
      "Edit an existing post. Pass the post's `slug` and a `patch` of fields to change. Slug itself can't change; delete and republish if you need a new URL.",
    inputSchema: UpdatePostInputSchema,
  },
  wrapTool<{ blog_id: string; slug: string; patch: Record<string, unknown>; idempotency_key?: string }>(
    config,
    'update_post',
    { auth: 'required', idempotent: true, crossBlogGuard: true },
    (args, ctx) => {
      const renderer = config.rendererFor(ctx.blog!)
      const { post, postUrl } = updatePost(
        config.store,
        renderer,
        ctx.blog!.id,
        args.slug,
        args.patch as Parameters<typeof updatePost>[4],
      )
      return {
        post,
        ...(postUrl !== undefined ? { post_url: postUrl } : {}),
      }
    },
  ),
)
```

Add imports at the top:

```ts
import { PostPatchSchema } from '../schema/index.js'
import { updatePost } from '../posts.js'
```

- [x] **Step 4: Run the update_post tests**

Run: `pnpm test -- tests/mcp/posts-update.test.ts`
Expected: 4 passed.

- [x] **Step 5: `pnpm check` + commit**

Run: `pnpm check`
Expected: 351 + 4 = 355 tests pass.

```bash
git add src/mcp/tools.ts tests/mcp/posts-update.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): update_post tool wraps PostPatchSchema

Slug is immutable (SDK-level rejection); empty patch is a no-op;
status transitions produce the same render side effects as REST.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `delete_post` tool

Implements spec tool #4. Tests cover same-key replay vs no-key `POST_NOT_FOUND` (decision #20 parity).

**Files:**
- Modify: `src/mcp/tools.ts`
- Create: `tests/mcp/posts-delete.test.ts`

- [x] **Step 1: Write the failing tests**

Create `tests/mcp/posts-delete.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiKey, createBlog } from '../../src/blogs.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createPost } from '../../src/posts.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { attachAuth, callTool } from './helpers.js'

describe('MCP tool: delete_post', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: () => Promise<void>
  let blogId: string
  let apiKey: string
  let otherBlogId: string

  const boot = async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    attachAuth(clientT, apiKey)
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    const other = createBlog(store, { name: 'other' }).blog
    otherBlogId = other.id
    createPost(store, renderer, blogId, { title: 'Seed', body: 'Body', slug: 'seed' })
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-delete-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    await boot()
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('happy path returns { deleted: true }', async () => {
    const result = await callTool(client, 'delete_post', { blog_id: blogId, slug: 'seed' })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ deleted: true })
  })

  it('same-key retry replays { deleted: true } (hit-match)', async () => {
    const first = await callTool(client, 'delete_post', {
      blog_id: blogId,
      slug: 'seed',
      idempotency_key: 'k-del-1',
    })
    const second = await callTool(client, 'delete_post', {
      blog_id: blogId,
      slug: 'seed',
      idempotency_key: 'k-del-1',
    })
    expect(first.structuredContent).toEqual({ deleted: true })
    expect(second.structuredContent).toEqual({ deleted: true })
  })

  it('no-key retry after successful delete → POST_NOT_FOUND envelope', async () => {
    await callTool(client, 'delete_post', { blog_id: blogId, slug: 'seed' })
    const retry = await callTool(client, 'delete_post', { blog_id: blogId, slug: 'seed' })
    expect(retry.isError).toBe(true)
    expect(retry.structuredContent.error?.code).toBe('POST_NOT_FOUND')
  })

  it('cross-blog guard: blog_id mismatch → BLOG_NOT_FOUND', async () => {
    const result = await callTool(client, 'delete_post', { blog_id: otherBlogId, slug: 'seed' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error?.code).toBe('BLOG_NOT_FOUND')
  })
})
```

- [x] **Step 2: Run — fails**

Run: `pnpm test -- tests/mcp/posts-delete.test.ts`
Expected: 4 failures (tool not registered).

- [x] **Step 3: Add `delete_post` to `src/mcp/tools.ts`**

Append inside `registerTools`:

```ts
// 4. delete_post — hard-delete by slug.
const DeletePostInputSchema = z
  .object({
    blog_id: z.string(),
    slug: z.string(),
    idempotency_key: z.string().optional(),
  })
  .strict()

server.registerTool(
  'delete_post',
  {
    description: "Remove a post permanently. This can't be undone.",
    inputSchema: DeletePostInputSchema,
  },
  wrapTool<{ blog_id: string; slug: string; idempotency_key?: string }>(
    config,
    'delete_post',
    { auth: 'required', idempotent: true, crossBlogGuard: true },
    (args, ctx) => {
      const renderer = config.rendererFor(ctx.blog!)
      return deletePost(config.store, renderer, ctx.blog!.id, args.slug)
    },
  ),
)
```

Add import:

```ts
import { deletePost } from '../posts.js'
```

- [x] **Step 4: Run tests**

Run: `pnpm test -- tests/mcp/posts-delete.test.ts`
Expected: 4 passed.

- [x] **Step 5: `pnpm check` + commit**

Run: `pnpm check`
Expected: 355 + 4 = 359 tests.

```bash
git add src/mcp/tools.ts tests/mcp/posts-delete.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): delete_post with crash-window failure mode tests

Same-key retry replays {deleted:true}; no-key retry after successful
delete returns POST_NOT_FOUND (matching REST decision #20).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Read tools — `get_blog`, `get_post`, `list_posts`

Implements spec tools #5, #6, #7. Read-only; no idempotency; authenticated + cross-blog-guarded. Grouped because each is trivial.

**Files:**
- Modify: `src/mcp/tools.ts`
- Create: `tests/mcp/posts-read.test.ts`

- [x] **Step 1: Write the failing tests**

Create `tests/mcp/posts-read.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createApiKey, createBlog } from '../../src/blogs.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createPost } from '../../src/posts.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { attachAuth, callTool } from './helpers.js'

describe('MCP read tools', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: () => Promise<void>
  let blogId: string
  let apiKey: string

  const boot = async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    attachAuth(clientT, apiKey)
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
    const blog = createBlog(store, { name: 'bb' }).blog
    blogId = blog.id
    apiKey = createApiKey(store, blogId).apiKey
    createPost(store, renderer, blogId, { title: 'Pub1', body: 'b', slug: 'pub1' })
    createPost(store, renderer, blogId, {
      title: 'Draft1',
      body: 'b',
      slug: 'draft1',
      status: 'draft',
    })
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-read-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    await boot()
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('get_blog returns { blog }', async () => {
    const result = await callTool(client, 'get_blog', { blog_id: blogId })
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent.blog as { id: string }).id).toBe(blogId)
  })

  it('get_post happy path', async () => {
    const result = await callTool(client, 'get_post', { blog_id: blogId, slug: 'pub1' })
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent.post as { slug: string }).slug).toBe('pub1')
  })

  it('get_post miss → POST_NOT_FOUND envelope', async () => {
    const result = await callTool(client, 'get_post', { blog_id: blogId, slug: 'nope' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error?.code).toBe('POST_NOT_FOUND')
  })

  it('list_posts default returns published only', async () => {
    const result = await callTool(client, 'list_posts', { blog_id: blogId })
    expect(result.isError).toBeFalsy()
    const posts = result.structuredContent.posts as { slug: string; status: string }[]
    expect(posts).toHaveLength(1)
    expect(posts[0].slug).toBe('pub1')
  })

  it("list_posts status: 'draft' returns drafts only", async () => {
    const result = await callTool(client, 'list_posts', { blog_id: blogId, status: 'draft' })
    expect(result.isError).toBeFalsy()
    const posts = result.structuredContent.posts as { slug: string; status: string }[]
    expect(posts).toHaveLength(1)
    expect(posts[0].slug).toBe('draft1')
  })
})
```

- [x] **Step 2: Run — all fail (tools not registered)**

Run: `pnpm test -- tests/mcp/posts-read.test.ts`
Expected: 5 failures.

- [x] **Step 3: Add three read tools to `src/mcp/tools.ts`**

Append inside `registerTools`:

```ts
// 5. get_blog — return the authenticated blog's metadata.
server.registerTool(
  'get_blog',
  {
    description: "Get the blog's current metadata.",
    inputSchema: z.object({ blog_id: z.string() }).strict(),
  },
  wrapTool<{ blog_id: string }>(
    config,
    'get_blog',
    { auth: 'required', crossBlogGuard: true },
    (_args, ctx) => ({ blog: ctx.blog! }),
  ),
)

// 6. get_post — single post by slug.
server.registerTool(
  'get_post',
  {
    description: 'Get a single post by its slug.',
    inputSchema: z.object({ blog_id: z.string(), slug: z.string() }).strict(),
  },
  wrapTool<{ blog_id: string; slug: string }>(
    config,
    'get_post',
    { auth: 'required', crossBlogGuard: true },
    (args, ctx) => ({ post: getPost(config.store, ctx.blog!.id, args.slug) }),
  ),
)

// 7. list_posts — published by default; ?status=draft flips.
const ListPostsInputSchema = z
  .object({
    blog_id: z.string(),
    status: z.enum(['draft', 'published']).optional(),
  })
  .strict()

server.registerTool(
  'list_posts',
  {
    description:
      "List posts on the blog. Defaults to published posts. Pass `status: 'draft'` for drafts.",
    inputSchema: ListPostsInputSchema,
  },
  wrapTool<{ blog_id: string; status?: 'draft' | 'published' }>(
    config,
    'list_posts',
    { auth: 'required', crossBlogGuard: true },
    (args, ctx) => ({
      posts: listPosts(
        config.store,
        ctx.blog!.id,
        args.status !== undefined ? { status: args.status } : undefined,
      ),
    }),
  ),
)
```

Add imports:

```ts
import { getPost, listPosts } from '../posts.js'
```

- [x] **Step 4: Run tests**

Run: `pnpm test -- tests/mcp/posts-read.test.ts`
Expected: 5 passed.

- [x] **Step 5: `pnpm check` + commit**

Run: `pnpm check`
Expected: 359 + 5 = 364 tests pass.

```bash
git add src/mcp/tools.ts tests/mcp/posts-read.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): get_blog + get_post + list_posts read tools

Authenticated + cross-blog-guarded + read-only. list_posts default
is published (matches REST).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `report_bug` tool

Implements spec tool #8. Always errors with `NOT_IMPLEMENTED` + `details.use` pointing to `config.bugReportUrl` when configured.

**Files:**
- Modify: `src/mcp/tools.ts`
- Create: `tests/mcp/bridge.test.ts`

- [x] **Step 1: Write the failing tests**

Create `tests/mcp/bridge.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createMcpServer } from '../../src/mcp/server.js'

describe('MCP tool: report_bug', () => {
  let dir: string
  let store: Store
  let client: Client
  let closer: () => Promise<void>

  const boot = async (bugReportUrl?: string) => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
      bugReportUrl,
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test', version: '0' }, {})
    await c.connect(clientT)
    client = c
    closer = async () => {
      await c.close()
      await server.close()
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-bridge-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(async () => {
    await closer?.()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns NOT_IMPLEMENTED envelope with details.use when bugReportUrl is configured', async () => {
    await boot('https://slopit.io/bridge')
    const result = (await client.callTool({
      name: 'report_bug',
      arguments: { summary: 'does not deploy on sundays' },
    })) as {
      isError: boolean
      structuredContent: { error: { code: string; details: { use?: string } } }
    }
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('NOT_IMPLEMENTED')
    expect(result.structuredContent.error.details.use).toBe('https://slopit.io/bridge')
  })

  it('returns NOT_IMPLEMENTED envelope without details.use when bugReportUrl is not configured', async () => {
    await boot()
    const result = (await client.callTool({
      name: 'report_bug',
      arguments: {},
    })) as {
      isError: boolean
      structuredContent: { error: { code: string; details: Record<string, unknown> } }
    }
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('NOT_IMPLEMENTED')
    expect(result.structuredContent.error.details).toEqual({})
  })
})
```

- [x] **Step 2: Run — fails**

Run: `pnpm test -- tests/mcp/bridge.test.ts`
Expected: 2 failures.

- [x] **Step 3: Add `report_bug` to `src/mcp/tools.ts`**

Append inside `registerTools`:

```ts
// 8. report_bug — always errors with NOT_IMPLEMENTED + optional pointer.
server.registerTool(
  'report_bug',
  {
    description: 'Report a bug or something unexpected. Returns a link to submit the report.',
    inputSchema: z.object({
      summary: z.string().optional(),
      details: z.unknown().optional(),
    }),
  },
  wrapTool(config, 'report_bug', { auth: 'public' }, () => {
    throw new SlopItError(
      'NOT_IMPLEMENTED',
      'Bug reports are handled by the platform, not core',
      config.bugReportUrl !== undefined ? { use: config.bugReportUrl } : {},
    )
  }),
)
```

Add imports:

```ts
import { SlopItError } from '../errors.js'
```

- [x] **Step 4: Run tests**

Run: `pnpm test -- tests/mcp/bridge.test.ts`
Expected: 2 passed.

- [x] **Step 5: `pnpm check` + commit**

Run: `pnpm check`
Expected: 364 + 2 = 366 tests pass. All 8 tools registered.

```bash
git add src/mcp/tools.ts tests/mcp/bridge.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): report_bug stub with NOT_IMPLEMENTED + platform pointer

Eighth and final tool. Stays in core so agents always find the
endpoint; platform overrides with a real bridge later.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Tool-descriptions guard test

Implements spec decision #10. Structural assertions on all 8 descriptions: length < 240 chars, no banned vocab (`endpoint`, `MCP`, `middleware`, `primitive`, `bridge`).

**Files:**
- Create: `tests/mcp/tool-descriptions.test.ts`

- [x] **Step 1: Write the test**

Create `tests/mcp/tool-descriptions.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createMcpServer } from '../../src/mcp/server.js'

const BANNED = ['endpoint', 'mcp', 'middleware', 'primitive', 'bridge']
const EXPECTED_TOOLS = [
  'signup',
  'create_post',
  'update_post',
  'delete_post',
  'get_blog',
  'get_post',
  'list_posts',
  'report_bug',
]

describe('MCP tool descriptions', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-desc-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('all 8 tools are registered, each with a description under 240 chars and no banned vocab', async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' }, {})
    await client.connect(clientT)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort())

    for (const tool of tools) {
      expect(tool.description, `tool "${tool.name}" is missing a description`).toBeTruthy()
      expect(
        tool.description!.length,
        `tool "${tool.name}" description too long: ${tool.description!.length}`,
      ).toBeLessThan(240)
      const lower = tool.description!.toLowerCase()
      for (const banned of BANNED) {
        expect(lower, `tool "${tool.name}" description contains banned word "${banned}"`).not.toContain(
          banned,
        )
      }
    }

    await client.close()
    await server.close()
  })
})
```

- [x] **Step 2: Run the test**

Run: `pnpm test -- tests/mcp/tool-descriptions.test.ts`
Expected: 1 passed. If any description fails, fix the offending description in `src/mcp/tools.ts` and re-run.

- [x] **Step 3: Commit**

```bash
git add tests/mcp/tool-descriptions.test.ts
git commit -m "$(cat <<'EOF'
test(mcp): enforce tool description length + banned vocab

Agent-facing copy is audience-#1 (LLM renders it for non-technical
users). Tests catch regressions that introduce jargon like "endpoint"
or "middleware".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Envelope parity cross-transport test

Implements spec "Required coverage areas — wrap-tool parity". Confirms that throwing the same `SlopItError` from a business handler produces matching envelopes on MCP's `structuredContent.error` and REST's `{ error }` body (minus `statusHint`).

**Files:**
- Create: `tests/mcp/envelope-parity.test.ts`

- [x] **Step 1: Write the test**

Create `tests/mcp/envelope-parity.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SlopItError, type SlopItErrorCode } from '../../src/errors.js'
import { mapErrorToEnvelope } from '../../src/envelope.js'
import { createStore, type Store } from '../../src/db/store.js'

const CODES: SlopItErrorCode[] = [
  'BLOG_NAME_CONFLICT',
  'BLOG_NOT_FOUND',
  'POST_SLUG_CONFLICT',
  'POST_NOT_FOUND',
  'UNAUTHORIZED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'NOT_IMPLEMENTED',
]

describe('envelope parity across transports', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-mcp-parity-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each(CODES)(
    'SlopItError code %s maps to the same code + details on both transports',
    (code) => {
      const err = new SlopItError(code, `${code} msg`, { detail: 'x' })
      const env = mapErrorToEnvelope(err)

      // REST wire body shape (what src/api/errors.ts emits):
      const restWire = { error: { code: env.code, message: env.message, details: env.details } }

      // MCP wire body shape (what wrapTool emits; statusHint stripped):
      const mcpWire = {
        error: { code: env.code, message: env.message, details: env.details },
      }

      expect(restWire).toEqual(mcpWire)
      expect(env.code).toBe(code)
    },
  )
})
```

- [x] **Step 2: Run the test**

Run: `pnpm test -- tests/mcp/envelope-parity.test.ts`
Expected: 7 passed (one per code).

- [x] **Step 3: Commit**

```bash
git add tests/mcp/envelope-parity.test.ts
git commit -m "$(cat <<'EOF'
test(mcp): envelope parity with REST for every SlopItErrorCode

Pinned so future refactors of either transport can't silently
diverge the wire shape. statusHint is intentionally stripped from
the MCP envelope (MCP has no HTTP status concept).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15 (Tier 2): Transport examples under `examples/self-hosted/`

Implements spec "Tier 2 (fold in if scope allows)". Two example files showing how to wire the MCP server to stdio (self-host) and HTTP (alongside REST).

**Files:**
- Create: `examples/self-hosted/mcp-stdio.ts`
- Create: `examples/self-hosted/mcp-http.ts`

- [x] **Step 1: Create `examples/self-hosted/mcp-stdio.ts`**

```ts
/**
 * Self-hosted MCP stdio example.
 *
 * Pair with authMode: 'none' — stdio is a single-tenant local-dev/
 * desktop-agent scenario. Idempotency is api_key-mode only
 * (spec decision #16), so retries on this transport re-execute.
 *
 * Run: tsx examples/self-hosted/mcp-stdio.ts
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createStore } from '../../src/db/store.js'

async function main(): Promise<void> {
  const store = createStore({ dbPath: process.env.SLOPIT_DB ?? './slopit.db' })
  const renderer = createRenderer({
    store,
    outputDir: process.env.SLOPIT_OUT ?? './out',
    baseUrl: process.env.SLOPIT_BASE_URL ?? 'http://localhost:8080',
  })

  const server = createMcpServer({
    store,
    rendererFor: () => renderer,
    baseUrl: process.env.SLOPIT_BASE_URL ?? 'http://localhost:8080',
    authMode: 'none',
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [x] **Step 2: Create `examples/self-hosted/mcp-http.ts`**

```ts
/**
 * Self-hosted MCP over HTTP example.
 *
 * Mounts WebStandardStreamableHTTPServerTransport under Hono at /mcp alongside the
 * REST router. authMode: 'api_key' — bearer arrives in the
 * Authorization header on the HTTP request, propagated into
 * extra.requestInfo.headers for resolveBearer.
 *
 * Run: tsx examples/self-hosted/mcp-http.ts
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createApiRouter } from '../../src/api/index.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createStore } from '../../src/db/store.js'

async function main(): Promise<void> {
  const baseUrl = process.env.SLOPIT_BASE_URL ?? 'http://localhost:8080'
  const store = createStore({ dbPath: process.env.SLOPIT_DB ?? './slopit.db' })
  const renderer = createRenderer({
    store,
    outputDir: process.env.SLOPIT_OUT ?? './out',
    baseUrl,
  })

  const apiConfig = {
    store,
    rendererFor: () => renderer,
    baseUrl,
    mcpEndpoint: `${baseUrl}/mcp`,
  }

  const api = createApiRouter(apiConfig)
  const mcp = createMcpServer(apiConfig)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await mcp.connect(transport)

  const app = new Hono()
  app.route('/', api)
  app.all('/mcp', (c) => transport.handleRequest(c.req.raw))

  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [x] **Step 3: Verify the files compile with project tsconfig**

Run: `pnpm typecheck`
Expected: no type errors. If `@hono/node-server` is missing from deps, add it: `pnpm add @hono/node-server` (only for examples). If `WebStandardStreamableHTTPServerTransport` has a different constructor signature in the installed SDK version, adjust the example (check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts`).

- [x] **Step 4: Run the full check**

Run: `pnpm check`
Expected: still green.

- [x] **Step 5: Commit**

```bash
git add examples/self-hosted/mcp-stdio.ts examples/self-hosted/mcp-http.ts package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(examples): mcp-stdio + mcp-http self-hosted wiring

Stdio pairs with authMode: 'none'. HTTP mounts alongside REST under
/mcp. Platform wiring uses the same pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If `@hono/node-server` isn't needed (package not added), commit only the two `.ts` files.

---

## Task 16 (Tier 2): SKILL.md MCP section + drift-guard test

Implements spec "Tier 2 (fold in if scope allows) — #3".

**Files:**
- Modify: `src/skill.ts`
- Create: `tests/mcp/skill-parity.test.ts`

- [x] **Step 1: Write the drift-guard test (failing first)**

Create `tests/mcp/skill-parity.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createStore, type Store } from '../../src/db/store.js'
import { createRenderer } from '../../src/rendering/generator.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { generateSkillFile } from '../../src/skill.js'

describe('SKILL.md ↔ MCP tools parity', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-skill-parity-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('every registered MCP tool is documented in the SKILL.md MCP section', async () => {
    const renderer = createRenderer({
      store,
      outputDir: join(dir, 'out'),
      baseUrl: 'https://b.example',
    })
    const server = createMcpServer({
      store,
      rendererFor: () => renderer,
      baseUrl: 'https://api.example',
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' }, {})
    await client.connect(clientT)

    const { tools } = await client.listTools()
    const skill = generateSkillFile({ baseUrl: 'https://api.example' })
    for (const tool of tools) {
      expect(skill, `SKILL.md missing MCP tool: ${tool.name}`).toContain(tool.name)
    }
    expect(skill).toContain('## MCP tools')

    await client.close()
    await server.close()
  })
})
```

- [x] **Step 2: Run — fails (SKILL.md has no `## MCP tools` section yet)**

Run: `pnpm test -- tests/mcp/skill-parity.test.ts`
Expected: failure on `expect(skill).toContain('## MCP tools')`.

- [x] **Step 3: Add the MCP tools section to `src/skill.ts`**

Append (before the closing backtick of the template literal) — add a new trailing section:

```ts
## MCP tools

SlopIt also speaks MCP. Connect an MCP-capable agent to the server and call these tools directly — same operations as the REST endpoints above, one tool per operation.

| Tool | Auth | Idempotent | Purpose |
|---|---|---|---|
| signup | none | no | Create a blog + API key. |
| create_post | bearer | yes | Publish a post. |
| update_post | bearer | yes | Edit an existing post. |
| delete_post | bearer | yes | Remove a post permanently. |
| get_blog | bearer | — | Get blog metadata. |
| get_post | bearer | — | Get a single post by slug. |
| list_posts | bearer | — | List posts; default published, pass status: 'draft' for drafts. |
| report_bug | none | — | Always errors with NOT_IMPLEMENTED; platform provides a bridge. |

**Caveats specific to MCP:**

- **Validation errors are SDK-shaped.** If you pass invalid arguments (missing required field, extra field on a strict schema), the server returns \`{ isError: true, content: [{ type: 'text', text: 'Input validation error: ...' }] }\` with no \`structuredContent\`. Business errors (POST_NOT_FOUND, IDEMPOTENCY_KEY_CONFLICT, etc.) return the full REST-parity envelope under \`structuredContent.error\`.
- **Idempotency is api_key-mode only.** If the server is configured with \`authMode: 'none'\` (self-hosted stdio), retries re-execute and \`idempotency_key\` is a no-op.
- **signup is not idempotent.** Passing \`idempotency_key\` to signup fails schema validation. Retries create distinct blogs unless \`name\` collisions occur.
- **Canonical-JSON hash for MCP idempotency** (vs REST's bytewise). Reordering object keys in your args hashes identically on MCP, unlike REST where reordering trips IDEMPOTENCY_KEY_CONFLICT.
`
```

The exact placement: the existing `generateSkillFile` returns a template literal. Append the MCP tools markdown block at the bottom of that template string, just before the trailing backtick. Keep the existing sections untouched.

- [x] **Step 4: Run the drift-guard test**

Run: `pnpm test -- tests/mcp/skill-parity.test.ts`
Expected: 1 passed.

- [x] **Step 5: `pnpm check` + commit**

Run: `pnpm check`
Expected: all tests pass. The existing `tests/skill.test.ts` (if it exists — check and adjust if it asserts a line count of the SKILL.md output) may need its expectations updated.

```bash
git add src/skill.ts tests/mcp/skill-parity.test.ts
git commit -m "$(cat <<'EOF'
feat(skill): append MCP tools section + drift-guard test

Tools listed in SKILL.md must match registered MCP tools. Drift-guard
test catches future additions/removals that forget to update SKILL.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Final verification + PR wrap-up

**Files:** none (verification only)

- [x] **Step 1: Final `pnpm check`**

Run: `pnpm check`
Expected: all green. Expected test count: 308 (baseline) + 5 (envelope) + 8 (idem-store) + 8 (auth-helper) + 10 (wrap-tool) + 2 (server) + 4 (signup) + 6 (create_post) + 4 (update_post) + 4 (delete_post) + 5 (read tools) + 2 (bridge) + 1 (descriptions) + 7 (envelope parity) + 1 (skill parity) = ~375.

- [x] **Step 2: Verify public barrel is unchanged**

Run: `git diff dev..HEAD -- src/index.ts`
Expected: ONLY the `createMcpServer` and `McpServerConfig` swap — these were already exported as throwing stubs pre-feature. No new exports. No removed exports.

- [x] **Step 3: Verify no `slopit.io` strings leaked into core**

Run: `grep -rn 'slopit.io' src/ | grep -v 'renderPoweredBy'`
Expected: no output (rule #5 narrow exception preserved).

- [x] **Step 4: Verify no platform env vars are read by core**

Run: `grep -rn 'process.env.STRIPE\|process.env.CLOUDFLARE\|process.env.SLOPIT_DOMAIN' src/`
Expected: no output.

- [x] **Step 5: Verify self-hosted example still compiles**

Run: `pnpm tsc --noEmit -p examples/self-hosted/tsconfig.json 2>/dev/null || pnpm typecheck`
Expected: no errors.

- [x] **Step 6: Push the branch (if not already)**

Run: `git push -u origin feat/mcp-tools`

- [x] **Step 7: Update the PR body with the final checklist**

In the PR description (see PR template in `docs/superpowers/handoffs/feat-mcp-tools.md` "What to hand back when done" section), make sure the following are checked:

- [x] Spec: `docs/superpowers/specs/2026-04-24-mcp-tools-design.md`
- [x] Plan: `docs/superpowers/plans/2026-04-24-mcp-tools-implementation.md`
- [x] 8 tools registered
- [x] Shared helpers: `mapErrorToEnvelope`, `lookup/recordIdempotencyResponse`, `resolveBearer`
- [x] `wrapTool` HOF
- [x] Per-tool tests + cross-cutting tests
- [x] Tier 2: examples + SKILL.md parity (if applicable)
- [x] `pnpm check` green
- [x] Public barrel unchanged

---

## Self-review

The plan has been written. Scan checklist:

**Spec coverage:** Every one of the 16 decisions from the spec table has a corresponding task or step — Decisions #1 (per-connection bearer) → Task 4 (resolveBearer) + Task 5 (wrapTool). #2 (error envelope shape) → Task 2 + Task 5. #3 (shared idempotency) → Task 3 + Task 5. #4 (wrapTool) → Task 5. #5 (config mirrors) → Task 6. #6 (signup rejects idempotency_key) → Task 7 regression guard. #7 (cross-blog guard) → Task 5 + Task 8+. #8 (scope `method='MCP'`) → Task 5 wrapTool. #9 (canonical-JSON hash) → Task 5 canonicalRequestHash. #10 (non-technical descriptions) → Task 13. #11 (Zod schemas to registerTool) → Tasks 7–12. #12 (unattached McpServer) → Task 6. #13 (Tier 2 examples) → Task 15. #14 (no resources/prompts) → not implemented; spec is explicit. #15 (SDK-shaped validation) → Tasks 7–9 regression assertions. #16 (idempotency api_key-only) → Task 5 guard + SKILL.md caveat in Task 16.

**Placeholder scan:** No "TBD" / "TODO" / "implement later" / "similar to Task N" in this plan. Where a test has an adjustment step (e.g., Task 8 step 3 — transport-patching fallback), both the primary path AND the fallback path are fully specified.

**Type consistency:** `McpServerConfig` shape matches in Tasks 5, 6, 15. `ToolCtx` shape matches across Task 5 definition and later usage. `IdempotencyScope` shape consistent across Task 3 + Task 5.
