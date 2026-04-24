# createPost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **For human execution:** Each task is bite-sized (2–5 min per step). Follow the steps in order within each task; tasks themselves run in order `1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 9.5 → 10 → 11 → 12 → 13`. (Task 9.5 was inserted during the plan-review round for XSS defense; it sits between Task 9 and the renderer implementation in Task 10.) Every TDD task follows the same shape: write failing test → run to fail → implement → run to pass → commit. Copy-paste the code blocks verbatim; don't paraphrase.

**Goal:** Implement `createPost(store, renderer, blogId, input)` end-to-end — Zod-validated input → slug preflight + narrow-match race guard → transactional INSERT → sync render of post page + blog index + CSS refresh on publish → DELETE compensation on render failure → return `{ post, postUrl? }`. Plus collateral: narrow theme enum to `['minimal']`, promote ID helpers to `src/ids.ts`, add optional `details` field to `SlopItError`.

**Architecture:** Pure operations in `src/posts.ts` and helpers in `src/ids.ts` / `src/rendering/templates.ts` / `src/rendering/generator.ts`. `Renderer` interface becomes sync (`better-sqlite3` and `renderMarkdown` are sync; `node:fs` sync writers are fine at our scale). File-based `minimal` theme in `src/themes/minimal/`. `@internal` helpers are module-level exports but are NOT re-exported through `src/index.ts` — tests and cross-module callers import from source paths directly.

**Tech Stack:** TypeScript strict ESM, Node >=22, `better-sqlite3`, Zod v4, Vitest, `marked`. No new dependencies — XSS protection in Task 9.5 uses marked's built-in renderer override, not a sanitization library.

---

## Authoritative spec

`docs/superpowers/specs/2026-04-22-create-post-design.md` (commit `3110320` on `feat/create-post`). All design decisions are documented there. If anything in this plan conflicts with the spec, the spec wins — stop and flag.

## Pre-flight

- Working directory: `/Users/nj/Workspace/SlopIt/code/slopit`.
- Branch: `feat/create-post`. Baseline is whatever the latest commit on this branch is at execution time — `main` + 6 docs-only commits (spec + 2 spec revisions + plan + plan revision + spec/plan-sync). Already branched from `main`. `git log main..HEAD` shows the full list.
- Baseline: `pnpm typecheck` passes; `pnpm test` shows 35 tests passing across 4 files. Every task must keep them green.
- Branch already pushed to `origin/feat/create-post` with PR #1 open. As implementation commits land, push incrementally so the PR reflects progress (`git push` after each task is fine; the branch is single-author for the duration of implementation).
- Do NOT add dependencies. Everything uses what's already installed.

## File Structure (this plan's full inventory)

| File | Action | Responsibility |
|---|---|---|
| `src/schema/index.ts` | MODIFY | Narrow `BlogSchema` / `CreateBlogInputSchema` theme enum to `['minimal']`. Enhance `PostInputSchema` (slug regex + min/max, title bounds, `superRefine` for empty auto-slug). Change `PostInput = z.input<...>`. |
| `src/themes/README.md` | MODIFY | Replace "three themes" references with minimal-only v1 wording. |
| `ARCHITECTURE.md` | MODIFY | (a) Line referencing "3 built-in themes" → minimal-only. (b) Boundary rule #5: add documented exception for the "Powered by SlopIt" footer link. |
| `DESIGN.md` | MODIFY | Replace "three themes it ships" wording → minimal-only v1. |
| `package.json` | MODIFY | Append `&& cp -R src/themes dist/themes` to the `build` script. |
| `tests/blogs.test.ts` | MODIFY | Update the existing `'accepts all three valid themes'` case to iterate only `['minimal']`. |
| `src/ids.ts` | NEW | `generateShortId()` (promoted from `src/blogs.ts`) + `generateSlug(title)`. Zero domain deps. |
| `src/blogs.ts` | MODIFY | Import `generateShortId` from `./ids.js`; remove the local helper + `ID_ALPHABET` const. Add `@internal` `getBlogInternal(store, blogId)`. |
| `tests/ids.test.ts` | NEW | Unit tests for `generateShortId` + `generateSlug`. |
| `src/errors.ts` | MODIFY | Add optional `details: Record<string, unknown>` (defaults `{}`) to `SlopItError`. Add `'POST_SLUG_CONFLICT'` to `SlopItErrorCode`. |
| `tests/errors.test.ts` | MODIFY | Add tests for the `details` field (default + explicit). |
| `src/posts.ts` | NEW | `createPost`, `@internal` `isPostSlugConflict`, `@internal` `autoExcerpt`, `@internal` `listPublishedPostsForBlog`. |
| `tests/posts.test.ts` | NEW | Tests for `PostInputSchema`, `isPostSlugConflict`, `autoExcerpt`, `listPublishedPostsForBlog`, `createPost`. Appended across Tasks 4, 5, 6, 11, 13. |
| `src/rendering/templates.ts` | NEW | `loadTheme(name)`, `render(template, vars)`, `escapeHtml(s)`. Pure. |
| `src/themes/minimal/post.html` | NEW | Post template with `{{...}}` vars. |
| `src/themes/minimal/index.html` | NEW | Blog-index template. |
| `src/themes/minimal/style.css` | NEW | ~70 lines, palette + typography from `DESIGN.md`. |
| `src/rendering/generator.ts` | MODIFY | New sync `Renderer` interface with readonly `baseUrl`; implement `createRenderer` with `renderPost` + `renderBlog`. Module-level `@internal` exports: `ensureCss`, `formatDate`, `renderPostList`, `renderTagList`, `renderPoweredBy`, `renderSeoMeta`. |
| `tests/rendering.test.ts` | NEW | Tests for `escapeHtml`, `render`, `loadTheme`, all fragment helpers, `renderPost`, `renderBlog`, `ensureCss`. Appended across Tasks 8, 9, 10. |
| `tests/posts.id-collision.test.ts` | NEW | Safety-net parallel to `tests/blogs.id-collision.test.ts`. Forces `posts.id` PK collision; asserts raw error bubbles (NOT `POST_SLUG_CONFLICT`). |
| `src/index.ts` | MODIFY | Re-export `createPost` and `PostInput`. |

## Testing strategy

- Every test using the DB uses `mkdtempSync` + `afterEach` cleanup. No shared DB state.
- Pure helpers (`generateSlug`, `autoExcerpt`, `escapeHtml`, `render`, fragment helpers, `isPostSlugConflict`) are tested synthetically with fixture inputs.
- `tests/posts.id-collision.test.ts` is a separate file so its `vi.mock('node:crypto')` is scoped and doesn't affect other tests.
- Coverage target: 100% line + branch on `src/posts.ts`, `src/ids.ts`, `src/rendering/templates.ts`, `src/rendering/generator.ts`.

---

## Task 1: Theme narrowing + collateral docs + build script

Purpose: tighten the theme enum to `['minimal']` and update every doc that claimed "three themes." Add the theme-copy step to the build script (themes will ship as real files inside the package). Single commit.

**Files:**
- Modify: `src/schema/index.ts` (theme enum in `BlogSchema` + `CreateBlogInputSchema`)
- Modify: `tests/blogs.test.ts` (`'accepts all three valid themes'` case)
- Modify: `src/themes/README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `DESIGN.md`
- Modify: `package.json` (build script)

- [ ] **Step 1.1: Read the existing test case**

Read the "accepts all three valid themes" block in `tests/blogs.test.ts`. It currently reads (verbatim, from the createBlog implementation commits):

```ts
it('accepts all three valid themes', () => {
  for (const theme of ['minimal', 'classic', 'zine'] as const) {
    expect(CreateBlogInputSchema.parse({ theme }).theme).toBe(theme)
  }
})
```

Leave the file open.

- [ ] **Step 1.2: Replace that test case**

Replace the block above with:

```ts
it('accepts the minimal theme', () => {
  expect(CreateBlogInputSchema.parse({ theme: 'minimal' }).theme).toBe('minimal')
})

it('rejects classic and zine (narrowed to minimal-only in v1)', () => {
  expect(() => CreateBlogInputSchema.parse({ theme: 'classic' })).toThrow()
  expect(() => CreateBlogInputSchema.parse({ theme: 'zine' })).toThrow()
})
```

- [ ] **Step 1.3: Run tests to see the first failure**

```bash
pnpm test tests/blogs.test.ts
```

Expected: **FAIL** — the two new cases will fail because `CreateBlogInputSchema` still accepts `'classic'` and `'zine'`.

- [ ] **Step 1.4: Narrow the schema**

Open `src/schema/index.ts`. Find the two occurrences of the enum `z.enum(['minimal', 'classic', 'zine'])` — one in `BlogSchema`, one in `CreateBlogInputSchema`. Change BOTH to:

```ts
z.enum(['minimal']).default('minimal')   // in CreateBlogInputSchema (already has .default)
```

and

```ts
theme: z.enum(['minimal']),                 // in BlogSchema (no default, keeps z.infer simple)
```

Actually — replace both enum literals so they look exactly like this:

**In `BlogSchema`:**
```ts
theme: z.enum(['minimal']),
```

**In `CreateBlogInputSchema`:**
```ts
theme: z.enum(['minimal']).default('minimal'),
```

Leave the rest of both schemas untouched.

- [ ] **Step 1.5: Run tests to verify they pass**

```bash
pnpm test tests/blogs.test.ts
pnpm typecheck
pnpm test
```

Expected: all green. Prior test count + 1 (we replaced one `it` with two, net +1).

- [ ] **Step 1.6: Update `src/themes/README.md`**

Open the file. It currently starts (paraphrased — use exact match on what's on disk):

> Core ships three themes (`minimal`, `classic`, `zine`). All three follow the rules here…

Replace that opening with:

> Core ships one built-in theme in v1: `minimal`. The theme system is designed to accept more (`classic`, `zine`, etc.) as separate follow-up features; each will land as a new folder under `src/themes/` with its own `post.html`, `index.html`, `style.css`. Until then, the rules here apply to `minimal` — and to any theme added later.

Save.

- [ ] **Step 1.7: Update `ARCHITECTURE.md`**

Two edits in this file.

**Edit A** — find the "What Goes Where" table row that says `Theme system + 3 built-in themes` and change it to:

```
| Theme system + built-in themes (v1: `minimal` only) | ✅ | |
```

**Edit B** — find boundary rule #5 about `slopit.io` strings. It currently reads (roughly):

> No `slopit.io` strings, and no platform env vars, in core. No Stripe keys, no Cloudflare tokens, no hardcoded domains, no marketing copy…

Replace with:

> No `slopit.io` strings, and no platform env vars, in core — **with one documented exception**: the "Powered by SlopIt" footer link emitted by `renderPoweredBy` in `src/rendering/generator.ts` points to `https://slopit.io`. This is the single branding hook in core; platform strips/replaces it per plan (Pro tier). Everything else this rule covers — Stripe keys, Cloudflare tokens, marketing copy, platform env vars, other hardcoded domains — stays forbidden.

- [ ] **Step 1.8: Update `DESIGN.md`**

Find the line near the top that says `The design spec for the three themes core ships` (or similar wording). Change to:

> The design spec for core's v1 built-in theme: `minimal`. Additional themes (`classic`, `zine`, etc.) will land as separate follow-up features and will follow the same rules here.

Also find the "Seven tokens. That's all." line — leave untouched (that's the palette count, unrelated to theme count).

- [ ] **Step 1.9: Update `package.json` build script**

Find the `"build"` script. It currently reads:

```json
"build": "tsc -p tsconfig.build.json && cp -R src/db/migrations dist/db/migrations",
```

Change to:

```json
"build": "tsc -p tsconfig.build.json && cp -R src/db/migrations dist/db/migrations && cp -R src/themes dist/themes",
```

The `src/themes/` directory doesn't exist yet — that's fine. It will be created in Task 7, well before anyone runs `pnpm build` in earnest.

- [ ] **Step 1.10: Run the full suite + typecheck + build**

```bash
pnpm typecheck
pnpm test
```

Expected: all green, 36 tests passing. (We net +1 from step 1.2.)

Do NOT run `pnpm build` yet — the build command references `src/themes` which doesn't exist until Task 7. The build check runs in Task 13.

- [ ] **Step 1.11: Commit**

```bash
git add src/schema/index.ts tests/blogs.test.ts src/themes/README.md ARCHITECTURE.md DESIGN.md package.json
git commit -m "Narrow theme enum to minimal; update collateral docs + build

- BlogSchema + CreateBlogInputSchema theme enum narrowed to ['minimal'].
  Classic/zine become follow-up features, each landing as a new folder
  under src/themes/. Keeps v1 shippable.
- Updated src/themes/README.md, ARCHITECTURE.md, and DESIGN.md to drop
  'three themes' framing.
- ARCHITECTURE.md boundary rule #5: documented narrow exception for the
  'Powered by SlopIt' footer link (the one intentional branding hook
  in core's themes; platform strips/replaces per plan).
- build script appends 'cp -R src/themes dist/themes' so the npm
  package ships with the minimal theme files (Task 7 creates them).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `src/ids.ts` — shared identifier helpers

Purpose: create a tiny new module housing `generateShortId` (promoted from `src/blogs.ts`) and `generateSlug` (new). Both are string → string pure functions with zero domain deps. Moving the `generateShortId` out of `src/blogs.ts` cleans up that file and lets `src/posts.ts` and `src/schema/index.ts` (for `superRefine`) depend on both without circular imports.

**Files:**
- Create: `src/ids.ts`
- Modify: `src/blogs.ts` (remove local helper, import from `./ids.js`)
- Create: `tests/ids.test.ts`

- [ ] **Step 2.1: Write failing tests**

Create `tests/ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { generateShortId, generateSlug } from '../src/ids.js'

describe('generateShortId', () => {
  const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

  it('produces an 8-char string from the expected alphabet', () => {
    const id = generateShortId()
    expect(id).toHaveLength(8)
    for (const ch of id) {
      expect(ALPHABET).toContain(ch)
    }
  })

  it('excludes visually ambiguous characters (I, l, o, 0, 1)', () => {
    // Generate many; assert none of the disallowed chars appear.
    for (let i = 0; i < 200; i++) {
      const id = generateShortId()
      expect(id).not.toMatch(/[Ilo01]/)
    }
  })

  it('returns different values on repeated calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateShortId())
    }
    expect(ids.size).toBeGreaterThan(95) // allow for astronomical collision
  })
})

