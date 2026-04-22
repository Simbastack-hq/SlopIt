# createBlog + createApiKey — Design Spec

**Status:** Revised 2026-04-22 after review. Pending user re-approval.
**Scope:** `@slopit/core`, first real feature pass.

---

## Context

Core's first two primitives:

- **`createBlog`** — creates a blog row. Returns the blog.
- **`createApiKey`** — creates an API key for an existing blog. Returns the plaintext key (once).

Every signup path builds on these:

- Self-hosted Docker bootstrap → calls both (`createBlog` then `createApiKey`) and prints the key.
- `POST /signup` REST handler in core → same composition, exposed as one HTTP call that internally runs both.
- Platform's hosted signup → calls `createBlog` only; platform uses its own account-scoped key table (separate concern, layered on top per `ARCHITECTURE.md`).

Splitting the two keeps each function single-responsibility, avoids minting unused key rows in the multi-tenant case, and gives us the natural home for future key rotation or additional keys per blog without touching blog creation.

Core is single-blog-scoped at request time, so this pair is the boundary between "no blog exists" and "blog exists with a key that can publish posts."

---

## Design decisions (resolved)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Blog `id` doubles as URL slug for unnamed blogs. | **Deliberate simplification.** Strategy.md presents `blog_id` and the path slug as distinct response fields; one field is simpler for v1. If we ever need opaque internal IDs, splitting into `id` + `path_slug` is a non-breaking migration (URLs stay stable because we keep the existing `id` values in a new `path_slug` column). |
| 2 | Pure operations live in one file per domain: `src/blogs.ts`. | YAGNI; split into a directory when a file grows past ~200 lines. |
| 3 | Errors: single `SlopItError` class with string-literal `code`. | One public class, easy switch-map to HTTP at the transport boundary. Core never carries HTTP status codes. |
| 4 | Sync functions, not async. | `better-sqlite3` is sync; no disk/network happens; async adds microtask overhead for no benefit. |
| 5 | No retry on ID collision. | 32⁸ ≈ 1.1 trillion combinations; statistically impossible at any scale we'll reach. |
| 6 | `createBlog` and `createApiKey` are separate functions. | Single responsibility; matches actual call patterns (platform doesn't want a key at blog creation); natural extension point for rotation/multi-key later. |

---

## Signatures

```ts
export function createBlog(
  store: Store,
  input: CreateBlogInput,
): { blog: Blog }

export function createApiKey(
  store: Store,
  blogId: string,
): { apiKey: string }
```

`createApiKey` returns the plaintext key **once**. It is never stored — only its sha256 hash is persisted in `api_keys.key_hash`. If the caller loses it, they issue a new one; there is no recovery path.

`createApiKey` throws `SlopItError('BLOG_NOT_FOUND', ...)` if `blogId` does not exist. (Introduces a second error code — added now because `createApiKey` actually needs it.)

---

## Input schema

Added to `src/schema/index.ts`:

```ts
export const CreateBlogInputSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .optional(),
  theme: z.enum(['minimal', 'classic', 'zine']).default('minimal'),
})
export type CreateBlogInput = z.infer<typeof CreateBlogInputSchema>
```

`name` is DNS-subdomain-safe: lowercase alphanumerics + hyphens, no leading or trailing hyphen, 2–63 chars. The `.min(2)` matches what the regex structurally enforces (two required character classes). 1-char blog names are disallowed — they're conventionally reserved, and nobody needs `a.slopit.io`.

The same constraints apply whether the blog ends up on a subdomain or not, for consistency.

---

## ID generation

Local helper in `src/blogs.ts` (not exported):

```ts
import { randomBytes } from 'node:crypto'

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789' // 32 chars; I/l/o/0/1 excluded

function generateBlogId(): string {
  const bytes = randomBytes(8)
  return Array.from(bytes, (b) => ID_ALPHABET[b % 32]).join('')
}
```

- 32-char alphabet is a power of 2; modulo is unbiased.
- Stdlib only — no `nanoid` dependency.
- Characters `I/l/o/0/1` omitted to reduce visual ambiguity.

For API key IDs, `src/auth/api-key.ts` already provides `generateApiKey` (prefixed with `sk_slop_`). The `api_keys.id` column uses a parallel stdlib helper (short random string, does not need to be URL-safe).

---

## Transactional flow

### `createBlog`

```sql
INSERT INTO blogs (id, name, theme, created_at) VALUES (?, ?, ?, datetime('now'))
```

Single-statement insert. No transaction wrapper needed — it's one statement.

### `createApiKey`

```sql
BEGIN
  SELECT 1 FROM blogs WHERE id = ?   -- existence check
  INSERT INTO api_keys (id, blog_id, key_hash, created_at) VALUES (?, ?, ?, datetime('now'))
COMMIT
```

Wrapped in `db.transaction(() => { ... })`. The existence check prevents creating a key for a non-existent blog even under concurrent blog deletion (if/when delete lands).

---

## Error handling

- **Invalid input** → `CreateBlogInputSchema.parse(input)` throws a `ZodError`. Not rewrapped; consumers handle it and map to HTTP 400 themselves.

- **Blog name conflict** (in `createBlog`) → SQLite throws with `code === 'SQLITE_CONSTRAINT_UNIQUE'` AND `message` containing `blogs.name`. Narrow check, because the migration has unique constraints on multiple columns (`blogs.id`, `blogs.name`, `api_keys.id`, `api_keys.key_hash`):

  ```ts
  try {
    insertBlog.run(id, name, theme)
  } catch (e) {
    if (
      e instanceof Error
      && (e as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE'
      && e.message.includes('blogs.name')
    ) {
      throw new SlopItError('BLOG_NAME_CONFLICT', `Blog name "${name}" is already taken`)
    }
    throw e
  }
  ```

  Any other `SQLITE_CONSTRAINT_UNIQUE` (e.g. the astronomically unlikely `blogs.id` collision) bubbles as-is — we surface the original SQLite error rather than misreport it as a name conflict.

- **Blog not found** (in `createApiKey`) → the existence check returns no row; throw `SlopItError('BLOG_NOT_FOUND', ...)`.

- **Any other DB error** → bubbles as-is. Core does not log or re-wrap; the consumer decides how to surface it.

### `src/errors.ts` (new)

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

Both codes are used by operations in this feature pass. Add further codes only when an operation actually throws them.

---

## Public surface added

In `src/index.ts`:

```ts
export { createBlog, createApiKey } from './blogs.js'
export type { CreateBlogInput } from './schema/index.js'
export { SlopItError } from './errors.js'
export type { SlopItErrorCode } from './errors.js'
```

---

## Testing

New file: `tests/blogs.test.ts`. Tests:

### `createBlog`

1. Creates an unnamed blog; verifies return shape `{ blog }` and `blog.id` is exactly 8 characters, all drawn from `abcdefghijkmnpqrstuvwxyz23456789`.
2. Creates a named blog; verifies `blog.name` persisted and `blog.id` still generated.
3. Creates a blog with default theme (`minimal`) when `theme` is omitted.
4. Throws `SlopItError` with `code === 'BLOG_NAME_CONFLICT'` when duplicate name is inserted.
5. Does **not** mislabel other `SQLITE_CONSTRAINT_UNIQUE` errors — test by directly inserting a duplicate `blogs.id` via raw SQL and asserting the raised error is **not** `SlopItError('BLOG_NAME_CONFLICT')`.
6. Zod rejects names with uppercase / invalid chars / too long / too short (1 char) / leading or trailing hyphen.

### `createApiKey`

7. Creates a key for an existing blog; verifies `apiKey` starts with `sk_slop_`.
8. Verifies each call returns a different key and the stored hash matches.
9. Verifies the plaintext key is never stored — no row in `api_keys` where `key_hash === plaintext`.
10. Throws `SlopItError` with `code === 'BLOG_NOT_FOUND'` when called with an unknown `blogId`.
11. Multiple keys per blog are allowed (two successive calls produce two rows).

### Errors

12. `SlopItError` round-trips `code` and `message` correctly; `instanceof Error` and `instanceof SlopItError` both hold.

Target: 100% line + branch coverage for `src/blogs.ts` and `src/errors.ts`.

---

## Out of scope (v1 protection)

Explicitly not in this feature pass:

- API key rotation or revocation (the `createApiKey` function supports multiple keys, but rotation UX is future work).
- Blog rename or theme change (`updateBlog`, later).
- Soft delete or archive.
- Blog lookup by name or id (`getBlog`, next pass).
- Anything touching `posts`.
- Platform's account-scoped API key layer (lives in `slopit-platform`, not here).