describe('generateSlug', () => {
  it('kebab-cases a standard English title', () => {
    expect(generateSlug('Why AI Slop is the Future')).toBe('why-ai-slop-is-the-future')
  })

  it('strips punctuation', () => {
    expect(generateSlug('Why AI Slop is the Future!')).toBe('why-ai-slop-is-the-future')
    expect(generateSlug('AI & the Creator Economy')).toBe('ai-the-creator-economy')
  })

  it('collapses multiple separators into one hyphen', () => {
    expect(generateSlug('hello   world---foo')).toBe('hello-world-foo')
  })

  it('trims leading and trailing hyphens', () => {
    expect(generateSlug('!!!hello')).toBe('hello')
    expect(generateSlug('hello!!!')).toBe('hello')
    expect(generateSlug('---hello---')).toBe('hello')
  })

  it('strips diacritics (NFKD normalize + combining marks)', () => {
    expect(generateSlug('Café résumé')).toBe('cafe-resume')
    expect(generateSlug('naïve')).toBe('naive')
  })

  it('returns empty string for titles with no slug-compatible characters', () => {
    expect(generateSlug('!!!')).toBe('')
    expect(generateSlug('   ')).toBe('')
    expect(generateSlug('日本語のタイトル')).toBe('')   // all non-ASCII; NFKD doesn't convert
  })

  it('truncates to 100 chars and re-trims trailing hyphen', () => {
    const long = 'a'.repeat(200)
    expect(generateSlug(long)).toHaveLength(100)

    const longBoundary = 'a'.repeat(99) + '-' + 'b'.repeat(50)
    // 99 a's, 1 hyphen at pos 99 → slice to 100 → trailing hyphen trimmed
    const result = generateSlug(longBoundary)
    expect(result.endsWith('-')).toBe(false)
  })

  it('lowercases uppercase input', () => {
    expect(generateSlug('HELLO WORLD')).toBe('hello-world')
  })
})
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
pnpm test tests/ids.test.ts
```

Expected: **FAIL** — module `../src/ids.js` does not exist.

- [ ] **Step 2.3: Implement `src/ids.ts`**

Create `src/ids.ts`:

```ts
import { randomBytes } from 'node:crypto'

// 32 URL-safe characters (no I/l/o/0/1). Power of 2 → modulo is unbiased.
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/**
 * Generate an 8-char URL-safe id.
 *
 * Used for `blogs.id` and `api_keys.id` and `posts.id`. 32^8 ≈ 1.1 trillion
 * combinations — astronomically safe against random collision at any scale we'll hit.
 */
export function generateShortId(): string {
  const bytes = randomBytes(8)
  return Array.from(bytes, (b) => ID_ALPHABET[b % 32]).join('')
}

/**
 * Kebab-case a title into a DNS-safe slug:
 * - NFKD-normalize and strip combining marks (é → e, naïve → naive)
 * - Lowercase
 * - Replace any run of non-[a-z0-9] characters with a single hyphen
 * - Trim leading/trailing hyphens
 * - Truncate to 100 characters and re-trim a trailing hyphen that the slice may have introduced
 *
 * Returns an empty string when the title has no slug-compatible characters
 * (e.g. pure punctuation, emojis, or non-Latin scripts that NFKD can't
 * decompose into ASCII). Callers using auto-slug must check for empty
 * output — the input schema enforces this via superRefine.
 */
export function generateSlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')       // any run of non-alphanumeric → one hyphen
    .replace(/^-+|-+$/g, '')           // trim leading/trailing
    .slice(0, 100)
    .replace(/-+$/, '')                // re-trim if slice cut into a hyphen run
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
pnpm test tests/ids.test.ts
pnpm typecheck
```

Expected: both green. The `tests/ids.test.ts` file has ~11 tests, all passing.

- [ ] **Step 2.5: Update `src/blogs.ts` to use the promoted helper**

Open `src/blogs.ts`. It currently contains (top of file):

```ts
import { randomBytes } from 'node:crypto'
import { generateApiKey, hashApiKey } from './auth/api-key.js'
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
```

Replace the imports + local helper block with:

```ts
import { generateApiKey, hashApiKey } from './auth/api-key.js'
import type { Store } from './db/store.js'
import { SlopItError } from './errors.js'
import { generateShortId } from './ids.js'
import {
  CreateBlogInputSchema,
  type Blog,
  type CreateBlogInput,
} from './schema/index.js'
```

That removes:
- the `randomBytes` import (no longer used here)
- the `ID_ALPHABET` const
- the local `generateShortId` function

And adds the import of `generateShortId` from `./ids.js`. Everything else in `src/blogs.ts` stays exactly as it is — `createBlog`, `isBlogNameConflict`, `createApiKey` all still work against the imported `generateShortId`.

- [ ] **Step 2.6: Run full suite to verify nothing regressed**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. Test count: baseline before this task (36) + ~11 from Task 2 = 47.

- [ ] **Step 2.7: Commit**

```bash
git add src/ids.ts src/blogs.ts tests/ids.test.ts
git commit -m "Promote generateShortId to src/ids.ts + add generateSlug

src/ids.ts owns both identifier helpers:
- generateShortId moved from src/blogs.ts (was a local helper there,
  now shared between blogs, posts, and schema's superRefine without
  circular imports)
- generateSlug (new) — NFKD-normalize, strip diacritics, kebab-case,
  truncate to 100 chars. Returns '' for titles with no slug-compatible
  characters; the Zod superRefine in Task 4 will reject that case.

src/blogs.ts imports generateShortId from ./ids.js and drops its local
ID_ALPHABET + helper. No behavior change; all existing createBlog and
createApiKey tests still pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `SlopItError` gets `details` + `POST_SLUG_CONFLICT` code

Purpose: add an optional `details: Record<string, unknown>` field to `SlopItError` (backward-compatible — defaults to `{}`). Add `'POST_SLUG_CONFLICT'` to the `SlopItErrorCode` union so `createPost` can throw it in Task 11. Existing `BLOG_NAME_CONFLICT` / `BLOG_NOT_FOUND` callers work unchanged.

**Files:**
- Modify: `src/errors.ts`
- Modify: `tests/errors.test.ts`

- [ ] **Step 3.1: Write failing tests**

Append to `tests/errors.test.ts` (inside the existing `describe('SlopItError', ...)`, append after the last `it` and before the closing `})`):

```ts
  it('exposes a details object, defaulting to empty', () => {
    const e = new SlopItError('BLOG_NAME_CONFLICT', 'oops')
    expect(e.details).toEqual({})
  })

  it('carries structured details when provided', () => {
    const e = new SlopItError('POST_SLUG_CONFLICT', 'slug taken', { slug: 'my-slug' })
    expect(e.details).toEqual({ slug: 'my-slug' })
    expect(e.code).toBe('POST_SLUG_CONFLICT')
  })

  it('supports the POST_SLUG_CONFLICT code', () => {
    const e = new SlopItError('POST_SLUG_CONFLICT', 'x', { slug: 's' })
    expect(e.code).toBe('POST_SLUG_CONFLICT')
  })
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
pnpm test tests/errors.test.ts
```

Expected: **FAIL** — `e.details` is undefined, and the `'POST_SLUG_CONFLICT'` string literal isn't a member of `SlopItErrorCode` (TypeScript error in the test).

- [ ] **Step 3.3: Update `src/errors.ts`**

Replace the entire contents of `src/errors.ts` with:

```ts
export type SlopItErrorCode =
  | 'BLOG_NAME_CONFLICT'
  | 'BLOG_NOT_FOUND'
  | 'POST_SLUG_CONFLICT'

export class SlopItError extends Error {
  readonly code: SlopItErrorCode
  readonly details: Record<string, unknown>

  constructor(
    code: SlopItErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'SlopItError'
    this.code = code
    this.details = details
  }
}
```

Backward-compatible — existing two-arg throws work with `details` defaulting to `{}`.

- [ ] **Step 3.4: Run tests to verify they pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. All existing error + blogs tests still pass because `details` defaults. Test count: 47 + 3 new = 50.

- [ ] **Step 3.5: Commit**

```bash
git add src/errors.ts tests/errors.test.ts
git commit -m "Add SlopItError.details + POST_SLUG_CONFLICT code

- details: Record<string, unknown> optional constructor arg, defaults
  to {}. Backward-compatible — existing two-arg throws unchanged.
- SlopItErrorCode union adds 'POST_SLUG_CONFLICT' so Task 11 can throw
  it with details: { slug } per spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Enhance `PostInputSchema`

Purpose: tighten the existing `PostInputSchema` in `src/schema/index.ts` — slug length + regex + min=2 chars, title length bounds, a `.superRefine` that rejects the case where auto-slug would be empty. Also change `PostInput` from `z.infer<...>` to `z.input<...>` (same lesson as Task 4 of the createBlog plan — the input type must make `theme`, `status`, and `tags` optional for callers).

**Files:**
- Modify: `src/schema/index.ts`
- Create: `tests/posts.test.ts` (with a first `describe('PostInputSchema', ...)` block)

- [ ] **Step 4.1: Read the existing `PostInputSchema`**

Open `src/schema/index.ts`. Find `PostInputSchema` and `PostInput`. They currently look like:

```ts
export const PostInputSchema = z.object({
  title: z.string().min(1),
  slug: z.string().optional(),
  body: z.string(),
  excerpt: z.string().optional(),
  tags: z.array(z.string()).default([]),
  status: z.enum(['draft', 'published']).default('published'),
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
  author: z.string().optional(),
  coverImage: z.url().optional(),
})
export type PostInput = z.infer<typeof PostInputSchema>
```

(Exact formatting on disk may differ; the shape is what matters.)

- [ ] **Step 4.2: Write failing tests**

Create `tests/posts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PostInputSchema } from '../src/schema/index.js'

describe('PostInputSchema', () => {
  it('accepts the minimum well-formed input', () => {
    const parsed = PostInputSchema.parse({
      title: 'Hello',
      body: 'Hello world',
    })
    expect(parsed.title).toBe('Hello')
    expect(parsed.body).toBe('Hello world')
    expect(parsed.status).toBe('published') // default
    expect(parsed.tags).toEqual([])         // default
  })

  it('trims leading/trailing whitespace from title and body', () => {
    const parsed = PostInputSchema.parse({ title: '  Hello  ', body: '  body content  ' })
    expect(parsed.title).toBe('Hello')
    expect(parsed.body).toBe('body content')
  })

  it('accepts all optional fields', () => {
    const parsed = PostInputSchema.parse({
      title: 'A post',
      slug: 'a-post',
      body: 'hello',
      excerpt: 'summary',
      tags: ['ai', 'content'],
      status: 'draft',
      seoTitle: 'SEO title',
      seoDescription: 'SEO description',
      author: 'Agent 47',
      coverImage: 'https://example.com/img.png',
    })
    expect(parsed.slug).toBe('a-post')
    expect(parsed.status).toBe('draft')
    expect(parsed.tags).toEqual(['ai', 'content'])
  })

  it.each([
    ['empty title', { title: '', body: 'x' }],
    ['whitespace-only title', { title: '   ', body: 'x' }],
    ['title over 200 chars', { title: 'a'.repeat(201), body: 'x' }],
    ['empty body', { title: 'T', body: '' }],
    ['whitespace-only body', { title: 'T', body: '   ' }],
    ['slug too short (1 char)', { title: 'T', body: 'x', slug: 'a' }],
    ['slug over 100 chars', { title: 'T', body: 'x', slug: 'a'.repeat(101) }],
    ['slug with uppercase', { title: 'T', body: 'x', slug: 'Not-Valid' }],
    ['slug with underscore', { title: 'T', body: 'x', slug: 'bad_slug' }],
    ['slug with leading hyphen', { title: 'T', body: 'x', slug: '-leading' }],
    ['slug with trailing hyphen', { title: 'T', body: 'x', slug: 'trailing-' }],
    ['invalid status', { title: 'T', body: 'x', status: 'archived' }],
    ['coverImage not a URL', { title: 'T', body: 'x', coverImage: 'not-a-url' }],
    ['seoTitle over 200 chars', { title: 'T', body: 'x', seoTitle: 'a'.repeat(201) }],
    ['seoDescription over 300 chars', { title: 'T', body: 'x', seoDescription: 'a'.repeat(301) }],
    ['author over 100 chars', { title: 'T', body: 'x', author: 'a'.repeat(101) }],
    ['excerpt over 300 chars', { title: 'T', body: 'x', excerpt: 'a'.repeat(301) }],
  ])('rejects %s', (_, input) => {
    expect(() => PostInputSchema.parse(input)).toThrow()
  })

  describe('auto-slug validation (superRefine)', () => {
    it('rejects titles that would produce empty auto-slug when slug is omitted', () => {
      expect(() => PostInputSchema.parse({ title: '!!!', body: 'x' })).toThrow()
      expect(() => PostInputSchema.parse({ title: '日本語のタイトル', body: 'x' })).toThrow()
    })

    it('accepts titles with no slug-compatible chars when caller supplies an explicit slug', () => {
      expect(() => PostInputSchema.parse({
        title: '日本語のタイトル',
        body: 'x',
        slug: 'ja-title',
      })).not.toThrow()
    })

    it('accepts a valid title without explicit slug', () => {
      expect(() => PostInputSchema.parse({
        title: 'Valid Title',
        body: 'x',
      })).not.toThrow()
    })
  })
})
```

- [ ] **Step 4.3: Run tests to verify they fail**

```bash
pnpm test tests/posts.test.ts
```

Expected: **FAIL** — most rejection cases will pass vacuously (title length, slug regex, etc., because the schema is too permissive). Several will fail:
- slug-too-short: current schema has no length on slug.
- title-over-200: no max.
- empty-body: current has `z.string()` (no `.min(1)`).
- Most slug rejections.
- All superRefine tests — there's no superRefine.

- [ ] **Step 4.4: Update `PostInputSchema` in `src/schema/index.ts`**

Replace the `PostInputSchema` + `PostInput` declarations with:

```ts
import { generateSlug } from '../ids.js'

// ...

export const PostInputSchema = z
  .object({
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
  .superRefine((input, ctx) => {
    if (input.slug === undefined && generateSlug(input.title) === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['title'],
        message: 'Title must contain slug-compatible characters, or provide an explicit slug',
      })
    }
  })

export type PostInput = z.input<typeof PostInputSchema>
```

**Important:** the `import { generateSlug } from '../ids.js'` line goes at the top of `src/schema/index.ts`, with the other imports. Check the path — from `src/schema/index.ts`, the relative path is `'../ids.js'`.

- [ ] **Step 4.5: Run tests to verify they pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. New `tests/posts.test.ts` has ~21 assertions across 4 `it` blocks + 15 `it.each` + 3 superRefine cases.

Test count: 50 + ~21 = ~71.

- [ ] **Step 4.6: Commit**

```bash
git add src/schema/index.ts tests/posts.test.ts
git commit -m "Enhance PostInputSchema with strict bounds + superRefine

Adds:
- title.min(1).max(200)
- slug.min(2).max(100) + DNS-safe regex
- body.min(1)
- excerpt.max(300), seoTitle.max(200), seoDescription.max(300),
  author.max(100)
- superRefine that rejects a title whose auto-slug would be empty,
  but only when the caller hasn't supplied an explicit slug. Non-Latin
  titles with explicit slugs are accepted.
- PostInput switched from z.infer<> to z.input<> so callers can omit
  theme/status/tags and get Zod defaults.

Schema now imports generateSlug from ../ids.js for the superRefine.
No circular import — ids.ts has zero domain deps.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `src/posts.ts` internal helpers — `isPostSlugConflict` + `autoExcerpt`

Purpose: create the `src/posts.ts` module with its first two `@internal` helpers. Both are pure functions. The narrow-match predicate parallel to `isBlogNameConflict`; the excerpt helper strips markdown and truncates.

**Files:**
- Create: `src/posts.ts`
- Modify: `tests/posts.test.ts` (append new `describe` blocks)

- [ ] **Step 5.1: Write failing tests**

Append to `tests/posts.test.ts` (top of file, with existing imports, add):

```ts
import { isPostSlugConflict, autoExcerpt } from '../src/posts.js'
```

Then append new `describe` blocks at the bottom of the file:

```ts
describe('isPostSlugConflict', () => {
  function sqliteUniqueError(constraint: string): Error {
    const e = new Error(`UNIQUE constraint failed: ${constraint}`) as NodeJS.ErrnoException
    e.code = 'SQLITE_CONSTRAINT_UNIQUE'
    return e
  }

  it('is true for UNIQUE errors on posts.blog_id, posts.slug (compound key)', () => {
    expect(isPostSlugConflict(sqliteUniqueError('posts.blog_id, posts.slug'))).toBe(true)
  })

  it('is false for UNIQUE errors on other columns', () => {
    expect(isPostSlugConflict(sqliteUniqueError('posts.id'))).toBe(false)
    expect(isPostSlugConflict(sqliteUniqueError('posts.slug'))).toBe(false) // not the compound form
    expect(isPostSlugConflict(sqliteUniqueError('blogs.name'))).toBe(false)
    expect(isPostSlugConflict(sqliteUniqueError('blogs.id'))).toBe(false)
    expect(isPostSlugConflict(sqliteUniqueError('api_keys.key_hash'))).toBe(false)
  })

  it('is false for FK errors, plain Errors, and non-Error values', () => {
    const fkErr = new Error('FOREIGN KEY constraint failed') as NodeJS.ErrnoException
    fkErr.code = 'SQLITE_CONSTRAINT_FOREIGNKEY'
    expect(isPostSlugConflict(fkErr)).toBe(false)

    expect(isPostSlugConflict(new Error('UNIQUE constraint failed: posts.blog_id, posts.slug'))).toBe(false)   // missing .code

    expect(isPostSlugConflict(null)).toBe(false)
    expect(isPostSlugConflict(undefined)).toBe(false)
    expect(isPostSlugConflict('not an error')).toBe(false)
    expect(isPostSlugConflict({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'posts.blog_id, posts.slug',
    })).toBe(false)
  })
})

describe('autoExcerpt', () => {
  it('returns body unchanged when short enough', () => {
    expect(autoExcerpt('short body')).toBe('short body')
  })

  it('strips common markdown syntax', () => {
    expect(autoExcerpt('# Heading\n\nBody here.')).toBe('Heading Body here.')
    expect(autoExcerpt('**bold** and *italic* and `code`')).toBe('bold and italic and code')
    expect(autoExcerpt('> a blockquote')).toBe('a blockquote')
    expect(autoExcerpt('- item 1\n- item 2')).toBe('item 1 item 2')
    expect(autoExcerpt('[text](url)')).toBe('text')
    expect(autoExcerpt('![alt](url)')).toBe('')
  })

  it('collapses whitespace', () => {
    expect(autoExcerpt('a   b\n\nc')).toBe('a b c')
  })

  it('truncates at ~160 chars and appends an ellipsis', () => {
    const longBody = 'word '.repeat(50)   // 250 chars
    const excerpt = autoExcerpt(longBody)
    expect(excerpt.length).toBeLessThanOrEqual(161)  // 160 + '…'
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('does not append ellipsis when under the threshold', () => {
    expect(autoExcerpt('short').endsWith('…')).toBe(false)
  })

  it('handles empty or whitespace-only body gracefully', () => {
    expect(autoExcerpt('')).toBe('')
    expect(autoExcerpt('   ')).toBe('')
  })
})
```

- [ ] **Step 5.2: Run tests to verify they fail**

```bash
pnpm test tests/posts.test.ts
```

Expected: **FAIL** — `../src/posts.js` does not exist.

- [ ] **Step 5.3: Implement `src/posts.ts`**

Create `src/posts.ts`:

```ts
/**
 * Pure predicate: was this error SQLite's UNIQUE constraint failing on
 * posts.blog_id + posts.slug (the compound key)? Used inside createPost's
 * INSERT catch to map the narrow case to SlopItError(POST_SLUG_CONFLICT)
 * while letting other UNIQUE errors (posts.id, api_keys.*) bubble raw.
 *
 * @internal — exported for unit testing; not re-exported from src/index.ts.
 */
export function isPostSlugConflict(err: unknown): boolean {
  return (
    err instanceof Error
    && (err as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE'
    && err.message.includes('posts.blog_id, posts.slug')
  )
}

/**
 * Build an auto-excerpt from markdown body: strip common syntax, collapse
 * whitespace, truncate to 160 chars with a trailing ellipsis on overflow.
 *
 * Not a real markdown parser — good enough for v1 for typical posts. Edge
 * cases (inline HTML, code fences with content) produce noisy excerpts,
 * which is acceptable; callers who care supply an explicit excerpt field.
 *
 * @internal — exported for unit testing; not re-exported from src/index.ts.
 */
export function autoExcerpt(body: string): string {
  const stripped = body
    // images first (preserves alt text removal)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // links → text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // headings / blockquote / list markers at line start
    .replace(/^[ \t]*#+ /gm, '')
    .replace(/^[ \t]*> /gm, '')
    .replace(/^[ \t]*[-*+] /gm, '')
    // emphasis + code markers
    .replace(/[*_`]/g, '')
    // collapse whitespace (incl. newlines)
    .replace(/\s+/g, ' ')
    .trim()

  if (stripped.length <= 160) return stripped
  return stripped.slice(0, 160).trimEnd() + '…'
}
```

- [ ] **Step 5.4: Run tests to verify they pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. Test count ~71 + ~15 = ~86.

- [ ] **Step 5.5: Commit**

```bash
git add src/posts.ts tests/posts.test.ts
git commit -m "Add src/posts.ts with isPostSlugConflict + autoExcerpt

Two @internal helpers, both pure:
- isPostSlugConflict: narrow predicate matching SQLite UNIQUE on the
  posts.blog_id + posts.slug compound key. Used by createPost's catch
  in Task 11. Parallel pattern to Task 2's isBlogNameConflict.
- autoExcerpt: strip common markdown syntax from body, collapse
  whitespace, truncate to 160 chars with trailing ellipsis. Not a
  full markdown parser; good enough for v1 typical posts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Internal DB helpers — `getBlogInternal` + `listPublishedPostsForBlog`

Purpose: the renderer needs to look up a blog by id (for display name) and list published posts (for the blog index). These are single-SELECT helpers that don't belong in the public surface. Export them as `@internal` from their domain files so tests and the renderer can import them directly.

**Files:**
- Modify: `src/blogs.ts` (add `getBlogInternal`)
- Modify: `src/posts.ts` (add `listPublishedPostsForBlog`)
- Modify: `tests/blogs.test.ts` (append a `describe('getBlogInternal', ...)`)
- Modify: `tests/posts.test.ts` (append a `describe('listPublishedPostsForBlog', ...)`)

- [ ] **Step 6.1: Write failing tests for `getBlogInternal`**

Append to `tests/blogs.test.ts` (inside the existing file; imports at top, describe at bottom). At the top, add `getBlogInternal` to the existing import from `../src/blogs.js`:

```ts
import { createBlog, isBlogNameConflict, createApiKey, getBlogInternal } from '../src/blogs.js'
```

At the bottom, append:

```ts
describe('getBlogInternal', () => {
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

  it('returns a named blog', () => {
    const { blog } = createBlog(store, { name: 'ai-thoughts' })
    const fetched = getBlogInternal(store, blog.id)
    expect(fetched.id).toBe(blog.id)
    expect(fetched.name).toBe('ai-thoughts')
    expect(fetched.theme).toBe('minimal')
  })

  it('returns an unnamed blog', () => {
    const { blog } = createBlog(store, {})
    const fetched = getBlogInternal(store, blog.id)
    expect(fetched.name).toBeNull()
  })

  it('throws SlopItError(BLOG_NOT_FOUND) when the id does not exist', () => {
    let caught: unknown
    try {
      getBlogInternal(store, 'nonexistent')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('BLOG_NOT_FOUND')
    expect((caught as SlopItError).details).toEqual({ blogId: 'nonexistent' })
  })
})
```

- [ ] **Step 6.2: Run tests to verify they fail**

```bash
pnpm test tests/blogs.test.ts
```

Expected: **FAIL** — `getBlogInternal` not exported.

- [ ] **Step 6.3: Implement `getBlogInternal` in `src/blogs.ts`**

At the bottom of `src/blogs.ts`, append:

```ts
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
    .prepare('SELECT id, name, theme, created_at FROM blogs WHERE id = ?')
    .get(blogId) as {
      id: string
      name: string | null
      theme: 'minimal'
      created_at: string
    } | undefined

  if (row === undefined) {
    throw new SlopItError('BLOG_NOT_FOUND', `Blog "${blogId}" does not exist`, { blogId })
  }

  return {
    id: row.id,
    name: row.name,
    theme: row.theme,
    createdAt: row.created_at,
  }
}
```

- [ ] **Step 6.4: Run tests to verify they pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. +3 tests.

- [ ] **Step 6.5: Write failing tests for `listPublishedPostsForBlog`**

Append to `tests/posts.test.ts`. Top of file, add to the posts.js import:

```ts
import { isPostSlugConflict, autoExcerpt, listPublishedPostsForBlog } from '../src/posts.js'
```

And add the testing imports if not already present:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
```

At the bottom of `tests/posts.test.ts`, append:

```ts
describe('listPublishedPostsForBlog', () => {
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

  it('returns an empty array when the blog has no posts', () => {
    const { blog } = createBlog(store, {})
    expect(listPublishedPostsForBlog(store, blog.id)).toEqual([])
  })

  it('returns published posts newest-first', () => {
    // Seed directly via raw SQL so this test doesn't depend on createPost.
    const { blog } = createBlog(store, { name: 'seed' })
    const insert = store.db.prepare(
      `INSERT INTO posts (id, blog_id, slug, title, body, status, published_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?)`,
    )
    insert.run('p1', blog.id, 'first',  'First',  'body1', '2025-01-01T00:00:00Z')
    insert.run('p2', blog.id, 'second', 'Second', 'body2', '2025-06-01T00:00:00Z')
    insert.run('p3', blog.id, 'third',  'Third',  'body3', '2025-03-01T00:00:00Z')

    const posts = listPublishedPostsForBlog(store, blog.id)
    expect(posts.map((p) => p.slug)).toEqual(['second', 'third', 'first'])
  })

  it('excludes drafts', () => {
    const { blog } = createBlog(store, { name: 'seed' })
    const insert = store.db.prepare(
      `INSERT INTO posts (id, blog_id, slug, title, body, status, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('p1', blog.id, 'pub',   'Pub',   'b', 'published', '2025-01-01T00:00:00Z')
    insert.run('p2', blog.id, 'draft', 'Draft', 'b', 'draft',     null)

    const posts = listPublishedPostsForBlog(store, blog.id)
    expect(posts.map((p) => p.slug)).toEqual(['pub'])
  })

  it('scopes by blog_id (does not leak posts from other blogs)', () => {
    const { blog: a } = createBlog(store, { name: 'alpha' })
    const { blog: b } = createBlog(store, { name: 'beta' })
    const insert = store.db.prepare(
      `INSERT INTO posts (id, blog_id, slug, title, body, status, published_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?)`,
    )
    insert.run('p1', a.id, 'a-post', 'A', 'x', '2025-01-01T00:00:00Z')
    insert.run('p2', b.id, 'b-post', 'B', 'x', '2025-02-01T00:00:00Z')

    expect(listPublishedPostsForBlog(store, a.id).map((p) => p.slug)).toEqual(['a-post'])
    expect(listPublishedPostsForBlog(store, b.id).map((p) => p.slug)).toEqual(['b-post'])
  })
})
```

- [ ] **Step 6.6: Run tests to verify they fail**

```bash
pnpm test tests/posts.test.ts
```

Expected: **FAIL** — `listPublishedPostsForBlog` not exported.

- [ ] **Step 6.7: Implement `listPublishedPostsForBlog` in `src/posts.ts`**

At the top of `src/posts.ts`, add imports (if not already present):

```ts
import type { Store } from './db/store.js'
import type { Post } from './schema/index.js'
```

At the bottom of `src/posts.ts`, append:

```ts
/**
 * Returns published posts for a blog, newest-first by published_at.
 * Drafts excluded. Used by the renderer to build the blog index.
 *
 * @internal
 */
export function listPublishedPostsForBlog(store: Store, blogId: string): Post[] {
  const rows = store.db
    .prepare(
      `SELECT id, blog_id, slug, title, body, excerpt, tags, status,
              seo_title, seo_description, author, cover_image,
              published_at, created_at, updated_at
         FROM posts
        WHERE blog_id = ? AND status = 'published'
        ORDER BY published_at DESC`,
    )
    .all(blogId) as {
      id: string
      blog_id: string
      slug: string
      title: string
      body: string
      excerpt: string | null
      tags: string
      status: 'published'
      seo_title: string | null
      seo_description: string | null
      author: string | null
      cover_image: string | null
      published_at: string | null
      created_at: string
      updated_at: string
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

- [ ] **Step 6.8: Run tests to verify they pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. +4 tests.

- [ ] **Step 6.9: Commit**

```bash
git add src/blogs.ts src/posts.ts tests/blogs.test.ts tests/posts.test.ts
git commit -m "Add @internal DB helpers: getBlogInternal + listPublishedPostsForBlog

Both used by the renderer (Task 10) and by tests. Neither in the public
barrel — callers import from './blogs.js' / './posts.js' directly.

- getBlogInternal(store, blogId) throws SlopItError(BLOG_NOT_FOUND)
  with details.blogId if missing. Used by createPost's existence check
  and by the renderer for display name.
- listPublishedPostsForBlog(store, blogId) returns published posts
  newest-first, scoped by blog_id. Drafts excluded. Used by renderBlog
  for the index.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Theme content files

Purpose: create the static content files for the `minimal` theme. No tests — this is content; the renderer tests in Tasks 8–10 exercise it.

**Files:**
- Create: `src/themes/minimal/post.html`
- Create: `src/themes/minimal/index.html`
- Create: `src/themes/minimal/style.css`

- [ ] **Step 7.1: Create `src/themes/minimal/post.html`**

Exact content:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{postTitle}} — {{blogName}}</title>
  {{{seoMeta}}}
  <link rel="stylesheet" href="{{themeCssHref}}">
  <link rel="canonical" href="{{canonicalUrl}}">
</head>
<body>
  <nav><a href="{{blogHomeHref}}">{{blogName}}</a></nav>
  <article>
    <header>
      <h1>{{postTitle}}</h1>
      <time datetime="{{postPublishedAt}}">{{postPublishedAtDisplay}}</time>
    </header>
    {{{postBody}}}
    {{{tagList}}}
  </article>
  <footer>{{{poweredBy}}}</footer>
</body>
</html>
```

- [ ] **Step 7.2: Create `src/themes/minimal/index.html`**

Exact content:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{blogName}}</title>
  <link rel="stylesheet" href="{{themeCssHref}}">
</head>
<body>
  <header><h1>{{blogName}}</h1></header>
  <main>{{{postList}}}</main>
  <footer>{{{poweredBy}}}</footer>
</body>
</html>
```

- [ ] **Step 7.3: Create `src/themes/minimal/style.css`**

Exact content (palette and typography per `DESIGN.md`):

```css
@import url('https://api.fontshare.com/v2/css?f[]=satoshi@900,700,500,400&display=swap');
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400&display=swap');

:root {
  --background: #FAFAF9;
  --surface: #F0EFEB;
  --border: #E5E5E2;
  --text: #1A1A1A;
  --text-muted: #6B6B6B;
  --accent: #FF4F00;
  --accent-dark: #D34000;
}

* { box-sizing: border-box; }

body {
  font-family: Satoshi, system-ui, -apple-system, sans-serif;
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 24px;
  background: var(--background);
  color: var(--text);
  line-height: 1.6;
  font-size: 16px;
}

nav { font-size: 16px; margin-bottom: 48px; }
nav a { color: var(--text); text-decoration: none; font-weight: 700; }
nav a:hover { color: var(--accent); }

article header h1 {
  font-size: 32px;
  font-weight: 900;
  letter-spacing: -0.02em;
  line-height: 1.2;
  margin: 0 0 8px;
}
article header time { font-size: 14px; color: var(--text-muted); }

article { margin-bottom: 64px; }
article p { font-size: 18px; margin: 16px 0; }
article h2 { font-size: 24px; font-weight: 700; margin-top: 32px; letter-spacing: -0.01em; }
article h3 { font-size: 20px; font-weight: 500; margin-top: 24px; }
article a { color: var(--accent); }
article a:hover { color: var(--accent-dark); }
article ul, article ol { padding-left: 24px; }
article li { margin: 8px 0; }
article blockquote {
  border-left: 4px solid var(--accent);
  padding-left: 16px;
  color: var(--text-muted);
  margin: 24px 0;
}
article code {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 14px;
  background: var(--surface);
  padding: 2px 4px;
  border-radius: 4px;
}
article pre {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  overflow-x: auto;
}
article pre code { background: transparent; padding: 0; }

.tags { margin-top: 32px; }
.tags span {
  display: inline-block;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 4px;
  margin-right: 4px;
}

main .post-item { border-bottom: 1px solid var(--border); padding: 24px 0; }
main .post-item:last-child { border-bottom: none; }
main .post-item h2 { font-size: 20px; margin: 0 0 8px; font-weight: 500; }
main .post-item h2 a { color: var(--text); text-decoration: none; }
main .post-item h2 a:hover { color: var(--accent); }
main .post-item time { font-size: 14px; color: var(--text-muted); }
main .post-item p { color: var(--text-muted); margin: 8px 0 0; font-size: 16px; }

footer { margin-top: 64px; font-size: 14px; color: var(--text-muted); text-align: center; }
footer a { color: var(--text-muted); }
footer a:hover { color: var(--text); }
```

- [ ] **Step 7.4: Verify no test regression**

```bash
pnpm test
pnpm typecheck
```

Expected: all green. No new tests from this task, but existing tests must still pass.

- [ ] **Step 7.5: Commit**

```bash
git add src/themes/minimal/post.html src/themes/minimal/index.html src/themes/minimal/style.css
git commit -m "Add minimal theme content files

- post.html: {{vars}} + {{{raw}}} for body/tags/seoMeta/poweredBy
- index.html: same var conventions
- style.css: ~90 lines, palette + typography from DESIGN.md,
  Satoshi via FontShare, JetBrains Mono via Google Fonts, 720px
  reading column, relative-href-friendly

Tasks 8-10 wire the template loader, render helpers, and renderer
body against these files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Template engine primitives — `escapeHtml`, `render`, `loadTheme`

Purpose: pure-function template engine. `escapeHtml` is a 6-character-replacement escape. `render(template, vars)` does `{{var}}` (escaped) / `{{{var}}}` (raw) substitution; throws on undefined vars (fail loud). `loadTheme` reads the three files from the `minimal` theme directory (works in `src/` during dev and `dist/` after build via `import.meta.url`).

**Files:**
- Create: `src/rendering/templates.ts`
- Create: `tests/rendering.test.ts`

- [ ] **Step 8.1: Write failing tests**

Create `tests/rendering.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { escapeHtml, render, loadTheme } from '../src/rendering/templates.js'

describe('escapeHtml', () => {
  it('escapes the five canonical HTML entities', () => {
    expect(escapeHtml('&')).toBe('&amp;')
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('>')).toBe('&gt;')
    expect(escapeHtml('"')).toBe('&quot;')
    expect(escapeHtml("'")).toBe('&#39;')
  })

  it('handles a mix', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    )
  })

  it('passes through benign strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
    expect(escapeHtml('')).toBe('')
  })

  it('escapes ampersands first (order matters)', () => {
    // If < were escaped first to &lt; and then & escaped to &amp;,
    // we'd get &amp;lt; — wrong.
    expect(escapeHtml('<&')).toBe('&lt;&amp;')
  })
})

describe('render', () => {
  it('substitutes {{var}} with escaped value', () => {
    expect(render('<p>{{name}}</p>', { name: '<script>' })).toBe('<p>&lt;script&gt;</p>')
  })

  it('substitutes {{{var}}} with raw (unescaped) value', () => {
    expect(render('<div>{{{html}}}</div>', { html: '<b>bold</b>' })).toBe('<div><b>bold</b></div>')
  })

  it('handles both forms in the same template', () => {
    const out = render('<p>{{text}}</p><div>{{{html}}}</div>', {
      text: '<script>',
      html: '<b>ok</b>',
    })
    expect(out).toBe('<p>&lt;script&gt;</p><div><b>ok</b></div>')
  })

  it('throws when an escaped var is missing', () => {
    expect(() => render('<p>{{missing}}</p>', {})).toThrow(/missing template variable: missing/i)
  })

  it('throws when a raw var is missing', () => {
    expect(() => render('<p>{{{missing}}}</p>', {})).toThrow(/missing template variable: missing/i)
  })

  it('handles whitespace inside braces (tolerant)', () => {
    expect(render('<p>{{ name }}</p>', { name: 'Ada' })).toBe('<p>Ada</p>')
    expect(render('<p>{{{  html  }}}</p>', { html: '<b>b</b>' })).toBe('<p><b>b</b></p>')
  })

  it('supports multiple occurrences of the same var', () => {
    expect(render('{{x}}-{{x}}', { x: 'a' })).toBe('a-a')
  })

  it('does not substitute {{ three braces }}} incorrectly', () => {
    // Triple-brace is matched greedily first; make sure it doesn't leak across adjacent vars.
    expect(render('{{{a}}}{{b}}', { a: '<x>', b: 'y' })).toBe('<x>y')
  })
})

describe('loadTheme', () => {
  it('loads the minimal theme files', () => {
    const theme = loadTheme('minimal')
    expect(theme.post.length).toBeGreaterThan(0)
    expect(theme.index.length).toBeGreaterThan(0)
    expect(theme.cssPath.endsWith('style.css')).toBe(true)
  })

  it('post template contains expected placeholders', () => {
    const theme = loadTheme('minimal')
    expect(theme.post).toContain('{{postTitle}}')
    expect(theme.post).toContain('{{{postBody}}}')
    expect(theme.post).toContain('{{themeCssHref}}')
    expect(theme.post).toContain('{{blogHomeHref}}')
  })

  it('index template contains expected placeholders', () => {
    const theme = loadTheme('minimal')
    expect(theme.index).toContain('{{blogName}}')
    expect(theme.index).toContain('{{{postList}}}')
    expect(theme.index).toContain('{{themeCssHref}}')
  })
})
```

- [ ] **Step 8.2: Run tests to verify they fail**

```bash
pnpm test tests/rendering.test.ts
```

Expected: **FAIL** — `../src/rendering/templates.js` does not exist.

- [ ] **Step 8.3: Implement `src/rendering/templates.ts`**

Create `src/rendering/templates.ts`:

```ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ThemeAssets {
  readonly post: string
  readonly index: string
  readonly cssPath: string
}

/**
 * HTML-escape the five canonical special characters. Ampersand MUST be
 * replaced first, otherwise other replacements introduce ampersands that
 * get doubly-escaped.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render a template string by substituting:
 *   {{{var}}}  → raw value (trust the helper that produced it to have escaped)
 *   {{var}}    → HTML-escaped value
 *
 * Throws if any referenced variable is missing from `vars`. Triple braces
 * are matched FIRST so "{{{a}}}{{b}}" parses as {{{a}}} followed by {{b}}
 * rather than {{ {a}} }{b}}.
 */
export function render(template: string, vars: Record<string, string>): string {
  // Triple-brace first (greedy, non-overlapping).
  let out = template.replace(/\{\{\{\s*(\w+)\s*\}\}\}/g, (_m, name: string) => {
    if (!(name in vars)) {
      throw new Error(`Missing template variable: ${name}`)
    }
    return vars[name]!
  })
  // Then double-brace on what's left.
  out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    if (!(name in vars)) {
      throw new Error(`Missing template variable: ${name}`)
    }
    return escapeHtml(vars[name]!)
  })
  return out
}

/**
 * Load a theme's three asset files. Works in src/ during dev and in
 * dist/ after build — path is resolved relative to this module via
 * import.meta.url (same pattern as src/db/store.ts uses for migrations).
 */
export function loadTheme(name: 'minimal'): ThemeAssets {
  const here = dirname(fileURLToPath(import.meta.url))
  const themeDir = join(here, '..', 'themes', name)
  return {
    post: readFileSync(join(themeDir, 'post.html'), 'utf8'),
    index: readFileSync(join(themeDir, 'index.html'), 'utf8'),
    cssPath: join(themeDir, 'style.css'),
  }
}
```

- [ ] **Step 8.4: Run tests to verify they pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. `tests/rendering.test.ts` should have ~17 tests passing.

- [ ] **Step 8.5: Commit**

```bash
git add src/rendering/templates.ts tests/rendering.test.ts
git commit -m "Add src/rendering/templates.ts — escapeHtml + render + loadTheme

Pure template engine primitives:
- escapeHtml: 5-character HTML escape; ampersand-first ordering
- render: {{var}} escaped, {{{var}}} raw; throws on undefined var
  (fail-hard-fail-loud); triple-braces matched first so adjacencies
  like '{{{a}}}{{b}}' parse as two separate vars.
- loadTheme: reads minimal theme's three files; works in both src/
  (dev) and dist/ (published) via import.meta.url.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Fragment helpers in `src/rendering/generator.ts`

Purpose: the pure HTML-fragment builders used via `{{{raw}}}` in templates. Each MUST call `escapeHtml(...)` on every user-derived field — that's how the raw-injection trust boundary stays safe.

**Files:**
- Modify: `src/rendering/generator.ts` (REPLACE full contents — the scaffold's `createRenderer` stub gets redefined here and again in Task 10)
- Modify: `tests/rendering.test.ts` (append fragment-helper tests)

- [ ] **Step 9.1: Write failing tests**

Append to `tests/rendering.test.ts` (add to the import at the top):

```ts
import {
  escapeHtml, render, loadTheme,
} from '../src/rendering/templates.js'
import {
  formatDate,
  renderPostList,
  renderTagList,
  renderPoweredBy,
  renderSeoMeta,
} from '../src/rendering/generator.js'
import type { Post } from '../src/schema/index.js'
```

At the bottom of the file, append:

```ts
function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    blogId: 'b1',
    slug: 'hello',
    title: 'Hello',
    body: 'body',
    excerpt: undefined,
    tags: [],
    status: 'published',
    seoTitle: undefined,
    seoDescription: undefined,
    author: undefined,
    coverImage: undefined,
    publishedAt: '2025-01-15T12:00:00Z',
    createdAt: '2025-01-15T12:00:00Z',
    updatedAt: '2025-01-15T12:00:00Z',
    ...overrides,
  }
}

describe('formatDate', () => {
  it('formats an ISO string into a human-readable date (UTC-pinned)', () => {
    expect(formatDate('2025-01-15T12:00:00Z')).toBe('January 15, 2025')
  })

  it('is deterministic across host timezones (UTC, not local)', () => {
    // Midnight UTC on Jan 1 would render as "December 31, 2024" in LAX
    // under local-TZ formatting. We pin UTC, so it stays Jan 1 everywhere.
    expect(formatDate('2025-01-01T00:00:00Z')).toBe('January 1, 2025')
  })

  it('returns empty string for null', () => {
    expect(formatDate(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(formatDate(undefined)).toBe('')
  })
})

describe('renderPostList', () => {
  it('returns an empty string when given no posts', () => {
    expect(renderPostList([])).toBe('')
  })

  it('builds a post-item per post', () => {
    const out = renderPostList([
      makePost({ slug: 'first',  title: 'First',  publishedAt: '2025-01-01T00:00:00Z' }),
      makePost({ slug: 'second', title: 'Second', publishedAt: '2025-02-01T00:00:00Z' }),
    ])
    expect(out).toContain('<article class="post-item">')
    expect(out).toContain('href="first/"')
    expect(out).toContain('href="second/"')
    expect(out).toContain('>First<')
    expect(out).toContain('>Second<')
  })

  it('escapes post titles, excerpts, and slugs', () => {
    const evil = makePost({
      slug: 'evil',
      title: '<script>alert(1)</script>',
      excerpt: '"onerror=alert(1)"',
    })
    const out = renderPostList([evil])
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('&quot;onerror')
  })

  it('omits excerpt paragraph when excerpt is absent', () => {
    const p = makePost({ excerpt: undefined })
    const out = renderPostList([p])
    expect(out).not.toMatch(/<p[^>]*>undefined<\/p>/)
    // No <p> element at all in the post-item's body
    const postItems = out.match(/<article class="post-item">[\s\S]*?<\/article>/g)
    expect(postItems).toHaveLength(1)
    expect(postItems![0]).not.toContain('<p>')
  })

  it('renders excerpt paragraph when present', () => {
    const p = makePost({ excerpt: 'A short summary.' })
    const out = renderPostList([p])
    expect(out).toContain('<p>A short summary.</p>')
  })
})

describe('renderTagList', () => {
  it('returns empty string for no tags', () => {
    expect(renderTagList([])).toBe('')
  })

  it('wraps tags in a div and span-pills with # prefix', () => {
    const out = renderTagList(['ai', 'content'])
    expect(out).toContain('<div class="tags">')
    expect(out).toContain('<span>#ai</span>')
    expect(out).toContain('<span>#content</span>')
  })

  it('escapes tag text', () => {
    const out = renderTagList(['<script>'])
    expect(out).not.toContain('<script>')
    expect(out).toContain('#&lt;script&gt;')
  })
})

describe('renderPoweredBy', () => {
  it('returns a link to slopit.io', () => {
    const out = renderPoweredBy()
    expect(out).toContain('https://slopit.io')
    expect(out).toContain('Powered by')
  })
})

describe('renderSeoMeta', () => {
  it('returns empty string when both seoTitle and seoDescription are absent', () => {
    expect(renderSeoMeta(undefined, undefined)).toBe('')
  })

  it('emits a description meta when seoDescription is present', () => {
    const out = renderSeoMeta(undefined, 'A description')
    expect(out).toContain('<meta name="description"')
    expect(out).toContain('content="A description"')
  })

  it('escapes user-derived content', () => {
    const out = renderSeoMeta(undefined, '<script>alert(1)</script>')
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('emits a title meta (og:title) when seoTitle is present', () => {
    const out = renderSeoMeta('My Title', undefined)
    expect(out).toContain('My Title')
  })
})
```

- [ ] **Step 9.2: Run tests to verify they fail**

```bash
pnpm test tests/rendering.test.ts
```

Expected: **FAIL** — none of the helpers are exported from `src/rendering/generator.ts` yet.

- [ ] **Step 9.3: Replace `src/rendering/generator.ts` contents**

Replace the entire contents of `src/rendering/generator.ts` with:

```ts
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Store } from '../db/store.js'
import type { Blog, Post } from '../schema/index.js'
import { escapeHtml } from './templates.js'

export interface RendererConfig {
  store: Store
  outputDir: string   // where static files are written, per-blog subdirs
  baseUrl: string     // e.g. "https://blog.example.com" — used for feeds + SEO
}

export interface Renderer {
  readonly baseUrl: string
  renderPost(blogId: string, post: Post): void
  renderBlog(blogId: string): void
}

/**
 * Format an ISO timestamp for human display. Returns '' on null/undefined.
 *
 * Pinned to UTC so static output is deterministic regardless of host
 * timezone — '2025-01-01T00:00:00Z' renders as 'January 1, 2025'
 * everywhere, not 'December 31, 2024' on LAX deploys.
 *
 * @internal
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Build the blog-index post list fragment. Every user-derived field is
 * HTML-escaped at the boundary here so the `{{{postList}}}` raw injection
 * stays safe.
 *
 * @internal
 */
export function renderPostList(posts: Post[]): string {
  if (posts.length === 0) return ''
  return posts
    .map((p) => {
      const excerpt = p.excerpt ? `<p>${escapeHtml(p.excerpt)}</p>` : ''
      return (
        `<article class="post-item">`
        + `<h2><a href="${escapeHtml(p.slug)}/">${escapeHtml(p.title)}</a></h2>`
        + `<time datetime="${escapeHtml(p.publishedAt ?? '')}">${escapeHtml(formatDate(p.publishedAt))}</time>`
        + excerpt
        + `</article>`
      )
    })
    .join('')
}

/**
 * Build the tag-pill fragment. Empty string when no tags.
 *
 * @internal
 */
export function renderTagList(tags: string[]): string {
  if (tags.length === 0) return ''
  return (
    `<div class="tags">`
    + tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join('')
    + `</div>`
  )
}

/**
 * Core's single branding hook. Documented exception to ARCHITECTURE.md
 * rule #5. Platform may strip/replace based on plan.
 *
 * @internal
 */
export function renderPoweredBy(): string {
  return `<a href="https://slopit.io">Powered by SlopIt</a>`
}

/**
 * Build the SEO meta-tag block. Returns '' when both title and
 * description are missing. All user content escaped at the boundary.
 *
 * @internal
 */
export function renderSeoMeta(
  seoTitle: string | undefined,
  seoDescription: string | undefined,
): string {
  if (!seoTitle && !seoDescription) return ''
  const parts: string[] = []
  if (seoDescription) {
    parts.push(`<meta name="description" content="${escapeHtml(seoDescription)}">`)
  }
  if (seoTitle) {
    parts.push(`<meta property="og:title" content="${escapeHtml(seoTitle)}">`)
  }
  if (seoDescription) {
    parts.push(`<meta property="og:description" content="${escapeHtml(seoDescription)}">`)
  }
  return parts.join('')
}

/**
 * Copy the theme's style.css into a blog's output directory. Always
 * overwrites (not copy-if-missing) so blogs pick up style.css changes
 * on the next publish after a package upgrade. Creates the blog dir
 * if it doesn't exist yet.
 *
 * @internal
 */
export function ensureCss(cssSourcePath: string, blogOutputDir: string): void {
  mkdirSync(blogOutputDir, { recursive: true })
  copyFileSync(cssSourcePath, join(blogOutputDir, 'style.css'))
}

/**
 * Placeholder factory — Task 10 replaces this with the real renderer.
 * Leaving it as a throw so any accidental use before Task 10 lands
 * fails loudly.
 */
export function createRenderer(_config: RendererConfig): Renderer {
  return {
    baseUrl: _config.baseUrl,
    renderPost() { throw new Error('createRenderer: not implemented until Task 10') },
    renderBlog() { throw new Error('createRenderer: not implemented until Task 10') },
  }
}
```

- [ ] **Step 9.4: Run tests to verify they pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. +~17 new rendering tests. `createRenderer` remains a stub that throws; it's not tested here (Task 10 replaces the body and tests it).

- [ ] **Step 9.5: Commit**

```bash
git add src/rendering/generator.ts tests/rendering.test.ts
git commit -m "Add fragment helpers + ensureCss in generator.ts

All module-level @internal exports, tested via tests/rendering.test.ts:
- formatDate: ISO → en-US human date; '' for null/undefined
- renderPostList: blog-index post cards; escapes title/excerpt/slug
- renderTagList: tag pills with # prefix; escapes tag text; empty
  string for zero tags
- renderPoweredBy: 'Powered by SlopIt' link (documented ARCHITECTURE
  rule #5 exception)
- renderSeoMeta: description + og:title + og:description tags; empty
  when no SEO fields; escapes user content
- ensureCss: always-overwrite CSS copy; mkdirSync recursive

createRenderer stays a stub (throws on renderPost/renderBlog call)
until Task 10 replaces its body with the real implementation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9.5: Sanitize markdown — strip raw HTML in `renderMarkdown`

Purpose: the scaffold's `renderMarkdown` is `marked.parse()` with no sanitization, so a post body containing `<script>alert(1)</script>` becomes stored XSS in the rendered blog. Task 10 will inject `renderMarkdown(post.body)` into the raw `{{{postBody}}}` slot, so the defense MUST land before the renderer is wired up.

**Design choice (no new deps):** override marked's `html` renderer to emit `''`. This strips both block and inline HTML tokens while leaving every legitimate markdown syntax intact (headings, emphasis, lists, links, code, blockquotes, images — all unaffected). Power users who want embeds can wait for v2, which will add proper DOM-level sanitization with an opt-in. For v1 the right default is strict — readers are untrusted recipients and the threat model assumes stored XSS from authored content matters.

**Files:**
- Modify: `src/rendering/markdown.ts`
- Modify: `tests/rendering.test.ts` (append XSS-neutralization tests)

- [ ] **Step 9.5.1: Write failing tests**

Append to `tests/rendering.test.ts`. At the top of the file (with other imports), add:

```ts
import { renderMarkdown } from '../src/rendering/markdown.js'
```

At the bottom of the file, append:

```ts
describe('renderMarkdown — HTML stripping (v1 XSS defense)', () => {
  it('strips <script> blocks entirely', () => {
    const out = renderMarkdown('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('alert(1)')
  })

  it('strips inline HTML with event handlers', () => {
    const out = renderMarkdown('Hello <img src=x onerror=alert(1)>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<img')
  })

  it('strips <iframe> and other embed attempts', () => {
    const out = renderMarkdown('<iframe src="evil.com"></iframe>')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('evil.com')
  })

  it('strips mixed HTML within legitimate markdown', () => {
    const out = renderMarkdown('**bold text** <script>evil()</script> **more bold**')
    expect(out).toContain('<strong>bold text</strong>')
    expect(out).toContain('<strong>more bold</strong>')
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('evil()')
  })

  it('preserves legitimate markdown → HTML conversions', () => {
    expect(renderMarkdown('# Heading')).toContain('<h1>Heading</h1>')
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>')
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>')
    expect(renderMarkdown('[text](https://example.com)')).toContain('<a href="https://example.com">text</a>')
    expect(renderMarkdown('- item 1\n- item 2')).toContain('<li>item 1</li>')
    expect(renderMarkdown('> quoted')).toContain('<blockquote>')
    expect(renderMarkdown('`code`')).toContain('<code>code</code>')
  })

  it('escapes HTML-like content inside code blocks (not stripped, but entity-escaped)', () => {
    const out = renderMarkdown('```\n<script>inside code</script>\n```')
    // Inside a fenced code block, marked produces <pre><code> with content entity-escaped,
    // NOT as an html token. So the literal '<script>' appears escaped, not stripped.
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('inside code')   // the text is preserved, just escaped
  })
})
```

- [ ] **Step 9.5.2: Run tests to verify they fail**

```bash
pnpm test tests/rendering.test.ts
```

Expected: **FAIL** — the XSS neutralization tests all fail because current `renderMarkdown` passes raw HTML through.

Example failure output (roughly):
```
FAIL  tests/rendering.test.ts > renderMarkdown — HTML stripping (v1 XSS defense) > strips <script> blocks entirely
AssertionError: expected '<script>alert(1)</script>' not to contain '<script>'
```

- [ ] **Step 9.5.3: Update `src/rendering/markdown.ts`**

Replace the full contents of `src/rendering/markdown.ts` with:

```ts
import { marked } from 'marked'

// v1 XSS defense: strip all raw HTML tokens (block and inline) via a
// renderer override. Agents author content on their own blog; readers
// are untrusted recipients; until v2 adds proper DOM-level sanitization
// with an opt-in, the safe default is to drop raw HTML entirely.
// Legitimate markdown syntax (headings, emphasis, lists, links, code,
// blockquotes, images) is unaffected — marked's token model treats
// those as non-html tokens with their own renderers.
//
// Note: marked.use() modifies the shared default marked instance. This
// is fine because src/rendering/markdown.ts is the only module in core
// that imports marked; no other code path depends on marked's default
// behavior.
marked.use({
  renderer: {
    html() {
      return ''
    },
  },
})

// Markdown → HTML. Synchronous because blog posts are short and we render
// once at publish time; no reason to reach for async here.
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string
}
```

- [ ] **Step 9.5.4: Run tests to verify they pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. The 6 XSS-neutralization tests pass; all prior tests still pass (marked still converts headings/bold/italic/links/lists/etc. normally).

- [ ] **Step 9.5.5: Commit**

```bash
git add src/rendering/markdown.ts tests/rendering.test.ts
git commit -m "Strip raw HTML from renderMarkdown to prevent stored XSS

Task 10 will inject renderMarkdown(post.body) into the {{{postBody}}}
raw slot. Without this, a post body containing <script> or inline
event handlers becomes XSS in the rendered blog.

v1 defense: override marked's html renderer to emit ''. Strips both
block-level HTML and inline HTML tokens. Legitimate markdown syntax
(headings, emphasis, links, lists, code, blockquotes, images) is
unaffected because marked treats those as non-html tokens with their
own renderers. HTML inside fenced code blocks stays in code-token
form and is entity-escaped, so it's visible but inert.

Threat model: agents are authors of their own blog; readers are
untrusted recipients. This is why we strip even 'trusted' author HTML.
v2 can add proper DOM-level sanitization with an opt-in, at which
point power users can embed iframes etc.

No new deps — uses marked's built-in renderer override.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Renderer implementation (`renderPost` + `renderBlog`)

Purpose: replace the `createRenderer` stub with the real implementation. Both methods call `ensureCss` FIRST (before any HTML write), then render + write. Tests verify file contents, paths, and routing-agnostic relative hrefs.

**Files:**
- Modify: `src/rendering/generator.ts` (replace `createRenderer` body)
- Modify: `tests/rendering.test.ts` (append renderer tests)

- [ ] **Step 10.1: Write failing tests**

Append to `tests/rendering.test.ts` (add imports at top if not already present):

```ts
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
import { createRenderer } from '../src/rendering/generator.js'
```

Append at the bottom:

```ts
describe('createRenderer — renderPost', () => {
  let dir: string
  let store: Store
  let outputDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes post HTML + CSS to disk at the expected path', () => {
    const { blog } = createBlog(store, { name: 'test-blog' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://test.example.com' })

    const post = makePost({ blogId: blog.id, slug: 'hello', title: 'Hello!' })
    renderer.renderPost(blog.id, post)

    const postPath = join(outputDir, blog.id, 'hello', 'index.html')
    const cssPath = join(outputDir, blog.id, 'style.css')
    expect(existsSync(postPath)).toBe(true)
    expect(existsSync(cssPath)).toBe(true)

    const html = readFileSync(postPath, 'utf8')
    expect(html).toContain('<title>Hello! — test-blog</title>')
    expect(html).toContain('<h1>Hello!</h1>')
  })

  it('uses relative hrefs (../style.css and ..) so path-based and subdomain blogs both work', () => {
    const { blog } = createBlog(store, {})
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://example.com/b/xxx' })
    renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 's' }))

    const html = readFileSync(join(outputDir, blog.id, 's', 'index.html'), 'utf8')
    expect(html).toContain('href="../style.css"')
    expect(html).toContain('href=".."')
  })

  it('shows blog.id as blogName for unnamed blogs', () => {
    const { blog } = createBlog(store, {})
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://ex.com' })
    renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 's' }))

    const html = readFileSync(join(outputDir, blog.id, 's', 'index.html'), 'utf8')
    expect(html).toContain(blog.id)      // id shows up somewhere as the nav/title
  })

  it('renders canonical URL as baseUrl + /slug/ (trailing slash matches directory layout)', () => {
    const { blog } = createBlog(store, { name: 'b' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 'my-slug' }))

    const html = readFileSync(join(outputDir, blog.id, 'my-slug', 'index.html'), 'utf8')
    expect(html).toContain('href="https://b.example.com/my-slug/"')
  })

  it('ensureCss always overwrites (picks up CSS changes on re-render)', () => {
    const { blog } = createBlog(store, { name: 'b' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 's' }))

    const cssPath = join(outputDir, blog.id, 'style.css')
    const fresh = readFileSync(cssPath, 'utf8')

    // Corrupt the file, re-render, expect the theme CSS restored.
    writeFileSync(cssPath, '/* STALE */', 'utf8')
    renderer.renderPost(blog.id, makePost({ blogId: blog.id, slug: 't' }))
    const restored = readFileSync(cssPath, 'utf8')
    expect(restored).toBe(fresh)
  })

  it('renders the post body as HTML (markdown passes through renderMarkdown)', () => {
    const { blog } = createBlog(store, {})
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://ex.com' })
    renderer.renderPost(blog.id, makePost({
      blogId: blog.id,
      slug: 's',
      body: '# Heading\n\nParagraph.',
    }))

    const html = readFileSync(join(outputDir, blog.id, 's', 'index.html'), 'utf8')
    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('<p>Paragraph.</p>')
  })
})

describe('createRenderer — renderBlog', () => {
  let dir: string
  let store: Store
  let outputDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the blog index HTML + CSS to disk', () => {
    const { blog } = createBlog(store, { name: 'b' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderBlog(blog.id)

    expect(existsSync(join(outputDir, blog.id, 'index.html'))).toBe(true)
    expect(existsSync(join(outputDir, blog.id, 'style.css'))).toBe(true)
  })

  it('lists published posts newest-first in the index', () => {
    const { blog } = createBlog(store, { name: 'b' })
    const insert = store.db.prepare(
      `INSERT INTO posts (id, blog_id, slug, title, body, status, published_at)
       VALUES (?, ?, ?, ?, ?, 'published', ?)`,
    )
    insert.run('p1', blog.id, 'first',  'First',  'x', '2025-01-01T00:00:00Z')
    insert.run('p2', blog.id, 'second', 'Second', 'x', '2025-02-01T00:00:00Z')

    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderBlog(blog.id)

    const html = readFileSync(join(outputDir, blog.id, 'index.html'), 'utf8')
    const secondIdx = html.indexOf('>Second<')
    const firstIdx = html.indexOf('>First<')
    expect(secondIdx).toBeGreaterThan(-1)
    expect(firstIdx).toBeGreaterThan(-1)
    expect(secondIdx).toBeLessThan(firstIdx)   // newest first
  })

  it('excludes drafts from the index', () => {
    const { blog } = createBlog(store, { name: 'b' })
    const insert = store.db.prepare(
      `INSERT INTO posts (id, blog_id, slug, title, body, status, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('p1', blog.id, 'pub',   'Pub',   'x', 'published', '2025-01-01T00:00:00Z')
    insert.run('p2', blog.id, 'draft', 'Draft', 'x', 'draft',     null)

    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderBlog(blog.id)

    const html = readFileSync(join(outputDir, blog.id, 'index.html'), 'utf8')
    expect(html).toContain('>Pub<')
    expect(html).not.toContain('>Draft<')
  })

  it('uses relative "style.css" href (not "../style.css") in the index', () => {
    const { blog } = createBlog(store, { name: 'b' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })
    renderer.renderBlog(blog.id)

    const html = readFileSync(join(outputDir, blog.id, 'index.html'), 'utf8')
    expect(html).toContain('href="style.css"')
    expect(html).not.toContain('href="../style.css"')
  })
})
```

- [ ] **Step 10.2: Run tests to verify they fail**

```bash
pnpm test tests/rendering.test.ts
```

Expected: **FAIL** — `createRenderer` is still the stub that throws.

- [ ] **Step 10.3: Replace `createRenderer` body in `src/rendering/generator.ts`**

At the top of `src/rendering/generator.ts`, update the imports to:

```ts
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getBlogInternal } from '../blogs.js'
import type { Store } from '../db/store.js'
import { listPublishedPostsForBlog } from '../posts.js'
import type { Blog, Post } from '../schema/index.js'
import { renderMarkdown } from './markdown.js'
import { loadTheme, render } from './templates.js'
import { escapeHtml } from './templates.js'
```

(`dirname` is already imported; keep it. `writeFileSync` is new. `renderMarkdown` is from the existing scaffold.)

Replace the stub `createRenderer` function at the bottom of the file with:

```ts
export function createRenderer(config: RendererConfig): Renderer {
  const theme = loadTheme('minimal')

  const displayName = (blog: Blog): string => blog.name ?? blog.id

  const blogOutputDir = (blogId: string) => join(config.outputDir, blogId)

  return {
    baseUrl: config.baseUrl,

    renderPost(blogId, post) {
      const blog = getBlogInternal(config.store, blogId)
      const blogDir = blogOutputDir(blogId)

      // ensureCss BEFORE HTML write — see spec's Render sequencing section
      ensureCss(theme.cssPath, blogDir)

      const postDir = join(blogDir, post.slug)
      mkdirSync(postDir, { recursive: true })

      const html = render(theme.post, {
        blogName: displayName(blog),
        postTitle: post.title,
        postPublishedAt: post.publishedAt ?? '',
        postPublishedAtDisplay: formatDate(post.publishedAt),
        themeCssHref: '../style.css',
        blogHomeHref: '..',
        canonicalUrl: config.baseUrl + '/' + post.slug + '/',   // trailing slash — matches directory layout
        seoMeta: renderSeoMeta(post.seoTitle, post.seoDescription),
        postBody: renderMarkdown(post.body),
        tagList: renderTagList(post.tags),
        poweredBy: renderPoweredBy(),
      })

      writeFileSync(join(postDir, 'index.html'), html, 'utf8')
    },

    renderBlog(blogId) {
      const blog = getBlogInternal(config.store, blogId)
      const blogDir = blogOutputDir(blogId)

      ensureCss(theme.cssPath, blogDir)

      const posts = listPublishedPostsForBlog(config.store, blogId)
      mkdirSync(blogDir, { recursive: true })

      const html = render(theme.index, {
        blogName: displayName(blog),
        themeCssHref: 'style.css',
        postList: renderPostList(posts),
        poweredBy: renderPoweredBy(),
      })

      writeFileSync(join(blogDir, 'index.html'), html, 'utf8')
    },
  }
}
```

- [ ] **Step 10.4: Run tests to verify they pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. +~10 renderer tests passing.

- [ ] **Step 10.5: Commit**

```bash
git add src/rendering/generator.ts tests/rendering.test.ts
git commit -m "Implement Renderer: sync renderPost + renderBlog

- New Renderer interface: readonly baseUrl + sync renderPost + renderBlog.
  Matches the spec's decision to go sync end-to-end (better-sqlite3 and
  renderMarkdown are sync; node:fs sync writers are fine at our scale).
- renderPost: ensureCss FIRST, then mkdir + write post.html. Template
  variables include '../style.css' and '..' for routing-agnostic
  relative hrefs that work under both subdomain and path-based blogs.
- renderBlog: ensureCss FIRST, then render index with newest-first
  published posts (drafts excluded), write to {blog}/index.html.
- displayName uses blog.name ?? blog.id so unnamed blogs still render
  cleanly (no 'null' in the title).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: `createPost` — the main function

Purpose: wire everything together. Validate input → check blog exists → resolve slug + derived fields → transactional INSERT with preflight + narrow-match → render (publish path) with compensation on failure → return `{ post, postUrl? }`.

**Files:**
- Modify: `src/posts.ts` (add the `createPost` function)
- Modify: `tests/posts.test.ts` (append end-to-end tests)

- [ ] **Step 11.1: Write failing tests**

Append to `tests/posts.test.ts`. Add to the existing `../src/posts.js` import:

```ts
import {
  createPost, isPostSlugConflict, autoExcerpt, listPublishedPostsForBlog,
} from '../src/posts.js'
```

And add to testing imports:

```ts
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { SlopItError } from '../src/errors.js'
import { createRenderer } from '../src/rendering/generator.js'
```

Append at the bottom:

```ts
describe('createPost', () => {
  let dir: string
  let store: Store
  let outputDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function newRenderer(baseUrl = 'https://test.example.com') {
    return createRenderer({ store, outputDir, baseUrl })
  }

  it('creates a published post: DB row, post file, blog index, CSS', () => {
    const { blog } = createBlog(store, { name: 'my-blog' })
    const r = newRenderer()

    const { post, postUrl } = createPost(store, r, blog.id, {
      title: 'Hello World',
      body: '# Hello\n\nBody text.',
    })

    expect(post.slug).toBe('hello-world')
    expect(post.status).toBe('published')
    expect(post.publishedAt).not.toBeNull()
    expect(postUrl).toBe('https://test.example.com/hello-world/')   // trailing slash

    expect(existsSync(join(outputDir, blog.id, 'hello-world', 'index.html'))).toBe(true)
    expect(existsSync(join(outputDir, blog.id, 'index.html'))).toBe(true)
    expect(existsSync(join(outputDir, blog.id, 'style.css'))).toBe(true)
  })

  it('creates a draft: DB row only, no files, no postUrl', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const result = createPost(store, r, blog.id, {
      title: 'Draft post',
      body: 'Draft body',
      status: 'draft',
    })

    expect(result.post.status).toBe('draft')
    expect(result.post.publishedAt).toBeNull()
    expect(result.postUrl).toBeUndefined()

    // No post dir, no blog index, no CSS
    expect(existsSync(join(outputDir, blog.id, 'draft-post'))).toBe(false)
    expect(existsSync(join(outputDir, blog.id, 'index.html'))).toBe(false)
  })

  it('honors an explicit custom slug verbatim', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'Any title',
      body: 'x',
      slug: 'custom-slug',
    })

    expect(post.slug).toBe('custom-slug')
  })

  it('persists tags as a JSON array (round-trips)', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'Tagged',
      body: 'x',
      tags: ['ai', 'content', 'weekly'],
    })

    expect(post.tags).toEqual(['ai', 'content', 'weekly'])

    const row = store.db.prepare('SELECT tags FROM posts WHERE id = ?').get(post.id) as { tags: string }
    expect(JSON.parse(row.tags)).toEqual(['ai', 'content', 'weekly'])
  })

  it('auto-generates an excerpt when none is provided', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'Titled',
      body: '# Hi\n\nThis is the body content that should become an excerpt.',
    })

    expect(post.excerpt).toBeDefined()
    expect(post.excerpt).not.toBe('')
    expect(post.excerpt).toContain('body content')
  })

  it('uses an explicit excerpt when provided', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'T',
      body: 'anything',
      excerpt: 'Explicit summary.',
    })

    expect(post.excerpt).toBe('Explicit summary.')
  })

  it('throws BLOG_NOT_FOUND (with details.blogId) for a missing blog', () => {
    const r = newRenderer()
    let caught: unknown
    try {
      createPost(store, r, 'nonexistent', { title: 'T', body: 'x' })
    } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('BLOG_NOT_FOUND')
    expect((caught as SlopItError).details).toEqual({ blogId: 'nonexistent' })
  })

  it('throws POST_SLUG_CONFLICT (with details.slug) on same-blog-same-slug', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()
    createPost(store, r, blog.id, { title: 'First', body: 'x', slug: 'taken' })

    let caught: unknown
    try {
      createPost(store, r, blog.id, { title: 'Second', body: 'y', slug: 'taken' })
    } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(SlopItError)
    expect((caught as SlopItError).code).toBe('POST_SLUG_CONFLICT')
    expect((caught as SlopItError).details).toEqual({ slug: 'taken' })
  })

  it('allows the same slug across different blogs (no cross-blog conflict)', () => {
    const { blog: a } = createBlog(store, { name: 'a' })
    const { blog: b } = createBlog(store, { name: 'b' })
    const r = newRenderer()

    createPost(store, r, a.id, { title: 'T', body: 'x', slug: 'shared' })
    createPost(store, r, b.id, { title: 'T', body: 'y', slug: 'shared' })

    expect(listPublishedPostsForBlog(store, a.id).map((p) => p.slug)).toEqual(['shared'])
    expect(listPublishedPostsForBlog(store, b.id).map((p) => p.slug)).toEqual(['shared'])
  })

  it('rejects bad input via Zod (pre-DB)', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    expect(() => createPost(store, r, blog.id, { title: '', body: 'x' })).toThrow()
    expect(() => createPost(store, r, blog.id, { title: 'a'.repeat(201), body: 'x' })).toThrow()
    expect(() => createPost(store, r, blog.id, { title: 'T', body: '' })).toThrow()
  })

  it('compensates by DELETEing the row when render fails', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    // Make the output path a file, so mkdirSync will fail (can't make dir
    // with that name).
    writeFileSync(outputDir, 'not a dir')

    let caught: unknown
    try {
      createPost(store, r, blog.id, { title: 'T', body: 'x' })
    } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(SlopItError)   // compensated; original render error bubbles

    const count = store.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE blog_id = ?').get(blog.id) as { n: number }
    expect(count.n).toBe(0)
  })

  it('returns the full Post shape with created_at and updated_at', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'T',
      body: 'x',
    })

    expect(typeof post.id).toBe('string')
    expect(typeof post.createdAt).toBe('string')
    expect(typeof post.updatedAt).toBe('string')
    expect(post.blogId).toBe(blog.id)
  })

  it('passes author / coverImage / seoTitle / seoDescription through to the DB', () => {
    const { blog } = createBlog(store, {})
    const r = newRenderer()

    const { post } = createPost(store, r, blog.id, {
      title: 'T',
      body: 'x',
      author: 'Agent 47',
      coverImage: 'https://example.com/img.png',
      seoTitle: 'SEO T',
      seoDescription: 'SEO D',
    })

    expect(post.author).toBe('Agent 47')
    expect(post.coverImage).toBe('https://example.com/img.png')
    expect(post.seoTitle).toBe('SEO T')
    expect(post.seoDescription).toBe('SEO D')
  })

  it('blog index includes the newly published post', () => {
    const { blog } = createBlog(store, { name: 'b' })
    const r = newRenderer()
    createPost(store, r, blog.id, { title: 'First Post', body: 'x' })

    const indexHtml = readFileSync(join(outputDir, blog.id, 'index.html'), 'utf8')
    expect(indexHtml).toContain('>First Post<')
  })
})
```

- [ ] **Step 11.2: Run tests to verify they fail**

```bash
pnpm test tests/posts.test.ts
```

Expected: **FAIL** — `createPost` not exported.

- [ ] **Step 11.3: Implement `createPost` in `src/posts.ts`**

At the top of `src/posts.ts`, update imports to include everything the function needs:

```ts
import type { Store } from './db/store.js'
import { generateShortId } from './ids.js'
import { SlopItError } from './errors.js'
import { getBlogInternal } from './blogs.js'
import { generateSlug } from './ids.js'
import { PostInputSchema, type Post, type PostInput } from './schema/index.js'
import type { Renderer } from './rendering/generator.js'
```

(Some of these may already be there from Tasks 5–6. Merge without duplicating. Order imports alphabetically within groups if the file already follows that convention.)

At the bottom of `src/posts.ts`, append the `createPost` function:

```ts
/**
 * Create a post. For published posts, also renders the post page + blog
 * index + CSS to disk, and returns a postUrl. For drafts, writes the DB
 * row only and returns { post } without postUrl.
 *
 * See docs/superpowers/specs/2026-04-22-create-post-design.md for the full
 * contract, including the weakened atomicity invariant: if render fails,
 * createPost attempts compensation via DELETE FROM posts. If the DELETE
 * also fails (extraordinarily rare — usually indicates DB corruption or
 * I/O failure), the row persists and operator cleanup is needed.
 */
export function createPost(
  store: Store,
  renderer: Renderer,
  blogId: string,
  input: PostInput,
): { post: Post; postUrl?: string } {
  const parsed = PostInputSchema.parse(input)

  // Step 2: blog exists
  getBlogInternal(store, blogId)   // throws BLOG_NOT_FOUND with details.blogId

  // Step 3: resolve slug
  const slug = parsed.slug ?? generateSlug(parsed.title)
  // (The superRefine in PostInputSchema already rejected empty auto-slug.)

  // Step 4: derived fields
  const id = generateShortId()
  const excerpt = parsed.excerpt ?? autoExcerpt(parsed.body)
  const now = new Date().toISOString()
  const publishedAt = parsed.status === 'published' ? now : null
  const tagsJson = JSON.stringify(parsed.tags)

  // Step 5: transactional INSERT with preflight + narrow-match
  const tx = store.db.transaction(() => {
    const exists = store.db
      .prepare('SELECT 1 FROM posts WHERE blog_id = ? AND slug = ?')
      .get(blogId, slug)
    if (exists) {
      throw new SlopItError('POST_SLUG_CONFLICT', `Slug "${slug}" is already taken in this blog`, { slug })
    }
    try {
      store.db
        .prepare(
          `INSERT INTO posts (
             id, blog_id, slug, title, body, excerpt, tags, status,
             seo_title, seo_description, author, cover_image, published_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, blogId, slug, parsed.title, parsed.body, excerpt, tagsJson, parsed.status,
          parsed.seoTitle ?? null,
          parsed.seoDescription ?? null,
          parsed.author ?? null,
          parsed.coverImage ?? null,
          publishedAt,
        )
    } catch (e) {
      if (isPostSlugConflict(e)) {
        throw new SlopItError('POST_SLUG_CONFLICT', `Slug "${slug}" is already taken in this blog`, { slug })
      }
      throw e
    }
  })
  tx()

  // Step 5.5: hydrate the row we just wrote
  const row = store.db
    .prepare(
      `SELECT id, blog_id, slug, title, body, excerpt, tags, status,
              seo_title, seo_description, author, cover_image,
              published_at, created_at, updated_at
         FROM posts WHERE id = ?`,
    )
    .get(id) as {
      id: string
      blog_id: string
      slug: string
      title: string
      body: string
      excerpt: string
      tags: string
      status: 'draft' | 'published'
      seo_title: string | null
      seo_description: string | null
      author: string | null
      cover_image: string | null
      published_at: string | null
      created_at: string
      updated_at: string
    }

  const post: Post = {
    id: row.id,
    blogId: row.blog_id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    excerpt: row.excerpt,
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

  // Step 6: render with compensation for published posts
  if (parsed.status === 'published') {
    try {
      renderer.renderPost(blogId, post)
      renderer.renderBlog(blogId)
    } catch (renderErr) {
      try {
        store.db.prepare('DELETE FROM posts WHERE id = ?').run(id)
      } catch { /* best-effort; see spec's decision #6 */ }
      throw renderErr
    }
    return { post, postUrl: renderer.baseUrl + '/' + post.slug + '/' }   // trailing slash — matches directory layout
  }

  return { post }
}
```

- [ ] **Step 11.4: Fix the `Post.excerpt` type if needed**

The spec's `PostSchema` expects `excerpt: z.string().optional()` — optional. But our INSERT always writes a non-null `excerpt` (either `parsed.excerpt` or the auto-generated one). So the DB row's `excerpt` is never `null` for rows we write. But the existing schema might allow `null` (from the DB schema).

Look at `src/schema/index.ts` → `PostSchema`. If `excerpt` is `z.string().optional()`, the inferred Post type has `excerpt?: string`. In the hydration code above, I wrote `excerpt: row.excerpt` (typed as string, always present post-INSERT). That's fine — it's a narrower value than the Post type permits.

**If typecheck fails** on the `post` object literal, the issue is likely: the SQL SELECT returned `excerpt: string | null` because the column is nullable. Fix by narrowing:

```ts
excerpt: row.excerpt ?? undefined,
```

Update the line in the hydration code above. Re-run typecheck.

- [ ] **Step 11.5: Run tests to verify they pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. +14 createPost tests passing.

- [ ] **Step 11.6: Commit**

```bash
git add src/posts.ts tests/posts.test.ts
git commit -m "Implement createPost end-to-end

Flow per spec:
1. Zod-parse input (PostInputSchema, with superRefine for empty auto-slug).
2. Blog exists check (getBlogInternal throws BLOG_NOT_FOUND).
3. Resolve slug — custom or auto via generateSlug.
4. Derive id, excerpt (autoExcerpt if not provided), publishedAt.
5. db.transaction: preflight SELECT + INSERT; narrow-match catch wraps
   UNIQUE(blog_id, slug) as POST_SLUG_CONFLICT with details.slug.
6. For published: renderer.renderPost + renderer.renderBlog inside
   try/catch; compensate via DELETE on render failure (best-effort).
7. Return { post, postUrl? } (postUrl only when published).

Draft path: steps 1-5 only; returns { post } with publishedAt=null.

Tags persisted as JSON string; round-trip via JSON.parse on read.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Safety-net test — `tests/posts.id-collision.test.ts`

Purpose: parallel to `tests/blogs.id-collision.test.ts`. Mock `node:crypto` to force a deterministic post id, then call `createPost` twice with DIFFERENT slugs (so preflight passes) but the SAME id (via mock), hitting `posts.id` PK violation at INSERT. Assert the raw SQLite error bubbles and is NOT mislabeled as `POST_SLUG_CONFLICT`. Catches any future regression where `createPost` widens its catch.

**Files:**
- Create: `tests/posts.id-collision.test.ts`

- [ ] **Step 12.1: Create the test file**

Create `tests/posts.id-collision.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock node:crypto so randomBytes is deterministic (all zeros → id 'aaaaaaaa').
// Mock is file-scoped; other test files get the real implementation.
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return {
    ...actual,
    randomBytes: (size: number) => Buffer.alloc(size),
  }
})

// Import AFTER the mock.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, type Store } from '../src/db/store.js'
import { createBlog } from '../src/blogs.js'
import { createPost } from '../src/posts.js'
import { createRenderer } from '../src/rendering/generator.js'
import { SlopItError } from '../src/errors.js'

describe('createPost — narrow error mapping through the function', () => {
  let dir: string
  let store: Store
  let outputDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slopit-'))
    store = createStore({ dbPath: join(dir, 'test.db') })
    outputDir = join(dir, 'out')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lets posts.id PK collisions bubble raw (does NOT mislabel as POST_SLUG_CONFLICT)', () => {
    const { blog } = createBlog(store, { name: 'b' })
    const renderer = createRenderer({ store, outputDir, baseUrl: 'https://b.example.com' })

    // First createPost succeeds (generates id "aaaaaaaa" via the mock).
    const first = createPost(store, renderer, blog.id, {
      title: 'First',
      body: 'x',
      slug: 'first-slug',
    })
    expect(first.post.id).toMatch(/^a{8}$/)   // sanity: mock took effect

    // Second createPost uses a DIFFERENT slug (so preflight passes) but
    // generates the same id via the mock → posts.id PK violation at INSERT.
    let caught: unknown
    try {
      createPost(store, renderer, blog.id, {
        title: 'Second',
        body: 'y',
        slug: 'second-slug',
      })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(SlopItError)   // NOT wrapped
    expect((caught as Error).message).toContain('posts.id')
    expect((caught as NodeJS.ErrnoException).code).toBe('SQLITE_CONSTRAINT_PRIMARYKEY')
  })
})
```

**Note on the error code:** SQLite raises `SQLITE_CONSTRAINT_PRIMARYKEY` (not `SQLITE_CONSTRAINT_UNIQUE`) for PRIMARY KEY violations. The narrow predicate `isPostSlugConflict` only matches `SQLITE_CONSTRAINT_UNIQUE` + `'posts.blog_id, posts.slug'` in the message, so a `posts.id` PK collision correctly returns `false` → raw error bubbles. This test asserts that behavior.

- [ ] **Step 12.2: Run tests to verify they pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. The test should PASS on first run (no code change needed — `createPost` already calls `isPostSlugConflict` narrowly). If it fails, the implementation in Task 11 is wrong. +1 test.

- [ ] **Step 12.3: Commit**

```bash
git add tests/posts.id-collision.test.ts
git commit -m "Safety-net: posts.id PK collision bubbles raw

Parallel to tests/blogs.id-collision.test.ts. Uses vi.mock('node:crypto')
to force deterministic randomBytes, making generateShortId produce the
same id twice. First createPost succeeds; second uses a different slug
(preflight passes) but gets the same id → posts.id PK violation at INSERT
→ isPostSlugConflict returns false → raw SQLite error bubbles.

Catches any future regression where createPost widens its catch to
swallow non-slug UNIQUE/PK errors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Public barrel + final verification + build check + push

Purpose: add `createPost` and `PostInput` to `src/index.ts`. Verify typecheck, test, coverage, and build all succeed. Push the branch to `origin`.

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/posts.test.ts` (append barrel smoke)

- [ ] **Step 13.1: Write failing barrel smoke test**

Append to `tests/posts.test.ts`:

```ts
describe('public barrel — createPost exports', () => {
  it('exposes createPost and PostInputSchema', async () => {
    const mod = await import('../src/index.js')
    expect(typeof mod.createPost).toBe('function')
    expect(typeof mod.PostInputSchema).toBe('object')      // Zod schema
    // PostInput is a type, not a runtime value; check via inferred use instead.
  })

  it('exposes the POST_SLUG_CONFLICT code through SlopItErrorCode', () => {
    // Type-level only; SlopItErrorCode is a union of literal strings.
    // Create a SlopItError with the code to verify it accepts the union member.
    const err = new (require('../src/errors.js').SlopItError)('POST_SLUG_CONFLICT', 'x', { slug: 's' })
    expect(err.code).toBe('POST_SLUG_CONFLICT')
  })
})
```

- [ ] **Step 13.2: Run test to verify failure**

```bash
pnpm test tests/posts.test.ts -t "public barrel — createPost"
```

Expected: **FAIL** — `createPost` not on the module.

- [ ] **Step 13.3: Update `src/index.ts`**

Open `src/index.ts`. Find the existing `export { createBlog, createApiKey } from './blogs.js'` line. After it, add:

```ts
export { createPost } from './posts.js'
```

`PostInputSchema` and the `PostInput` type are already re-exported via the existing `export * from './schema/index.js'` line, so nothing else needs to change in the barrel. `SlopItError` and `SlopItErrorCode` are also already there.

- [ ] **Step 13.4: Run tests + typecheck, verify pass**

```bash
pnpm typecheck
pnpm test
```

Expected: all green. +2 barrel tests.

- [ ] **Step 13.5: Run full coverage + build**

```bash
pnpm test:coverage
```

Expected: all tests pass. Coverage summary shows 100% lines + 100% branches for:
- `src/posts.ts`
- `src/ids.ts`
- `src/rendering/templates.ts`
- `src/rendering/generator.ts`

(Other files — `src/api/index.ts` stub, `src/mcp/server.ts` stub, `src/dashboard/index.ts` stub, `src/rendering/feeds.ts` stubs — will show non-100% coverage because they're still stubs awaiting later features. Ignore those. Only the four files above are required to hit 100% in this feature.)

If any target file is below 100%, add tests until covered.

```bash
pnpm build
```

Expected: build succeeds. Verify `dist/themes/minimal/post.html`, `dist/themes/minimal/index.html`, `dist/themes/minimal/style.css` all exist (copied by the build step added in Task 1).

```bash
ls dist/themes/minimal
```

Expected output:
```
index.html  post.html  style.css
```

- [ ] **Step 13.6: Commit**

```bash
git add src/index.ts tests/posts.test.ts
git commit -m "Export createPost from public barrel + final coverage

src/index.ts adds:
  export { createPost } from './posts.js'

PostInputSchema + PostInput come through the existing
'export * from ./schema/index.js'. SlopItError + SlopItErrorCode
were already in the barrel.

Coverage on src/posts.ts, src/ids.ts, src/rendering/templates.ts,
src/rendering/generator.ts: 100% lines + 100% branches.
pnpm build succeeds; dist/themes/minimal/{post.html,index.html,style.css}
copied as expected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 13.7: Push and open PR**

```bash
git push -u origin feat/create-post
```

Then open a PR from `feat/create-post` → `main`. PR title: `createPost: publish primitive + minimal theme + render pipeline`. PR description: summarize the feature, link the spec (`docs/superpowers/specs/2026-04-22-create-post-design.md`) and this plan, list the 13 task commits, note coverage + test counts.

Use the template:

```bash
gh pr create --base main --head feat/create-post --title "createPost: publish primitive + minimal theme + render pipeline" --body "$(cat <<'EOF'
## Summary

Second feature of @slopit/core. `createPost` is the publish primitive — strategy.md's one-call-to-live-URL loop.

- End-to-end: Zod-validated input → blog-exists check → slug preflight + narrow-match race guard → transactional INSERT → sync render of post page + blog index + CSS refresh on publish → DELETE compensation on render failure → return `{ post, postUrl? }`.
- File-based theme system, `minimal` theme shipped. Template loader + escape + fragment helpers in `src/rendering/`.
- Theme enum narrowed from `['minimal','classic','zine']` to `['minimal']` across `BlogSchema` + `CreateBlogInputSchema`. Classic/zine become follow-up features.
- New `src/ids.ts` with `generateShortId` (promoted from `src/blogs.ts`) + `generateSlug`.
- `SlopItError` gains optional `details` field (backward-compatible). New code `POST_SLUG_CONFLICT` with `details.slug`.
- ARCHITECTURE.md boundary rule #5 updated with a narrow exception for the "Powered by SlopIt" footer link.
- 13 TDD commits. 100% line + branch coverage on `src/posts.ts`, `src/ids.ts`, `src/rendering/templates.ts`, `src/rendering/generator.ts`.

## Spec / plan

- Spec: `docs/superpowers/specs/2026-04-22-create-post-design.md`
- Plan: `docs/superpowers/plans/2026-04-22-create-post-implementation.md`

## Test plan

- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` — all tests pass
- [ ] `pnpm test:coverage` — 100% on the four target files
- [ ] `pnpm build` succeeds and `dist/themes/minimal/` contains `post.html`, `index.html`, `style.css`
- [ ] Spot-check: create a blog, call createPost, inspect the resulting file structure in an `outputDir`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 13.8: Done**

Feature complete. Next features per sequence: REST routes + MCP tools (which pulls in getBlog/listBlogs), then self-hosted example, then Nginx → Caddy migration, then landing page.

---

## Self-review

- **Spec coverage:** every decision table row (1–12) and every test case number (1–27) from the spec maps to a task above. Collateral doc + schema narrowing + build script: Task 1. `generateShortId` promotion + `generateSlug`: Task 2. `SlopItError.details` + `POST_SLUG_CONFLICT`: Task 3. `PostInputSchema` enhancement + `superRefine`: Task 4. `isPostSlugConflict` + `autoExcerpt`: Task 5. `getBlogInternal` + `listPublishedPostsForBlog`: Task 6. Theme content: Task 7. Template primitives: Task 8. Fragment helpers + `ensureCss`: Task 9. Renderer body (sync, `ensureCss` first, relative hrefs, displayName fallback): Task 10. `createPost` end-to-end + draft path + compensation: Task 11. Safety-net PK collision: Task 12. Barrel + coverage + build + PR: Task 13.
- **Placeholder scan:** No TBD, no "implement later", no "add appropriate X." Every step shows exact code and exact commands.
- **Type consistency:** `Post`, `PostInput`, `Store`, `Renderer`, `Blog`, `SlopItError`, `SlopItErrorCode` used consistently across tasks. `generateShortId`, `generateSlug`, `isPostSlugConflict`, `autoExcerpt`, `getBlogInternal`, `listPublishedPostsForBlog`, `escapeHtml`, `render`, `loadTheme`, `formatDate`, `renderPostList`, `renderTagList`, `renderPoweredBy`, `renderSeoMeta`, `ensureCss`, `createPost` — names match across the tasks that define them and the tasks that use them.
- **Deviation noted:** None from the spec. The spec itself notes that `autoExcerpt` is "not a full markdown parser — good enough for v1"; this plan implements that faithfully.
- **Node/API availability:** `node:crypto.randomBytes`, `node:fs.{readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync,mkdtempSync,rmSync}`, `node:os.tmpdir`, `node:path.{join,dirname}`, `node:url.fileURLToPath` — all stdlib, all Node ≥22.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-22-create-post-implementation.md`. Since the user has stated the plan will be executed by a different person (not via subagent-driven-development from this session), the plan is self-contained and paste-executable.

When execution is picked up, the executor can either:

1. **Subagent-Driven** (recommended for AI execution) — dispatch a fresh subagent per task using `superpowers:subagent-driven-development`.
2. **Inline** — execute tasks in-session using `superpowers:executing-plans` with checkpoints.
3. **Human** — copy-paste each step manually.

All three paths work because every step has exact code, commands, and expected output.
